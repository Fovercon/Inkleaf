import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { HistoryList, HistoryVersion } from '../shared/knowledge'

export const contentHash = (value: string) => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const markdown = (file: string) => /\.(md|markdown|mdx)$/i.test(file)
interface RecordFile { version: 1; path: string; entries: HistoryVersion[] }

export async function atomicText(file: string, text: string, mode = 0o600): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try { await fs.writeFile(temporary, text, { mode, flag: 'wx' }); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}

/** All owned document mutations share a per-path queue, including snapshot + compare + rename. */
export class DocumentHistory {
  private writes = new Map<string, Promise<unknown>>()
  constructor(readonly directory: string) {}
  private key(file: string) { return path.resolve(file) }
  private recordPath(file: string) { return path.join(this.directory, contentHash(this.key(file)) + '.json') }
  private async serial<T>(file: string, work: () => Promise<T>): Promise<T> {
    const key = this.key(file)
    const pending = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    this.writes.set(key, pending)
    try { return await pending } finally { if (this.writes.get(key) === pending) this.writes.delete(key) }
  }
  async limit(): Promise<number> {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, 'settings'), 'utf8')).limit
      if (!Number.isInteger(value) || value < 2 || value > 10000) throw new Error('历史设置无效')
      return value
    } catch (error) { if (missing(error)) return 100; throw new Error('无法读取历史设置，请检查历史存储目录') }
  }
  async setLimit(limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 2 || limit > 10000) throw new Error('历史保留数量须为 2 至 10000 的整数')
    await fs.mkdir(this.directory, { recursive: true })
    await this.serial(path.join(this.directory, 'settings'), () => atomicText(path.join(this.directory, 'settings'), JSON.stringify({ limit })))
  }
  private async read(file: string): Promise<RecordFile> {
    try {
      const record = JSON.parse(await fs.readFile(this.recordPath(file), 'utf8')) as RecordFile
      if (record.version !== 1 || record.path !== this.key(file) || !Array.isArray(record.entries) || record.entries.some(e =>
        !e || typeof e.content !== 'string' || e.id !== contentHash(e.content) || typeof e.at !== 'string' || typeof e.reason !== 'string')) throw new Error('Invalid history')
      return record
    } catch (error) { if (missing(error)) return { version: 1, path: this.key(file), entries: [] }; throw new Error('历史记录无法读取，已停止修改以保护原文') }
  }
  private async captureContent(file: string, content: string, reason: string): Promise<void> {
    const record = await this.read(file), limit = await this.limit(), id = contentHash(content)
    if (record.entries[0]?.id === id && record.entries.length <= limit) return
    const entry: HistoryVersion = { id, content, at: new Date().toISOString(), reason, bytes: Buffer.byteLength(content) }
    record.entries = [entry, ...record.entries.filter(e => e.id !== id)].slice(0, limit)
    await fs.mkdir(this.directory, { recursive: true })
    await atomicText(this.recordPath(file), JSON.stringify(record))
  }
  async capture(file: string, reason = '手动快照'): Promise<void> {
    await this.serial(file, async () => this.captureContent(file, await fs.readFile(file, 'utf8'), reason))
  }
  async list(file: string): Promise<HistoryList> {
    return this.serial(file, async () => {
      const current = await fs.readFile(file, 'utf8')
      await this.captureContent(file, current, '浏览历史时记录')
      const record = await this.read(file)
      return { current, limit: await this.limit(), entries: record.entries.map(({ content: _content, ...meta }) => meta) }
    })
  }
  async version(file: string, id: string): Promise<HistoryVersion> {
    const entry = (await this.read(file)).entries.find(e => e.id === id)
    if (!entry) throw new Error('该历史版本不存在或已超过保留数量')
    return entry
  }
  async write(file: string, content: string, expected?: string, reason = '保存前'): Promise<void> {
    if (typeof content !== 'string') throw new Error('文档内容必须是文本')
    await this.serial(file, () => this.writeUnlocked(file, content, expected, reason))
  }
  private async writeUnlocked(file: string, content: string, expected: string | undefined, reason: string): Promise<void> {
    let before: string | undefined, mode = 0o600
    try { before = await fs.readFile(file, 'utf8'); mode = (await fs.stat(file)).mode & 0o777 }
    catch (error) { if (!missing(error)) throw error }
    if (expected !== undefined && before !== expected) throw new Error('文件已发生变化，请刷新预览后重试')
    if (before === content) return
    if (before !== undefined && markdown(file)) await this.captureContent(file, before, reason)
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, content, { mode, flag: 'wx' })
      const latest = await fs.readFile(file, 'utf8').catch(error => { if (missing(error)) return undefined; throw error })
      if (latest !== before) throw new Error('文件在保存期间发生变化，已保留外部版本，请重新打开核对')
      await fs.rename(temporary, file)
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
  async restore(file: string, id: string, expected: string): Promise<string> {
    if (typeof expected !== 'string') throw new Error('恢复前必须检查当前版本')
    return this.serial(file, async () => {
      const entry = await this.version(file, id)
      await this.writeUnlocked(file, entry.content, expected, '恢复前')
      return entry.content
    })
  }
  async relocate(oldPath: string, newPath: string): Promise<void> {
    const names = await fs.readdir(this.directory).catch(error => { if (missing(error)) return []; throw error })
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const source = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')) as RecordFile
      if (source.path !== oldPath && !source.path.startsWith(oldPath + path.sep)) continue
      const target = newPath + source.path.slice(oldPath.length)
      const existing = await this.read(target)
      const combined = [...source.entries, ...existing.entries].sort((a, b) => b.at.localeCompare(a.at))
      const unique = [...new Map(combined.map(e => [e.id, e])).values()].slice(0, await this.limit())
      await atomicText(this.recordPath(target), JSON.stringify({ version: 1, path: this.key(target), entries: unique }))
      // Keep the old identity too, so a later move failure never strands its history.
    }
  }
}
