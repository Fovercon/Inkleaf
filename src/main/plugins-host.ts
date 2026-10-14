/**
 * 插件宿主（主进程侧 · docs/04 §六）：
 * - pluginsRoot：userData/plugins 目录
 * - plugins:list：扫描合法 manifest 返回声明（含 inkplug:// 入口 URL）
 * - 路径穿越防护由协议处理器（index.ts inkplug://）执行
 */
import { app, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
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

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i

async function readManifest(dir: string, name: string): Promise<PluginManifestInfo | null> {
  const manifestPath = path.join(dir, 'ink.plugin.json')
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : ''
    const main = typeof raw.main === 'string' ? raw.main : 'main.mjs'
    const version = typeof raw.version === 'string' ? raw.version : '0.0.0'
    if (!ID_RE.test(id) || !ID_RE.test(name)) return null
    // main 必须位于插件目录内
    const mainAbs = path.resolve(dir, main)
    if (!mainAbs.startsWith(dir + path.sep)) return null
    if (!fsSync.existsSync(mainAbs)) return null
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
}
