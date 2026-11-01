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
import { randomUUID } from 'node:crypto'
import { PluginCatalogService } from './plugin-catalog'
import { comparePluginVersions, type PluginResult } from '../shared/plugins'
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

let catalog: PluginCatalogService | undefined
const catalogService = () => catalog ??= new PluginCatalogService(app.getPath('userData'))

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
    if (raw.minAppVersion !== undefined && (typeof raw.minAppVersion !== 'string' || comparePluginVersions(app.getVersion(), raw.minAppVersion) === null || comparePluginVersions(app.getVersion(), raw.minAppVersion)! < 0)) return null
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
  await recoverUpdates()
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

/** Recover a crash between moving the previous version and committing its replacement. */
let recovered: Promise<void> | undefined
function recoverUpdates(): Promise<void> {
  if (recovered) return recovered
  const pending = (async () => {
    const root = pluginsRoot()
    let names: string[]
    try { names = await fs.readdir(root) } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err }
    for (const name of names.filter(n => /^\.upgrade-[a-f0-9-]{36}$/.test(n))) {
      const stage = path.join(root, name)
      if ((await fs.lstat(stage)).isSymbolicLink()) continue
      try {
        if (!await exists(path.join(stage, 'transaction.json')) && !await exists(path.join(stage, 'previous'))) { await fs.rm(stage, { recursive: true, force: true }); continue }
        const journal = JSON.parse(await fs.readFile(path.join(stage, 'transaction.json'), 'utf8'))
        if (!ID_RE.test(journal.target) || journal.target === 'sandbox' || journal.target.startsWith('bundled.')) continue
        const target = path.join(root, journal.target), previous = path.join(stage, 'previous')
        if (await exists(previous) && !await exists(target)) await fs.rename(previous, target)
        // A committed replacement must still be valid before discarding the backup.
        if (await exists(previous) && !await readManifest(target, journal.target)) throw Error('新版插件无效，旧版备份保留在 ' + stage)
        await fs.rm(stage, { recursive: true, force: true })
      } catch (err) { throw Error('插件升级恢复失败：' + String(err)) }
    }
  })()
  recovered = pending
  void pending.catch(() => { if (recovered === pending) recovered = undefined })
  return pending
}
async function confirmPackage(info: PluginManifestInfo, old?: PluginManifestInfo): Promise<boolean> {
  const permissions = (info.manifest.permissions as string[]).map(p => p === 'render' ? '处理文档预览' : '提供命令').join('、') || '无需额外权限'
  const added = (info.manifest.permissions as string[]).filter(p => !(old?.manifest.permissions as string[] | undefined)?.includes(p))
  const result = await dialog.showMessageBox({ type: 'question', title: old ? '更新插件' : '安装插件',
    message: `${old ? '更新' : '安装'}「${info.name}」？`,
    detail: `${info.id}\n版本：${old ? old.version + ' → ' : ''}${info.version}\n权限：${permissions}${old && added.length ? '\n本次新增权限：' + added.join('、') : ''}\n${old ? '更新后保留原来的启停选择。' : '安装后需手动启用。'}`,
    buttons: ['取消', old ? '更新' : '安装'], defaultId: 0, cancelId: 0 })
  return result.response === 1
}
async function replaceFromDirectory(selected: string, updatingId?: string): Promise<PluginResult> {
  const source = await fs.realpath(selected)
  await fs.mkdir(pluginsRoot(), { recursive: true })
  const root = await fs.realpath(pluginsRoot())
  if (source === root || source.startsWith(root + path.sep) || root.startsWith(source + path.sep)) throw Error('不能从插件安装目录或其上级目录导入')
  const candidate = await readManifest(source, 'candidate')
  if (!candidate) throw Error('插件声明、入口或兼容版本无效')
  const installed = await listPlugins()
  const old = installed.find(p => p.id === (updatingId ?? candidate.id))
  if (updatingId && (!old || candidate.id !== updatingId)) throw Error('所选文件夹与待更新插件的 ID 不一致')
  if (!updatingId && old) throw Error('插件已安装，请从详情页选择更新')
  if (old && comparePluginVersions(candidate.version, old.version) !== 1) throw Error('只能更新到更高的正式版本')
  const targetName = old ? new URL(old.mainUrl).host : candidate.id
  const target = path.join(root, targetName)
  const stage = path.join(root, '.upgrade-' + randomUUID())
  const payload = path.join(stage, 'payload'), previous = path.join(stage, 'previous')
  await fs.mkdir(stage)
  try {
    await fs.writeFile(path.join(stage, 'transaction.json'), JSON.stringify({ target: targetName }))
    await fs.cp(source, payload, { recursive: true, force: false, errorOnExist: true, filter: async file => {
      const stat = await fs.lstat(file)
      if (!stat.isDirectory() && !stat.isFile()) throw Error('插件不能包含符号链接或特殊文件')
      return true
    } })
    const copied = await readManifest(payload, 'candidate')
    if (!copied || JSON.stringify(copied.manifest) !== JSON.stringify(candidate.manifest)) throw Error('复制期间插件声明发生变化')
    if (!await confirmPackage(copied, old)) return { ok: false, canceled: true }
    if (old) await fs.rename(target, previous)
    else if (await exists(target)) throw Error('插件目标目录已存在')
    try { await fs.rename(payload, target) }
    catch (err) { if (old) await fs.rename(previous, target); throw err }
    return { ok: true, id: candidate.id }
  } finally {
    // If rollback itself failed, preserve the journal and previous files for next launch.
    if (!await exists(previous) || await exists(target)) await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

export function registerPluginIpc() {
  ipcMain.handle(CH.pluginsList, () => listPlugins())
  ipcMain.handle(CH.pluginsCatalog, () => catalogService().get())
  ipcMain.handle(CH.pluginsCheckUpdates, () => catalogService().check())
  ipcMain.handle(CH.pluginsUpdateLocal, (_event, id: unknown) => mutate(async () => {
    try {
      if (typeof id !== 'string' || !ID_RE.test(id) || id.startsWith('bundled.')) throw Error('非法的插件 ID')
      const picked = await dialog.showOpenDialog({ title: '选择新版插件文件夹', properties: ['openDirectory'] })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
      return await replaceFromDirectory(picked.filePaths[0], id)
    } catch (err) { return failure(err) }
  }))
  ipcMain.handle(CH.pluginsInstallCatalog, (_event, id: unknown, version: unknown) => mutate(async () => {
    let temporary: string | undefined
    try {
      const entry = await catalogService().package(id, version)
      await fs.mkdir(app.getPath('userData'), { recursive: true })
      temporary = await fs.mkdtemp(path.join(app.getPath('userData'), '.plugin-package-'))
      for (const [name, content] of Object.entries(entry.files!)) await fs.writeFile(path.join(temporary, name), content, { mode: 0o600 })
      const old = (await listPlugins()).find(p => p.id === entry.id)
      return await replaceFromDirectory(temporary, old?.id)
    } catch (err) { return failure(err) }
    finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}) }
  }))
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
