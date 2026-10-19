import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import matter from 'gray-matter'

export interface IndexLink { target: string; line: number }
export interface DocIndexEntry {
  path: string; title: string; mtime: number; size: number; sha256: string
  tags: string[]; links: IndexLink[]; frontmatter: Record<string, unknown>
}
export interface TagCount { tag: string; count: number }
export interface Backlink { path: string; line: number }

const extension = /\.(md|markdown|mdx)$/i
const basename = (p: string) => path.basename(p).replace(extension, '')
const wikilink = /\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
// Inline tags must start with a letter and must not be markdown link targets,
// so issue references (#1720) and heading anchors (#1-设计) stay out of the index.
const bodyTag = /(?<!\])(?:^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gu
const indexFormat = 3
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const within = (root: string, p: string) => path.resolve(p).startsWith(path.resolve(root) + path.sep)

/** Documents are data: only YAML and JSON frontmatter are accepted. */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const text = raw.replace(/^\uFEFF/, '')
  const header = /^---([^\r\n]*)\r?\n/.exec(text)
  if (!header || !['', 'yaml', 'yml', 'json'].includes(header[1].trim().toLowerCase())) return { data: {}, content: raw }
  try {
    const parsed = matter(text, {
      // gray-matter has an eval-based default engine. Disable it as well as
      // checking the header, so future parser changes cannot enable execution.
      engines: { javascript: () => { throw new Error('Executable frontmatter is disabled') } },
    })
    const value = parsed.data
    const data = value && typeof value === 'object' && !Array.isArray(value)
      ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {}
    return { data, content: parsed.content }
  } catch { return { data: {}, content: raw } }
}

function parseDoc(p: string, raw: string, mtime: number, size: number): DocIndexEntry {
  const { data, content } = parseFrontmatter(raw), tags = new Set<string>()
  if (typeof data.tags === 'string') data.tags.split(/[，,\s]+/).filter(Boolean).forEach(t => tags.add(t))
  else if (Array.isArray(data.tags)) data.tags.forEach(t => { if (typeof t === 'string' && t.trim()) tags.add(t.trim()) })
  for (const match of content.matchAll(bodyTag)) tags.add(match[1])
  const links: IndexLink[] = []
  const offset = raw === content ? 0 : raw.slice(0, raw.length - content.length).split('\n').length - 1
  content.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(wikilink)) links.push({ target: match[1].trim(), line: offset + i + 1 })
  })
  return { path: p, title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || basename(p), mtime, size,
    sha256: hash(raw), tags: [...tags], links, frontmatter: data }
}

/** A library generation cancels old scans; file revisions cancel stale reads. */
export class DocumentIndex {
  private entries = new Map<string, DocIndexEntry>()
  private root: string | null = null
  private rootReal: Promise<string> = Promise.resolve('')
  private generation = 0
  private revisions = new Map<string, number>()
  private files = new Set<string>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private writes: Promise<void> = Promise.resolve()
  constructor(private cacheFile: string) {}

  private begin(root: string): number {
    this.clear()
    this.root = path.resolve(root)
    this.rootReal = fs.realpath(this.root).catch(() => '')
    return this.generation
  }

  clear(): void {
    this.generation++
    this.entries.clear(); this.revisions.clear(); this.files.clear()
    this.root = null
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
  }

  private async readDocument(p: string): Promise<{ raw: string; mtime: number; size: number } | null> {
    const root = this.root, rootReal = this.rootReal
    if (!root || !within(root, p) || !extension.test(p)) return null
    try {
      const [realRoot, realFile] = await Promise.all([rootReal, fs.realpath(p)])
      if (!realRoot || !within(realRoot, realFile)) return null
      const raw = await fs.readFile(p, 'utf8'), info = await fs.stat(p)
      return info.isFile() ? { raw, mtime: info.mtimeMs, size: info.size } : null
    } catch { return null }
  }

  async build(root: string, files: string[]): Promise<void> {
    const generation = this.begin(root)
    this.files = new Set(files.filter(p => within(root, p) && extension.test(p)))
    for (const p of this.files) {
      const revision = this.revisions.get(p) ?? 0, doc = await this.readDocument(p)
      if (generation !== this.generation) return
      if ((this.revisions.get(p) ?? 0) !== revision) continue
      if (doc) this.entries.set(p, parseDoc(p, doc.raw, doc.mtime, doc.size))
    }
    this.persistSoon()
  }

  async update(p: string): Promise<void> {
    if (!this.root || !within(this.root, p) || !extension.test(p)) return
    const generation = this.generation, revision = (this.revisions.get(p) ?? 0) + 1
    this.revisions.set(p, revision); this.files.add(p)
    const doc = await this.readDocument(p)
    if (generation !== this.generation || this.revisions.get(p) !== revision) return
    if (doc) this.entries.set(p, parseDoc(p, doc.raw, doc.mtime, doc.size))
    else this.entries.delete(p)
    this.persistSoon()
  }

  remove(p: string): void {
    if (!this.root || (!within(this.root, p) && path.resolve(p) !== this.root)) return
    for (const file of new Set([...this.files, ...this.entries.keys()])) {
      if (file === p || within(p, file)) {
        this.revisions.set(file, (this.revisions.get(file) ?? 0) + 1)
        this.entries.delete(file); this.files.delete(file)
      }
    }
    this.persistSoon()
  }

  /** Validate the complete file set and contents, including changes while closed. */
  async load(root: string, files: string[]): Promise<boolean> {
    const generation = this.begin(root)
    this.files = new Set(files.filter(p => within(root, p) && extension.test(p)))
    try {
      const cached = JSON.parse(await fs.readFile(this.cacheFile, 'utf8')) as {
        version?: number; root?: string; entries?: DocIndexEntry[]
      }
      if (generation !== this.generation || cached.version !== indexFormat || cached.root !== this.root || !Array.isArray(cached.entries)) return false
      const loaded = new Map<string, DocIndexEntry>()
      for (const entry of cached.entries) {
        if (!entry || typeof entry.path !== 'string' || !this.files.has(entry.path) || loaded.has(entry.path)
          || typeof entry.title !== 'string' || !Array.isArray(entry.tags) || entry.tags.some(t => typeof t !== 'string')
          || !Array.isArray(entry.links) || entry.links.some(l => !l || typeof l.target !== 'string' || !Number.isInteger(l.line))) return false
        const doc = await this.readDocument(entry.path)
        if (generation !== this.generation) return false
        if (!doc || entry.sha256 !== hash(doc.raw)) return false
        loaded.set(entry.path, { ...entry, mtime: doc.mtime, size: doc.size })
      }
      if (loaded.size !== this.files.size || this.revisions.size || generation !== this.generation) return false
      this.entries = loaded
      return true
    } catch { return false }
  }

  private persistSoon(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => { this.persistTimer = null; void this.flush() }, 800)
  }

  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    const generation = this.generation
    this.writes = this.writes.then(async () => {
      if (generation !== this.generation || !this.root) return
      const payload = JSON.stringify({ version: indexFormat, root: this.root, entries: [...this.entries.values()] })
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true })
      await fs.writeFile(`${this.cacheFile}.tmp`, payload, { mode: 0o600 })
      await fs.rename(`${this.cacheFile}.tmp`, this.cacheFile)
    }).catch(() => {})
    await this.writes
  }

  resolve(name: string): string | null {
    const requested = name.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(extension, '')
    if (!requested) return null
    if (requested.includes('/')) {
      // Qualified links must match the directory too, even for duplicate basenames.
      for (const entry of this.entries.values()) {
        const relative = path.relative(this.root!, entry.path).split(path.sep).join('/').replace(extension, '')
        if (relative === requested) return entry.path
      }
      return null
    }
    for (const entry of this.entries.values()) if (basename(entry.path) === requested) return entry.path
    for (const entry of this.entries.values()) if (entry.title === requested) return entry.path
    return null
  }

  tags(): TagCount[] {
    const counts = new Map<string, number>()
    for (const entry of this.entries.values()) for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'))
  }

  backlinks(name: string): Backlink[] {
    const target = this.resolve(name)
    if (!target) return []
    const out: Backlink[] = []
    for (const entry of this.entries.values()) for (const link of entry.links) {
      if (this.resolve(link.target) === target) out.push({ path: entry.path, line: link.line })
    }
    return out
  }

  names(): { name: string; path: string }[] {
    const out: { name: string; path: string }[] = [], seen = new Set<string>()
    for (const entry of this.entries.values()) for (const name of [basename(entry.path), entry.title]) {
      if (name && !seen.has(name)) { seen.add(name); out.push({ name, path: entry.path }) }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }

  filesByTag(tag: string): string[] {
    return [...this.entries.values()].filter(entry => entry.tags.includes(tag)).map(entry => entry.path).sort()
  }

  async peek(p: string, maxChars = 240): Promise<{ title: string; excerpt: string } | null> {
    const generation = this.generation, doc = await this.readDocument(p)
    if (!doc || generation !== this.generation) return null
    const { content } = parseFrontmatter(doc.raw)
    const excerpt = content.split('\n').filter(l => l.trim() && !/^#{1,6}\s/.test(l.trim())).join(' ')
      .replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[[^\]]*\]\]/g, m => m.replace(/[\[\]|]/g, ' ').trim())
      .replace(/[*_`>#|-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, Math.max(0, Math.min(4000, maxChars)))
    return { title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || basename(p), excerpt }
  }
}
