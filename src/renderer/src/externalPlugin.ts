import DOMPurify from 'dompurify'

export interface ExternalRegistration {
  type: 'command' | 'post' | 'codeblock'
  token: string
  id?: string
  title?: string
  lang?: string
}

const MAX_HTML = 2 * 1024 * 1024

function safeOriginalStyle(value: string): boolean {
  if (value.length > 4096) return false
  // CSS escapes/comments must not disguise resource loads or executable legacy CSS.
  const normalized = value.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\(?:\r\n|[\r\n\f])/g, '')
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd'
    })
    .replace(/\\([^\r\n\f])/g, '$1').replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase()
  return !/(?:url\(|@import|expression\(|(?:-webkit-)?image-set\(|image\(|cross-fade\(|paint\(|var\(|attr\(|https?:|file:|data:|blob:|mdasset:|\/\/)/.test(normalized)
}

/** Only allow existing document URLs or inert data images in plugin-generated HTML. */
export function sanitizePluginHtml(html: string, original: string): string {
  if (typeof html !== 'string' || html.length > MAX_HTML) throw new Error('插件 HTML 超出限制')
  const before = document.createElement('template')
  before.innerHTML = original
  const sources = new Set([...before.content.querySelectorAll('[src]')].map((el) => el.getAttribute('src')))
  const links = new Set([...before.content.querySelectorAll('[href]')].map((el) => el.getAttribute('href')))
  const styles = new Set([...before.content.querySelectorAll('[style]')]
    .map((el) => el.getAttribute('style') ?? '').filter(safeOriginalStyle))
  const candidate = document.createElement('template')
  candidate.innerHTML = html
  for (const el of candidate.content.querySelectorAll('[style]')) {
    if (!styles.has(el.getAttribute('style') ?? '')) el.removeAttribute('style')
  }
  const clean = document.createElement('template')
  clean.innerHTML = DOMPurify.sanitize(candidate.innerHTML, {
    FORBID_TAGS: ['iframe', 'object', 'embed', 'style', 'link', 'meta', 'base', 'form', 'video', 'audio', 'source', 'track', 'template'],
    FORBID_ATTR: ['srcset', 'ping', 'formaction', 'autofocus', 'contenteditable'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mdasset|mailto|tel):|data:image\/(?:png|jpeg|gif|webp);base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
  for (const el of clean.content.querySelectorAll('[src]')) {
    const src = el.getAttribute('src') ?? ''
    if (!sources.has(src) && !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(src)) el.removeAttribute('src')
  }
  for (const el of clean.content.querySelectorAll('[href]')) {
    const href = el.getAttribute('href') ?? ''
    if (!links.has(href) && !href.startsWith('#')) el.removeAttribute('href')
  }
  return clean.innerHTML
}

export interface PluginSandbox {
  ready: Promise<void>
  invoke: (type: 'command' | 'post' | 'codeblock', token: string, payload?: unknown) => Promise<unknown>
  dispose: () => void
}

/** Opaque origin, no preload, no same-origin permission, and a private per-record port. */
export function createPluginSandbox(
  mainUrl: string,
  permissions: string[],
  register: (registration: ExternalRegistration) => void,
  onFault: (error: Error) => void,
): PluginSandbox {
  const entry = new URL(mainUrl)
  if (entry.protocol !== 'inkplug:' || !entry.host || entry.username || entry.password) throw new Error('插件入口协议非法')
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.referrerPolicy = 'no-referrer'
  iframe.hidden = true
  iframe.src = 'inkplug://sandbox/index.html'
  let port: MessagePort | null = null
  let closed = false
  let serial = 0
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const activationTimer = setTimeout(() => fault(new Error('插件隔离环境激活超时')), 15000)
  function dispose() {
    if (closed) return
    closed = true
    clearTimeout(activationTimer)
    rejectReady(new Error('插件已停用'))
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('插件已停用')) }
    pending.clear()
    if (port) { port.onmessage = null; port.close(); port = null }
    iframe.onload = null
    iframe.onerror = null
    iframe.remove()
  }
  function fault(err: Error) {
    if (closed) return
    rejectReady(err)
    dispose()
    onFault(err)
  }
  iframe.onerror = () => fault(new Error('插件隔离环境加载失败'))
  iframe.onload = () => {
    if (closed || port) return
    const channel = new MessageChannel()
    port = channel.port1
    port.onmessage = (event) => {
      if (closed) return
      const msg = event.data
      if (!msg || typeof msg !== 'object') return
      if (msg.kind === 'register') {
        try {
          if (!Number.isSafeInteger(msg.request) || typeof msg.token !== 'string' || !/^cb-\d{1,5}$/.test(msg.token)) throw new Error('插件注册消息非法')
          if (!['command', 'post', 'codeblock'].includes(msg.type)) throw new Error('未知插件注册类型')
          register({ type: msg.type, token: msg.token, id: msg.id, title: msg.title, lang: msg.lang })
          port?.postMessage({ kind: 'registered', request: msg.request })
        } catch (err) {
          port?.postMessage({ kind: 'registered', request: msg.request, error: String(err) })
          fault(new Error(String(err)))
        }
      } else if (msg.kind === 'activated') {
        if (msg.error) { fault(new Error(String(msg.error))); return }
        clearTimeout(activationTimer)
        resolveReady()
      } else if (msg.kind === 'result' && Number.isSafeInteger(msg.request)) {
        const item = pending.get(msg.request)
        if (!item) return
        pending.delete(msg.request)
        clearTimeout(item.timer)
        if (msg.error) item.reject(new Error(String(msg.error)))
        else item.resolve(msg.value)
      }
    }
    port.start()
    iframe.contentWindow?.postMessage({ kind: 'inkleaf-plugin-init', mainUrl, permissions }, '*', [channel.port2])
  }
  document.body.appendChild(iframe)
  return {
    ready,
    invoke(type, token, payload) {
      if (closed || !port) return Promise.reject(new Error('插件已停用'))
      if (pending.size >= 32) return Promise.reject(new Error('插件请求过多'))
      const request = ++serial
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request)
          const err = new Error('插件响应超时')
          reject(err)
          fault(err)
        }, 5000)
        pending.set(request, { resolve, reject, timer })
        try { port!.postMessage({ kind: 'invoke', request, type, token, payload }) }
        catch (err) { clearTimeout(timer); pending.delete(request); reject(new Error(String(err))) }
      })
    },
    dispose,
  }
}
