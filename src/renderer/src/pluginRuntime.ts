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
const PREFERENCES_KEY = 'inkleaf:plugin-preferences:v1'
function readPreferences(): Map<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map()
    return new Map(Object.entries(value).filter((entry): entry is [string, boolean] =>
      /^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry[0]) && typeof entry[1] === 'boolean'))
  } catch { return new Map() }
}
let preferences = readPreferences()
function remember(id: string, enabled?: boolean) {
  const next = new Map(preferences)
  if (enabled === undefined) next.delete(id)
  else next.set(id, enabled)
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(Object.fromEntries(next))) }
  catch { throw new Error('无法保存插件设置，请检查磁盘空间后重试') }
  preferences = next
}

export interface PluginSnapshot {
  id: string
  name: string
  version: string
  description: string
  state: PluginRecord['state']
  bundled: boolean
  permissions: string[]
  commands: { id: string; title: string }[]
  message?: string
}
const stateListeners = new Set<() => void>()
function notify() { for (const cb of stateListeners) { try { cb() } catch { /* listener detached */ } } }
/** UI reads a plain copy; mutations still go through the lifecycle API. */
export function pluginSnapshot(): PluginSnapshot[] {
  return [...records.values()].map((rec) => ({
    id: rec.id,
    name: typeof rec.manifest.name === 'string' ? rec.manifest.name : rec.id,
    version: typeof rec.manifest.version === 'string' ? rec.manifest.version : '',
    description: typeof rec.manifest.description === 'string' ? rec.manifest.description : '',
    state: rec.state,
    bundled: rec.bundled,
    permissions: Array.isArray(rec.manifest.permissions) ? rec.manifest.permissions.map(String) : [],
    commands: ((rec.manifest.contributes as { commands?: Array<{ id: string; title: string }> } | undefined)?.commands ?? []).map((c) => ({ id: c.id, title: c.title })),
    message: rec.message,
  }))
}
export function onPluginStateChange(cb: () => void): () => void {
  stateListeners.add(cb)
  return () => stateListeners.delete(cb)
}

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
  notify()
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
      enable: (id: string) => Promise<boolean>
      list: () => { id: string; state: string }[]
    }
  }
}
function record(id: string, manifest: Record<string, unknown>, bundled: boolean, mainUrl?: string): PluginRecord {
  if (records.has(id)) throw new Error(`插件 ID 已注册：${id}`)
  const rec: PluginRecord = { id, manifest, bundled, mainUrl, state: preferences.get(id) === false ? 'disabled' : 'registered', epoch: 0, deactivators: [], declarations: new Map() }
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
  rec.message = undefined
  const epoch = ++rec.epoch
  const activation = Promise.resolve().then(async () => {
    if (!live(rec, epoch)) return false
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
      notify()
      return true
    } catch (err) {
      if (live(rec, epoch)) fail(rec, err)
      return false
    }
  })
  rec.activation = activation
  notify()
  try { return await activation }
  finally { if (rec.activation === activation) rec.activation = undefined }
}
function deactivatePlugin(id: string) {
  const rec = records.get(id)
  if (!rec) return
  rec.epoch++
  rec.state = 'disabled'
  rec.message = undefined
  rec.activation = undefined
  cleanup(rec)
  notify()
}
export function registerBundledPlugin(id: string, manifest: Record<string, unknown>, activate: (ink: InkApi) => Promise<void> | void) {
  record(id, manifest, true)
  bundledActivators.set(id, activate)
}
let discovery: Promise<void> | undefined
export async function discoverExternalPlugins(): Promise<void> {
  if (discovery) return discovery
  const pending = discover()
  discovery = pending
  try { await pending } finally { if (discovery === pending) discovery = undefined }
}
async function discover() {
  // A failed scan must not be mistaken for an empty plugin directory.
  const list = await window.mdr.pluginsList()
  if (new Set(list.map(p => p.id)).size !== list.length) throw new Error('发现重复的插件 ID，请检查插件文件夹')
  const present = new Set(list.map((plugin) => plugin.id))
  for (const [id, rec] of records) {
    if (!rec.bundled && !present.has(id)) {
      deactivatePlugin(id)
      records.delete(id)
    }
  }
  const restart: string[] = []
  for (const p of list) {
    if (p.id.startsWith('bundled.')) continue
    const old = records.get(p.id)
    if (old) {
      if (!old.bundled && (old.mainUrl !== p.mainUrl || JSON.stringify(old.manifest) !== JSON.stringify(p.manifest))) {
        const disabled = old.state === 'disabled'
        const running = old.state === 'active' || old.state === 'activating'
        deactivatePlugin(p.id)
        old.manifest = p.manifest ?? {}
        old.mainUrl = p.mainUrl
        old.state = disabled ? 'disabled' : 'registered'
        if (running) restart.push(p.id)
      }
      continue
    }
    record(p.id, p.manifest ?? {}, false, p.mainUrl)
  }
  for (const rec of records.values()) {
    if (!rec.bundled) { try { injectDeclarations(rec) } catch (err) { fail(rec, err) } }
  }
  notify()
  for (const id of restart) await activatePlugin(id)
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
    version: '0.4.0', activate: activatePlugin,
    disable(id) {
      if (!records.has(id)) return
      remember(id, false)
      deactivatePlugin(id)
    },
    async enable(id) {
      const rec = records.get(id)
      if (!rec) return false
      remember(id, true)
      if (rec.state === 'disabled' || rec.state === 'error') {
        rec.state = 'registered'
        rec.activation = undefined
      }
      try { if (!rec.bundled) injectDeclarations(rec) } catch (err) { fail(rec, err); return false }
      return activatePlugin(id)
    },
    list: () => [...records.values()].map(({ id, state }) => ({ id, state })),
  }
}
/** Reload is temporary; it must not overwrite the user's enable/disable choice. */
export async function reloadPlugin(id: string): Promise<boolean> {
  const previousEpoch = records.get(id)?.epoch
  await discoverExternalPlugins()
  const rec = records.get(id)
  if (!rec || rec.bundled) throw new Error('找不到可重新加载的外部插件')
  // Discovery already replaces a running instance when its manifest changes.
  if (rec.epoch !== previousEpoch && (rec.state === 'active' || rec.state === 'error')) return rec.state === 'active'
  const disabled = rec.state === 'disabled'
  deactivatePlugin(id)
  if (disabled) return true
  rec.state = 'registered'
  try { injectDeclarations(rec) } catch (err) { fail(rec, err); return false }
  return activatePlugin(id)
}
/** Leave the running instance intact if moving the installed folder to trash fails. */
export async function uninstallPlugin(id: string): Promise<void> {
  const rec = records.get(id)
  if (!rec || rec.bundled) throw new Error('找不到可卸载的外部插件')
  const result = await window.mdr.pluginsUninstall(id)
  if (!result.ok) throw new Error(result.error ?? '卸载失败')
  deactivatePlugin(id)
  records.delete(id)
  notify()
  try { remember(id) } catch { throw new Error('插件已卸载，但未能清除启停设置，请检查磁盘空间') }
}
export async function bootPlugins() {
  initPluginRuntime()
  try { await discoverExternalPlugins() } catch (err) { console.error('[plugin] 扫描失败', err) }
  for (const rec of records.values()) {
    if (rec.state === 'registered' && (rec.bundled || preferences.get(rec.id) === true)) await activatePlugin(rec.id)
  }
}
