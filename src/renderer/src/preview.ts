import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import katexPlugin from '@vscode/markdown-it-katex'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'
import { currentTheme, onThemeChange } from './theme'

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    if (lang && lang !== 'mermaid' && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        /* fall through to escaped output */
      }
    }
    return ''
  },
})

md.use(katexPlugin as never)
md.use(taskLists as never, { label: true })

// tag block tokens with their source line so the preview can scroll-sync with the editor
md.core.ruler.push('mdr_source_line', (state) => {
  for (const t of state.tokens) {
    if (t.map && t.nesting !== -1) {
      t.attrSet('data-source-line', String(t.map[0] + 1))
    }
  }
})

// stable heading ids for outline jumps and #anchor links
md.core.ruler.push('mdr_heading_id', (state) => {
  const used = new Set<string>()
  for (let i = 0; i < state.tokens.length; i++) {
    const t = state.tokens[i]
    if (t.type !== 'heading_open') continue
    const text = (state.tokens[i + 1]?.children ?? []).map((c) => c.content).join('')
    const base =
      text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .slice(0, 60) || 'section'
    let id = base
    let n = 2
    while (used.has(id)) id = `${base}-${n++}`
    used.add(id)
    t.attrSet('id', id)
  }
})

interface LastRender {
  container: HTMLElement
  scroller: HTMLElement
  text: string
  filePath: string | null
}

let last: LastRender | null = null
let renderSeq = 0

function encodeFilePath(abs: string): string {
  return abs.split('/').map(encodeURIComponent).join('/')
}

let mermaidReady: Promise<typeof import('mermaid')['default']> | null = null
function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then((m) => {
      const mermaid = m.default
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mermaidTheme() })
      return mermaid
    })
  }
  return mermaidReady
}

function mermaidTheme(): 'dark' | 'default' {
  return currentTheme() === 'dark' ? 'dark' : 'default'
}

async function renderMermaidBlocks(container: HTMLElement) {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
  if (!blocks.length) return
  const mermaid = await getMermaid()
  for (let i = 0; i < blocks.length; i++) {
    const code = blocks[i]
    const pre = code.parentElement as HTMLElement
    const source = code.textContent ?? ''
    const holder = document.createElement('div')
    holder.className = 'mermaid-block'
    if (pre.dataset.sourceLine) holder.dataset.sourceLine = pre.dataset.sourceLine
    try {
      const { svg } = await mermaid.render(`mmd-${Date.now().toString(36)}-${i}`, source)
      holder.innerHTML = DOMPurify.sanitize(svg, { ADD_TAGS: ['foreignObject'] })
    } catch (err) {
      holder.classList.add('mermaid-error')
      const msg = document.createElement('div')
      msg.className = 'mermaid-error-msg'
      msg.textContent = '⚠ Mermaid 渲染失败'
      holder.appendChild(msg)
      const fallback = document.createElement('pre')
      fallback.textContent = source
      holder.appendChild(fallback)
    }
    pre.replaceWith(holder)
  }
}

export async function renderPreview(scroller: HTMLElement, container: HTMLElement, text: string, filePath: string | null) {
  const seq = ++renderSeq
  const html = DOMPurify.sanitize(md.render(text), {
    ADD_ATTR: ['target', 'data-source-line', 'id'],
  })
  if (seq !== renderSeq) return // superseded by a newer render
  container.innerHTML = html

  const baseDir = filePath ? filePath.slice(0, filePath.lastIndexOf('/')) : null
  container.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (/^https?:/i.test(src)) {
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      img.classList.add('zoomable')
      img.addEventListener('click', () => window.open(src, '_blank', 'noopener'))
      return
    }
    if (/^(data:|mdasset:)/i.test(src)) return
    if (!baseDir) return
    const clean = decodeURIComponent(src.split('?')[0].split('#')[0])
    const abs = `${baseDir}/${clean}`.replace(/\/{2,}/g, '/').replace(/\/$/, '')
    img.loading = 'lazy'
    img.src = 'mdasset://' + encodeFilePath(abs)
  })

  await renderMermaidBlocks(container)
  last = { container, scroller, text, filePath }
}

onThemeChange(async () => {
  // mermaid diagrams are baked with a theme; re-render everything and keep scroll position
  if (!last) return
  const { scroller, text, filePath } = last
  const scroll = scroller.scrollTop
  const mermaid = await getMermaid()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mermaidTheme() })
  await renderPreview(scroller, scroller, text, filePath)
  scroller.scrollTop = scroll
})

export function handleLinkClick(scroller: HTMLElement, container: HTMLElement, onOpenMd: (path: string) => void) {
  container.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      const target = container.querySelector(`#${CSS.escape(href.slice(1))}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (/^https?:/i.test(href)) {
      e.preventDefault()
      window.open(href, '_blank', 'noopener')
      return
    }
    if (/\.md$/i.test(href.split('?')[0].split('#')[0]) && last?.filePath) {
      e.preventDefault()
      const baseDir = last.filePath.slice(0, last.filePath.lastIndexOf('/'))
      const clean = decodeURIComponent(href.split('?')[0].split('#')[0])
      onOpenMd(`${baseDir}/${clean}`.replace(/\/{2,}/g, '/'))
    }
  })
}
