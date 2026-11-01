import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import bundledCatalog from '../../resources/plugin-catalog.json'
import { comparePluginVersions, parsePluginVersion, type CatalogEntry, type CatalogState } from '../shared/plugins'

export const CATALOG_URL = 'https://raw.githubusercontent.com/Fovercon/Inkleaf/main/resources/plugin-catalog.json'
const MAX_BYTES = 2 * 1024 * 1024
export interface CatalogPackage extends CatalogEntry { files?: Record<string, string>; hashes?: Record<string, string> }
export interface PluginCatalog { schema: 1; entries: CatalogPackage[] }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
export function validateCatalog(raw: unknown): PluginCatalog {
  if (!record(raw) || raw.schema !== 1 || !Array.isArray(raw.entries) || raw.entries.length > 100) throw Error('插件目录格式无效')
  const ids = new Set<string>()
  for (const entry of raw.entries) {
    if (!record(entry) || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.id) || entry.id === 'sandbox' || ids.has(entry.id)) throw Error('插件目录 ID 无效或重复')
    ids.add(entry.id)
    for (const key of ['name', 'description', 'author', 'category', 'usage']) {
      if (entry[key] !== undefined && (typeof entry[key] !== 'string' || entry[key].length > 12000)) throw Error('插件说明无效')
    }
    if (!entry.name || !parsePluginVersion(entry.version) || (entry.minAppVersion !== undefined && !parsePluginVersion(entry.minAppVersion))) throw Error('插件版本无效')
    if (!Array.isArray(entry.permissions) || entry.permissions.some((p: unknown) => p !== 'commands' && p !== 'render') || new Set(entry.permissions).size !== entry.permissions.length) throw Error('插件权限无效')
    for (const key of ['examples', 'changelog']) {
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || entry[key].length > 64 || entry[key].some((x: unknown) => !record(x) || Object.values(x).some(v => typeof v !== 'string' || v.length > 12000)))) throw Error('插件详情无效')
    }
    if (entry.bundled === true) {
      if (entry.id !== 'bundled.callout' || entry.files || entry.hashes) throw Error('未知的内置插件')
      continue
    }
    if (entry.bundled !== undefined && entry.bundled !== false || entry.id.startsWith('bundled.')) throw Error('非法的内置插件 ID')
    if (!record(entry.files) || !record(entry.hashes)) throw Error('插件缺少文件或校验值')
    const names = Object.keys(entry.files)
    if (!names.includes('ink.plugin.json') || names.length > 32 || names.length !== Object.keys(entry.hashes).length) throw Error('插件文件列表无效')
    for (const name of names) {
      // A small, flat package format avoids archive traversal, symlinks and executable native helpers.
      const content = entry.files[name]
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.(?:json|mjs|js)$/.test(name) || typeof content !== 'string' || Buffer.byteLength(content) > 512 * 1024) throw Error('插件文件名或大小无效')
      if (createHash('sha256').update(content).digest('hex') !== entry.hashes[name]) throw Error('插件文件校验失败')
    }
    const manifest = JSON.parse(entry.files['ink.plugin.json'])
    if (!record(manifest) || manifest.id !== entry.id || manifest.name !== entry.name || manifest.version !== entry.version || JSON.stringify(manifest.permissions) !== JSON.stringify(entry.permissions) || manifest.minAppVersion !== entry.minAppVersion || typeof manifest.main !== 'string' || !/\.(mjs|js)$/.test(manifest.main) || !names.includes(manifest.main)) throw Error('插件声明与目录不一致')
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES) throw Error('插件目录过大')
  return raw as unknown as PluginCatalog
}
export function publicEntries(catalog: PluginCatalog): CatalogEntry[] {
  return catalog.entries.map(({ files: _files, hashes: _hashes, ...entry }) => entry)
}
/** Only a fixed HTTPS origin is used; payloads stay in the main process. */
export class PluginCatalogService {
  private catalog = validateCatalog(bundledCatalog)
  private source: CatalogState['source'] = 'bundled'
  private checkedAt?: string
  private warning?: string
  private initialization?: Promise<void>
  private pending?: Promise<CatalogState>
  constructor(private profile: string, private fetcher: typeof fetch = fetch) {}
  private get cache() { return path.join(this.profile, 'plugin-catalog-cache.json') }
  async get(): Promise<CatalogState> {
    this.initialization ??= this.loadCache()
    await this.initialization
    return { entries: publicEntries(this.catalog), source: this.source, checkedAt: this.checkedAt, warning: this.warning }
  }
  private async loadCache(): Promise<void> {
    try {
      const stat = await fs.stat(this.cache)
      if (stat.size <= MAX_BYTES) {
        const cached = JSON.parse(await fs.readFile(this.cache, 'utf8'))
        this.catalog = validateCatalog(this.merge(validateCatalog(cached))); this.source = 'cache'
        this.checkedAt = stat.mtime.toISOString()
      }
    } catch { /* An absent or invalid cache cannot block the shipped directory. */ }
  }
  private merge(incoming: PluginCatalog): PluginCatalog {
    const byId = new Map(this.catalog.entries.map(e => [e.id, e]))
    for (const entry of incoming.entries) {
      const old = byId.get(entry.id)
      if (!old || (comparePluginVersions(entry.version, old.version) ?? -1) >= 0) byId.set(entry.id, entry)
    }
    return { schema: 1, entries: [...byId.values()] }
  }
  async check(): Promise<CatalogState> {
    if (this.pending) return this.pending
    const pending = this.refresh(); this.pending = pending
    try { return await pending } finally { this.pending = undefined }
  }
  private async refresh(): Promise<CatalogState> {
    await this.get()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const response = await this.fetcher(CATALOG_URL, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } })
      if (!response.ok || !response.body) throw Error(`目录请求失败（HTTP ${response.status}）`)
      const parts: Uint8Array[] = []; let size = 0
      for await (const chunk of response.body as any) {
        size += chunk.byteLength
        if (size > MAX_BYTES) { controller.abort(); throw Error('插件目录过大') }
        parts.push(chunk)
      }
      const next = validateCatalog(this.merge(validateCatalog(JSON.parse(Buffer.concat(parts).toString('utf8')))))
      const temporary = this.cache + '.tmp'
      await fs.mkdir(this.profile, { recursive: true })
      try { await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await fs.rename(temporary, this.cache) }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
      this.catalog = next; this.source = 'online'; this.checkedAt = new Date().toISOString(); this.warning = undefined
    } catch (err) {
      this.warning = `未能获取在线目录，继续使用${this.source === 'bundled' ? '随软件附带的' : '上次保存的'}目录。${err instanceof Error ? err.message : String(err)}`
    } finally { clearTimeout(timer) }
    return this.get()
  }
  async package(id: unknown, version: unknown): Promise<CatalogPackage> {
    await this.get()
    const entry = this.catalog.entries.find(e => e.id === id && e.version === version)
    if (!entry || entry.bundled || !entry.files) throw Error('找不到此版本的可安装插件，请刷新目录')
    return entry
  }
}
