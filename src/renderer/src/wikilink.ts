/**
 * 双链 [[...]]：通过渲染管线注册语法解析与导航交互。
 * - 语法层：markdown-it inline 规则（markdownPlugin 钩子）→ <a data-wikilink>
 * - 交互层：DOM 后处理（postProcessor 钩子）→ 名称解析/点击打开/悬停预览卡/断链样式
 */
import { registerMarkdownPlugin, registerPostProcessor } from './pipeline'

let navHandler: ((path: string, anchor?: string) => void) | null = null
export function setWikilinkNav(fn: (path: string, anchor?: string) => void) {
  navHandler = fn
}

// ---------------- 语法层：inline 规则 ----------------

registerMarkdownPlugin((md) => {
  md.inline.ruler.before(
    'link',
    'mdr_wikilink',
    (state, silent) => {
      const src = state.src
      const pos = state.pos
      if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5b) return false
      const end = src.indexOf(']]', pos + 2)
      if (end === -1 || end > state.posMax) return false
      const inner = src.slice(pos + 2, end)
      if (!inner.trim()) return false

      const bar = inner.indexOf('|')
      let target = (bar === -1 ? inner : inner.slice(0, bar)).trim()
      let display = (bar === -1 ? '' : inner.slice(bar + 1)).trim()
      let anchor = ''
      const hash = target.indexOf('#')
      if (hash !== -1) {
        anchor = target.slice(hash + 1).trim()
        target = target.slice(0, hash).trim()
      }
      if (!target && !anchor) return false
      if (!display) display = target || anchor

      if (!silent) {
        const open = state.push('link_open', 'a', 1)
        open.attrs = [['href', '#'], ['data-wikilink', target], ['class', 'internal-link']]
        if (anchor) open.attrs.push(['data-wikilink-anchor', anchor])
        const text = state.push('text', '', 0)
        text.content = display
        state.push('link_close', 'a', -1)
      }
      state.pos = end + 2
      return true
    },
    { alt: ['link', 'image', 'emphasis'] },
  )
})

// ---------------- 交互层：DOM 后处理 ----------------

let hoverTimer: number | null = null
let activeCard: HTMLElement | null = null
// hover-card content cache: repeat hovers show instantly
const peekCache = new Map<string, { title: string; excerpt: string } | null>()

function dismissCard() {
  if (hoverTimer !== null) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
  activeCard?.remove()
  activeCard = null
}

registerPostProcessor((container) => {
  const links = container.querySelectorAll<HTMLAnchorElement>('a[data-wikilink]')
  links.forEach((a) => {
    const target = a.dataset.wikilink ?? ''
    // resolve asynchronously; mark broken links once known
    void window.mdr.indexResolve(target).then((path) => {
      if (path) a.dataset.wikilinkPath = path
      else a.classList.add('broken')
    })

    a.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const path = a.dataset.wikilinkPath
      if (path) navHandler?.(path, a.dataset.wikilinkAnchor)
      else void window.mdr.confirm({ title: '未找到文档', message: `书库中没有找到“${target}”`, okLabel: '知道了' })
    })

    a.addEventListener('mouseenter', () => {
      dismissCard()
      hoverTimer = window.setTimeout(async () => {
        const path = a.dataset.wikilinkPath
        if (!path) return
        const peek = peekCache.has(path) ? peekCache.get(path)! : await window.mdr.indexPeek(path)
        peekCache.set(path, peek)
        if (!peek) return
        dismissCard()
        const card = document.createElement('div')
        card.className = 'wikilink-card'
        card.innerHTML =
          `<div class="wl-title"></div><div class="wl-excerpt"></div>`
        ;(card.querySelector('.wl-title') as HTMLElement).textContent = peek.title
        ;(card.querySelector('.wl-excerpt') as HTMLElement).textContent = peek.excerpt || '（空文档）'
        document.body.appendChild(card)
        const rect = a.getBoundingClientRect()
        const cardH = card.offsetHeight || 90
        const top = rect.bottom + 8 + cardH > window.innerHeight ? Math.max(8, rect.top - cardH - 8) : rect.bottom + 8
        card.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`
        card.style.top = `${top}px`
        activeCard = card
        // the card disappears on mouseleave or after a while (re-renders don't fire mouseleave)
        setTimeout(() => activeCard === card && dismissCard(), 6000)
      }, 150)
    })
    a.addEventListener('mouseleave', dismissCard)
  })
  // stale cards from a previous render should not survive
  dismissCard()
})
