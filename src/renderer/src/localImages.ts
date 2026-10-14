import type MarkdownIt from 'markdown-it'
import imageRule from 'markdown-it/lib/rules_inline/image.mjs'
import type { ImageResolution } from '../../shared/ipc'
import type { RenderContext } from './pipeline'

export type ImageSourceKind = 'remote' | 'inline' | 'local' | 'invalid'
export type ImageFailureKind = NonNullable<ImageResolution['error']> | 'decode' | 'network'

/** Filesystem paths are deliberately neither decoded nor joined in the renderer. */
export function classifyImageSource(source: string): ImageSourceKind {
  const value = source.trim()
  if (!value || value.includes('\0')) return 'invalid'
  if (/^https?:\/\//i.test(value)) return 'remote'
  if (/^(?:data:|blob:)/i.test(value)) return 'inline'
  if (/^(?:file:|mdasset:)/i.test(value)) return 'local'
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return 'invalid'
  return 'local'
}

const reasons: Record<ImageFailureKind, string> = {
  'not-found': '找不到图片文件，请检查路径及大小写',
  forbidden: '图片不在允许访问的目录内',
  unreadable: '无法读取图片文件',
  invalid: '图片地址或格式不受支持',
  decode: '图片无法显示，内容可能损坏或格式不受支持',
  network: '图片加载失败，请检查网络或地址',
}

export function describeImageFailure(source: string, result?: ImageResolution, afterLoadFailure = false) {
  const kind = classifyImageSource(source)
  const error: ImageFailureKind = afterLoadFailure && kind === 'remote' ? 'network'
    : afterLoadFailure && kind === 'inline' ? 'decode'
      : result?.error ?? (afterLoadFailure ? 'decode' : 'invalid')
  return {
    error,
    reason: kind !== 'remote' && kind !== 'inline' && result?.error && result.message
      ? result.message : reasons[error],
    path: result?.path || source || '（未提供图片地址）',
  }
}

/** Permit image-only URLs; normal Markdown link validation remains untouched. */
export function localImageMarkdownPlugin(md: MarkdownIt) {
  md.inline.ruler.at('image', (state, silent) => {
    const validate = state.md.validateLink
    state.md.validateLink = (url) => /^(?:file:|mdasset:|blob:|data:image\/)/i.test(url) || validate.call(state.md, url)
    try { return imageRule(state, silent) }
    finally { state.md.validateLink = validate }
  })
}

let imageSerial = 0

/** Keep original URLs in a private render snapshot, never in plugin-writable attributes. */
export function prepareImageMarkup(html: string): { html: string; sources: ReadonlyMap<string, string> } {
  const sources = new Map<string, string>()
  if (!/<img\b/i.test(html)) return { html, sources }
  const template = document.createElement('template')
  template.innerHTML = html
  for (const img of template.content.querySelectorAll('img')) {
    const source = img.getAttribute('src') ?? ''
    const id = `native-image-${++imageSerial}`
    sources.set(id, source)
    img.dataset.inkleafImageId = id
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    img.removeAttribute('srcset')
    const kind = classifyImageSource(source)
    if (kind === 'local' || kind === 'invalid') img.removeAttribute('src')
  }
  return { html: template.innerHTML, sources }
}

/** Each image resolves independently; a slow or invalid image cannot block other hooks. */
export function bindPreviewImages(container: HTMLElement, ctx: RenderContext, sources: ReadonlyMap<string, string>) {
  for (const img of container.querySelectorAll('img')) {
    const source = sources.get(img.dataset.inkleafImageId ?? '') ?? img.getAttribute('src') ?? ''
    img.removeAttribute('data-inkleaf-image-id')
    bindImage(img, source, container, ctx)
  }
}

function bindImage(img: HTMLImageElement, source: string, container: HTMLElement, ctx: RenderContext) {
  const kind = classifyImageSource(source)
  const current = () => ctx.isCurrent?.() !== false && container.contains(img)
  let applied = false, diagnosing = false
  img.loading = 'lazy'
  img.referrerPolicy = 'no-referrer'

  function showFailure(result?: ImageResolution, afterLoadFailure = false) {
    if (!current()) return
    const detail = describeImageFailure(source, result, afterLoadFailure)
    const alt = img.getAttribute('alt') ?? ''
    const placeholder = document.createElement('span')
    placeholder.className = 'image-error'
    placeholder.dataset.imageError = detail.error
    placeholder.setAttribute('role', 'img')
    placeholder.setAttribute('aria-label', `${alt || '图片'}：${detail.reason}`)
    if (img.dataset.sourceLine) placeholder.dataset.sourceLine = img.dataset.sourceLine
    const label = document.createElement('span')
    label.className = 'image-error-alt'
    label.textContent = alt || '图片加载失败'
    const reason = document.createElement('span')
    reason.className = 'image-error-reason'
    reason.textContent = detail.reason
    const path = document.createElement('span')
    path.className = 'image-error-path'
    path.textContent = detail.path
    placeholder.append(label, reason, path)
    img.replaceWith(placeholder)
  }

  async function resolve(): Promise<ImageResolution> {
    try { return await window.mdr.resolveImage(source, ctx.filePath ?? '') }
    catch { return { error: 'unreadable', message: '图片解析失败，请重新打开文档' } }
  }

  async function diagnose() {
    if (!current() || !applied || diagnosing) return
    diagnosing = true
    img.dataset.imageStatus = 'diagnosing'
    // A browser error carries no HTTP status. Ask the authority again for local diagnostics.
    const result = await resolve()
    if (current()) showFailure(result, true)
  }

  img.addEventListener('load', () => { if (current()) img.dataset.imageStatus = 'loaded' })
  img.addEventListener('error', () => { void diagnose() })

  if (kind === 'remote' || kind === 'inline') {
    applied = true
    img.dataset.imageStatus = 'loading'
    if (img.getAttribute('src') !== source) img.setAttribute('src', source)
    if (img.complete) {
      if (img.naturalWidth > 0) img.dataset.imageStatus = 'loaded'
      else void diagnose()
    }
    return
  }

  img.dataset.imageStatus = 'resolving'
  void (async () => {
    const result = await resolve()
    if (!current()) return
    if (result.error || !result.url || !/^mdasset:\/\//i.test(result.url)) { showFailure(result); return }
    if (result.path) img.dataset.imagePath = result.path
    applied = true
    img.dataset.imageStatus = 'loading'
    img.src = result.url
    if (img.complete) {
      if (img.naturalWidth > 0) img.dataset.imageStatus = 'loaded'
      else void diagnose()
    }
  })()
}
