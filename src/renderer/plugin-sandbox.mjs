// This module runs only inside an opaque sandboxed iframe, never in the host realm.
let initialized = false
window.addEventListener('message', async (event) => {
  if (initialized || event.source !== parent || event.data?.kind !== 'inkleaf-plugin-init' || event.ports.length !== 1) return
  initialized = true
  const port = event.ports[0]
  const mainUrl = event.data.mainUrl
  const permissions = Array.isArray(event.data.permissions) ? event.data.permissions : []
  const callbacks = new Map()
  const registrations = []
  const pending = new Map()
  let serial = 0
  let module
  function permit(permission) {
    if (!permissions.includes(permission)) throw new Error(`插件未声明权限 ${permission}`)
  }
  function register(type, fn, fields = {}) {
    permit(type === 'command' ? 'commands' : 'render')
    if (typeof fn !== 'function') throw new Error('插件 callback 必须是函数')
    if (callbacks.size >= 128) throw new Error('插件注册项过多')
    const request = ++serial
    const token = `cb-${request}`
    callbacks.set(token, { type, fn })
    const promise = new Promise((resolve, reject) => pending.set(request, { resolve, reject }))
    // The host accepts or rejects each contribution before activation completes.
    registrations.push(promise)
    port.postMessage({ kind: 'register', request, token, type, ...fields })
  }
  const ink = Object.freeze({
    version: '0.4.0',
    commands: Object.freeze({ register(def) {
      if (def.when !== undefined) throw new Error('隔离插件不支持同步 when 函数')
      register('command', def.run, { id: def.id, title: def.title })
    } }),
    pipeline: Object.freeze({
      registerMarkdownPlugin() { throw new Error('隔离插件不能直接访问宿主 MarkdownIt；请使用 postProcessor 或 codeBlockProcessor') },
      registerPostProcessor(fn) { register('post', fn) },
      registerCodeBlockProcessor(lang, fn) { register('codeblock', fn, { lang }) },
    }),
  })
  port.onmessage = async ({ data: msg }) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.kind === 'registered') {
      const item = pending.get(msg.request)
      if (!item) return
      pending.delete(msg.request)
      if (msg.error) item.reject(new Error(msg.error))
      else item.resolve()
      return
    }
    if (msg.kind !== 'invoke') return
    try {
      const callback = callbacks.get(msg.token)
      if (!callback || callback.type !== msg.type) throw new Error('未知插件 callback')
      let value = null
      if (msg.type === 'command') await callback.fn()
      else {
        const { html, context, source } = msg.payload ?? {}
        if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) throw new Error('渲染输入非法')
        const holder = document.createElement('div')
        holder.innerHTML = html
        if (msg.type === 'post') await callback.fn(holder, context)
        else {
          const pre = holder.firstElementChild
          if (!pre || pre.tagName !== 'PRE' || typeof source !== 'string') throw new Error('代码块输入非法')
          await callback.fn(pre, source, context)
        }
        value = holder.innerHTML
        if (value.length > 2 * 1024 * 1024) throw new Error('渲染输出超出限制')
      }
      port.postMessage({ kind: 'result', request: msg.request, value })
    } catch (err) {
      port.postMessage({ kind: 'result', request: msg.request, error: String(err) })
    }
  }
  port.start()
  try {
    const url = new URL(mainUrl)
    if (url.protocol !== 'inkplug:' || url.host === 'sandbox') throw new Error('插件入口非法')
    module = await import(mainUrl)
    if (typeof module.activate !== 'function') throw new Error('插件缺少 activate 导出')
    await module.activate(ink)
    await Promise.all(registrations)
    port.postMessage({ kind: 'activated' })
  } catch (err) {
    try { await module?.deactivate?.() } catch { /* isolated cleanup */ }
    port.postMessage({ kind: 'activated', error: String(err) })
  }
})
