import '../styles/app.css'
import '../styles/preview.css'
import 'katex/dist/katex.min.css'

import { getState, saveState, runtime, PaneKey } from './state'
import { applyTheme, setTheme, cycleTheme, onThemeChange, currentTheme } from './theme'
import { FileTree } from './fileTree'
import { EditorPane } from './editor'
import { renderPreview, handleLinkClick, setTaskToggleHandler } from './preview'
import { buildOutline, updateActiveHeading } from './outline'
import { setupSync } from './syncScroll'
import { setupLightbox } from './lightbox'

const $ = (s: string) => document.querySelector<HTMLElement>(s)!

const sidebar = $('#sidebar')
const editorPane = $('#editor-pane')
const previewPane = $('#preview-pane')
const outlinePane = $('#outline-pane')
const preview = $('#preview')
const outlineNav = $('#outline')
const editorHost = $('#editor-host')
const treeHost = $('#file-tree')
const saveStateEl = $('#save-state')
const emptyState = $('#empty-state')
const fileTitle = $('#file-title')

const editor = new EditorPane()
const tree = new FileTree(treeHost)

let renderTimer: number | null = null
let scrollSaveTimer: number | null = null
let session: Record<string, unknown> = {}

// ---------------- layout ----------------

function applyLayout() {
  const s = getState()
  sidebar.classList.toggle('pane-collapsed', s.collapsed.sidebar)
  editorPane.classList.toggle('pane-collapsed', s.collapsed.editor)
  previewPane.classList.toggle('pane-collapsed', s.collapsed.preview)
  outlinePane.classList.toggle('pane-collapsed', s.collapsed.outline)
  sidebar.style.width = `${s.widths.sidebar}px`
  editorPane.style.width = `${s.widths.editor}px`
  outlinePane.style.width = `${s.widths.outline}px`
  $('#resizer-sidebar').classList.toggle('pane-collapsed', s.collapsed.sidebar)
  $('#resizer-editor').classList.toggle('pane-collapsed', s.collapsed.editor || s.collapsed.preview)
  $('#resizer-outline').classList.toggle('pane-collapsed', s.collapsed.outline)
  emptyState.classList.toggle('visible', !runtime.currentFile)
}

function togglePane(key: PaneKey) {
  const s = getState()
  // never leave both editor and preview hidden
  if ((key === 'editor' || key === 'preview') && !s.collapsed[key]) {
    const other: PaneKey = key === 'editor' ? 'preview' : 'editor'
    if (s.collapsed[other]) s.collapsed[other] = false
  }
  s.collapsed[key] = !s.collapsed[key]
  saveState()
  applyLayout()
}

function setupResizer(handle: HTMLElement, pane: HTMLElement, key: 'sidebar' | 'editor' | 'outline', min: number, max: number) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = pane.getBoundingClientRect().width
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('active')
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.min(max, Math.max(min, startW + ev.clientX - startX)))
      pane.style.width = `${w}px`
    }
    const up = () => {
      handle.releasePointerCapture(e.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.classList.remove('active')
      getState().widths[key] = Math.round(pane.getBoundingClientRect().width)
      saveState()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
}

// ---------------- files ----------------

function persistSession() {
  void window.mdr.setSession(session)
}

async function openLibrary(root: string): Promise<boolean> {
  const treeData = await window.mdr.openLibrary(root)
  if (!treeData) return false
  runtime.libraryRoot = root
  session.libraryRoot = root
  persistSession()
  await tree.refresh()
  applyLayout()
  return true
}

async function openFolderAction() {
  const root = await window.mdr.selectFolder()
  if (root) await openLibrary(root)
}

async function openFileAction() {
  const p = await window.mdr.selectFile()
  if (!p) return
  if (!runtime.libraryRoot) await openLibrary(p.slice(0, p.lastIndexOf('/')))
  void openFile(p)
}

let opening = false
async function openFile(path: string) {
  if (opening) return
  opening = true
  try {
    let content: string
    try {
      content = await window.mdr.readFile(path)
    } catch {
      return
    }
    runtime.currentFile = path
    session.lastFile = path
    persistSession()
    tree.markSelected(path)
    editor.openFile(path, content)
    const name = path.split('/').pop() ?? path
    fileTitle.textContent = name
    document.title = `${name} — Markdown Reader`
    await renderPreview(previewPane, preview, content, path)
    buildOutline(preview, outlineNav)
    updateActiveHeading(preview, outlineNav)
    const saved = getState().scrollByPath[path]
    if (saved) previewPane.scrollTop = saved
    const s = getState()
    s.recent = [path, ...s.recent.filter((x) => x !== path)].slice(0, 10)
    saveState()
    applyLayout()
  } finally {
    opening = false
  }
}

function closeFile() {
  runtime.currentFile = null
  session.lastFile = null
  persistSession()
  tree.markSelected(null)
  editor.clear()
  preview.innerHTML = ''
  outlineNav.innerHTML = ''
  fileTitle.textContent = ''
  document.title = 'Markdown Reader'
  saveStateEl.textContent = ''
  applyLayout()
}

async function newFileAction(dirOverride?: string) {
  if (!runtime.libraryRoot) {
    await openFolderAction()
    if (!runtime.libraryRoot) return
  }
  const dir = dirOverride ?? tree.currentDir(runtime.libraryRoot)
  if (!dir) return
  const p = await window.mdr.saveNewFile(dir, '未命名.md')
  if (!p) return
  await window.mdr.writeFile(p, '# 未命名\n\n')
  await tree.refresh()
  void openFile(p)
}

// ---------------- wiring ----------------

function setupActions() {
  $('#btn-open-folder').addEventListener('click', () => void openFolderAction())
  $('#btn-open-file').addEventListener('click', () => void openFileAction())
  $('#btn-new-file').addEventListener('click', () => void newFileAction())
  $('#empty-open-folder').addEventListener('click', () => void openFolderAction())
  $('#empty-open-file').addEventListener('click', () => void openFileAction())
  $('#btn-toggle-sidebar').addEventListener('click', () => togglePane('sidebar'))
  $('#btn-toggle-editor').addEventListener('click', () => togglePane('editor'))
  $('#btn-toggle-preview').addEventListener('click', () => togglePane('preview'))
  $('#btn-toggle-outline').addEventListener('click', () => togglePane('outline'))
  $('#btn-theme').addEventListener('click', () => cycleTheme())

  window.mdr.onMenu((action) => {
    switch (action) {
      case 'open-file':
        void openFileAction()
        break
      case 'open-folder':
        void openFolderAction()
        break
      case 'new-file':
        void newFileAction()
        break
      case 'save':
        void editor.saveNow()
        break
      case 'toggle-sidebar':
        togglePane('sidebar')
        break
      case 'toggle-editor':
        togglePane('editor')
        break
      case 'toggle-preview':
        togglePane('preview')
        break
      case 'toggle-outline':
        togglePane('outline')
        break
      case 'theme-light':
        setTheme('light')
        break
      case 'theme-dark':
        setTheme('dark')
        break
      case 'theme-auto':
        setTheme('auto')
        break
      case 'fmt-bold':
        editor.toggleBold()
        break
      case 'fmt-italic':
        editor.toggleItalic()
        break
      case 'fmt-code':
        editor.toggleInlineCode()
        break
      case 'fmt-codeblock':
        editor.toggleCodeBlock()
        break
      case 'fmt-link':
        editor.insertLink()
        break
    }
  })
}

function setupEditorCallbacks() {
  editor.onDirtyChange = (d) => {
    saveStateEl.textContent = d ? '● 未保存' : '已保存'
    saveStateEl.classList.toggle('dirty', d)
    const name = runtime.currentFile?.split('/').pop() ?? ''
    document.title = `${d ? '● ' : ''}${name} — Markdown Reader`
  }
  editor.onStatsChange = (s) => {
    $('#editor-stats').textContent = s
  }
  editor.onDocChanged = () => {
    if (renderTimer) clearTimeout(renderTimer)
    renderTimer = window.setTimeout(async () => {
      await renderPreview(previewPane, preview, editor.getContent(), runtime.currentFile)
      buildOutline(preview, outlineNav)
    }, 250)
  }
  setTaskToggleHandler((line, checked) => editor.toggleTaskAtLine(line, checked))
}

function setupPreviewScroll() {
  previewPane.addEventListener(
    'scroll',
    () => {
      updateActiveHeading(preview, outlineNav)
      if (runtime.currentFile) {
        if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
        scrollSaveTimer = window.setTimeout(() => {
          getState().scrollByPath[runtime.currentFile!] = previewPane.scrollTop
          saveState()
        }, 400)
      }
    },
    { passive: true },
  )
}

let fsTimer: number | null = null
function setupFsWatch() {
  window.mdr.onFsEvent((ev) => {
    if (fsTimer) clearTimeout(fsTimer)
    fsTimer = window.setTimeout(async () => {
      if (runtime.libraryRoot) await tree.refresh()
      const cur = runtime.currentFile
      if (!cur || ev.path !== cur && !cur.startsWith(ev.path)) return
      if (ev.event === 'unlink' || ev.event === 'unlinkDir') {
        closeFile()
      } else if (ev.event === 'change') {
        // skip reloads right after our own autosave
        if (Date.now() - editor.lastSavedAt < 2000) return
        if (editor.isDirty()) return
        try {
          const content = await window.mdr.readFile(cur)
          const scroll = previewPane.scrollTop
          editor.openFile(cur, content)
          await renderPreview(previewPane, preview, content, cur)
          buildOutline(preview, outlineNav)
          previewPane.scrollTop = scroll
        } catch {
          /* file vanished */
        }
      }
    }, 300)
  })
}

function setupDragDrop() {
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    const path = window.mdr.pathForFile(file)
    const entry = e.dataTransfer?.items?.[0]?.webkitGetAsEntry?.()
    if (entry?.isDirectory) {
      void openLibrary(path)
    } else if (/\.(md|markdown|mdx)$/i.test(path)) {
      void (async () => {
        if (!runtime.libraryRoot) await openLibrary(path.slice(0, path.lastIndexOf('/')))
        await openFile(path)
      })()
    }
  })
}

// ---------------- boot ----------------

async function boot() {
  applyTheme()
  editor.mount(editorHost, currentTheme() === 'dark')
  onThemeChange((t) => editor.setDarkTheme(t === 'dark'))

  setupActions()
  setupEditorCallbacks()
  setupPreviewScroll()
  setupFsWatch()
  setupDragDrop()
  handleLinkClick(previewPane, preview, (p) => void openFile(p))
  setupLightbox(preview)

  setupResizer($('#resizer-sidebar'), sidebar, 'sidebar', 160, 480)
  setupResizer($('#resizer-editor'), editorPane, 'editor', 240, 1400)
  setupResizer($('#resizer-outline'), outlinePane, 'outline', 160, 420)

  setupSync(editor, previewPane, () => {
    const c = getState().collapsed
    return !c.editor && !c.preview
  })

  tree.onOpenFile = (p) => void openFile(p)
  tree.onNewFile = (dir) => void newFileAction(dir)

  applyLayout()

  const q = new URLSearchParams(location.search)
  if (q.get('test')) {
    const lib = q.get('lib') ?? ''
    await openLibrary(lib)
    if (runtime.libraryRoot) await openFile(`${runtime.libraryRoot}/README.md`)
    return
  }

  session = await window.mdr.getSession()
  const savedRoot = session.libraryRoot
  if (typeof savedRoot === 'string' && savedRoot) {
    await openLibrary(savedRoot)
  }
  const lastFile = session.lastFile
  if (typeof lastFile === 'string' && lastFile) {
    void openFile(lastFile)
  }
}

window.addEventListener('beforeunload', () => {
  void editor.saveNow()
})

void boot()
