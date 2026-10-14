/**
 * Command palette in the style of the Obsidian quick switcher:
 * - files mode (⌘P): fuzzy filename matching, empty query shows recent files
 * - search mode (⇧⌘F): full-text search over the library, results grouped per file
 * Keyboard: ↑/↓ navigate, Enter open, Esc close.
 */

export type PaletteMode = 'files' | 'search'

export interface PaletteOpts {
  listFiles: () => Promise<string[]>
  searchText: (q: string, isRegex?: boolean) => Promise<{ path: string; line: number; text: string }[]>
  recent: () => string[]
  libraryRoot: () => string | null
  onOpenFile: (path: string, line?: number) => void
}

interface FuzzyResult {
  score: number
  indices: number[]
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fuzzyMatch(text: string, query: string): FuzzyResult | null {
  if (!query) return { score: 0, indices: [] }
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let ti = 0
  let score = 0
  let streak = 0
  const indices: number[] = []
  for (let i = 0; i < q.length; i++) {
    const idx = t.indexOf(q[i], ti)
    if (idx === -1) return null
    if (idx === ti && i > 0) {
      score += 6
      streak += 4
    } else {
      streak = 0
    }
    score += streak
    if (idx === 0 || /[\s\-_/.]/.test(t[idx - 1] ?? ' ')) score += 8
    score += Math.max(0, 6 - (idx - ti))
    indices.push(idx)
    ti = idx + 1
  }
  return { score, indices }
}

function highlightName(name: string, indices: number[], offset = 0): string {
  const set = new Set(indices.filter((i) => i >= offset).map((i) => i - offset))
  let html = ''
  for (let i = 0; i < name.length; i++) {
    html += set.has(i) ? `<span class="hl">${escapeHtml(name[i])}</span>` : escapeHtml(name[i])
  }
  return html
}

type Row =
  | { kind: 'file'; path: string; nameHtml: string; dir: string }
  | { kind: 'header'; path: string; name: string; count: number }
  | { kind: 'line'; path: string; line: number; html: string }

export function openPalette(mode: PaletteMode, opts: PaletteOpts) {
  // remove any existing palette
  document.querySelector('.palette-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.className = 'palette-overlay'
  const box = document.createElement('div')
  box.className = 'palette'
  const input = document.createElement('input')
  input.className = 'palette-input'
  input.type = 'text'
  input.placeholder = mode === 'files' ? '输入文件名，模糊匹配…' : '搜索书库全部文档…（/ 开头为正则）'
  const list = document.createElement('div')
  list.className = 'palette-list'
  box.appendChild(input)
  box.appendChild(list)
  overlay.appendChild(box)
  document.body.appendChild(overlay)

  let rows: Row[] = []
  let selectable: Row[] = []
  let active = 0
  let debounceTimer: number | null = null
  let closed = false

  const close = () => {
    closed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    overlay.remove()
  }
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })

  const renderRows = () => {
    list.innerHTML = ''
    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'palette-empty'
      empty.textContent = mode === 'files' ? '没有匹配的文件' : '没有找到匹配内容'
      list.appendChild(empty)
      return
    }
    selectable = rows.filter((r) => r.kind !== 'header')
    if (active >= selectable.length) active = Math.max(0, selectable.length - 1)
    const activeRow = selectable[active]
    for (const r of rows) {
      const el = document.createElement('div')
      if (r.kind === 'file') {
        el.className = 'pal-row' + (r === activeRow ? ' active' : '')
        el.innerHTML =
          `<span class="pal-name">${r.nameHtml}</span>` +
          `<span class="pal-path">${escapeHtml(r.dir)}</span>`
        el.addEventListener('click', () => {
          opts.onOpenFile(r.path)
          close()
        })
      } else if (r.kind === 'header') {
        el.className = 'pal-section'
        el.innerHTML =
          `<span class="pal-file">${escapeHtml(r.name)}</span>` +
          `<span class="pal-count">${r.count} 处</span>`
      } else {
        el.className = 'pal-line' + (r === activeRow ? ' active' : '')
        el.innerHTML = `<span class="pal-lineno">${r.line}</span><span class="pal-text">${r.html}</span>`
        el.addEventListener('click', () => {
          opts.onOpenFile(r.path, r.line)
          close()
        })
      }
      list.appendChild(el)
    }
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }

  const searchFiles = async (q: string) => {
    const files = await opts.listFiles()
    const root = opts.libraryRoot()
    if (closed) return
    if (!q) {
      const rec = opts.recent().slice(0, 8)
      rows = rec.map((p) => {
        const name = p.split('/').pop() ?? p
        const dir = root && p.startsWith(root + '/') ? p.slice(root.length + 1, p.lastIndexOf('/')) : p.slice(0, p.lastIndexOf('/'))
        return { kind: 'file', path: p, nameHtml: highlightName(name, []), dir: dir || '（根目录）' }
      })
      renderRows()
      return
    }
    const scored: { path: string; r: FuzzyResult; name: string }[] = []
    for (const p of files) {
      const name = p.split('/').pop() ?? p
      const r = fuzzyMatch(name, q) ?? fuzzyMatch(p, q)
      if (r) scored.push({ path: p, r, name })
    }
    scored.sort((a, b) => b.r.score - a.r.score || a.path.length - b.path.length)
    rows = scored.slice(0, 30).map(({ path, r, name }) => {
      const dir = root && path.startsWith(root + '/') ? path.slice(root.length + 1, path.lastIndexOf('/')) : path.slice(0, path.lastIndexOf('/'))
      return {
        kind: 'file',
        path,
        nameHtml: highlightName(name, r.indices, 0),
        dir: dir || '（根目录）',
      }
    })
    renderRows()
  }

  const searchText = async (raw: string) => {
    // '/'-prefixed queries switch the palette to regex matching;
    // a trailing '/' (regex-literal habit) is tolerated and stripped
    const isRegex = raw.startsWith('/')
    let q = isRegex ? raw.slice(1) : raw
    if (isRegex && q.length > 1 && q.endsWith('/')) q = q.slice(0, -1)
    const results = await opts.searchText(q, isRegex)
    if (closed) return
    const root = opts.libraryRoot()
    rows = []
    let currentFile = ''
    for (const hit of results) {
      if (hit.path !== currentFile) {
        currentFile = hit.path
        const name = hit.path.split('/').pop() ?? hit.path
        rows.push({ kind: 'header', path: hit.path, name, count: 0 })
      }
      const header = rows[rows.length - 1] as Extract<Row, { kind: 'header' }>
      header.count++
      const esc = escapeHtml(hit.text)
      let marked = esc
      try {
        marked = esc.replace(new RegExp(`(${escapeRegExp(escapeHtml(q))})`, 'gi'), '<mark>$1</mark>')
      } catch {
        /* regex-unsafe query — show plain text */
      }
      rows.push({ kind: 'line', path: hit.path, line: hit.line, html: marked })
    }
    renderRows()
  }

  const run = () => {
    const q = input.value.trim()
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      void (mode === 'files' ? searchFiles(q) : q ? searchText(q) : ((rows = []), renderRows()))
    }, 130)
  }

  input.addEventListener('input', run)
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!selectable.length) return
      if (e.key === 'ArrowDown') active = (active + 1) % selectable.length
      else active = (active - 1 + selectable.length) % selectable.length
      renderRows()
    } else if (e.key === 'Enter') {
      const r = selectable[active]
      if (r && r.kind !== 'header') {
        opts.onOpenFile(r.path, r.kind === 'line' ? r.line : undefined)
        close()
      }
    }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !closed) close()
  }, { once: true })

  // initial content: recent files (files mode) / hint (search mode)
  if (mode === 'files') void searchFiles('')
  else {
    rows = []
    const hint = document.createElement('div')
    hint.className = 'palette-empty'
    hint.textContent = '输入关键词，搜索书库内所有文档内容'
    list.appendChild(hint)
  }
  setTimeout(() => input.focus())
}
