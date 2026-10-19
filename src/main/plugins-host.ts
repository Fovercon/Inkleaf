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
    if (!ID_RE.test(id) || !ID_RE.test(name) || id.startsWith('bundled.') || name === 'sandbox') return null
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
  } catch {
    return null
  }
}

export async function listPlugins(): Promise<PluginManifestInfo[]> {
  const root = pluginsRoot()
  try {
    const dirs = await fs.readdir(root, { withFileTypes: true })
    const out: PluginManifestInfo[] = []
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const info = await readManifest(path.join(root, d.name), d.name)
      if (info) out.push(info)
    }
    return out
  } catch {
    return []
  }
}

export function registerPluginIpc() {
  ipcMain.handle(CH.pluginsList, () => listPlugins())
  ipcMain.handle(CH.pluginsReveal, async () => {
    const root = pluginsRoot()
    await fs.mkdir(root, { recursive: true })
    await shell.openPath(root)
  })
  ipcMain.handle(CH.pluginsInstall, async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择插件文件夹（需包含 ink.plugin.json）',
      properties: ['openDirectory'],
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: '已取消' }
    const source = picked.filePaths[0]
    const name = path.basename(source)
    if (!ID_RE.test(name) || name === 'sandbox') return { ok: false, error: '文件夹名需为小写字母、数字、点、横线（且不为 sandbox）' }
    // the same manifest rules as discovery apply before anything is copied
    if (!await readManifest(source, name)) return { ok: false, error: 'ink.plugin.json 缺失或不符合插件规范' }
    const root = pluginsRoot()
    const target = path.resolve(root, name)
    if (!target.startsWith(root + path.sep)) return { ok: false, error: '非法的安装路径' }
    try {
      await fs.access(target)
      return { ok: false, error: `插件目录已存在：${name}` }
    } catch { /* not installed yet */ }
    await fs.mkdir(root, { recursive: true })
    await fs.cp(source, target, { recursive: true })
    return { ok: true, id: name }
  })
  ipcMain.handle(CH.pluginsUninstall, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !ID_RE.test(id) || id.startsWith('bundled.') || id === 'sandbox') {
      return { ok: false, error: '非法的插件 ID' }
    }
    const root = pluginsRoot()
    const target = path.resolve(root, id)
    if (!target.startsWith(root + path.sep)) return { ok: false, error: '非法的卸载路径' }
    try {
      if ((await fs.lstat(target)).isDirectory() === false) return { ok: false, error: '插件目录不存在' }
    } catch { return { ok: false, error: '插件目录不存在' } }
    await shell.trashItem(target)
    return { ok: true }
  })
}
