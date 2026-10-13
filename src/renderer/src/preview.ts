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
md.use(taskLists as never, { enabled: true, label: true })

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

// preview task checkbox -> editor source line write-back
let taskToggleHandler: ((line: number, checked: boolean) => void) | null = null
export function setTaskToggleHandler(fn: (line: number, checked: boolean) => void) {
  taskToggleHandler = fn
}

function encodeFilePath(abs: string): string {
  return abs.split('/').map(encodeURIComponent).join('/')
}

let mermaidReady: Promise<typeof import('mermaid')['default']> | null = null
function mermaidInitOptions() {
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    theme: mermaidTheme(),
    // pure SVG <text> labels: foreignObject HTML gets stripped by DOMPurify's SVG profile
    // useMaxWidth off: keep diagrams readable, the container scrolls horizontally instead
    flowchart: { htmlLabels: false, useMaxWidth: false },
    class: { htmlLabels: false, useMaxWidth: false },
    sequence: { useMaxWidth: false },
  }
}
function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then((m) => {
      const mermaid = m.default
      mermaid.initialize(mermaidInitOptions())
      return mermaid
    })
  }
  return mermaidReady
}

function mermaidTheme(): 'dark' | 'default' {
  return currentTheme() === 'dark' ? 'dark' : 'default'
}

// rendered-diagram cache keyed by theme+source (cleared on theme change)
const mermaidCache = new Map<string, string>()

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
    // reuse previously rendered diagrams — typing re-renders skip unchanged sources
    const key = `${mermaidTheme()}\u0000${source}`
    const cached = mermaidCache.get(key)
    if (cached !== undefined) {
      holder.innerHTML = cached
      pre.replaceWith(holder)
      continue
    }
    try {
      const { svg } = await mermaid.render(`mmd-${Date.now().toString(36)}-${i}`, source)
      // mermaid renders node labels as foreignObject HTML regardless of htmlLabels;
      // DOMPurify's SVG profile strips that HTML (labels vanish), so the raw output is
      // kept as-is — safety comes from securityLevel:'strict' (labels escaped by mermaid)
      // plus the page CSP which blocks any script execution.
      const clean = svg
      if (mermaidCache.size > 60) mermaidCache.clear()
      mermaidCache.set(key, clean)
      holder.innerHTML = clean
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
  const big = text.length > 20000
  const t0 = big ? performance.now() : 0
  const raw = md.render(text)
  const t1 = big ? performance.now() : 0
  const html = DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target', 'data-source-line', 'id', 'checked', 'disabled'],
  })
  const t2 = big ? performance.now() : 0
  if (seq !== renderSeq) return // superseded by a newer render
  container.innerHTML = html
  const t3 = big ? performance.now() : 0

  const baseDir = filePath ? filePath.slice(0, filePath.lastIndexOf('/')) : null
  container.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (/^https?:/i.test(src)) {
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      return
    }
    if (/^(data:|mdasset:)/i.test(src)) return
    if (!baseDir) return
    const clean = decodeURIComponent(src.split('?')[0].split('#')[0])
    const abs = `${baseDir}/${clean}`.replace(/\/{2,}/g, '/').replace(/\/$/, '')
    img.loading = 'lazy'
    // constant host keeps the URL parser from treating the leading path segment as a host
    img.src = 'mdasset://local' + encodeFilePath(abs)
  })

  // hover tooltip with the target URL for external links
  container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    if (/^https?:/i.test(href) && !a.title) a.title = href
  })

  // task list checkboxes toggle the source line and write back through the editor
  container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const li = cb.closest('li') as HTMLElement | null
      const line = Number(li?.dataset.sourceLine ?? 0)
      if (line > 0 && taskToggleHandler) taskToggleHandler(line, cb.checked)
    })
  })

  const tm0 = big ? performance.now() : 0
  await renderMermaidBlocks(container)
  last = { container, scroller, text, filePath }
  if (big) {
    const t4 = performance.now()
    console.log(
      `[perf] render ${(text.length / 1024) | 0}KB parse=${(t1 - t0) | 0}ms sanitize=${(t2 - t1) | 0}ms dom=${(tm0 - t3) | 0}ms mermaid=${(t4 - tm0) | 0}ms total=${(t4 - t0) | 0}ms`,
    )
  }
}

onThemeChange(async () => {
  // mermaid diagrams are baked with a theme; drop the cache and re-render, keep scroll position
  mermaidCache.clear()
  if (!last) return
  const { scroller, text, filePath } = last
  const scroll = scroller.scrollTop
  const mermaid = await getMermaid()
  mermaid.initialize(mermaidInitOptions())
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
