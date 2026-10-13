import '../styles/app.css'
import '../styles/preview.css'
import 'katex/dist/katex.min.css'

import { getState, saveState, runtime, PaneKey, ThemePref } from './state'
import { applyTheme, setTheme, cycleTheme, onThemeChange, currentTheme } from './theme'
import { FileTree } from './fileTree'
import { EditorPane } from './editor'
import { renderPreview, handleLinkClick, setTaskToggleHandler } from './preview'
import { buildOutline, updateActiveHeading } from './outline'
import { setupSync } from './syncScroll'
import { setupLightbox } from './lightbox'
import { openPalette } from './commandPalette'
import { buildStandaloneHtml } from './export'
import { setupUpdater } from './updater'

const $ = (s: string) => document.querySelector<HTMLElement>(s)!

const sidebar = $('#sidebar')
const editorPane = $('#editor-pane')
const previewPane = $('#preview-pane')
const previewScroll = $('#preview-scroll')
const outlinePane = $('#outline-pane')
const preview = $('#preview')
const outlineNav = $('#outline')
const editorHost = $('#editor-host')
const treeHost = $('#file-tree')
const saveStateEl = $('#save-state')
const emptyState = $('#empty-state')
const fileTitle = $('#file-title')

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

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
  // Keep all four panes usable when the window is narrowed, without changing
  // the user's saved widths for the next full-size window.
  const width = $('#workspace').clientWidth
  const desiredWidth = (s.collapsed.sidebar ? 0 : s.widths.sidebar)
    + (s.collapsed.outline ? 0 : s.widths.outline)
    + (!s.collapsed.editor && !s.collapsed.preview ? s.widths.editor : 0)
  const scale = Math.min(1, Math.max(0, width - 260) / Math.max(1, desiredWidth))
  const sidebarWidth = s.widths.sidebar * scale
  const outlineWidth = s.widths.outline * scale
  sidebar.style.width = s.collapsed.sidebar ? '' : `${sidebarWidth}px`
  // with the preview hidden the editor takes over the full area
  const editorFills = s.collapsed.preview && !s.collapsed.editor
  editorPane.classList.toggle('fill', editorFills)
  editorPane.style.width = editorFills ? '' : `${s.widths.editor * scale}px`
  outlinePane.style.width = `${outlineWidth}px`
  $('#resizer-sidebar').classList.toggle('pane-collapsed', s.collapsed.sidebar)
  $('#resizer-editor').classList.toggle('pane-collapsed', s.collapsed.editor || s.collapsed.preview)
  $('#resizer-outline').classList.toggle('pane-collapsed', s.collapsed.outline)
  $('#sidebar-collapse').classList.toggle('pane-collapsed', s.collapsed.sidebar)
  $('#sidebar-expand').classList.toggle('visible', s.collapsed.sidebar)
  for (const key of ['sidebar', 'editor', 'preview', 'outline'] as const) {
    $(`#btn-toggle-${key}`).setAttribute('aria-pressed', String(!s.collapsed[key]))
  }
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
      applyLayout()
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
  $('#library-name').textContent = root.split('/').pop() || '书库'
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
async function openFile(path: string, opts?: { line?: number }): Promise<boolean> {
  if (opening) return false
  opening = true
  try {
    let content: string
    try {
      content = await window.mdr.readFile(path)
    } catch {
      // file no longer exists — drop it from recent list
      const s = getState()
      s.recent = s.recent.filter((x) => x !== path)
      saveState()
      renderRecent()
      return false
    }
    runtime.currentFile = path
    session.lastFile = path
    session.recentFiles = [path, ...(Array.isArray(session.recentFiles) ? (session.recentFiles as string[]) : []).filter((x) => x !== path)].slice(0, 10)
    persistSession()
    void window.mdr.setWindowFile(path)
    tree.markSelected(path)
    editor.openFile(path, content)
    const name = path.split('/').pop() ?? path
    fileTitle.textContent = name
    document.title = `${name} — 墨页 · Inkleaf`
    await renderPreview(previewScroll, preview, content, path)
    buildOutline(preview, outlineNav)
    updateActiveHeading(preview, outlineNav)
    const saved = getState().scrollByPath[path]
    if (opts?.line) {
      jumpToLine(opts.line)
    } else if (saved) {
      previewScroll.scrollTop = saved
    }
    const s = getState()
    s.recent = [path, ...s.recent.filter((x) => x !== path)].slice(0, 10)
    saveState()
    if (s.sidebarTab === 'recent') renderRecent()
    updateBreadcrumb()
    applyLayout()
    return true
  } finally {
    opening = false
  }
}

function closeFile() {
  runtime.currentFile = null
  session.lastFile = null
  persistSession()
  void window.mdr.setWindowFile(null)
  void window.mdr.setWindowEdited(false)
  tree.markSelected(null)
  editor.clear()
  preview.innerHTML = ''
  outlineNav.innerHTML = ''
  fileTitle.textContent = ''
  document.title = '墨页 · Inkleaf'
  saveStateEl.textContent = ''
  updateBreadcrumb()
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

// ---------------- breadcrumb / recent / back-to-top ----------------

function updateBreadcrumb() {
  const bc = $('#breadcrumb')
  const cur = runtime.currentFile
  const root = runtime.libraryRoot
  bc.innerHTML = ''
  if (!cur) return
  const rel = root && cur.startsWith(root + '/') ? cur.slice(root.length + 1) : cur
  const segs = rel.split('/')
  let acc = root ?? ''
  segs.forEach((seg, i) => {
    if (i < segs.length - 1) {
      acc = acc ? `${acc}/${seg}` : seg
      const btn = document.createElement('button')
      btn.className = 'crumb'
      btn.textContent = seg
      btn.title = acc
      btn.addEventListener('click', () => revealFolderInTree(acc))
      bc.appendChild(btn)
      const sep = document.createElement('span')
      sep.className = 'crumb-sep'
      sep.textContent = '/'
      bc.appendChild(sep)
    } else {
      const curEl = document.createElement('span')
      curEl.className = 'crumb cur'
      curEl.textContent = seg
      bc.appendChild(curEl)
    }
  })
}

function revealFolderInTree(folder: string) {
  if (!runtime.libraryRoot) return
  if (getState().collapsed.sidebar) togglePane('sidebar')
  const rel = folder.slice(runtime.libraryRoot.length)
  const parts = rel.split('/').filter(Boolean)
  const set = new Set(getState().expandedDirs)
  let acc = runtime.libraryRoot
  for (const p of parts) {
    acc = `${acc}/${p}`
    set.add(acc)
  }
  getState().expandedDirs = [...set]
  saveState()
  setSidebarTab('files')
  void tree.refresh().then(() => tree.flash(folder))
}

function setSidebarTab(tab: 'files' | 'recent') {
  getState().sidebarTab = tab
  saveState()
  $('#tab-files').classList.toggle('active', tab === 'files')
  $('#tab-recent').classList.toggle('active', tab === 'recent')
  $('#tab-files').setAttribute('aria-pressed', String(tab === 'files'))
  $('#tab-recent').setAttribute('aria-pressed', String(tab === 'recent'))
  treeHost.style.display = tab === 'files' ? '' : 'none'
  $('#recent-list').classList.toggle('visible', tab === 'recent')
  if (tab === 'recent') renderRecent()
}

function renderRecent() {
  const host = $('#recent-list')
  host.innerHTML = ''
  const rec = getState().recent
  if (!rec.length) {
    const empty = document.createElement('div')
    empty.className = 'recent-empty'
    empty.textContent = '暂无最近文件'
    host.appendChild(empty)
    return
  }
  const root = runtime.libraryRoot
  rec.forEach((p) => {
    const item = document.createElement('div')
    item.className = 'recent-item'
    const name = p.split('/').pop() ?? p
    const dir =
      root && p.startsWith(root + '/')
        ? p.slice(root.length + 1, p.lastIndexOf('/')) || '（书库根目录）'
        : p.slice(0, p.lastIndexOf('/'))
    item.innerHTML = `<div class="ri-name">${escapeHtml(name)}</div><div class="ri-dir">${escapeHtml(dir)}</div>`
    item.addEventListener('click', () => void openFile(p))
    host.appendChild(item)
  })
}

function setupBackToTop() {
  const btn = $('#back-top')
  previewScroll.addEventListener(
    'scroll',
    () => btn.classList.toggle('show', previewScroll.scrollTop > 500),
    { passive: true },
  )
  btn.addEventListener('click', () => previewScroll.scrollTo({ top: 0, behavior: 'smooth' }))
}

// ---------------- wiring ----------------

function jumpToLine(line: number) {
  const els = Array.from(preview.querySelectorAll<HTMLElement>('[data-source-line]'))
  const el = els.find((e) => Number(e.dataset.sourceLine) >= line)
  el?.scrollIntoView({ block: 'start' })
  editor.scrollToLine(line)
}

function applyFontScale(scale: number) {
  const s = getState()
  s.fontScale = Math.min(1.6, Math.max(0.8, Math.round(scale * 100) / 100))
  saveState()
  document.documentElement.style.setProperty('--font-scale', String(s.fontScale))
}

function zoomFont(delta: number) {
  applyFontScale(getState().fontScale + delta)
}

function paletteOpts() {
  return {
    listFiles: () => window.mdr.listFiles(),
    searchText: (q: string) => window.mdr.searchText(q),
    recent: () => getState().recent,
    libraryRoot: () => runtime.libraryRoot,
    onOpenFile: (p: string, line?: number) => void openFile(p, { line }),
  }
}

function openPaletteFor(mode: 'files' | 'search') {
  if (!runtime.libraryRoot) return
  openPalette(mode, paletteOpts())
}

async function exportTo(kind: 'pdf' | 'html', target: string) {
  console.log('[export] start', kind, target, 'file:', runtime.currentFile)
  if (!runtime.currentFile) return
  try {
    const name = (runtime.currentFile.split('/').pop() ?? 'export').replace(/\.(md|markdown|mdx)$/i, '')
    const html = await buildStandaloneHtml(preview, name)
    console.log('[export] html built, length:', html.length)
    if (kind === 'html') {
      await window.mdr.writeFile(target, html)
      console.log('[export] html written')
      window.mdr.reveal(target)
    } else {
      const r = await window.mdr.exportPdf(html, target)
      console.log('[export] pdf result:', JSON.stringify(r))
      if (r.ok) window.mdr.reveal(target)
      else void window.mdr.confirm({ title: '导出失败', message: r.error ?? '未知错误', okLabel: '知道了' })
    }
  } catch (err) {
    console.error('[export] error', err)
  }
}

/** pick an image (or use the given src), copy it into assets, reference it at the cursor */
async function insertImageFrom(srcOverride?: string) {
  const cur = runtime.currentFile
  if (!cur) return
  const src = srcOverride ?? (await window.mdr.pickImage())
  if (!src) return
  const dir = cur.slice(0, cur.lastIndexOf('/'))
  const dest = await window.mdr.copyImage(src, `${dir}/assets`)
  if (!dest) {
    void window.mdr.confirm({ title: '插入失败', message: '图片复制失败', okLabel: '知道了' })
    return
  }
  editor.insertImageAtCursor(`assets/${dest.split('/').pop()}`)
}

async function exportCurrent(kind: 'pdf' | 'html') {
  if (!runtime.currentFile) return
  const name = (runtime.currentFile.split('/').pop() ?? 'export').replace(/\.(md|markdown|mdx)$/i, '')
  const ext = kind === 'pdf' ? 'pdf' : 'html'
  const target = await window.mdr.saveExportPath(`${name}.${ext}`, ext)
  if (!target) return
  await exportTo(kind, target)
}

async function closeLibrary() {
  await window.mdr.closeLibrary()
  runtime.libraryRoot = null
  session.libraryRoot = null
  persistSession()
  closeFile()
  await tree.refresh()
  applyLayout()
}

function setupActions() {
  $('#btn-open-folder').addEventListener('click', () => void openFolderAction())
  $('#btn-open-file').addEventListener('click', () => void openFileAction())
  $('#btn-new-file').addEventListener('click', () => void newFileAction())
  $('#empty-open-folder').addEventListener('click', () => void openFolderAction())
  $('#empty-open-file').addEventListener('click', () => void openFileAction())
  $('#btn-toggle-sidebar').addEventListener('click', () => togglePane('sidebar'))
  $('#sidebar-collapse').addEventListener('click', () => togglePane('sidebar'))
  $('#sidebar-expand').addEventListener('click', () => togglePane('sidebar'))
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
      case 'theme-sepia':
        setTheme('sepia')
        break
      case 'theme-green':
        setTheme('green')
        break
      case 'theme-dark':
        setTheme('dark')
        break
      case 'theme-auto':
        setTheme('auto')
        break
      case 'zoom-in':
        zoomFont(0.1)
        break
      case 'zoom-out':
        zoomFont(-0.1)
        break
      case 'zoom-reset':
        applyFontScale(1)
        break
      case 'close-library':
        void closeLibrary()
        break
      default:
        if (action.startsWith('open-path:')) {
          const p = action.slice('open-path:'.length)
          void (async () => {
            if (!runtime.libraryRoot) await openLibrary(p.slice(0, p.lastIndexOf('/')))
            await openFile(p)
          })()
        }
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
      case 'insert-image':
        void insertImageFrom()
        break
      case 'quick-switch':
        openPaletteFor('files')
        break
      case 'search':
        openPaletteFor('search')
        break
      case 'export-pdf':
        void exportCurrent('pdf')
        break
      case 'export-html':
        void exportCurrent('html')
        break
    }
  })
}

function setupEditorCallbacks() {
  editor.onDirtyChange = (d) => {
    saveStateEl.textContent = d ? '● 未保存' : '已保存'
    saveStateEl.classList.toggle('dirty', d)
    const name = runtime.currentFile?.split('/').pop() ?? ''
    document.title = `${d ? '● ' : ''}${name} — 墨页 · Inkleaf`
    void window.mdr.setWindowEdited(d && !!runtime.currentFile)
  }
  editor.onStatsChange = (s) => {
    $('#editor-stats').textContent = s
  }
  editor.onDocChanged = () => {
    if (renderTimer) clearTimeout(renderTimer)
    // larger documents get a longer debounce so typing stays ahead of rendering
    const size = editor.getContent().length
    const delay = size > 100_000 ? 600 : size > 30_000 ? 400 : 250
    renderTimer = window.setTimeout(async () => {
      await renderPreview(previewScroll, preview, editor.getContent(), runtime.currentFile)
      buildOutline(preview, outlineNav)
    }, delay)
  }
  setTaskToggleHandler((line, checked) => editor.toggleTaskAtLine(line, checked))
}

function setupPreviewScroll() {
  previewScroll.addEventListener(
    'scroll',
    () => {
      updateActiveHeading(preview, outlineNav)
      if (runtime.currentFile) {
        if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
        scrollSaveTimer = window.setTimeout(() => {
          getState().scrollByPath[runtime.currentFile!] = previewScroll.scrollTop
          saveState()
        }, 400)
      }
    },
    { passive: true },
  )
  setupBackToTop()
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
          const scroll = previewScroll.scrollTop
          editor.openFile(cur, content)
          await renderPreview(previewScroll, preview, content, cur)
          buildOutline(preview, outlineNav)
          previewScroll.scrollTop = scroll
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
    // internal tree drags are handled by the file tree itself
    if ([...(e.dataTransfer?.types ?? [])].includes('application/x-mdr-tree')) return
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
    } else if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(path) && runtime.currentFile) {
      // drop an image straight into the document
      void insertImageFrom(path)
    }
  })
}

// ---------------- boot ----------------

async function boot() {
  applyTheme()
  applyFontScale(getState().fontScale)
  editor.mount(editorHost, currentTheme() === 'dark')
  onThemeChange((t) => editor.setDarkTheme(t === 'dark'))

  setupActions()
  setupEditorCallbacks()
  setupUpdater(() => editor.saveNow())
  setupPreviewScroll()
  setupFsWatch()
  setupDragDrop()
  handleLinkClick(previewScroll, preview, (p) => void openFile(p))
  setupLightbox(preview)

  $('#tab-files').addEventListener('click', () => setSidebarTab('files'))
  $('#tab-recent').addEventListener('click', () => setSidebarTab('recent'))

  // test hook: lets the automated harness open the palette without native menu accelerators
  document.addEventListener('mdr-test-palette', (e) => {
    openPaletteFor((e as CustomEvent).detail?.mode === 'search' ? 'search' : 'files')
  })
  // test hook: export to a fixed path, bypassing the save dialog
  document.addEventListener('mdr-test-export', (e) => {
    void exportTo((e as CustomEvent).detail?.kind === 'html' ? 'html' : 'pdf', (e as CustomEvent).detail?.path ?? '')
  })
  // test hooks: theme & font scale
  document.addEventListener('mdr-test-theme', (e) => {
    const t = (e as CustomEvent).detail?.theme as ThemePref | undefined
    setTheme(t ?? 'auto')
  })
  document.addEventListener('mdr-test-zoom', (e) => {
    applyFontScale(Number((e as CustomEvent).detail?.scale ?? 1) || 1)
  })
  // test hook: insert an image from a fixed path
  document.addEventListener('mdr-test-insert-image', (e) => {
    void insertImageFrom((e as CustomEvent).detail?.src)
  })

  // macOS: file double-clicked in Finder / dock recent files
  window.mdr.onOpenPath((p) => {
    void (async () => {
      if (!runtime.libraryRoot) await openLibrary(p.slice(0, p.lastIndexOf('/')))
      await openFile(p)
    })()
  })

  setupResizer($('#resizer-sidebar'), sidebar, 'sidebar', 160, 480)
  setupResizer($('#resizer-editor'), editorPane, 'editor', 240, 1400)
  setupResizer($('#resizer-outline'), outlinePane, 'outline', 160, 420)
  window.addEventListener('resize', applyLayout)

  setupSync(editor, previewScroll, () => {
    const c = getState().collapsed
    return !c.editor && !c.preview
  })

  tree.onOpenFile = (p) => void openFile(p)
  tree.onCreated = (p) => void openFile(p)
  tree.onRenamed = ({ oldPath, newPath, isDir }) => {
    const remap = (p: string | null): string | null => {
      if (!p) return null
      if (isDir) {
        if (p.startsWith(oldPath + '/')) return newPath + p.slice(oldPath.length)
        return null
      }
      return p === oldPath ? newPath : null
    }
    const cur = runtime.currentFile
    const remapped = remap(cur)
    if (cur && remapped) {
      runtime.currentFile = remapped
      editor.setPath(remapped)
      session.lastFile = remapped
      persistSession()
      tree.markSelected(remapped)
      const name = remapped.split('/').pop() ?? remapped
      fileTitle.textContent = name
      document.title = `${name} — 墨页 · Inkleaf`
      updateBreadcrumb()
    }
    // migrate recent list + remembered scroll positions
    const s = getState()
    s.recent = s.recent.map((p) => {
      const r = isDir ? (p.startsWith(oldPath + '/') ? newPath + p.slice(oldPath.length) : p) : p === oldPath ? newPath : p
      return r
    })
    const scroll: Record<string, number> = {}
    for (const [k, v] of Object.entries(s.scrollByPath)) {
      const r = isDir ? (k.startsWith(oldPath + '/') ? newPath + k.slice(oldPath.length) : k) : k === oldPath ? newPath : k
      scroll[r] = v
    }
    s.scrollByPath = scroll
    saveState()
    if (s.sidebarTab === 'recent') renderRecent()
  }
  tree.onDeleted = (path) => {
    const cur = runtime.currentFile
    if (cur && (cur === path || cur.startsWith(path + '/'))) closeFile()
    const s = getState()
    s.recent = s.recent.filter((p) => p !== path && !p.startsWith(path + '/'))
    saveState()
    if (s.sidebarTab === 'recent') renderRecent()
  }

  const filterInput = $('#tree-filter-input') as HTMLInputElement
  filterInput.addEventListener('input', () => tree.setFilter(filterInput.value))

  applyLayout()
  setSidebarTab(getState().sidebarTab)

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
