/**
 * 文档索引服务（docs/02 P0-2 · 知识管理功能的底座）。
 * 维护书库全量结构化索引：标题 / 标签（frontmatter + 正文）/ 双链出链 / frontmatter。
 * - 全量构建：lib:open 后异步扫描（不阻塞文件树返回）
 * - 增量更新：挂接现有 chokidar 事件，按文件粒度重扫
 * - 持久化：userData/index.json（换库重建，进程内即查即用）
 */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import matter from 'gray-matter'

export interface IndexLink {
  target: string
  line: number
}

export interface DocIndexEntry {
  path: string
  title: string
  mtime: number
  tags: string[]
  links: IndexLink[]
  frontmatter: Record<string, unknown>
}

export interface TagCount {
  tag: string
  count: number
}

export interface Backlink {
  path: string
  line: number
}

const entries = new Map<string, DocIndexEntry>()
let indexedRoot: string | null = null
let persistTimer: NodeJS.Timeout | null = null

const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const BODY_TAG_RE = /(?:^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu

const indexPath = () => path.join(app.getPath('userData'), 'index.json')
const baseName = (p: string) => path.basename(p).replace(/\.(md|markdown|mdx)$/i, '')

function parseDoc(p: string, raw: string): DocIndexEntry {
  let data: Record<string, unknown> = {}
  let content = raw
  try {
    const parsed = matter(raw)
    data = (parsed.data ?? {}) as Record<string, unknown>
    content = parsed.content
  } catch {
    /* malformed frontmatter — index the raw content */
  }

  const tags = new Set<string>()
  const fmTags = data.tags
  if (typeof fmTags === 'string') {
    fmTags.split(/[，,\s]+/).filter(Boolean).forEach((t) => tags.add(t))
  } else if (Array.isArray(fmTags)) {
    fmTags.forEach((t) => {
      if (typeof t === 'string' && t.trim()) tags.add(t.trim())
    })
  }
  for (const m of content.matchAll(BODY_TAG_RE)) tags.add(m[1])

  const links: IndexLink[] = []
  content.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(WIKILINK_RE)) links.push({ target: m[1].trim(), line: i + 1 })
  })

  const h1 = /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
  return {
    path: p,
    title: h1 || baseName(p),
    mtime: Date.now(),
    tags: [...tags],
    links,
    frontmatter: data,
  }
}

function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const payload = JSON.stringify({ root: indexedRoot, entries: [...entries.values()] })
    fs.mkdir(path.dirname(indexPath()), { recursive: true })
      .then(() => fs.writeFile(indexPath(), payload, 'utf8'))
      .catch(() => {})
  }, 800)
}

export async function buildIndex(root: string, files: string[]): Promise<void> {
  if (indexedRoot === root && entries.size) return // already indexed in this session
  entries.clear()
  indexedRoot = root
  for (const f of files) {
    try {
      entries.set(f, parseDoc(f, await fs.readFile(f, 'utf8')))
    } catch {
      /* unreadable — skip */
    }
  }
  persistSoon()
}

export function clearIndex(): void {
  entries.clear()
  indexedRoot = null
}

export async function indexFile(p: string): Promise<void> {
  if (!/\.(md|markdown|mdx)$/i.test(p)) return
  try {
    entries.set(p, parseDoc(p, await fs.readFile(p, 'utf8')))
  } catch {
    entries.delete(p)
  }
  persistSoon()
}

export function unindexPath(p: string): void {
  entries.delete(p)
  for (const key of entries.keys()) {
    if (key.startsWith(p + '/')) entries.delete(key)
  }
  persistSoon()
}

/** 名称（标题或文件名，可带相对路径）→ 文档绝对路径；歧义时按索引顺序取首个 */
export function resolveName(name: string): string | null {
  const n = name.trim()
  if (!n) return null
  let byTitle: string | null = null
  for (const e of entries.values()) {
    const base = baseName(e.path)
    if (base === n || n.endsWith('/' + base) || e.path.endsWith(n.replace(/^\//, '') + '.md')) {
      return e.path
    }
    if (e.title === n && !byTitle) byTitle = e.path
  }
  return byTitle
}

export function queryTags(): TagCount[] {
  const counts = new Map<string, number>()
  for (const e of entries.values()) {
    for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'))
}

export function queryBacklinks(name: string): Backlink[] {
  const target = resolveName(name)
  if (!target) return []
  const out: Backlink[] = []
  for (const e of entries.values()) {
    for (const l of e.links) {
      if (resolveName(l.target) === target) out.push({ path: e.path, line: l.line })
    }
  }
  return out
}

/** 启动时加载上次索引（换库会重建，仅为加速同库重启） */
export async function loadPersistedIndex(root: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await fs.readFile(indexPath(), 'utf8')) as {
      root: string
      entries: DocIndexEntry[]
    }
    if (raw.root !== root) return false
    entries.clear()
    for (const e of raw.entries) {
      if (fsSync.existsSync(e.path)) entries.set(e.path, e)
    }
    indexedRoot = root
    return entries.size > 0
  } catch {
    return false
  }
}

/** 全部文档名（basename 与 title 双出口），供 [[ 补全 */
export function listNames(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = []
  const seen = new Set<string>()
  for (const e of entries.values()) {
    const base = baseName(e.path)
    if (base && !seen.has(base)) {
      seen.add(base)
      out.push({ name: base, path: e.path })
    }
    if (e.title && e.title !== base && !seen.has(e.title)) {
      seen.add(e.title)
      out.push({ name: e.title, path: e.path })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/** 标签 → 文档路径列表 */
export function queryFilesByTag(tag: string): string[] {
  const out: string[] = []
  for (const e of entries.values()) {
    if (e.tags.includes(tag)) out.push(e.path)
  }
  return out.sort()
}

/** 悬停预览：标题 + 摘要（粗剥 Markdown 语法的正文前若干行） */
export async function peekDoc(p: string, maxChars = 240): Promise<{ title: string; excerpt: string } | null> {
  let raw: string
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
  let content = raw
  try {
    content = matter(raw).content
  } catch {
    /* keep raw */
  }
  const lines = content.split('\n').filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()))
  const excerpt = lines
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[[^\]]*\]\]/g, (m) => m.replace(/[\[\]|]/g, ' ').trim())
    .replace(/[*_`>#|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
  const h1 = /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
  return { title: h1 || baseName(p), excerpt }
}
