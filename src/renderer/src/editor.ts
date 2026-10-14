import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { indentMore, indentLess } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'

const AUTOSAVE_DELAY = 2000

// ---------- markdown formatting commands (Typora-style shortcuts) ----------

function toggleWrap(view: EditorView, mark: string, closeMark = mark): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  const selected = state.sliceDoc(from, to)

  // unwrap: markers directly around the selection
  if (
    from >= mark.length &&
    state.sliceDoc(from - mark.length, from) === mark &&
    state.sliceDoc(to, to + closeMark.length) === closeMark
  ) {
    view.dispatch({
      changes: [
        { from: from - mark.length, to: from },
        { from: to, to: to + closeMark.length },
      ],
      selection: { anchor: from - mark.length, head: to - mark.length },
      scrollIntoView: true,
    })
    return true
  }
  // unwrap: selection itself carries the markers
  if (
    selected.length >= mark.length + closeMark.length &&
    selected.startsWith(mark) &&
    selected.endsWith(closeMark)
  ) {
    view.dispatch({
      changes: { from, to, insert: selected.slice(mark.length, selected.length - closeMark.length) },
      selection: { anchor: from, head: to - mark.length - closeMark.length },
    })
    return true
  }
  // wrap
  view.dispatch({
    changes: { from, to, insert: mark + selected + closeMark },
    selection: selected
      ? { anchor: from + mark.length, head: to + mark.length }
      : { anchor: from + mark.length },
  })
  return true
}

function toggleCodeBlock(view: EditorView): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from)
  const last = state.doc.lineAt(to)
  const text = state.sliceDoc(first.from, last.to)

  if (text.startsWith('```') && text.includes('\n') && text.trimEnd().endsWith('```')) {
    const inner = text.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '')
    view.dispatch({ changes: { from: first.from, to: last.to, insert: inner } })
    return true
  }
  view.dispatch({
    changes: { from: first.from, to: last.to, insert: '```\n' + text + '\n```' },
    selection: { anchor: first.from + 3 },
  })
  return true
}

function insertLink(view: EditorView): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  const sel = state.sliceDoc(from, to)

  if (sel.startsWith('[') && sel.endsWith(')')) {
    const m = /^\[([^\]]*)\]\((.*)\)$/.exec(sel)
    if (m) {
      view.dispatch({
        changes: { from, to, insert: m[1] },
        selection: { anchor: from, head: from + m[1].length },
      })
      return true
    }
  }
  const label = sel || '链接文字'
  view.dispatch({
    changes: { from, to, insert: `[${label}](url)` },
    selection: sel
      ? { anchor: from + label.length + 3, head: from + label.length + 6 }
      : { anchor: from + 1, head: from + 1 + label.length },
  })
  return true
}

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const chunks: string[] = []
  for (let i = 0; i < buf.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...buf.subarray(i, i + 0x8000)))
  }
  return btoa(chunks.join(''))
}

// ---------- editor pane ----------

export class EditorPane {
  view: EditorView | null = null
  private themeComp = new Compartment()
  private path: string | null = null
  private dirty = false
  private saveTimer: number | null = null
  /** true while openFile/clear swap the document — suppresses dirty tracking and re-render */
  private loading = false
  /** last time this editor itself wrote the file — used to ignore the resulting fs watch event */
  lastSavedAt = 0

  onDirtyChange: ((dirty: boolean) => void) | null = null
  onDocChanged: (() => void) | null = null
  onStatsChange: ((stats: string) => void) | null = null

  mount(host: HTMLElement, dark: boolean) {
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '', extensions: this.stateExtensions(dark) }),
    })
  }

  /** 扩展集中定义：mount 与 loadState(fromJSON) 共用 */
  private stateExtensions(dark = false) {
    return [
      basicSetup,
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
      EditorView.lineWrapping,
      this.themeComp.of(dark ? oneDark : []),
      // list nesting / selection indent (after basicSetup so it takes precedence)
      keymap.of([
        { key: 'Tab', run: indentMore, shift: indentLess },
      ]),
      EditorView.domEventHandlers({
        paste: (event) => {
          const items = event.clipboardData?.items
          if (!items) return false
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (!file) continue
              event.preventDefault()
              void this.savePastedImage(file)
              return true
            }
          }
          return false
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !this.loading) {
          this.setDirty(true)
          this.onDocChanged?.()
          this.scheduleSave()
        }
        if (u.docChanged || u.selectionSet) {
          this.reportStats()
          if (this.typewriter) this.centerCursor()
        }
      }),
    ]
  }

  setDarkTheme(dark: boolean) {
    this.view?.dispatch({ effects: this.themeComp.reconfigure(dark ? oneDark : []) })
  }

  openFile(path: string, content: string) {
    this.path = path
    this.cancelSave()
    this.setDirty(false)
    this.loading = true
    try {
      this.view?.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: content } })
    } finally {
      this.loading = false
    }
    this.reportStats()
  }

  clear() {
    this.path = null
    this.cancelSave()
    this.setDirty(false)
    this.loading = true
    try {
      this.view?.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: '' } })
    } finally {
      this.loading = false
    }
    this.onStatsChange?.('')
  }

  get currentPath() {
    return this.path
  }

  /** path changed underneath us (file renamed in the tree) */
  setPath(p: string) {
    this.path = p
  }

  /** typewriter scrolling: keep the cursor vertically centered after each edit */
  setTypewriter(on: boolean) {
    this.typewriter = on
    if (on) this.centerCursor()
  }

  /** 序列化当前编辑器状态（含撤销历史）——多标签切换保存用 */
  exportState(): unknown {
    return this.view ? this.view.state.toJSON() : null
  }

  /** 恢复编辑器状态；JSON 为空时置空文档 */
  loadState(json: unknown): void {
    if (!this.view) return
    this.loading = true
    try {
      const state =
        json && typeof json === 'object'
          ? EditorState.fromJSON(json, { extensions: this.stateExtensions() })
          : EditorState.create({ doc: '', extensions: this.stateExtensions() })
      this.view.setState(state)
    } catch {
      this.view.setState(EditorState.create({ doc: '', extensions: this.stateExtensions() }))
    } finally {
      this.loading = false
    }
    this.reportStats()
  }

  private typewriter = false

  private centerCursor() {
    const v = this.view
    if (!v) return
    const pos = v.state.selection.main.head
    v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  }

  getContent(): string {
    return this.view?.state.doc.toString() ?? ''
  }

  isDirty() {
    return this.dirty
  }

  setDirty(d: boolean) {
    if (this.dirty === d) return
    this.dirty = d
    this.onDirtyChange?.(d)
  }

  // ---- formatting actions (menu + shortcut entry points) ----
  toggleBold() {
    this.view && toggleWrap(this.view, '**')
    this.focus()
  }
  toggleItalic() {
    this.view && toggleWrap(this.view, '*')
    this.focus()
  }
  toggleInlineCode() {
    this.view && toggleWrap(this.view, '`')
    this.focus()
  }
  toggleCodeBlock() {
    this.view && toggleCodeBlock(this.view!)
    this.focus()
  }
  insertLink() {
    this.view && insertLink(this.view!)
    this.focus()
  }

  /** toggle a `- [ ]` / `- [x]` marker on the given 1-based source line */
  toggleTaskAtLine(n: number, checked: boolean) {
    const v = this.view
    if (!v || n < 1 || n > v.state.doc.lines) return
    const line = v.state.doc.line(n)
    const text = v.state.sliceDoc(line.from, line.to)
    const updated = checked ? text.replace(/\[[ ]?\]/, '[x]') : text.replace(/\[[xX]\]/, '[ ]')
    if (updated !== text) v.dispatch({ changes: { from: line.from, to: line.to, insert: updated } })
  }

  /** insert an image reference at the cursor */
  insertImageAtCursor(ref: string) {
    const v = this.view
    if (!v) return
    const sel = v.state.selection.main
    v.dispatch({ changes: { from: sel.from, to: sel.to, insert: `![](${ref})\n` } })
    this.focus()
  }

  private async savePastedImage(file: File) {
    const v = this.view
    if (!v || !this.path) return
    const dir = this.path.slice(0, this.path.lastIndexOf('/'))
    const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const rel = `assets/paste-${stamp}.${ext}`
    try {
      const base64 = await fileToBase64(file)
      await window.mdr.writeBinary(`${dir}/${rel}`, base64)
    } catch (err) {
      console.error('paste image save failed', err)
      return
    }
    const pos = v.state.selection.main
    v.dispatch({ changes: { from: pos.from, to: pos.to, insert: `![](${encodeURI(rel)})` } })
  }

  private reportStats() {
    const v = this.view
    if (!v) return
    if (!this.path) {
      this.onStatsChange?.('')
      return
    }
    const sel = v.state.selection.main
    const line = v.state.doc.lineAt(sel.head)
    const chars = v.state.doc.toString().replace(/\s/g, '').length
    this.onStatsChange?.(`${chars} 字 · ${line.number}:${sel.head - line.from + 1}`)
  }

  private cancelSave() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  private scheduleSave() {
    this.cancelSave()
    this.saveTimer = window.setTimeout(() => {
      void this.saveNow()
    }, AUTOSAVE_DELAY)
  }

  async saveNow() {
    if (!this.dirty || !this.path || !this.view) return
    this.cancelSave()
    await window.mdr.writeFile(this.path, this.getContent())
    this.lastSavedAt = Date.now()
    this.setDirty(false)
  }

  lineAtTop(): number {
    const v = this.view
    if (!v) return 1
    const block = v.lineBlockAtHeight(v.scrollDOM.scrollTop + 8)
    return v.state.doc.lineAt(block.from).number
  }

  scrollToLine(n: number) {
    const v = this.view
    if (!v) return
    const line = v.state.doc.line(Math.max(1, Math.min(n, v.state.doc.lines)))
    v.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 4 }) })
  }

  onScroll(cb: () => void) {
    this.view?.scrollDOM.addEventListener('scroll', cb, { passive: true })
  }

  focus() {
    this.view?.focus()
  }
}
