import { basicSetup } from 'codemirror'
import { EditorView } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'

const AUTOSAVE_DELAY = 2000

export class EditorPane {
  view: EditorView | null = null
  private themeComp = new Compartment()
  private path: string | null = null
  private dirty = false
  private saveTimer: number | null = null
  /** last time this editor itself wrote the file — used to ignore the resulting fs watch event */
  lastSavedAt = 0

  onDirtyChange: ((dirty: boolean) => void) | null = null
  onDocChanged: (() => void) | null = null

  mount(host: HTMLElement, dark: boolean) {
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
          EditorView.lineWrapping,
          this.themeComp.of(dark ? oneDark : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              this.setDirty(true)
              this.onDocChanged?.()
              this.scheduleSave()
            }
          }),
        ],
      }),
    })
  }

  setDarkTheme(dark: boolean) {
    this.view?.dispatch({ effects: this.themeComp.reconfigure(dark ? oneDark : []) })
  }

  openFile(path: string, content: string) {
    this.path = path
    this.cancelSave()
    this.setDirty(false)
    this.view?.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: content } })
  }

  clear() {
    this.path = null
    this.cancelSave()
    this.setDirty(false)
    this.view?.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: '' } })
  }

  get currentPath() {
    return this.path
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
