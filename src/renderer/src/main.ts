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
import { setupPlatformUi } from './platform'
import { registerCommand, runCommand } from './commands'
import { applyFocusModes, toggleFocusMode, toggleTypewriter, setupFocusHighlight } from './focus'
import { setWikilinkNav } from './wikilink'
import { setBacklinkNav, refreshBacklinks } from './backlink'
import { TabManager } from './docSession'
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

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

/** 声明式注册侧栏面板：内置两块，插件面板同源（docs/04 §五 L4） */
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

/** tabbar 渲染：文件名 + 脏点 + 关闭按钮 */
function renderTabs() {
  const bar = document.getElementById('tabbar')
  if (!bar) return
  bar.innerHTML = ''
  const paths = tabs.paths()
  paths.forEach((p, i) => {
    const tab = document.createElement('div')
    tab.className = 'doc-tab' + (i === tabs.activeIndex ? ' active' : '') + (i === tabs.activeIndex && editor.isDirty() ? ' dirty' : '')
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
  if (!target || i === tabs.activeIndex) return
  await openFile(target.path)
}

async function closeTabUi(i: number): Promise<void> {
  const closing = tabs.get(i)
  if (!closing) return
  if (i === tabs.activeIndex) {
    if (editor.isDirty()) await editor.saveNow()
    tabs.capture(editor.exportState(), previewScroll.scrollTop, false)
  }
  const next = tabs.close(i)
  if (!next) {
    closeFileUi()
    return
  }
  await openFile(next.path)
}

/** 清空文档区 UI（所有标签已关或书库关闭时） */
function closeFileUi() {
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
  preview.innerHTML = ''
  outlineNav.innerHTML = ''
  fileTitle.textContent = ''
  document.title = '墨页 · Inkleaf'
  saveStateEl.textContent = ''
  updateBreadcrumb()
  void refreshBacklinks(null)
  applyLayout()
}

async function openFile(path: string, opts?: { line?: number; newTab?: boolean }): Promise<boolean> {
  if (opening) return false
  // 已是当前文件：仅跳转
  if (tabs.activePath === path && !opts?.newTab) {
    if (opts?.line) jumpToLine(opts.line)
    return true
  }
  opening = true
  try {
    // 切换前：保存并捕获当前 tab 状态
    if (tabs.activePath) {
      if (editor.isDirty()) await editor.saveNow()
      tabs.capture(editor.exportState(), previewScroll.scrollTop, false)
    }
    const sess = tabs.activate(path, { newTab: opts?.newTab })
    let restored = false
    if (sess.editorJSON) {
      // 内存态恢复（含撤销历史与滚动位置）
      editor.setPath(path)
      editor.loadState(sess.editorJSON)
      editor.setDirty(sess.dirty)
      restored = true
    }
    let content: string | null = restored ? editor.getContent() : null
    if (!restored) {
      try {
        content = await window.mdr.readFile(path)
      } catch {
        // file no longer exists — drop it from recent list and the tab
        const s = getState()
        s.recent = s.recent.filter((x) => x !== path)
        saveState()
        renderRecent()
        const idx = tabs.indexOf(path)
        if (idx >= 0) tabs.close(idx)
        return false
      }
    }
    runtime.currentFile = path
    session.lastFile = path
    session.recentFiles = [path, ...(Array.isArray(session.recentFiles) ? (session.recentFiles as string[]) : []).filter((x) => x !== path)].slice(0, 10)
    persistSession()
    void window.mdr.setWindowFile(path)
    tree.markSelected(path)
    if (!restored) editor.openFile(path, content!)
    const name = path.split('/').pop() ?? path
    fileTitle.textContent = name
    document.title = `${name} — 墨页 · Inkleaf`
    await renderPreview(previewScroll, preview, editor.getContent(), path)
    buildOutline(preview, outlineNav)
    updateActiveHeading(preview, outlineNav)
    const saved = restored ? sess.scrollY : getState().scrollByPath[path]
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
    void refreshBacklinks(runtime.currentFile)
    applyLayout()
    renderTabs()
    return true
  } finally {
    opening = false
  }
}

/** 外部删除/关闭书库：从 tab 集中管理角度清理当前文档 */
function closeFile() {
  const cur = runtime.currentFile
  const idx = cur ? tabs.indexOf(cur) : -1
  const next = idx >= 0 ? tabs.close(idx) : null
  if (next) {
    void openFile(next.path)
    return
  }
  closeFileUi()
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

function paletteOpts() {
  return {
    listFiles: () => window.mdr.listFiles(),
    searchText: (q: string, isRegex?: boolean) => window.mdr.searchText(q, isRegex),
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

function registerBuiltinCommands() {
  // 文件
  registerCommand({ id: 'open-file', title: '打开文件…', run: () => void openFileAction() })
  registerCommand({ id: 'open-folder', title: '打开文件夹…', run: () => void openFolderAction() })
  registerCommand({ id: 'new-file', title: '新建文件', run: () => void newFileAction() })
  registerCommand({ id: 'save', title: '保存', run: () => void editor.saveNow() })
  registerCommand({ id: 'close-library', title: '关闭书库', run: () => void closeLibrary() })
  registerCommand({ id: 'new-tab', title: '新标签页打开文件…', run: () => openPaletteFor('files'), when: () => !!runtime.libraryRoot })
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
  registerCommand({ id: 'toggle-backlink', title: '切换反向链接', run: () => togglePane('backlink' as PaneKey) })
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
      void (async () => {
        if (!runtime.libraryRoot) await openLibrary(p.slice(0, p.lastIndexOf('/')))
        await openFile(p)
      })()
    }
  })
}

function setupEditorCallbacks() {
  editor.onDirtyChange = (d) => {
    renderTabs()
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
  setupPlatformUi()
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
  applyFocusModes()
  editor.setTypewriter(getState().typewriter)
  setupFocusHighlight(previewScroll, preview)
  setupEditorCallbacks()
  setupUpdater(() => editor.saveNow())
  setupPreviewScroll()
  setupFsWatch()
  setupDragDrop()
  handleLinkClick(previewScroll, preview, (p) => void openFile(p))
  setWikilinkNav((p, anchor) => {
    void openFile(p, anchor ? { line: findHeadingLine(p, anchor) } : undefined)
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

  // Files opened from the system file manager, command line, or recent files.
  window.mdr.onOpenPath((p) => {
    void (async () => {
      if (!runtime.libraryRoot) await openLibrary(p.slice(0, p.lastIndexOf('/')))
      await openFile(p)
    })()
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
    window.mdr.rendererReady()
    return
  }

  session = await window.mdr.getSession()
  const savedRoot = session.libraryRoot
  if (typeof savedRoot === 'string' && savedRoot) {
    await openLibrary(savedRoot)
  }
  // 恢复上次会话的标签页集合（懒加载：仅激活页读内容）
  const savedTabs = Array.isArray(session.tabs) ? (session.tabs as string[]).filter((t) => typeof t === 'string') : []
  if (savedTabs.length) {
    tabs.restorePaths(savedTabs, typeof session.activeIndex === 'number' ? session.activeIndex : savedTabs.length - 1)
    const activePath = tabs.activePath
    if (activePath) await openFile(activePath)
  } else {
    const lastFile = session.lastFile
    if (typeof lastFile === 'string' && lastFile) {
      await openFile(lastFile)
    }
  }
  window.mdr.rendererReady()
}

window.addEventListener('beforeunload', () => {
  void editor.saveNow()
})

void boot()
