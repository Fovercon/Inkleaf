import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import katexPlugin from '@vscode/markdown-it-katex'
import footnotePlugin from 'markdown-it-footnote'
import deflistPlugin from 'markdown-it-deflist'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'
import { currentTheme, onThemeChange } from './theme'
import {
  getMarkdownRevision,
  registerMarkdownPlugin,
  registerPostProcessor,
  registerCodeBlockProcessor,
  applyMarkdownPlugins,
  listPostProcessors,
  getCodeBlockProcessor,
  type RenderContext,
} from './pipeline'

// ---------------- 内置渲染能力的管线注册（与插件同一 API） ----------------

/** 语法层：KaTeX / 任务列表 / 脚注 / 定义列表 / callout / 行号与标题锚点 */
registerMarkdownPlugin((md) => {
  md.use(katexPlugin as never)
  md.use(taskLists as never, { enabled: true, label: true })
  md.use(footnotePlugin as never)
  md.use(deflistPlugin as never)

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
})

// preview task checkbox -> editor source line write-back
let taskToggleHandler: ((line: number, checked: boolean) => void) | null = null
export function setTaskToggleHandler(fn: (line: number, checked: boolean) => void) {
  taskToggleHandler = fn
}

/** DOM 后处理：图片协议重写 / 外链提示 / 任务复选框回写 */
registerPostProcessor((container, ctx) => {
  container.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (/^https?:/i.test(src)) {
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      return
    }
    if (/^(data:|mdasset:)/i.test(src)) return
    if (!ctx.baseDir) return
    const clean = decodeURIComponent(src.split('?')[0].split('#')[0])
    const abs = `${ctx.baseDir}/${clean}`.replace(/\/{2,}/g, '/').replace(/\/$/, '')
    img.loading = 'lazy'
    // constant host keeps the URL parser from treating the leading path segment as a host
    img.src = 'mdasset://local' + abs.split('/').map(encodeURIComponent).join('/')
  })

  // hover tooltip with the target URL for external links
  container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    if (/^https?:/i.test(href) && !a.title) a.title = href
  })

  container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const li = cb.closest('li') as HTMLElement | null
      const line = Number(li?.dataset.sourceLine ?? 0)
      if (line > 0 && taskToggleHandler) taskToggleHandler(line, cb.checked)
    })
  })
})

// ---------------- markdown 实例（经管线装配） ----------------

let md: MarkdownIt = new MarkdownIt({
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
// 装配延迟到首次渲染；插件注册变更（含反注册）时按版本号重建实例
let appliedRevision = -1
function ensurePipeline() {
  if (appliedRevision === getMarkdownRevision()) return
  appliedRevision = getMarkdownRevision()
  md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight(code: string, lang: string) {
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
  applyMarkdownPlugins(md)
}

// ---------------- Mermaid：代码块处理器（懒加载 + 缓存） ----------------

function mermaidTheme(): 'dark' | 'default' {
  return currentTheme() === 'dark' ? 'dark' : 'default'
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

// rendered-diagram cache keyed by theme+source (cleared on theme change)
const mermaidCache = new Map<string, string>()

let mermaidSeq = 0
registerCodeBlockProcessor('mermaid', async (pre, source) => {
  const holder = document.createElement('div')
  holder.className = 'mermaid-block'
  if (pre.dataset.sourceLine) holder.dataset.sourceLine = pre.dataset.sourceLine
  // reuse previously rendered diagrams — typing re-renders skip unchanged sources
  const key = `${mermaidTheme()}\u0000${source}`
  const cached = mermaidCache.get(key)
  if (cached !== undefined) {
    holder.innerHTML = cached
    pre.replaceWith(holder)
    return
  }
  try {
    const mermaid = await getMermaid()
    const { svg } = await mermaid.render(`mmd-${Date.now().toString(36)}-${mermaidSeq++}`, source)
    // mermaid renders node labels as foreignObject HTML regardless of htmlLabels;
    // DOMPurify's SVG profile strips that HTML (labels vanish), so the raw output is
    // kept as-is — safety comes from securityLevel:'strict' (labels escaped by mermaid)
    // plus the page CSP which blocks any script execution.
    if (mermaidCache.size > 60) mermaidCache.clear()
    mermaidCache.set(key, svg)
    holder.innerHTML = svg
  } catch {
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
})

// ---------------- 渲染主流程 ----------------

interface LastRender {
  container: HTMLElement
  scroller: HTMLElement
  text: string
  filePath: string | null
}

let last: LastRender | null = null
let renderSeq = 0

/** Close-file transitions invalidate every pending render and theme callback. */
export function clearPreview(container: HTMLElement) {
  renderSeq++
  last = null
  container.innerHTML = ''
}

export async function renderPreview(scroller: HTMLElement, container: HTMLElement, text: string, filePath: string | null) {
  ensurePipeline()
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

  const ctx: RenderContext = {
    filePath,
    baseDir: filePath ? filePath.slice(0, filePath.lastIndexOf('/')) : null,
    isCurrent: () => seq === renderSeq,
  }
  for (const fn of listPostProcessors()) {
    try { await fn(container, ctx) } catch (err) { console.error('[pipeline] 后处理失败', err) }
    if (seq !== renderSeq) return
  }
  const tm0 = big ? performance.now() : 0

  // custom code-block processors (```lang with a registered handler)
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre > code[class*="language-"]'))
  for (const code of blocks) {
    const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? ''
    const processor = getCodeBlockProcessor(lang)
    if (processor) {
      try { await processor(code.parentElement as HTMLElement, code.textContent ?? '', ctx) }
      catch (err) { console.error('[pipeline] 代码块处理失败', err) }
      if (seq !== renderSeq) return
    }
  }

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
  // render into the content container (#preview) — rendering into the scroller would
  // destroy the container element itself and detach it from the document
  const previous = last
  const seq = renderSeq
  const { scroller, container, text, filePath } = previous
  const scroll = scroller.scrollTop
  const mermaid = await getMermaid()
  if (last !== previous || renderSeq !== seq) return
  mermaid.initialize(mermaidInitOptions())
  await renderPreview(scroller, container, text, filePath)
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
