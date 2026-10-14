import '../styles/app.css'
import '../styles/preview.css'
import 'katex/dist/katex.min.css'

import { getState, saveState, runtime, PaneKey, ThemePref } from './state'
import { escapeHtml } from './util'
import { applyTheme, setTheme, cycleTheme, onThemeChange, currentTheme } from './theme'
import { FileTree } from './fileTree'
import { EditorPane } from './editor'
import { clearPreview, renderPreview, handleLinkClick, setTaskToggleHandler } from './preview'
import { buildOutline, updateActiveHeading } from './outline'
import { setupSync } from './syncScroll'
import { setupLightbox } from './lightbox'
import { openPalette } from './commandPalette'
import { buildStandaloneHtml } from './export'
import { setupUpdater } from './updater'
import { setupPlatformUi } from './platform'
import { registerCommand, runCommand } from './commands'
import { applyFocusModes, toggleFocusMode, toggleTypewriter, setupFocusHighlight } from './focus'
import { setWikilinkNav } from './wikilink'
import { setBacklinkNav, refreshBacklinks } from './backlink'
import { TabManager, type DocSession } from './docSession'
import { bootPlugins } from './pluginRuntime'
import { registerCalloutPlugin } from './bundled-callout'
import { registerPanel, listPanels, getPanel, attachPanelResizers, type PanelDef } from './panels'

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

const editor = new EditorPane()
const tree = new FileTree(treeHost)
const tabs = new TabManager()
tabs.onTabsChanged = () => {
  renderTabs()
  session.tabs = tabs.paths()
  session.activeIndex = tabs.activeIndex
  persistSession()
}

let renderTimer: number | null = null
let scrollSaveTimer: number | null = null
let session: Record<string, unknown> = {}

// ---------------- layout ----------------

/** 编辑区分隔条：编辑区宽度有 fill/缩放专用逻辑，不进面板注册表 */
function attachEditorResizer() {
  const handle = $('#resizer-editor')
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = editorPane.getBoundingClientRect().width
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('active')
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.min(1400, Math.max(240, startW + ev.clientX - startX)))
      editorPane.style.width = `${w}px`
    }
    const up = () => {
      handle.releasePointerCapture(e.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.classList.remove('active')
      getState().widths.editor = Math.round(editorPane.getBoundingClientRect().width)
      saveState()
      applyLayout()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
}

/** 声明式注册内置侧栏面板，统一管理面板布局。 */
function registerBuiltinPanels() {
  const sidebarPanel: PanelDef = {
    id: 'sidebar', slot: 'left', el: sidebar, resizer: $('#resizer-sidebar'),
    min: 160, max: 480, defaultWidth: 224,
    onLayout: (c) => {
      $('#sidebar-collapse').classList.toggle('pane-collapsed', c)
      $('#sidebar-expand').classList.toggle('visible', c)
    },
  }
  registerPanel(sidebarPanel)
  registerPanel({
    id: 'outline', slot: 'right', el: outlinePane, resizer: $('#resizer-outline'),
    min: 160, max: 420, defaultWidth: 184,
  })
  registerPanel({
    id: 'backlink', slot: 'right', el: $('#backlink-pane'), resizer: $('#resizer-outline'),
    min: 160, max: 420, defaultWidth: 184, sharesWidth: 'outline',
  })
}

function applyLayout() {
  const s = getState()
  const collapsed = (id: string) => !!s.collapsed[id]
  editorPane.classList.toggle('pane-collapsed', collapsed('editor'))
  previewPane.classList.toggle('pane-collapsed', collapsed('preview'))
  // Keep all four panes usable when the window is narrowed, without changing
  // the user's saved widths for the next full-size window.
  const width = $('#workspace').clientWidth
  const panelWidth = (p: PanelDef) => s.widths[p.id] ?? p.defaultWidth
  let desiredWidth = !collapsed('editor') && !collapsed('preview') ? s.widths.editor : 0
  for (const p of listPanels()) if (!collapsed(p.id)) desiredWidth += panelWidth(p)
  const scale = Math.min(1, Math.max(0, width - 260) / Math.max(1, desiredWidth))
  for (const p of listPanels()) {
    const c = collapsed(p.id)
    p.el.classList.toggle('pane-collapsed', c)
    // sharesWidth 面板（右栏堆叠）不设自身宽度，随容器铺满
    if (!p.sharesWidth) p.el.style.width = c ? '' : `${Math.round(panelWidth(p) * scale)}px`
    p.onLayout?.(c)
    $(`#btn-toggle-${p.id}`)?.setAttribute('aria-pressed', String(!c))
  }
  // with the preview hidden the editor takes over the full area
  const editorFills = collapsed('preview') && !collapsed('editor')
  editorPane.classList.toggle('fill', editorFills)
  editorPane.style.width = editorFills ? '' : `${s.widths.editor * scale}px`
  $('#resizer-editor').classList.toggle('pane-collapsed', collapsed('editor') || collapsed('preview'))
  $('#btn-toggle-editor').setAttribute('aria-pressed', String(!collapsed('editor')))
  $('#btn-toggle-preview').setAttribute('aria-pressed', String(!collapsed('preview')))
  emptyState.classList.toggle('visible', !runtime.currentFile && !runtime.libraryRoot)
  $('#library-empty').classList.toggle('visible', !runtime.currentFile && !!runtime.libraryRoot)
  $('#library-empty-title').textContent = tree.hasDocuments ? '选择一篇文档，开始阅读' : '书库还是空的'
  $('#library-empty-description').textContent = tree.hasDocuments
    ? '从左侧选择一篇文档，或新建一页，记录此刻的想法。'
    : '这里还没有 Markdown 文档。新建一页，让文字开始生长。'
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

// ---------------- files ----------------

let sessionSave = Promise.resolve()
function persistSession() {
  const snapshot = structuredClone(session)
  sessionSave = sessionSave.catch(() => {}).then(() => window.mdr.setSession(snapshot)).catch(error => console.error('Session save failed', error))
}

let libraryLoads = 0
let choosingFolder = false
let choosingFile = false
let libraryFailure: string | null = null

function updateLibraryFeedback() {
  const busy = libraryLoads > 0 || choosingFolder
  const feedback = $('#library-feedback')
  const message = libraryLoads > 0 ? '正在打开书库…' : choosingFolder ? '请选择书库文件夹…' : libraryFailure
  feedback.hidden = !message
  feedback.textContent = message ?? ''
  feedback.classList.toggle('loading', busy)
  feedback.classList.toggle('error', !busy && !!libraryFailure)
  document.body.classList.toggle('library-loading', busy)
  sidebar.setAttribute('aria-busy', String(libraryLoads > 0))
  for (const id of ['btn-open-folder', 'empty-open-folder', 'btn-open-file', 'empty-open-file', 'library-open-file', 'btn-new-file', 'library-new-file']) {
    const button = $('#' + id) as HTMLButtonElement
    button.disabled = busy || choosingFile
    button.classList.toggle('is-loading', busy && (id === 'btn-open-folder' || id === 'empty-open-folder'))
    button.setAttribute('aria-busy', String(busy && (id === 'btn-open-folder' || id === 'empty-open-folder')))
  }
}

async function withLibraryLoading<T>(operation: () => Promise<T>): Promise<T> {
  libraryLoads++
  libraryFailure = null
  updateLibraryFeedback()
  try { return await operation() }
  finally { libraryLoads--; updateLibraryFeedback() }
}

function normalizeLibraryRoot(root: string): string { return root.replace(/\/+$/, '') || '/' }
function isInLibrary(path: string, root = runtime.libraryRoot): boolean {
  if (!root) return false
  const normalized = normalizeLibraryRoot(root)
  return path === normalized || path.startsWith(normalized === '/' ? '/' : normalized + '/')
}
function parentDirectory(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator === 0 ? '/' : path.slice(0, separator)
}

type OpenLibraryOptions = { restoreSession?: boolean }
function openLibrary(root: string, options?: OpenLibraryOptions): Promise<boolean> {
  return withLibraryLoading(() => serializeNavigation(() => openLibraryNow(root, options)))
}

async function openLibraryNow(root: string, options?: OpenLibraryOptions): Promise<boolean> {
  const normalized = normalizeLibraryRoot(root)
  editor.setMutationLocked(true)
  try {
    try { await saveAllDocuments() }
    catch (error) {
      console.error('Save before opening library failed', error)
      libraryFailure = '当前编辑未能保存，请先保存后再切换书库。'
      return false
    }
    await sessionSave
    const treeData = await window.mdr.openLibrary(normalized)
    if (!treeData) throw new Error('Library is unavailable')
    runtime.libraryRoot = normalized
    session.libraryRoot = normalized
    if (!options?.restoreSession) closeFileUi()
    const filterInput = $('#tree-filter-input') as HTMLInputElement
    filterInput.value = ''
    tree.load(treeData, true)
    const state = getState()
    state.collapsed.sidebar = false
    state.expandedDirs = state.expandedDirs.filter(path => isInLibrary(path, normalized))
    saveState()
    setSidebarTab('files')
    $('#library-name').textContent = normalized.split('/').pop() || '书库'
    persistSession()
    applyLayout()
    return true
  } catch (error) {
    console.error('Opening library failed', error)
    libraryFailure = '无法打开所选书库，请检查文件夹是否存在且可以访问。'
    return false
  } finally { editor.setMutationLocked(false) }
}

async function openFolderAction() {
  if (libraryLoads || choosingFolder || choosingFile) return
  choosingFolder = true
  libraryFailure = null
  updateLibraryFeedback()
  try {
    const root = await window.mdr.selectFolder()
    if (root) await openLibrary(root)
  } catch (error) {
    console.error('Selecting library failed', error)
    libraryFailure = '无法选择书库，请重试。'
  } finally { choosingFolder = false; updateLibraryFeedback() }
}

async function openFileAction() {
  if (libraryLoads || choosingFolder || choosingFile) return
  choosingFile = true
  updateLibraryFeedback()
  try {
    const path = await window.mdr.selectFile()
    if (path) await openFile(path)
  } catch (error) { showDocumentError('无法打开文件', error) }
  finally { choosingFile = false; updateLibraryFeedback() }
}

let navigation = Promise.resolve()

function serializeNavigation<T>(operation: () => Promise<T>): Promise<T> {
  const result = navigation.then(operation)
  navigation = result.then(() => {}, () => {})
  return result
}

function cachedText(session: DocSession | null): string | null {
  const json = session?.editorJSON as { doc?: unknown } | null
  return typeof json?.doc === 'string' ? json.doc : null
}

function showDocumentError(title: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(title, error)
  void window.mdr.confirm({ title, message, okLabel: '知道了' })
}

async function captureCurrentDocument(): Promise<void> {
  await editor.saveNow()
  const path = editor.currentPath
  if (!path) return
  tabs.capturePath(path, editor.exportState(), previewScroll.scrollTop, editor.isDirty())
  const session = tabs.get(tabs.indexOf(path))
  if (session && !editor.isDirty()) session.diskContent = editor.getContent()
}

async function saveAllDocuments(): Promise<void> {
  await captureCurrentDocument()
  for (const session of tabs.all()) {
    if (!session.dirty || session.path === editor.currentPath) continue
    const text = cachedText(session)
    if (text === null) throw new Error('未保存标签页的内容无法读取，请先回到该标签页保存')
    await window.mdr.writeFile(session.path, text)
    session.dirty = false
    session.diskContent = text
  }
}

/** tabbar 渲染：文件名 + 脏点 + 关闭按钮 */
function renderTabs() {
  const bar = document.getElementById('tabbar')
  if (!bar) return
  bar.innerHTML = ''
  const paths = tabs.paths()
  paths.forEach((p, i) => {
    const tab = document.createElement('div')
    tab.className = 'doc-tab' + (i === tabs.activeIndex ? ' active' : '') + (tabs.get(i)?.dirty ? ' dirty' : '')
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(i === tabs.activeIndex))
    const name = document.createElement('span')
    name.className = 'tab-name'
    name.textContent = p.split('/').pop() ?? p
    tab.title = p
    const close = document.createElement('span')
    close.className = 'tab-close'
    close.textContent = '×'
    close.title = '关闭标签页'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      void closeTabUi(i)
    })
    tab.addEventListener('click', () => void switchToTab(i))
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) void closeTabUi(i)
    })
    tab.appendChild(name)
    tab.appendChild(close)
    bar.appendChild(tab)
  })
}

async function switchToTab(i: number): Promise<void> {
  const target = tabs.get(i)
  if (!target) return
  await openFile(target.path)
}

async function closeTabUi(i: number): Promise<void> {
  const closing = tabs.get(i)
  if (!closing) return
  await serializeNavigation(async () => {
    const index = tabs.indexOf(closing.path)
    if (index < 0) return
    const locksEditor = closing.path === editor.currentPath
    if (locksEditor) editor.setMutationLocked(true)
    try {
      if (closing.path === editor.currentPath) await captureCurrentDocument()
      else if (closing.dirty) {
        const text = cachedText(closing)
        if (text === null) throw new Error('标签页尚未保存，无法关闭')
        await window.mdr.writeFile(closing.path, text)
        closing.dirty = false
      }
      const next = tabs.close(index)
      if (!next) closeFileUi()
      else await openFileNow(next.path)
    } catch (error) { showDocumentError('保存失败，标签页仍保持打开', error) }
    finally { if (locksEditor) editor.setMutationLocked(false) }
  })
}

/** 清空文档区 UI（所有标签已关或书库关闭时） */
function closeFileUi() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
  if (scrollSaveTimer) { clearTimeout(scrollSaveTimer); scrollSaveTimer = null }
  if (tabs.count) {
    tabs.restorePaths([], -1)
  }
  runtime.currentFile = null
  session.lastFile = null
  persistSession()
  void window.mdr.setWindowFile(null)
  void window.mdr.setWindowEdited(false)
  tree.markSelected(null)
  editor.clear()
  clearPreview(preview)
  outlineNav.innerHTML = ''
  fileTitle.textContent = ''
  document.title = '墨页 · Inkleaf'
  saveStateEl.textContent = ''
  updateBreadcrumb()
  void refreshBacklinks(null)
  applyLayout()
}

type OpenDocumentOptions = { line?: number; newTab?: boolean; anchor?: string }

function openFile(path: string, opts?: OpenDocumentOptions): Promise<boolean> {
  const operation = () => serializeNavigation(async () => {
    if (!isInLibrary(path)) {
      const switchLibrary = () => openLibraryNow(parentDirectory(path))
      const opened = libraryLoads ? await switchLibrary() : await withLibraryLoading(switchLibrary)
      if (!opened) return false
    }
    const opened = await openFileNow(path, opts)
    if (opened) { libraryFailure = null; updateLibraryFeedback() }
    return opened
  })
  return isInLibrary(path) ? operation() : withLibraryLoading(operation)
}

async function openFileNow(path: string, opts?: OpenDocumentOptions): Promise<boolean> {
  const existing = tabs.get(tabs.indexOf(path))
  // 已是当前文件：仅跳转
  if (editor.currentPath === path && runtime.currentFile === path && tabs.activePath === path && !existing?.stale) {
    const line = opts?.line ?? (opts?.anchor ? findHeadingLine(path, opts.anchor) : undefined)
    if (line) jumpToLine(line)
    return true
  }
  try {
    await captureCurrentDocument()
    // Always validate existence and freshness before restoring a cached buffer.
    let diskContent: string
    try {
      diskContent = await window.mdr.readFile(path)
    } catch (error) {
      const s = getState()
      s.recent = s.recent.filter(value => value !== path)
      saveState()
      if (s.sidebarTab === 'recent') renderRecent()
      const next = existing ? tabs.removePath(path) : tabs.get()
      if (!editor.currentPath || editor.currentPath === path || tabs.indexOf(editor.currentPath) < 0) {
        editor.clear()
        runtime.currentFile = null
        if (next && next.path !== path) return openFileNow(next.path)
        closeFileUi()
      }
      showDocumentError('无法打开文件', error)
      return false
    }
    const text = cachedText(existing)
    if (existing?.dirty && existing.diskContent !== null && existing.diskContent !== diskContent) {
      const proceed = await window.mdr.confirm({ title: '文件在外部发生变化', message: '该标签页仍有未保存编辑。继续会保留这些编辑，请核对内容后再保存；保存会覆盖外部版本。', okLabel: '继续编辑' })
      if (!proceed) return false
    }
    // Reading the target or answering a conflict dialog can take time; flush any
    // input made in the current document during that wait before changing views.
    await captureCurrentDocument()
    const restored = !!existing?.editorJSON && (existing.dirty || !existing.stale && text === diskContent)
    const sess = tabs.activate(path, { newTab: opts?.newTab })
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
    if (scrollSaveTimer) { clearTimeout(scrollSaveTimer); scrollSaveTimer = null }
    runtime.currentFile = path
    session.lastFile = path
    session.recentFiles = [path, ...(Array.isArray(session.recentFiles) ? (session.recentFiles as string[]) : []).filter((x) => x !== path)].slice(0, 10)
    persistSession()
    void window.mdr.setWindowFile(path)
    tree.markSelected(path)
    if (restored) {
      const wasDirty = sess.dirty
      editor.setPath(path)
      try { editor.loadState(sess.editorJSON) }
      catch { editor.openFile(path, wasDirty && text !== null ? text : diskContent) }
      editor.setDirty(wasDirty)
    } else editor.openFile(path, diskContent)
    sess.diskContent = diskContent
    sess.stale = false
    const name = path.split('/').pop() ?? path
    fileTitle.textContent = name
    document.title = `${name} — 墨页 · Inkleaf`
    await renderPreview(previewScroll, preview, editor.getContent(), path)
    buildOutline(preview, outlineNav)
    updateActiveHeading(preview, outlineNav)
    const saved = restored ? sess.scrollY : getState().scrollByPath[path]
    const line = opts?.line ?? (opts?.anchor ? findHeadingLine(path, opts.anchor) : undefined)
    if (line) jumpToLine(line)
    else previewScroll.scrollTop = saved ?? 0
    tabs.capturePath(path, editor.exportState(), previewScroll.scrollTop, editor.isDirty())
    const s = getState()
    s.recent = [path, ...s.recent.filter((x) => x !== path)].slice(0, 10)
    saveState()
    if (s.sidebarTab === 'recent') renderRecent()
    updateBreadcrumb()
    void refreshBacklinks(runtime.currentFile)
    applyLayout()
    renderTabs()
    return true
  } catch (error) {
    showDocumentError('无法切换文档，当前编辑仍已保留', error)
    return false
  }
}

/** 外部删除/关闭书库：从 tab 集中管理角度清理当前文档 */
async function removeDeletedDocuments(path: string, directory = false): Promise<void> {
  const current = editor.currentPath
  const removesCurrent = current === path || !!current && directory && current.startsWith(path + '/')
  const next = tabs.removePath(path, directory)
  if (!removesCurrent) return
  // Never autosave a document back to a path that has just been deleted.
  editor.clear()
  runtime.currentFile = null
  if (next) await openFileNow(next.path)
  else closeFileUi()
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

function setSidebarTab(tab: 'files' | 'recent' | 'tags') {
  getState().sidebarTab = tab
  saveState()
  $('#tab-files').classList.toggle('active', tab === 'files')
  $('#tab-recent').classList.toggle('active', tab === 'recent')
  $('#tab-tags').classList.toggle('active', tab === 'tags')
  $('#tab-files').setAttribute('aria-pressed', String(tab === 'files'))
  $('#tab-recent').setAttribute('aria-pressed', String(tab === 'recent'))
  $('#tab-tags').setAttribute('aria-pressed', String(tab === 'tags'))
  treeHost.style.display = tab === 'files' ? '' : 'none'
  $('#recent-list').classList.toggle('visible', tab === 'recent')
  $('#tag-list').classList.toggle('visible', tab === 'tags')
  if (tab === 'recent') renderRecent()
  if (tab === 'tags') void renderTags()
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

/** 标签面板：聚合标签 → 点击展开该标签下的文档 */
async function renderTags(selectedTag?: string) {
  const host = $('#tag-list')
  host.innerHTML = ''
  const root = runtime.libraryRoot
  const tags = await window.mdr.indexTags().catch(() => [])
  if (!tags.length) {
    const empty = document.createElement('div')
    empty.className = 'recent-empty'
    empty.textContent = '暂无标签（在文档里写 #标签 或 frontmatter tags）'
    host.appendChild(empty)
    return
  }
  if (!selectedTag) {
    for (const { tag, count } of tags) {
      const item = document.createElement('div')
      item.className = 'tag-item'
      item.dataset.tag = tag
      item.innerHTML = `<span class="tg-name"></span><span class="tg-count">${count}</span>`
      ;(item.querySelector('.tg-name') as HTMLElement).textContent = tag
      item.addEventListener('click', () => void renderTags(tag))
      host.appendChild(item)
    }
    return
  }
  // selected: back button + files under this tag
  const back = document.createElement('div')
  back.className = 'tag-back'
  back.textContent = '‹ 全部标签'
  back.addEventListener('click', () => void renderTags())
  host.appendChild(back)
  const files = await window.mdr.indexFilesByTag(selectedTag).catch(() => [])
  if (!files.length) {
    const empty = document.createElement('div')
    empty.className = 'recent-empty'
    empty.textContent = '该标签下暂无文档'
    host.appendChild(empty)
    return
  }
  for (const p of files) {
    const item = document.createElement('div')
    item.className = 'tagfile-item'
    const name = p.split('/').pop() ?? p
    const dir = root && p.startsWith(root + '/') ? p.slice(root.length + 1, p.lastIndexOf('/')) : ''
    item.innerHTML = `<div class="ri-name"></div><div class="ri-dir"></div>`
    ;(item.querySelector('.ri-name') as HTMLElement).textContent = name
    ;(item.querySelector('.ri-dir') as HTMLElement).textContent = dir
    item.addEventListener('click', () => void openFile(p))
    host.appendChild(item)
  }
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

/** wikilink 锚点 → 源码行号（匹配标题文本） */
function findHeadingLine(path: string, anchor: string): number | undefined {
  const content = editor.getContent()
  if (!content || editor.currentPath !== path) return undefined
  const re = new RegExp('^#{1,6}\\s+' + anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm')
  const m = re.exec(content)
  if (!m) return undefined
  return content.slice(0, m.index).split('\n').length
}

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

function paletteOpts(newTab = false) {
  return {
    listFiles: () => window.mdr.listFiles(),
    searchText: (q: string, isRegex?: boolean) => window.mdr.searchText(q, isRegex),
    recent: () => getState().recent,
    libraryRoot: () => runtime.libraryRoot,
    onOpenFile: (p: string, line?: number) => void openFile(p, { line, newTab }),
  }
}

function openPaletteFor(mode: 'files' | 'search', newTab = false) {
  if (!runtime.libraryRoot) return
  openPalette(mode, paletteOpts(newTab))
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
  if (runtime.currentFile !== cur) return
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
  await serializeNavigation(async () => {
    editor.setMutationLocked(true)
    try {
      await saveAllDocuments()
      await window.mdr.closeLibrary()
      runtime.libraryRoot = null
      session.libraryRoot = null
      closeFileUi()
      tree.load([], true)
      const filterInput = $('#tree-filter-input') as HTMLInputElement
      filterInput.value = ''
      $('#library-name').textContent = '我的书库'
      libraryFailure = null
      updateLibraryFeedback()
      applyLayout()
    } catch (error) { showDocumentError('保存失败，书库仍保持打开', error) }
    finally { editor.setMutationLocked(false) }
  })
}

function registerBuiltinCommands() {
  // 文件
  registerCommand({ id: 'open-file', title: '打开文件…', run: () => void openFileAction() })
  registerCommand({ id: 'open-folder', title: '打开文件夹…', run: () => void openFolderAction() })
  registerCommand({ id: 'new-file', title: '新建文件', run: () => void newFileAction() })
  registerCommand({ id: 'save', title: '保存', run: () => void saveAllDocuments().catch(error => showDocumentError('保存失败', error)) })
  registerCommand({ id: 'close-library', title: '关闭书库', run: () => void closeLibrary() })
  registerCommand({ id: 'new-tab', title: '新标签页打开文件…', run: () => openPaletteFor('files', true), when: () => !!runtime.libraryRoot })
  registerCommand({ id: 'close-tab', title: '关闭标签页', run: () => void closeTabUi(tabs.activeIndex), when: () => tabs.count > 0 })
  registerCommand({ id: 'quick-switch', title: '快速切换文件', run: () => openPaletteFor('files'), when: () => !!runtime.libraryRoot })
  registerCommand({ id: 'search', title: '在书库中搜索', run: () => openPaletteFor('search'), when: () => !!runtime.libraryRoot })
  registerCommand({ id: 'export-pdf', title: '导出为 PDF…', run: () => void exportCurrent('pdf'), when: () => !!runtime.currentFile })
  registerCommand({ id: 'export-html', title: '导出为 HTML…', run: () => void exportCurrent('html'), when: () => !!runtime.currentFile })
  registerCommand({ id: 'insert-image', title: '插入图片…', run: () => void insertImageFrom(), when: () => !!runtime.currentFile })
  // 面板
  registerCommand({ id: 'toggle-sidebar', title: '切换书库栏', run: () => togglePane('sidebar') })
  registerCommand({ id: 'toggle-editor', title: '切换编辑面板', run: () => togglePane('editor') })
  registerCommand({ id: 'toggle-preview', title: '切换预览面板', run: () => togglePane('preview') })
  registerCommand({ id: 'toggle-outline', title: '切换大纲', run: () => togglePane('outline') })
  registerCommand({ id: 'toggle-backlink', title: '切换反向链接', run: () => togglePane('backlink') })
  // 主题与字号
  registerCommand({ id: 'theme-light', title: '浅色主题', run: () => setTheme('light') })
  registerCommand({ id: 'theme-sepia', title: '羊皮纸主题', run: () => setTheme('sepia') })
  registerCommand({ id: 'theme-green', title: '护眼绿主题', run: () => setTheme('green') })
  registerCommand({ id: 'theme-dark', title: '深色主题', run: () => setTheme('dark') })
  registerCommand({ id: 'theme-auto', title: '跟随系统主题', run: () => setTheme('auto') })
  registerCommand({ id: 'zoom-in', title: '放大字号', run: () => zoomFont(0.1) })
  registerCommand({ id: 'zoom-out', title: '缩小字号', run: () => zoomFont(-0.1) })
  registerCommand({ id: 'zoom-reset', title: '重置字号', run: () => applyFontScale(1) })
  // 格式
  registerCommand({ id: 'fmt-bold', title: '加粗', run: () => editor.toggleBold() })
  registerCommand({ id: 'fmt-italic', title: '斜体', run: () => editor.toggleItalic() })
  registerCommand({ id: 'fmt-code', title: '行内代码', run: () => editor.toggleInlineCode() })
  registerCommand({ id: 'fmt-codeblock', title: '代码块', run: () => editor.toggleCodeBlock() })
  registerCommand({ id: 'fmt-link', title: '链接', run: () => editor.insertLink() })
  // 专注与打字机
  registerCommand({ id: 'toggle-focus', title: '专注模式', run: () => { toggleFocusMode(); editor.setTypewriter(getState().typewriter) } })
  registerCommand({ id: 'toggle-typewriter', title: '打字机滚动', run: () => { toggleTypewriter(); editor.setTypewriter(getState().typewriter) } })
}

function setupActions() {
  // 工具栏与空状态按钮统一走命令分发
  $('#btn-open-folder').addEventListener('click', () => runCommand('open-folder'))
  $('#btn-open-file').addEventListener('click', () => runCommand('open-file'))
  $('#btn-new-file').addEventListener('click', () => runCommand('new-file'))
  $('#empty-open-folder').addEventListener('click', () => runCommand('open-folder'))
  $('#empty-open-file').addEventListener('click', () => runCommand('open-file'))
  $('#library-open-file').addEventListener('click', () => runCommand('open-file'))
  $('#library-new-file').addEventListener('click', () => runCommand('new-file'))
  $('#btn-toggle-sidebar').addEventListener('click', () => runCommand('toggle-sidebar'))
  $('#sidebar-collapse').addEventListener('click', () => runCommand('toggle-sidebar'))
  $('#sidebar-expand').addEventListener('click', () => runCommand('toggle-sidebar'))
  $('#btn-toggle-editor').addEventListener('click', () => runCommand('toggle-editor'))
  $('#btn-toggle-preview').addEventListener('click', () => runCommand('toggle-preview'))
  $('#btn-toggle-outline').addEventListener('click', () => runCommand('toggle-outline'))
  $('#btn-theme').addEventListener('click', () => cycleTheme())

  // 菜单 / Dock 菜单动作 → 命令注册表；open-path:<path> 为系统文件打开的专用通道
  window.mdr.onMenu((action) => {
    if (runCommand(action)) return
    if (action.startsWith('open-path:')) {
      const p = action.slice('open-path:'.length)
      void openFile(p)
    }
  })
}

function setupEditorCallbacks() {
  editor.onDirtyChange = (d) => {
    const current = editor.currentPath
    const tab = current ? tabs.get(tabs.indexOf(current)) : null
    if (tab) tab.dirty = d
    renderTabs()
    saveStateEl.textContent = d ? '● 未保存' : '已保存'
    saveStateEl.classList.toggle('dirty', d)
    const name = runtime.currentFile?.split('/').pop() ?? ''
    document.title = `${d ? '● ' : ''}${name} — 墨页 · Inkleaf`
    void window.mdr.setWindowEdited(d && !!runtime.currentFile)
  }
  editor.onSaveError = () => {
    saveStateEl.textContent = '● 保存失败，编辑仍已保留'
    saveStateEl.classList.add('dirty')
    renderTabs()
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
const fsEvents = new Map<string, { event: string; path: string }>()
function setupFsWatch() {
  window.mdr.onFsEvent((ev) => {
    fsEvents.set(ev.path, ev)
    if (fsTimer) clearTimeout(fsTimer)
    fsTimer = window.setTimeout(() => {
      fsTimer = null
      const pending = [...fsEvents.values()]
      fsEvents.clear()
      void serializeNavigation(async () => {
        if (runtime.libraryRoot) await tree.refresh()
        for (const event of pending) {
          if (event.event === 'unlink' || event.event === 'unlinkDir') {
            await removeDeletedDocuments(event.path, event.event === 'unlinkDir')
            continue
          }
          if (event.event !== 'change') continue
          const tab = tabs.get(tabs.indexOf(event.path))
          if (!tab) continue
          if (editor.lastSavedPath === event.path && Date.now() - editor.lastSavedAt < 2000) continue
          tabs.invalidate(event.path)
          if (editor.currentPath !== event.path || editor.isDirty()) continue
          try {
            const content = await window.mdr.readFile(event.path)
            if (editor.currentPath !== event.path || editor.isDirty()) continue
            const scroll = previewScroll.scrollTop
            editor.openFile(event.path, content)
            tab.diskContent = content
            tab.stale = false
            tabs.capturePath(event.path, editor.exportState(), scroll, false)
            await renderPreview(previewScroll, preview, content, event.path)
            buildOutline(preview, outlineNav)
            previewScroll.scrollTop = scroll
          } catch { /* A later unlink event or activation handles a vanished file. */ }
        }
      }).catch(error => showDocumentError('文件变化处理失败', error))
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
      void openFile(path)
    } else if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(path) && runtime.currentFile) {
      // drop an image straight into the document
      void insertImageFrom(path)
    }
  })
}

// ---------------- boot ----------------

async function boot() {
  setupPlatformUi()
  // 内置插件立即激活；外部插件通过沙箱声明注册。
  registerCalloutPlugin()
  void bootPlugins()
  applyTheme()
  applyFontScale(getState().fontScale)
  editor.mount(editorHost, currentTheme() === 'dark')
  onThemeChange((t) => editor.setDarkTheme(t === 'dark'))

  setupActions()
  registerBuiltinCommands()
  registerBuiltinPanels()
  attachPanelResizers(
    (id) => getState().widths[id] ?? getPanel(id)?.defaultWidth ?? 200,
    (id, w) => {
      getState().widths[id] = w
    },
    () => {
      saveState()
      applyLayout()
    },
  )
  editor.docNamesProvider = () => window.mdr.indexListNames()
  applyFocusModes()
  editor.setTypewriter(getState().typewriter)
  setupFocusHighlight(previewScroll, preview)
  setupEditorCallbacks()
  setupUpdater(() => serializeNavigation(saveAllDocuments))
  setupPreviewScroll()
  setupFsWatch()
  setupDragDrop()
  handleLinkClick(previewScroll, preview, (p) => void openFile(p))
  setWikilinkNav((p, anchor) => {
    void openFile(p, anchor ? { anchor } : undefined)
  })
  setBacklinkNav((p, opts) => void openFile(p, opts))
  setupLightbox(preview)

  $('#tab-files').addEventListener('click', () => setSidebarTab('files'))
  $('#tab-recent').addEventListener('click', () => setSidebarTab('recent'))
  $('#tab-tags').addEventListener('click', () => setSidebarTab('tags'))

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
  // test hook: dispatch any registered command by id
  document.addEventListener('mdr-test-command', (e) => {
    runCommand(String((e as CustomEvent).detail?.id ?? ''))
  })
  // test hook: type text into the editor at the cursor (drives CM input pipeline)
  document.addEventListener('mdr-test-type', (e) => {
    editor.focus()
    editor.typeText(String((e as CustomEvent).detail?.text ?? ''))
  })
  // test hook: (re)discover external plugins
  document.addEventListener('mdr-test-plugins-init', () => {
    void bootPlugins()
  })
  // test hook: re-render the current preview (plugin enable/disable verification)
  document.addEventListener('mdr-test-rerender', () => {
    void renderPreview(previewScroll, preview, editor.getContent(), runtime.currentFile)
  })

  // Files opened from the system file manager, command line, or recent files.
  window.mdr.onOpenPath((p) => {
    void openFile(p)
  })

  // 编辑器分隔条不属于面板注册表（编辑区宽度有专用逻辑），单独挂接
  attachEditorResizer()
  window.addEventListener('resize', applyLayout)

  setupSync(editor, previewScroll, () => {
    const c = getState().collapsed
    return !c.editor && !c.preview
  })

  tree.onOpenFile = (p, newTab) => void openFile(p, { newTab })
  tree.onCreated = (p) => void openFile(p)
  tree.onMutate = operation => serializeNavigation(async () => {
    editor.setMutationLocked(true)
    try {
      await saveAllDocuments()
      await operation()
    } finally { editor.setMutationLocked(false) }
  })
  tree.onRenamed = ({ oldPath, newPath, isDir }) => {
    const remap = (p: string | null): string | null => {
      if (!p) return null
      if (isDir) {
        if (p.startsWith(oldPath + '/')) return newPath + p.slice(oldPath.length)
        return null
      }
      return p === oldPath ? newPath : null
    }
    tabs.rename(oldPath, newPath, isDir)
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
  tree.onDeleted = async (path) => {
    await removeDeletedDocuments(path, true)
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
    window.mdr.rendererReady()
    return
  }

  session = await window.mdr.getSession()
  const savedRoot = session.libraryRoot
  const savedTabs = Array.isArray(session.tabs) ? (session.tabs as string[]).filter((t) => typeof t === 'string') : []
  const savedActiveIndex = typeof session.activeIndex === 'number' ? session.activeIndex : savedTabs.length - 1
  const savedLastFile = session.lastFile
  let restoredLibrary = true
  if (typeof savedRoot === 'string' && savedRoot) {
    restoredLibrary = await openLibrary(savedRoot, { restoreSession: true })
  }
  // 恢复上次会话的标签页集合（懒加载：仅激活页读内容）
  if (restoredLibrary && savedTabs.length) {
    tabs.restorePaths(savedTabs, savedActiveIndex)
    const activePath = tabs.activePath
    if (activePath) await openFile(activePath)
  } else if (restoredLibrary) {
    if (typeof savedLastFile === 'string' && savedLastFile) {
      await openFile(savedLastFile)
    }
  }
  window.mdr.rendererReady()
}

window.addEventListener('beforeunload', () => {
  void editor.saveNow().catch(error => console.error('Save during close failed', error))
})

void boot()
