/**
 * 主进程插件宿主：扫描插件声明并提供受限的入口协议。
 * - pluginsRoot：userData/plugins 目录
 * - plugins:list：扫描合法 manifest 返回声明（含 inkplug:// 入口 URL）
 * - plugins:reveal / install / uninstall：插件中心的目录操作
 * - 路径穿越与符号链接防护由 inkplug:// 协议处理器执行
 */
import { app, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CH } from '../shared/ipc'

export interface PluginManifestInfo {
  id: string
  name: string
  version: string
  manifest: Record<string, unknown>
  mainUrl: string
}

export const pluginsRoot = () => path.join(app.getPath('userData'), 'plugins')

// Standard URL hosts are case-insensitive; require canonical lowercase folder names.
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/

const PERMISSIONS = new Set(['commands', 'render'])

async function confinedFile(dir: string, file: string): Promise<string | null> {
  const candidate = path.resolve(dir, file)
  if (!candidate.startsWith(dir + path.sep)) return null
  const realDir = await fs.realpath(dir)
  const real = await fs.realpath(candidate)
  if (!real.startsWith(realDir + path.sep) || !(await fs.stat(real)).isFile()) return null
  return real
}

/** Protocol routes use the same decoded, per-plugin realpath boundary as discovery. */
export async function resolvePluginFile(requestUrl: string): Promise<string | null> {
  try {
    const url = new URL(requestUrl)
    const name = decodeURIComponent(url.host)
    if (url.protocol !== 'inkplug:' || url.username || url.password || url.search || url.hash || !ID_RE.test(name) || name === 'sandbox') return null
    const relative = decodeURIComponent(url.pathname).slice(1)
    if (!relative || relative.includes('\0') || relative.includes('\\') || !/\.(?:mjs|js|json)$/i.test(relative)) return null
    const root = await fs.realpath(pluginsRoot())
    const dir = path.join(root, name)
    if (await fs.realpath(dir) !== dir || !(await fs.lstat(dir)).isDirectory()) return null
    return await confinedFile(dir, relative)
  } catch { return null }
}

async function readManifest(dir: string, name: string): Promise<PluginManifestInfo | null> {
  try {
    const manifestPath = await confinedFile(dir, 'ink.plugin.json')
    if (!manifestPath || (await fs.stat(manifestPath)).size > 128 * 1024) return null
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : ''
    const main = typeof raw.main === 'string' ? raw.main : 'main.mjs'
    const version = typeof raw.version === 'string' ? raw.version : ''
    if (!ID_RE.test(id) || !ID_RE.test(name) || id.startsWith('bundled.') || id === 'sandbox' || name === 'sandbox') return null
    if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(version)) return null
    if (!Array.isArray(raw.permissions) || raw.permissions.some((p) => typeof p !== 'string' || !PERMISSIONS.has(p))) return null
    const contributes = raw.contributes as { commands?: unknown } | undefined
    if (contributes?.commands !== undefined) {
      if (!Array.isArray(contributes.commands) || contributes.commands.length > 128 || !raw.permissions.includes('commands')) return null
      const ids = new Set<string>()
      for (const c of contributes.commands) {
        if (!c || typeof c.id !== 'string' || !c.id.startsWith(id + '.') || c.id.length > 256 || !/^[a-z0-9._-]+$/i.test(c.id) || ids.has(c.id)) return null
        if (typeof c.title !== 'string' || !c.title || c.title.length > 200) return null
        ids.add(c.id)
      }
    }
    // main 必须位于插件目录内
    if (!/\.(?:mjs|js)$/i.test(main) || main.includes('\\') || main.includes('\0') || !await confinedFile(dir, main)) return null
    return {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      version,
      manifest: raw,
      mainUrl: `inkplug://${encodeURIComponent(name)}/${main.split('/').map(encodeURIComponent).join('/')}`,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return null
  }
}

export async function listPlugins(): Promise<PluginManifestInfo[]> {
  const root = pluginsRoot()
  try {
    const dirs = await fs.readdir(root, { withFileTypes: true })
    const out: PluginManifestInfo[] = []
    for (const d of dirs) {
      if (!d.isDirectory() || !ID_RE.test(d.name)) continue
      const info = await readManifest(path.join(root, d.name), d.name)
      if (info) out.push(info)
    }
    const ids = new Set<string>()
    for (const p of out) {
      if (ids.has(p.id)) throw new Error(`插件 ID 重复：${p.id}，请在插件文件夹中移除重复目录`)
      ids.add(p.id)
    }
    return out
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

// Serialize filesystem mutations, including requests from more than one window.
let mutation: Promise<unknown> = Promise.resolve()
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const pending = mutation.then(operation)
  mutation = pending.catch(() => {})
  return pending
}
function failure(err: unknown) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err }
}
async function installDirectory(selected: string) {
  const source = await fs.realpath(selected)
  await fs.mkdir(pluginsRoot(), { recursive: true })
  const root = await fs.realpath(pluginsRoot())
  if (source === root || source.startsWith(root + path.sep) || root.startsWith(source + path.sep)) {
    throw new Error('请选择下载的插件文件夹，不能选择插件安装目录或其上级目录')
  }
  const info = await readManifest(source, 'candidate')
  if (!info) throw new Error('ink.plugin.json 缺失或不符合插件规范，或找不到有效的插件入口')
  const target = path.join(root, info.id)
  if (await exists(target) || (await listPlugins()).some(p => p.id === info.id)) throw new Error(`插件已安装：${info.id}，请先卸载旧版本`)
  // Staging is hidden from discovery; a failed copy never leaves a half-installed plugin.
  const staging = await fs.mkdtemp(path.join(root, '.install-'))
  try {
    const payload = path.join(staging, 'payload')
    await fs.cp(source, payload, {
      recursive: true, force: false, errorOnExist: true,
      filter: async (file) => {
        const stat = await fs.lstat(file)
        if (!stat.isDirectory() && !stat.isFile()) throw new Error('插件文件夹不能包含符号链接或特殊文件')
        return true
      },
    })
    const copied = await readManifest(payload, info.id)
    if (!copied || copied.id !== info.id) throw new Error('插件文件在复制期间发生变化，请重新安装')
    if (await exists(target)) throw new Error(`插件目录已存在：${info.id}`)
    await fs.rename(payload, target)
    return { ok: true, id: info.id }
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}

export function registerPluginIpc() {
  ipcMain.handle(CH.pluginsList, () => listPlugins())
  ipcMain.handle(CH.pluginsReveal, async () => {
    const root = pluginsRoot()
    await fs.mkdir(root, { recursive: true })
    const error = await shell.openPath(root)
    if (error) throw new Error(error)
  })
  ipcMain.handle(CH.pluginsInstall, () => mutate(async () => {
    try {
      const picked = await dialog.showOpenDialog({ title: '选择插件文件夹（需包含 ink.plugin.json）', properties: ['openDirectory'] })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
      return await installDirectory(picked.filePaths[0])
    } catch (err) { return failure(err) }
  }))
  ipcMain.handle(CH.pluginsUninstall, (_event, id: unknown) => mutate(async () => {
    try {
      if (typeof id !== 'string' || !ID_RE.test(id) || id.startsWith('bundled.') || id === 'sandbox') throw new Error('非法的插件 ID')
      const info = (await listPlugins()).find(p => p.id === id)
      if (!info) throw new Error('插件目录不存在或插件声明无效，请打开插件文件夹检查')
      // Legacy installations may have a folder name different from their manifest ID.
      const name = new URL(info.mainUrl).host
      const root = await fs.realpath(pluginsRoot())
      const target = path.join(root, name)
      if (!ID_RE.test(name) || !(await fs.lstat(target)).isDirectory() || await fs.realpath(target) !== target) throw new Error('非法的卸载路径')
      await shell.trashItem(target)
      return { ok: true }
    } catch (err) { return failure(err) }
  }))
}
