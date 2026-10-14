/**
 * 插件运行时（渲染层 · docs/04）：
 * - window.ink 能力面：commands / pipeline 三级钩子（受权限网关包装）
 * - 生命周期：discovered → registered（声明注入）→ active（懒激活）→ disabled
 * - 故障隔离：单个插件激活失败不影响宿主与其他插件
 * 内置功能（bundled.*）与外部插件走同一 API —— 吃自己的狗粮。
 */
import { registerCommand, unregisterCommand as hostUnregisterCommand, runCommand as hostRunCommand } from './commands'
import {
  registerMarkdownPlugin,
  registerPostProcessor,
  registerCodeBlockProcessor,
  removeMarkdownPlugin,
  removePostProcessor,
  unregisterCodeBlockProcessor,
} from './pipeline'

interface PluginRecord {
  id: string
  manifest: Record<string, unknown>
  mainUrl?: string
  bundled: boolean
  state: 'registered' | 'active' | 'disabled' | 'error'
  message?: string
  deactivators: Array<() => void>
}

const records = new Map<string, PluginRecord>()

/** 插件间共享的去注册器：deactivate 时回收全部贡献 */
class InkApi {
  readonly version = '0.4.0'
  private rec: PluginRecord

  constructor(rec: PluginRecord) {
    this.rec = rec
  }

  private permit(name: string): void {
    const perms = (this.rec.manifest.permissions as string[]) ?? []
    if (!perms.includes(name)) {
      throw new Error(`插件 ${this.rec.id} 未声明权限 "${name}"，调用被网关拒绝`)
    }
  }

  get commands() {
    const rec = this.rec
    return {
      register: (def: { id: string; title: string; run: () => void; when?: () => boolean }) => {
        this.permit('commands')
        registerCommand({
          id: def.id,
          title: def.title,
          run: def.run,
          when: def.when,
        })
        rec.deactivators.push(() => {
          hostUnregisterCommand(def.id)
        })
      },
    }
  }

  get pipeline() {
    const rec = this.rec
    return {
      registerMarkdownPlugin: (fn: (md: unknown) => void) => {
        this.permit('render')
        registerMarkdownPlugin(fn as never)
        rec.deactivators.push(() => unregisterMarkdownPlugin(fn as never))
      },
      registerPostProcessor: (fn: (container: HTMLElement, ctx: unknown) => void | Promise<void>) => {
        this.permit('render')
        registerPostProcessor(fn as never)
        rec.deactivators.push(() => unregisterPostProcessor(fn as never))
      },
      registerCodeBlockProcessor: (lang: string, fn: unknown) => {
        this.permit('render')
        registerCodeBlockProcessor(lang, fn as never)
        rec.deactivators.push(() => {
          unregisterCodeBlockProcessor(lang)
        })
      },
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

// ---------- 注册表反注册支持（commands/pipeline 增补） ----------

function unregisterMarkdownPlugin(fn: (md: unknown) => void): void {
  removeMarkdownPlugin(fn as never)
}

function unregisterPostProcessor(fn: (container: HTMLElement, ctx: unknown) => void | Promise<void>): void {
  removePostProcessor(fn as never)
}

// ---------- 生命周期 ----------

function record(id: string, manifest: Record<string, unknown>, bundled: boolean, mainUrl?: string): PluginRecord {
  const rec: PluginRecord = { id, manifest, bundled, mainUrl, state: 'registered', deactivators: [] }
  records.set(id, rec)
  return rec
}

async function activatePlugin(id: string): Promise<boolean> {
  const rec = records.get(id)
  if (!rec || rec.state === 'active') return rec?.state === 'active'
  if (rec.state === 'disabled') return false
  try {
    if (rec.bundled) {
      const activate = bundledActivators.get(id)
      if (!activate) throw new Error('内置插件缺少激活器')
      await activate(new InkApi(rec))
    } else {
      if (!rec.mainUrl) throw new Error('缺少 mainUrl')
      const mod = (await import(/* @vite-ignore */ rec.mainUrl)) as {
        activate: (ink: InkApi) => Promise<void>
      }
      if (typeof mod.activate !== 'function') throw new Error('main.mjs 缺少 activate 导出')
      await mod.activate(new InkApi(rec))
    }
    rec.state = 'active'
    return true
  } catch (err) {
    rec.state = 'error'
    rec.message = String(err)
    console.error(`[plugin] ${id} 激活失败：`, err)
    return false
  }
}

function deactivatePlugin(id: string): void {
  const rec = records.get(id)
  if (!rec) return
  for (const dispose of rec.deactivators.splice(0)) {
    try {
      dispose()
    } catch {
      /* 回收失败不阻塞其余 */
    }
  }
  rec.state = 'disabled'
}

// ---------- 对外初始化 ----------

const bundledActivators = new Map<string, (ink: InkApi) => Promise<void> | void>()

/** 内置功能以插件形态注册（狗粮） */
export function registerBundledPlugin(
  id: string,
  manifest: Record<string, unknown>,
  activate: (ink: InkApi) => Promise<void> | void,
): void {
  record(id, manifest, true)
  bundledActivators.set(id, activate)
}

/** 发现外部插件（plugins:list）并注册声明 */
export async function discoverExternalPlugins(): Promise<void> {
  const list = await window.mdr.pluginsList().catch(() => [])
  for (const p of list) {
    if (records.has(p.id)) continue
    record(p.id, p.manifest ?? { id: p.id, name: p.name, version: p.version }, false, p.mainUrl)
  }
}

/** 声明注入：manifest contributes.commands 预先进命令注册表（未激活时执行才触发激活） */
function injectDeclarations(rec: PluginRecord): void {
  const contributes = rec.manifest.contributes as { commands?: Array<{ id: string; title: string }> } | undefined
  for (const c of contributes?.commands ?? []) {
    registerCommand({
      id: c.id,
      title: c.title,
      run: () => {
        // 懒激活：首次调用时加载插件再执行其真实 handler（此时通常已激活）
        void activatePlugin(rec.id).then(() => {
          hostRunCommand(c.id)
        })
      },
    })
  }
}

export function initPluginRuntime(): void {
  window.ink = {
    version: '0.4.0',
    activate: activatePlugin,
    disable: (id: string) => deactivatePlugin(id),
    enable: (id: string) => {
      const rec = records.get(id)
      if (rec && rec.state === 'disabled') {
        rec.state = 'registered'
        void activatePlugin(id)
      }
    },
    list: () => [...records.values()].map((r) => ({ id: r.id, state: r.state })),
  }
}

/** 激活所有 bundled 插件并注入外部声明 */
export async function bootPlugins(): Promise<void> {
  initPluginRuntime()
  for (const rec of records.values()) {
    if (rec.bundled) {
      // 内置插件立即激活（构成基线能力）
      await activatePlugin(rec.id)
    } else {
      injectDeclarations(rec)
    }
  }
  await discoverExternalPlugins()
  for (const rec of records.values()) {
    if (!rec.bundled && rec.state === 'registered') injectDeclarations(rec)
  }
}
