/** Bundled code is trusted; external plugins run in opaque sandboxed iframes. */
import { registerCommand, unregisterCommand, getCommand, type CommandDef } from './commands'
import {
  registerMarkdownPlugin, registerPostProcessor, registerCodeBlockProcessor,
  removeMarkdownPlugin, removePostProcessor, unregisterCodeBlockProcessor,
  type RenderContext,
} from './pipeline'
import { createPluginSandbox, sanitizePluginHtml, type PluginSandbox, type ExternalRegistration } from './externalPlugin'

interface PluginRecord {
  id: string
  manifest: Record<string, unknown>
  mainUrl?: string
  bundled: boolean
  state: 'registered' | 'activating' | 'active' | 'disabled' | 'error'
  message?: string
  epoch: number
  activation?: Promise<boolean>
  sandbox?: PluginSandbox
  declarations: Map<string, CommandDef>
  deactivators: Array<() => void>
}
const records = new Map<string, PluginRecord>()
const bundledActivators = new Map<string, (ink: InkApi) => Promise<void> | void>()

function live(rec: PluginRecord, epoch: number) {
  return rec.epoch === epoch && (rec.state === 'activating' || rec.state === 'active')
}
function permit(rec: PluginRecord, permission: string, epoch: number) {
  if (!live(rec, epoch)) throw new Error('插件已停用')
  const permissions = rec.manifest.permissions
  if (!Array.isArray(permissions) || !permissions.includes(permission)) throw new Error(`插件 ${rec.id} 未声明权限 ${permission}`)
}
function cleanup(rec: PluginRecord) {
  rec.sandbox?.dispose()
  rec.sandbox = undefined
  for (const dispose of rec.deactivators.splice(0).reverse()) {
    try { dispose() } catch (err) { console.error('[plugin] 清理失败', err) }
  }
  for (const [id, def] of rec.declarations) unregisterCommand(id, def)
  rec.declarations.clear()
}
function fail(rec: PluginRecord, err: unknown) {
  rec.epoch++
  rec.state = 'error'
  rec.message = String(err)
  cleanup(rec)
  console.error(`[plugin] ${rec.id} 失败`, err)
}
function commandId(rec: PluginRecord, id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length > 256 || !id.startsWith(rec.id + '.') || !/^[a-z0-9._-]+$/i.test(id)) throw new Error('插件命令必须以插件 ID 加点号为前缀')
}
function addCommand(rec: PluginRecord, epoch: number, def: CommandDef) {
  permit(rec, 'commands', epoch)
  commandId(rec, def.id)
  if (typeof def.title !== 'string' || !def.title || def.title.length > 200 || typeof def.run !== 'function') throw new Error('插件命令定义非法')
  const declared = rec.declarations.get(def.id)
  if (declared) { unregisterCommand(def.id, declared); rec.declarations.delete(def.id) }
  const owned: CommandDef = { ...def, run: async () => {
    if (!live(rec, epoch) || rec.state !== 'active') return
    try { await def.run() } catch (err) { if (live(rec, epoch)) fail(rec, err) }
  } }
  registerCommand(owned)
  rec.deactivators.push(() => unregisterCommand(def.id, owned))
}
function addPost(rec: PluginRecord, epoch: number, fn: (container: HTMLElement, ctx: RenderContext) => void | Promise<void>, external = false) {
  permit(rec, 'render', epoch)
  const owned = async (container: HTMLElement, ctx: RenderContext) => {
    if (!live(rec, epoch)) return
    try { await fn(container, ctx) } catch (err) { if (live(rec, epoch)) fail(rec, err) }
  }
  registerPostProcessor(owned, external)
  rec.deactivators.push(() => removePostProcessor(owned))
}
function addCode(rec: PluginRecord, epoch: number, lang: string, fn: (pre: HTMLElement, source: string, ctx: RenderContext) => void | Promise<void>) {
  permit(rec, 'render', epoch)
  if (typeof lang !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(lang)) throw new Error('代码块语言非法')
  const owned = async (pre: HTMLElement, source: string, ctx: RenderContext) => {
    if (!live(rec, epoch)) return
    try { await fn(pre, source, ctx) } catch (err) { if (live(rec, epoch)) fail(rec, err) }
  }
  registerCodeBlockProcessor(lang, owned)
  rec.deactivators.push(() => unregisterCodeBlockProcessor(lang, owned))
}
/** Available only to trusted bundled code; methods bind the activation token. */
class InkApi {
  readonly version = '0.4.0'
  constructor(private rec: PluginRecord, private epoch: number) {}
  get commands() { return { register: (def: CommandDef) => addCommand(this.rec, this.epoch, def) } }
  get pipeline() {
    const rec = this.rec, epoch = this.epoch
    return {
      registerMarkdownPlugin: (fn: (md: unknown) => void) => {
        permit(rec, 'render', epoch)
        const owned = (md: unknown) => {
          if (!live(rec, epoch)) return
          try { fn(md) } catch (err) { if (live(rec, epoch)) fail(rec, err) }
        }
        registerMarkdownPlugin(owned)
        rec.deactivators.push(() => removeMarkdownPlugin(owned))
      },
      registerPostProcessor: (fn: (container: HTMLElement, ctx: RenderContext) => void | Promise<void>) => addPost(rec, epoch, fn),
      registerCodeBlockProcessor: (lang: string, fn: (pre: HTMLElement, source: string, ctx: RenderContext) => void | Promise<void>) => addCode(rec, epoch, lang, fn),
    }
  }
}
declare global {
  interface Window {
    ink?: {
      version: string
      activate: (id: string) => Promise<boolean>
      disable: (id: string) => void
      enable: (id: string) => void
      list: () => { id: string; state: string }[]
    }
  }
}
function record(id: string, manifest: Record<string, unknown>, bundled: boolean, mainUrl?: string): PluginRecord {
  if (records.has(id)) throw new Error(`插件 ID 已注册：${id}`)
  const rec: PluginRecord = { id, manifest, bundled, mainUrl, state: 'registered', epoch: 0, deactivators: [], declarations: new Map() }
  records.set(id, rec)
  return rec
}
function externalRegistration(rec: PluginRecord, epoch: number, registration: ExternalRegistration) {
  if (rec.deactivators.length >= 128) throw new Error('插件注册项过多')
  const sandbox = rec.sandbox
  if (!sandbox || !live(rec, epoch)) throw new Error('插件已停用')
  const context = (ctx: RenderContext) => ({ filePath: ctx.filePath, baseDir: ctx.baseDir })
  if (registration.type === 'command') {
    addCommand(rec, epoch, { id: registration.id!, title: registration.title!, run: async () => { await sandbox.invoke('command', registration.token) } })
  } else if (registration.type === 'post') {
    addPost(rec, epoch, async (container, ctx) => {
      const before = container.innerHTML
      if (before.length > 2 * 1024 * 1024) throw new Error('插件渲染输入超出限制')
      const html = await sandbox.invoke('post', registration.token, { html: before, context: context(ctx) })
      if (!live(rec, epoch) || ctx.isCurrent?.() === false) return
      if (html !== before) container.innerHTML = sanitizePluginHtml(html as string, before)
    }, true)
  } else if (registration.type === 'codeblock') {
    addCode(rec, epoch, registration.lang!, async (pre, source, ctx) => {
      const before = pre.outerHTML
      const html = await sandbox.invoke('codeblock', registration.token, { html: before, source, context: context(ctx) })
      if (!live(rec, epoch) || ctx.isCurrent?.() === false) return
      const replacement = document.createElement('template')
      replacement.innerHTML = sanitizePluginHtml(html as string, before)
      pre.replaceWith(replacement.content)
    })
  }
}
async function activatePlugin(id: string): Promise<boolean> {
  const rec = records.get(id)
  if (!rec || rec.state === 'disabled') return false
  if (rec.state === 'active') return true
  if (rec.activation) return rec.activation
  rec.state = 'activating'
  const epoch = ++rec.epoch
  const activation = (async () => {
    try {
      if (rec.bundled) {
        const activate = bundledActivators.get(id)
        if (!activate) throw new Error('内置插件缺少激活器')
        await activate(new InkApi(rec, epoch))
      } else {
        if (!rec.mainUrl) throw new Error('缺少插件入口')
        rec.sandbox = createPluginSandbox(rec.mainUrl, Array.isArray(rec.manifest.permissions) ? rec.manifest.permissions : [],
          (registration) => externalRegistration(rec, epoch, registration),
          (err) => { if (live(rec, epoch)) fail(rec, err) })
        await rec.sandbox.ready
        if (rec.declarations.size) throw new Error('插件未注册所有声明命令')
      }
      if (!live(rec, epoch)) return false
      rec.state = 'active'
      return true
    } catch (err) {
      if (live(rec, epoch)) fail(rec, err)
      return false
    }
  })()
  rec.activation = activation
  try { return await activation }
  finally { if (rec.activation === activation) rec.activation = undefined }
}
function deactivatePlugin(id: string) {
  const rec = records.get(id)
  if (!rec) return
  rec.epoch++
  rec.state = 'disabled'
  rec.activation = undefined
  cleanup(rec)
}
export function registerBundledPlugin(id: string, manifest: Record<string, unknown>, activate: (ink: InkApi) => Promise<void> | void) {
  record(id, manifest, true)
  bundledActivators.set(id, activate)
}
export async function discoverExternalPlugins() {
  const list = await window.mdr.pluginsList().catch(() => null)
  if (!list) return
  const present = new Set(list.map((plugin) => plugin.id))
  for (const [id, rec] of records) {
    if (!rec.bundled && !present.has(id)) {
      deactivatePlugin(id)
      records.delete(id)
    }
  }
  for (const p of list) {
    if (p.id.startsWith('bundled.')) continue
    const old = records.get(p.id)
    if (old) {
      if (!old.bundled && (old.mainUrl !== p.mainUrl || JSON.stringify(old.manifest) !== JSON.stringify(p.manifest))) {
        const disabled = old.state === 'disabled'
        deactivatePlugin(p.id)
        old.manifest = p.manifest ?? {}
        old.mainUrl = p.mainUrl
        old.state = disabled ? 'disabled' : 'registered'
      }
      continue
    }
    record(p.id, p.manifest ?? {}, false, p.mainUrl)
  }
}
function injectDeclarations(rec: PluginRecord) {
  if (rec.state !== 'registered') return
  const contributes = rec.manifest.contributes as { commands?: Array<{ id: string; title: string }> } | undefined
  for (const c of contributes?.commands ?? []) {
    commandId(rec, c.id)
    if (rec.declarations.has(c.id)) continue
    if (!Array.isArray(rec.manifest.permissions) || !rec.manifest.permissions.includes('commands')) throw new Error('插件声明命令缺少 commands 权限')
    const stub: CommandDef = { id: c.id, title: c.title, run: async () => {
      if (!await activatePlugin(rec.id)) return
      const real = getCommand(c.id)
      if (rec.state === 'active' && real && real !== stub) await real.run()
    } }
    registerCommand(stub)
    rec.declarations.set(c.id, stub)
  }
}
export function initPluginRuntime() {
  window.ink = {
    version: '0.4.0', activate: activatePlugin, disable: deactivatePlugin,
    enable(id) {
      const rec = records.get(id)
      if (rec?.state === 'disabled') {
        rec.state = 'registered'
        try { if (!rec.bundled) injectDeclarations(rec) } catch (err) { fail(rec, err); return }
        void activatePlugin(id)
      }
    },
    list: () => [...records.values()].map(({ id, state }) => ({ id, state })),
  }
}
export async function bootPlugins() {
  initPluginRuntime()
  await discoverExternalPlugins()
  for (const rec of records.values()) {
    if (rec.bundled) await activatePlugin(rec.id)
    else { try { injectDeclarations(rec) } catch (err) { fail(rec, err) } }
  }
}
