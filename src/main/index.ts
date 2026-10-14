import { app, BrowserWindow, Menu, protocol, net, shell, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { registerIpc, getLibraryRoot, rebuildDockMenu, stopWatch, flushSessionWrites } from './ipc'
import { registerPluginIpc, resolvePluginFile } from './plugins-host'
import { initializeUpdater } from './updater'
import { markdownFromArguments } from './openPath'
import { appImageTarget } from './linuxAppImage'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'mdasset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'inkplug', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

const RENDERER_ROOT = path.join(__dirname, 'renderer')
const readyWindows = new Set<number>()

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

// Keep the existing profile so rebranding preserves libraries, themes and recents.
app.setPath('userData', process.env.MDR_TEST
  ? path.join(app.getPath('temp'), `inkleaf-ui-${process.pid}`)
  : path.join(app.getPath('appData'), 'my-markdown-reader'))
app.setName('Inkleaf')

// Release filesystem resources before Chromium starts its shutdown sequence.
let closingResources = false, resourcesClosed = false
app.on('before-quit', event => {
  if (resourcesClosed) return
  event.preventDefault()
  if (closingResources) return
  closingResources = true
  if (process.env.MDR_TEST) console.log('[quit-check] stopping file watcher')
  void Promise.all([stopWatch(), flushSessionWrites()]).finally(() => {
    resourcesClosed = true
    if (process.env.MDR_TEST) console.log('[quit-check] watcher stopped')
    app.quit()
  })
})
if (process.env.MDR_TEST) {
  app.on('will-quit', () => console.log('[quit-check] all windows closed; will quit'))
  process.once('exit', code => console.log(`[quit-check] process exit ${code}`))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Linux desktop launchers pass files through argv; macOS uses open-file.
  let pendingOpenPath = process.platform === 'darwin' ? null
    : markdownFromArguments(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd())
  const deliverOpenPath = (p: string) => {
    const win = BrowserWindow.getAllWindows()[0]
    pendingOpenPath = p
    if (win && readyWindows.has(win.webContents.id)) {
      win.webContents.send('open-path', p)
      pendingOpenPath = null
    }
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  }
  ipcMain.on('app:renderer-ready', event => {
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url.split('?')[0] !== 'app://local/index.html') return
    readyWindows.add(event.sender.id)
    if (pendingOpenPath) {
      event.sender.send('open-path', pendingOpenPath)
      pendingOpenPath = null
    }
  })
  app.on('open-file', (event, p) => {
    event.preventDefault()
    deliverOpenPath(p)
  })

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const p = markdownFromArguments(argv.slice(app.isPackaged ? 1 : 2), workingDirectory)
    if (p) { deliverOpenPath(p); return }
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // serves the built renderer (index.html / js chunks / css / fonts)
    protocol.handle('app', (request) => {
      const u = new URL(request.url)
      let p = decodeURIComponent(u.pathname)
      if (p === '/' || p === '') p = '/index.html'
      const abs = path.normalize(path.join(RENDERER_ROOT, p))
      if (!abs.startsWith(RENDERER_ROOT + path.sep) && abs !== RENDERER_ROOT) {
        return new Response('forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(abs).toString())
    })

    // serves local images referenced from markdown, restricted to the current library root
    protocol.handle('mdasset', async (request) => {
      const u = new URL(request.url)
      const abs = path.normalize(decodeURIComponent(u.pathname))
      const root = getLibraryRoot()
      if (!root || !abs.startsWith(root + path.sep)) {
        return new Response('forbidden', { status: 403 })
      }
      try {
        const data = await fsp.readFile(abs)
        const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
        return new Response(new Uint8Array(data), { headers: { 'content-type': type } })
      } catch {
        return new Response('not found', { status: 404 })
      }
    })

    // External modules are served only into opaque sandbox frames. No host
    // renderer script permission or preload bridge is granted to plugin code.
    protocol.handle('inkplug', async (request) => {
      try {
        const u = new URL(request.url)
        const bootstrap = u.host === 'sandbox' && !u.username && !u.password && !u.search && !u.hash
          ? { '/index.html': 'plugin-sandbox.html', '/bootstrap.mjs': 'plugin-sandbox.mjs' }[u.pathname] : undefined
        const abs = bootstrap ? path.join(RENDERER_ROOT, bootstrap) : await resolvePluginFile(request.url)
        if (!abs) return new Response('forbidden', { status: 403 })
        const info = await fsp.stat(abs)
        if (!info.isFile() || info.size > 4 * 1024 * 1024) return new Response('forbidden', { status: 403 })
        return new Response(new Uint8Array(await fsp.readFile(abs)), { headers: {
          'content-type': bootstrap === 'plugin-sandbox.html' ? 'text/html; charset=utf-8'
            : path.extname(abs).toLowerCase() === '.json' ? 'application/json' : 'text/javascript; charset=utf-8',
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
        } })
      } catch { return new Response('not found', { status: 404 }) }
    })
    registerIpc()
    registerPluginIpc()
    if (process.env.MDR_TEST) void writeSamplePlugin()
    initializeUpdater()
    buildMenu()
    createWindow()
    if (app.dock) void rebuildDockMenu()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.env.MDR_TEST || process.platform !== 'darwin') app.quit()
})

async function createWindow() {
  // UI checks edit a private copy, keeping the source fixtures and real profile intact.
  const testLibrary = path.join(app.getPath('userData'), 'test-library')
  if (process.env.MDR_TEST) {
    await fsp.cp(path.resolve(process.cwd(), 'test-library'), testLibrary, { recursive: true })
  }
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 780,
    minHeight: 540,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 23 } }
      : { icon: path.join(__dirname, 'icon.png') }),
    title: '墨页 · Inkleaf',
    backgroundColor: '#fbf9f4',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const contentsId = win.webContents.id
  win.webContents.on('did-start-loading', () => readyWindows.delete(contentsId))
  win.webContents.once('destroyed', () => readyWindows.delete(contentsId))
  if (process.env.MDR_TEST) win.once('closed', () => console.log(`[quit-check] window ${contentsId} closed`))
  win.once('ready-to-show', () => win.show())
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message)
  })

  // external links open in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  const query = process.env.MDR_TEST
    ? `?test=1&lib=${encodeURIComponent(testLibrary)}`
    : ''
  await win.loadURL(`app://local/index.html${query}`)

  if (process.env.MDR_TEST) {
    // give the renderer time to load the library, render markdown + mermaid, then capture proof
    const round = process.env.MDR_ROUND ?? '0'
    setTimeout(async () => {
      let failed = false
      const injectedCheck = process.env.MDR_TEST_FAIL_CHECK
      const assertUiCheck = (name: string, passed: unknown, details: unknown): void => {
        if (injectedCheck === name) {
          console.log(`[ui-failure-injection] ${name}`)
          passed = false
        }
        if (passed !== true) throw new Error(`[ui-check-failed] ${name}: ${JSON.stringify(details)}`)
      }
      try {
        if (injectedCheck && !['render', 'focus', 'index', 'wikilink', 'backlink', 'tag', 'tab', 'completion', 'plugin', 'stability', 'regex'].includes(injectedCheck)) {
          throw new Error('Unknown MDR_TEST_FAIL_CHECK selector')
        }
        const expectedPlatform = process.platform
        const expectedShortcut = process.platform === 'darwin' ? '⌘O' : 'Ctrl+O'
        const platformOk = await win.webContents.executeJavaScript(`(() => {
          return window.mdr.platform === ${JSON.stringify(expectedPlatform)}
            && document.body.dataset.platform === ${JSON.stringify(expectedPlatform)}
            && window.mdr.sandboxed === true
            && typeof window.mdr.readFile === 'function'
            && document.getElementById('btn-open-file').title.includes(${JSON.stringify(expectedShortcut)});
        })()`)
        if (!platformOk || !readyWindows.has(win.webContents.id)
          || app.commandLine.hasSwitch('no-sandbox') || app.commandLine.hasSwitch('disable-setuid-sandbox')) {
          throw new Error('Platform shortcuts, isolated preload or sandbox startup failed')
        }
        if (process.platform === 'linux' && app.isPackaged) {
          const kind = process.env.APPIMAGE ? 'appimage' : 'deb'
          const actualKind = await win.webContents.executeJavaScript('window.mdr.getUpdateState().then(state => state.installationKind)')
          if (actualKind !== kind) throw new Error('Linux installation type was not detected correctly')
          if (kind === 'appimage') await appImageTarget(process.env.APPIMAGE, process.arch)
          console.log(`[installation-check] ${kind} update mode OK`)
        }
        console.log(`[platform-check] ${expectedPlatform} shortcuts, preload and sandbox OK`)
        const dir = path.join(process.cwd(), 'verify')
        fs.mkdirSync(dir, { recursive: true })
        await win.webContents.executeJavaScript(`document.dispatchEvent(new CustomEvent('mdr-test-theme', {detail: {theme: 'light'}}))`)
        await new Promise((r) => setTimeout(r, 500))
        const img = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}.png`), img.toPNG())
        win.webContents.send('menu', 'close-library')
        await new Promise((r) => setTimeout(r, 500))
        const welcomeOk = await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('empty-state')).display === 'flex'`)
        if (!welcomeOk) throw new Error('Welcome screen did not appear after closing the library')
        fs.writeFileSync(path.join(dir, `round${round}-welcome.png`), (await win.webContents.capturePage()).toPNG())
        win.setSize(780, 540)
        await new Promise((r) => setTimeout(r, 500))
        fs.writeFileSync(path.join(dir, `round${round}-welcome-small.png`), (await win.webContents.capturePage()).toPNG())
        win.webContents.send('open-path', path.join(testLibrary, 'README.md'))
        await new Promise((r) => setTimeout(r, 1600))
        const layoutOk = await win.webContents.executeJavaScript(`(() => {
          const preview = document.getElementById('preview-pane').getBoundingClientRect();
          const toolbar = document.getElementById('toolbar').getBoundingClientRect();
          const footer = document.getElementById('statusbar').getBoundingClientRect();
          return preview.width >= 250 && toolbar.right <= innerWidth && document.body.scrollWidth <= innerWidth
            && footer.bottom <= innerHeight && footer.top >= innerHeight - 31
            && !!document.querySelector('#preview-scroll > #preview.md-preview');
        })()`)
        if (!layoutOk) throw new Error('Small-window layout overflow')
        console.log('[layout-check] OK at 780x540')
        fs.writeFileSync(path.join(dir, `round${round}-small.png`), (await win.webContents.capturePage()).toPNG())
        win.setSize(1360, 880)
        await new Promise((r) => setTimeout(r, 500))
        // large-document performance probe: open the big fixture, log render timings, capture, go back
        await win.webContents.executeJavaScript(
          `document.querySelector('.tree-row[data-path$="大文档.md"]')?.click()`,
        )
        await new Promise((r) => setTimeout(r, 4500))
        const bigShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-big.png`), bigShot.toPNG())
        // simulate a keystroke in the big doc: re-render should hit the mermaid cache, then undo
        await win.webContents.executeJavaScript(`
          (() => {
            document.querySelector('.cm-content')?.focus();
            document.execCommand('insertText', false, 'x');
            return true
          })()
        `)
        await new Promise((r) => setTimeout(r, 1600))
        await win.webContents.executeJavaScript(`document.execCommand('undo')`)
        await new Promise((r) => setTimeout(r, 3200))
        await win.webContents.executeJavaScript(
          `document.querySelector('.tree-row[data-path$="README.md"]')?.click()`,
        )
        await new Promise((r) => setTimeout(r, 1500))
        // exercise the image lightbox: click the first preview image, then capture again
        await win.webContents.executeJavaScript(
          `!!document.querySelector('#preview .md-preview img, #preview img')`,
        )
        await win.webContents.executeJavaScript(
          `document.querySelector('#preview img')?.dispatchEvent(new MouseEvent('click', {bubbles: true}))`,
        )
        await new Promise((r) => setTimeout(r, 600))
        const lb = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-lightbox.png`), lb.toPNG())
        // verify task checkbox write-back: close lightbox, click an unchecked box, re-render should check it
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`,
        )
        await new Promise((r) => setTimeout(r, 250))
        const before = await win.webContents.executeJavaScript(
          `document.querySelectorAll('#preview input[type=checkbox]:checked').length`,
        )
        await win.webContents.executeJavaScript(
          `(() => { const cb = document.querySelector('#preview input[type=checkbox]'); if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', {bubbles: true})) } return !!cb })()`,
        )
        await new Promise((r) => setTimeout(r, 1000))
        const after = await win.webContents.executeJavaScript(
          `document.querySelectorAll('#preview input[type=checkbox]:checked').length`,
        )
        const toggled = Math.abs(Number(after) - Number(before)) === 1
        // restore the fixture state we just toggled (wait out the 2s autosave debounce)
        await win.webContents.executeJavaScript(
          `(() => { const cb = document.querySelector('#preview input[type=checkbox]'); if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', {bubbles: true})) } })()`,
        )
        await new Promise((r) => setTimeout(r, 2600))
        console.log(`[task-check] before=${before} after=${after} ${toggled ? 'OK' : 'FAIL'}`)
        if (!toggled) throw new Error('Task checkbox did not update the source')
        const task = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-task.png`), task.toPNG())
        // exercise the new navigation: recent-files tab and outline folding
        await win.webContents.executeJavaScript(
          `document.getElementById('tab-recent')?.click()`,
        )
        await new Promise((r) => setTimeout(r, 400))
        const recent = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-recent.png`), recent.toPNG())
        await win.webContents.executeJavaScript(`
          document.getElementById('tab-files')?.click();
          setTimeout(() => document.querySelector('.outline-item.has-children .ol-disc')?.click(), 200)
        `)
        await new Promise((r) => setTimeout(r, 700))
        const outlineShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-outline.png`), outlineShot.toPNG())
        // file tree filter screenshot
        await win.webContents.executeJavaScript(`
          (() => { const i = document.getElementById('tree-filter-input'); i.value = '旅行'; i.dispatchEvent(new Event('input', {bubbles: true})) })()
        `)
        await new Promise((r) => setTimeout(r, 350))
        const filterShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-filter.png`), filterShot.toPNG())
        await win.webContents.executeJavaScript(`
          (() => { const i = document.getElementById('tree-filter-input'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles: true})) })()
        `)
        // rename e2e: context menu -> 重命名 -> inline input -> Enter
        const libPath = testLibrary
        const renameResult = await win.webContents.executeJavaScript(`
          (async () => {
            const folderRow = document.querySelector('.tree-row[data-path$="/笔记"]');
            if (folderRow && !folderRow.querySelector('.disclosure')?.textContent?.includes('▾')) {
              folderRow.dispatchEvent(new MouseEvent('click', {bubbles: true}));
              await new Promise(r => setTimeout(r, 250));
            }
            const row = document.querySelector('.tree-row[data-path$="旅行计划.md"]');
            if (!row) return 'no-row';
            row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 120, clientY: 240}));
            await new Promise(r => setTimeout(r, 200));
            const item = [...document.querySelectorAll('.ctx-item')].find(b => b.textContent === '重命名');
            if (!item) return 'no-menu-item';
            item.click();
            await new Promise(r => setTimeout(r, 250));
            const input = document.querySelector('.tree-input');
            if (!input) return 'no-input';
            input.value = '旅行计划-备份.md';
            input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            await new Promise(r => setTimeout(r, 900));
            return document.querySelector('.tree-row[data-path$="旅行计划-备份.md"]') ? 'renamed-ok' : 'renamed-fail';
          })()
        `)
        console.log(`[rename-check] ${renameResult}`)
        // restore the original name via direct IPC (chokidar refreshes the tree)
        await win.webContents.executeJavaScript(
          `window.mdr.rename(${JSON.stringify(`${libPath}/笔记/旅行计划-备份.md`)}, ${JSON.stringify(`${libPath}/笔记/旅行计划.md`)})`,
        )
        await new Promise((r) => setTimeout(r, 800))
        // quick switcher (⌘P): fuzzy filename search + Enter to open
        const paletteResult = await win.webContents.executeJavaScript(`
          (async () => {
            document.dispatchEvent(new CustomEvent('mdr-test-palette', {detail: {mode: 'files'}}));
            await new Promise(r => setTimeout(r, 400));
            const input = document.querySelector('.palette-input');
            if (!input) return 'no-input';
            input.value = '旅行';
            input.dispatchEvent(new Event('input', {bubbles: true}));
            await new Promise(r => setTimeout(r, 450));
            const row = document.querySelector('.pal-row');
            if (!row) return 'no-results';
            return row.querySelector('.pal-name')?.textContent ?? 'no-name';
          })()
        `)
        console.log(`[palette-check] top-result=${paletteResult}`)
        const paletteShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-palette.png`), paletteShot.toPNG())
        const paletteOpen = await win.webContents.executeJavaScript(`
          (async () => {
            document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            await new Promise(r => setTimeout(r, 700));
            return document.getElementById('file-title')?.textContent;
          })()
        `)
        console.log(`[palette-open] opened=${paletteOpen}`)
        // full-text search (⇧⌘F)
        await win.webContents.executeJavaScript(`
          (() => {
            document.dispatchEvent(new CustomEvent('mdr-test-palette', {detail: {mode: 'search'}}));
            setTimeout(() => {
              const input = document.querySelector('.palette-input');
              if (input) { input.value = '预算'; input.dispatchEvent(new Event('input', {bubbles: true})) }
            }, 350);
            return true
          })()
        `)
        await new Promise((r) => setTimeout(r, 900))
        const searchShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-search.png`), searchShot.toPNG())
        await win.webContents.executeJavaScript(
          `document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`,
        )
        // export end-to-end: reopen README.md (has math/mermaid/image) and export to the system temp dir
        await win.webContents.executeJavaScript(
          `document.querySelector('.tree-row[data-path$="README.md"]')?.click()`,
        )
        await new Promise((r) => setTimeout(r, 1200))
        const tmpDir = app.getPath('temp')
        const pdfPath = path.join(tmpDir, `mdr-round${round}-export.pdf`)
        const htmlPath = path.join(tmpDir, `mdr-round${round}-export.html`)
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent('mdr-test-export', {detail: ${JSON.stringify({ kind: 'pdf', path: pdfPath })}}))`,
        )
        await new Promise((r) => setTimeout(r, 7000))
        const pdfOk = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 20000
        console.log(`[export-pdf] ${pdfOk ? 'OK' : 'FAIL'} size=${fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0}`)
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent('mdr-test-export', {detail: ${JSON.stringify({ kind: 'html', path: htmlPath })}}))`,
        )
        await new Promise((r) => setTimeout(r, 2500))
        const htmlOk = fs.existsSync(htmlPath) && fs.statSync(htmlPath).size > 10000
        const htmlText = htmlOk ? fs.readFileSync(htmlPath, 'utf8') : ''
        const htmlEmbedded =
          htmlText.includes('data:application/octet-stream') ||
          htmlText.includes('data:font/') ||
          htmlText.includes('data:image/')
        console.log(`[export-html] ${htmlOk ? 'OK' : 'FAIL'} size=${fs.existsSync(htmlPath) ? fs.statSync(htmlPath).size : 0} embedded=${htmlEmbedded}`)
        // drag-and-drop move: 旅行计划.md -> 笔记/技术, verify, then move back
        const dragResult = await win.webContents.executeJavaScript(`
          (async () => {
            const folderRow = document.querySelector('.tree-row[data-path$="/笔记"]');
            if (folderRow && !folderRow.querySelector('.disclosure')?.textContent?.includes('▾')) {
              folderRow.dispatchEvent(new MouseEvent('click', {bubbles: true}));
              await new Promise(r => setTimeout(r, 300));
            }
            const src = document.querySelector('.tree-row[data-path$="旅行计划.md"]');
            const dst = document.querySelector('.tree-row[data-path$="/技术"]');
            if (!src || !dst) return 'no-rows';
            const dt = new DataTransfer();
            dt.setData('application/x-mdr-tree', ${JSON.stringify(`${libPath}/笔记/旅行计划.md`)});
            src.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
            dst.dispatchEvent(new DragEvent('drop', {bubbles: true, dataTransfer: dt}));
            await new Promise(r => setTimeout(r, 900));
            // the target folder may be collapsed — expand it before asserting the moved row exists
            if (dst && !dst.querySelector('.disclosure')?.textContent?.includes('▾')) {
              dst.dispatchEvent(new MouseEvent('click', {bubbles: true}));
              await new Promise(r => setTimeout(r, 400));
            }
            return document.querySelector('.tree-row[data-path$="技术/旅行计划.md"]') ? 'moved-ok' : 'moved-fail';
          })()
        `)
        console.log(`[drag-check] ${dragResult}`)
        await win.webContents.executeJavaScript(
          `window.mdr.rename(${JSON.stringify(`${libPath}/笔记/技术/旅行计划.md`)}, ${JSON.stringify(`${libPath}/笔记/旅行计划.md`)})`,
        )
        await new Promise((r) => setTimeout(r, 800))
        // mermaid text labels: scroll to the first diagram and capture it
        await win.webContents.executeJavaScript(
          `document.querySelector('#preview .mermaid-block')?.scrollIntoView({block: 'center'})`,
        )
        await new Promise((r) => setTimeout(r, 400))
        const mermaidShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-mermaid.png`), mermaidShot.toPNG())
        // --- debug: inspect mermaid svg structure on the decision-flow doc ---
        await win.webContents.executeJavaScript(
          `document.querySelector('.tree-row[data-path$="算法笔记.md"]')?.click()`,
        )
        await new Promise((r) => setTimeout(r, 2500))
        const mermaidDebug = await win.webContents.executeJavaScript(`
          (() => {
            const blocks = [...document.querySelectorAll('.mermaid-block')];
            const b = blocks[0];
            if (!b) return 'no-block';
            const svg = b.querySelector('svg');
            return JSON.stringify({
              blocks: blocks.length,
              hasSvg: !!svg,
              foreignObject: svg?.querySelectorAll('foreignObject').length ?? 0,
              foDivs: svg?.querySelectorAll('foreignObject div').length ?? 0,
              textEls: svg?.querySelectorAll('text').length ?? 0,
              tspans: svg?.querySelectorAll('tspan').length ?? 0,
              nodeTexts: [...(svg?.querySelectorAll('g.node text') ?? [])].map(t => t.textContent).slice(0, 6),
              edgeTexts: [...(svg?.querySelectorAll('g.edgeLabel text') ?? [])].map(t => t.textContent).slice(0, 6),
              foDivTexts: [...(svg?.querySelectorAll('foreignObject div') ?? [])].map(d => d.textContent).slice(0, 6)
            });
          })()
        `)
        console.log('[mermaid-debug]', mermaidDebug)
        await win.webContents.executeJavaScript(
          `document.querySelector('.tree-row[data-path$="README.md"]')?.click()`,
        )
        await new Promise((r) => setTimeout(r, 1200))
        await win.webContents.executeJavaScript(
          `document.querySelector('#preview')?.scrollTo?.(0, 0); document.getElementById('preview-scroll')?.scrollTo(0, 0)`,
        )
        // collapse the preview pane: the editor must fill the freed space
        await win.webContents.executeJavaScript(`document.getElementById('btn-toggle-preview')?.click()`)
        await new Promise((r) => setTimeout(r, 400))
        const collapsedShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-nopreview.png`), collapsedShot.toPNG())
        await win.webContents.executeJavaScript(`document.getElementById('btn-toggle-preview')?.click()`)
        await new Promise((r) => setTimeout(r, 400))
        // insert-image flow: copy sample.png into assets, reference at cursor, verify preview picks it up
        const insertResult = await win.webContents.executeJavaScript(`
          (async () => {
            const path = ${JSON.stringify(`${libPath}/README.md`)};
            const before = await window.mdr.readFile(path);
            const imgsBefore = document.querySelectorAll('#preview img').length;
            document.dispatchEvent(new CustomEvent('mdr-test-insert-image', {detail: {src: ${JSON.stringify(`${libPath}/assets/sample.png`)}}}));
            await new Promise(r => setTimeout(r, 1200));
            const imgsAfter = document.querySelectorAll('#preview img').length;
            await window.mdr.writeFile(path, before);
            return JSON.stringify({imgsBefore, imgsAfter, ok: imgsAfter === imgsBefore + 1});
          })()
        `)
        console.log(`[insert-image-check] ${insertResult}`)
        // render-completeness check: callout / footnote / definition list
        const renderCheck = await win.webContents.executeJavaScript(`
          (() => {
            const callout = document.querySelector('#preview blockquote.md-callout')
            const warn = document.querySelector('#preview blockquote.md-callout-warning')
            const footnoteRef = document.querySelector('#preview .footnote-ref, #preview sup a.footnote-ref')
            const footnotes = document.querySelector('#preview .footnotes, #preview section.footnotes')
            const deflist = document.querySelector('#preview dl')
            const mermaidBlocks = document.querySelectorAll('#preview .mermaid-block').length
            return JSON.stringify({
              callout: !!callout,
              title: callout?.getAttribute('data-callout-title') ?? null,
              warning: !!warn,
              footnote: !!footnoteRef,
              footnotes: !!footnotes,
              deflist: !!deflist,
              mermaid: mermaidBlocks,
            })
          })()
        `)
        const rc = JSON.parse(renderCheck)
        console.log(`[render-check] callout=${rc.callout} title=${rc.title} warning=${rc.warning} footnote=${rc.footnote}/${rc.footnotes} deflist=${rc.deflist} mermaid=${rc.mermaid} ${rc.callout && rc.warning && rc.footnote && rc.footnotes && rc.deflist && rc.mermaid >= 2 ? 'OK' : 'FAIL'}`)
        assertUiCheck('render', rc.callout && rc.warning && rc.footnote && rc.footnotes && rc.deflist && rc.mermaid >= 2, rc)
        // focus & typewriter mode check
        const focusCheck = await win.webContents.executeJavaScript(`
          (async () => {
            document.dispatchEvent(new CustomEvent('mdr-test-command', {detail: {id: 'toggle-focus'}}));
            await new Promise(r => setTimeout(r, 400));
            const focus = document.body.classList.contains('focus-mode');
            document.dispatchEvent(new CustomEvent('mdr-test-command', {detail: {id: 'toggle-typewriter'}}));
            await new Promise(r => setTimeout(r, 250));
            const tw = document.body.classList.contains('typewriter-mode');
            return JSON.stringify({focus, typewriter: tw});
          })()
        `)
        console.log(`[focus-check] ${focusCheck}`)
        const fc = JSON.parse(focusCheck)
        assertUiCheck('focus', fc.focus && fc.typewriter, fc)
        // document index check: tags / wikilinks / backlinks
        const indexCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const tags = await window.mdr.indexTags();
              const backlinks = await window.mdr.indexBacklinks('云南七日游');
              const resolve = await window.mdr.indexResolve('算法笔记');
              const tagNames = (tags || []).map(t => t.tag);
              return JSON.stringify({
                hasTravel: tagNames.includes('旅行'),
                hasYunnan: tagNames.includes('云南'),
                hasBudget: tagNames.includes('预算'),
                backlinks: (backlinks || []).length,
                backlinkFrom: (backlinks || [])[0]?.path?.split('/').pop() ?? null,
                resolveOk: typeof resolve === 'string' && resolve.endsWith('算法笔记.md'),
              });
            } catch (err) {
              return JSON.stringify({ error: String(err) });
            }
          })()
        `)
        const ic = JSON.parse(indexCheck)
        const icOk = ic.hasTravel && ic.hasYunnan && ic.hasBudget && ic.backlinks >= 1 && ic.resolveOk
        console.log(`[index-check] travel=${ic.hasTravel} yunnan=${ic.hasYunnan} budget=${ic.hasBudget} backlinks=${ic.backlinks}(${ic.backlinkFrom}) resolve=${ic.resolveOk} ${icOk ? 'OK' : 'FAIL'}`)
        assertUiCheck('index', icOk, ic)
        // wikilink check: render / click-to-open / hover preview card
        const wikilinkCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const links = document.querySelectorAll('#preview a[data-wikilink]');
              const first = links[0];
              const rendered = links.length >= 3 && !!first && first.textContent.trim() === '旅行计划';
              let opened = false;
              if (first) {
                first.click();
                await new Promise(r => setTimeout(r, 1200));
                opened = (document.getElementById('file-title')?.textContent ?? '') === '旅行计划.md';
              }
              // hover preview card on the current doc's wikilink (旅行计划 has none — go back to README first)
              let hovered = false;
              if (opened) {
                document.querySelector('.tree-row[data-path$="README.md"]')?.click();
                await new Promise(r => setTimeout(r, 1200));
                const target = document.querySelector('#preview a[data-wikilink]');
                if (target) {
                  for (let i = 0; i < 20 && !target.dataset.wikilinkPath; i++) {
                    await new Promise(r => setTimeout(r, 60));
                  }
                  target.dispatchEvent(new MouseEvent('mouseenter', {bubbles: false}));
                  await new Promise(r => setTimeout(r, 1200));
                  hovered = !!document.querySelector('.wikilink-card');
                  document.querySelector('.wikilink-card')?.remove();
                }
              }
              return JSON.stringify({count: links.length, rendered, opened, hovered});
            } catch (err) {
              return JSON.stringify({error: String(err)});
            }
          })()
        `)
        const wl = JSON.parse(wikilinkCheck)
        console.log(`[wikilink-check] count=${wl.count} rendered=${wl.rendered} opened=${wl.opened} hoverCard=${wl.hovered} ${wl.rendered && wl.opened && wl.hovered ? 'OK' : 'FAIL'}`)
        assertUiCheck('wikilink', wl.rendered && wl.opened && wl.hovered, wl)
        // backlink panel check: open 旅行计划 (linked from README), panel lists the reference
        const backlinkCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              document.querySelector('.tree-row[data-path$="旅行计划.md"]')?.click();
              await new Promise(r => setTimeout(r, 1500));
              const pane = document.getElementById('backlink-pane');
              const items = pane ? pane.querySelectorAll('.backlink-item') : [];
              const firstText = items[0]?.textContent ?? '';
              let jumped = false;
              if (items[0]) {
                items[0].click();
                await new Promise(r => setTimeout(r, 1200));
                jumped = (document.getElementById('file-title')?.textContent ?? '') === 'README.md';
              }
              return JSON.stringify({paneExists: !!pane, count: items.length, mentionsReadme: firstText.includes('README'), jumped});
            } catch (err) {
              return JSON.stringify({error: String(err)});
            }
          })()
        `)
        const bl = JSON.parse(backlinkCheck)
        console.log(`[backlink-check] pane=${bl.paneExists} count=${bl.count} readme=${bl.mentionsReadme} jump=${bl.jumped} ${bl.paneExists && bl.count >= 1 && bl.mentionsReadme && bl.jumped ? 'OK' : 'FAIL'}`)
        assertUiCheck('backlink', bl.paneExists && bl.count >= 1 && bl.mentionsReadme && bl.jumped, bl)
        // tag panel check: third sidebar tab lists index tags, click filters to files
        const tagCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              document.getElementById('tab-tags')?.click();
              await new Promise(r => setTimeout(r, 500));
              const pane = document.getElementById('tag-list');
              const items = pane ? pane.querySelectorAll('.tag-item') : [];
              const texts = [...items].map(i => i.dataset.tag ?? '');
              const hasTravel = texts.includes('旅行');
              let filtered = false;
              if (hasTravel) {
                [...items].find(i => i.dataset.tag === '旅行')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
                await new Promise(r => setTimeout(r, 600));
                const files = [...document.querySelectorAll('#tag-list .tagfile-item')].map(f => f.textContent ?? '');
                filtered = files.some(t => t.includes('旅行计划'));
              }
              document.getElementById('tab-files')?.click();
              await new Promise(r => setTimeout(r, 300));
              return JSON.stringify({paneExists: !!pane, count: items.length, hasTravel, filtered, texts: texts.slice(0, 6)});
            } catch (err) {
              return JSON.stringify({error: String(err)});
            }
          })()
        `)
        const tg = JSON.parse(tagCheck)
        console.log(`[tag-check] pane=${tg.paneExists} count=${tg.count} travel=${tg.hasTravel} filtered=${tg.filtered} tags=${JSON.stringify(tg.texts)} ${tg.paneExists && tg.hasTravel && tg.filtered ? 'OK' : 'FAIL'}`)
        assertUiCheck('tag', tg.paneExists && tg.hasTravel && tg.filtered, tg)
        // multi-tab check: cmd-click opens a new tab, switching restores, close works
        const tabCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const bar = document.getElementById('tabbar');
              const initial = bar ? bar.querySelectorAll('.doc-tab').length : -1;
              // ⌘-click the tree file → new tab
              const row = document.querySelector('.tree-row[data-path$="旅行计划.md"]');
              row?.dispatchEvent(new MouseEvent('click', {bubbles: true, metaKey: true}));
              await new Promise(r => setTimeout(r, 1500));
              const afterOpen = bar ? bar.querySelectorAll('.doc-tab').length : -1;
              const activeTitle = (document.getElementById('file-title')?.textContent ?? '');
              // click back to the first tab
              const tabs = bar ? [...bar.querySelectorAll('.doc-tab')] : [];
              tabs[0]?.click();
              await new Promise(r => setTimeout(r, 900));
              const backTitle = (document.getElementById('file-title')?.textContent ?? '');
              // close the second tab via its close button
              const closeBtns = bar ? [...bar.querySelectorAll('.doc-tab .tab-close')] : [];
              const beforeClose = bar ? bar.querySelectorAll('.doc-tab').length : -1;
              if (closeBtns[1]) closeBtns[1].click();
              await new Promise(r => setTimeout(r, 900));
              const afterClose = bar ? bar.querySelectorAll('.doc-tab').length : -1;
              const afterCloseTitle = document.getElementById('file-title')?.textContent ?? '';
              return JSON.stringify({bar: !!bar, initial, afterOpen, activeTitle, backTitle, beforeClose, afterClose, afterCloseTitle});
            } catch (err) {
              return JSON.stringify({error: String(err)});
            }
          })()
        `)
        const tb = JSON.parse(tabCheck)
        const tabOk = tb.bar && tb.initial === 1 && tb.afterOpen === 2 && tb.activeTitle === '旅行计划.md' && tb.backTitle === 'README.md' && tb.afterClose === 1 && tb.afterCloseTitle === 'README.md'
        console.log(`[tab-check] bar=${tb.bar} initial=${tb.initial} open=${tb.afterOpen}(${tb.activeTitle}) back=${tb.backTitle} close=${tb.beforeClose}->${tb.afterClose} ${tabOk ? 'OK' : 'FAIL'}`)
        assertUiCheck('tab', tabOk, tb)
        // [[ completion check: typing [[ in the editor offers document names; original content restored after
        const readmePath4Restore = path.join(testLibrary, 'README.md')
        const readmeBefore = fs.readFileSync(readmePath4Restore, 'utf8')
        const completionCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const cm = document.querySelector('.cm-content');
              if (!cm) return JSON.stringify({focused: false});
              cm.focus();
              document.dispatchEvent(new CustomEvent('mdr-test-type', {detail: {text: '[['}}));
              await new Promise(r => setTimeout(r, 1800));
              const tooltip = document.querySelector('.cm-tooltip-autocomplete');
              const options = [...(tooltip?.querySelectorAll('li') ?? [])].map(li => li.textContent ?? '');
              return JSON.stringify({tooltip: !!tooltip, options: options.slice(0, 6)});
            } catch (err) {
              return JSON.stringify({error: String(err)});
            }
          })()
        `)
        // 还原文档：编辑器中残留的 [[ 不落盘（先停自动保存风险——直接写回原文并让 fs 事件重载）
        await win.webContents.executeJavaScript(
          `window.mdr.writeFile(${JSON.stringify(readmePath4Restore)}, ${JSON.stringify(readmeBefore)})`,
        ).catch(() => {})
        const cc = JSON.parse(completionCheck)
        const ccOk = cc.tooltip && (cc.options || []).some((o: string) => o.includes('旅行计划'))
        console.log(`[completion-check] tooltip=${cc.tooltip} options=${JSON.stringify(cc.options)} ${ccOk ? 'OK' : 'FAIL'}`)
        assertUiCheck('completion', ccOk, cc)
        // plugin runtime check: sample plugin loads, contributes a command, runs; callout dogfood disable/enable
        const pluginCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              document.dispatchEvent(new CustomEvent('mdr-test-plugins-init'));
              await new Promise(r => setTimeout(r, 1200));
              const runtimeReady = !!window.ink;
              const listed = runtimeReady ? await window.mdr.pluginsList() : [];
              const hello = (listed || []).find(p => p.id === 'hello-inkleaf');
              const probe = (listed || []).find(p => p.id === 'bridge-probe');
              const probeActivated = !!probe && await window.ink.activate('bridge-probe');
              const bridgeProbe = probeActivated && window.ink.list().some(p => p.id === 'bridge-probe' && p.state === 'active');
              let activated = false, ran = false;
              if (hello) {
                activated = await window.ink.activate('hello-inkleaf');
                document.dispatchEvent(new CustomEvent('mdr-test-command', {detail: {id: 'hello-inkleaf.hello'}}));
                await new Promise(r => setTimeout(r, 600));
                document.dispatchEvent(new CustomEvent('mdr-test-rerender'));
                await new Promise(r => setTimeout(r, 900));
                ran = !!document.querySelector('#preview [data-plugin-demo="1"]');
              }
              // dogfood: disable the internal callout plugin, re-render, callout must disappear
              let disableWorks = false, reenableWorks = false;
              if (runtimeReady) {
                window.ink.disable('bundled.callout');
                await new Promise(r => setTimeout(r, 400));
                document.dispatchEvent(new CustomEvent('mdr-test-rerender'));
                await new Promise(r => setTimeout(r, 900));
                disableWorks = document.querySelectorAll('#preview blockquote.md-callout').length === 0;
                window.ink.enable('bundled.callout');
                await new Promise(r => setTimeout(r, 400));
                document.dispatchEvent(new CustomEvent('mdr-test-rerender'));
                await new Promise(r => setTimeout(r, 900));
                reenableWorks = document.querySelectorAll('#preview blockquote.md-callout').length >= 1;
              }
              const isolated = document.querySelector('#preview [data-plugin-demo="1"]')?.getAttribute('data-bridge-isolated') === 'true';
              return JSON.stringify({runtimeReady, listed: listed.length, hello: !!hello, activated, ran, isolated, bridgeProbe, disableWorks, reenableWorks});
            } catch (err) {
              return JSON.stringify({error: String(err)});
            }
          })()
        `)
        const pc2 = JSON.parse(pluginCheck)
        const pcOk = pc2.runtimeReady && pc2.hello && pc2.activated && pc2.ran && pc2.isolated && pc2.bridgeProbe && pc2.disableWorks && pc2.reenableWorks
        console.log(`[plugin-check] runtime=${pc2.runtimeReady} listed=${pc2.listed} hello=${pc2.hello} activated=${pc2.activated} ran=${pc2.ran} isolated=${pc2.isolated} zeroPermissionProbe=${pc2.bridgeProbe} calloutOff=${pc2.disableWorks} calloutOn=${pc2.reenableWorks} ${pcOk ? 'OK' : 'FAIL'}`)
        assertUiCheck('plugin', pcOk, pc2)
        // stability checks: tab dirty-state preservation / session tabs persisted / clipboard image paste
        const tripPath = path.join(testLibrary, '笔记', '旅行计划.md')
        const tripOriginal = fs.readFileSync(tripPath, 'utf8')
        const stabilityCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              // --- ST3: 编辑旅行计划 → 切走再切回，内容与脏状态保全 ---
              document.querySelector('.tree-row[data-path$="旅行计划.md"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
              await new Promise(r => setTimeout(r, 1400));
              document.dispatchEvent(new CustomEvent('mdr-test-type', {detail: {text: 'ST3MARK'}}));
              await new Promise(r => setTimeout(r, 300));
              document.querySelector('.tree-row[data-path$="README.md"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
              await new Promise(r => setTimeout(r, 1400));
              document.querySelector('.tree-row[data-path$="旅行计划.md"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
              await new Promise(r => setTimeout(r, 1400));
              const cmText = document.querySelector('.cm-content')?.textContent ?? '';
              const returnedState = document.getElementById('save-state')?.textContent ?? '';
              const returnedDirty = document.querySelector('.doc-tab.active')?.classList.contains('dirty') === true;
              const diskText = await window.mdr.readFile(${JSON.stringify(tripPath)});
              const stateMatches = (returnedState.includes('未保存') && returnedDirty)
                || (returnedState === '已保存' && !returnedDirty && diskText.includes('ST3MARK'));
              const preserved = cmText.includes('ST3MARK') && stateMatches
                && document.getElementById('file-title')?.textContent === '旅行计划.md';
              // 清理：删掉标记（通过命令面板不可行——直接编辑器选中末尾删除：撤销即可）
              document.dispatchEvent(new CustomEvent('mdr-test-command', {detail: {id: '__noop__'}}));
              // --- ST5: 剪贴板贴图（合成 ClipboardEvent） ---
              let pasteOk = false;
              try {
                const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
                const file = new File([bytes], 'pasted.png', {type: 'image/png'});
                const dt = new DataTransfer();
                dt.items.add(file);
                const cm = document.querySelector('.cm-content');
                cm?.focus();
                const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
                cm?.dispatchEvent(ev);
                await new Promise(r => setTimeout(r, 800));
                const src = document.querySelector('.cm-content')?.textContent ?? '';
                pasteOk = src.includes('assets/paste-');
              } catch (e) { pasteOk = false; }
              // --- ST4 由主进程侧核对 session.json ---
              return JSON.stringify({preserved, pasteOk, returnedState, returnedDirty, savedMarker: diskText.includes('ST3MARK')});
            } catch (err) {
              return JSON.stringify({error: String(err)});
            }
          })()
        `)
        // ST3 现场恢复：旅行计划文档的 ST3MARK 需要从磁盘撤销——读原文重写
        const st = JSON.parse(stabilityCheck)
        // 等自动保存落盘后还原（贴图/输入已触发保存计时器）
        await new Promise((r) => setTimeout(r, 2600))
        fs.writeFileSync(tripPath, tripOriginal)
        const readmeOriginal = fs.readFileSync(path.join(testLibrary, 'README.md'), 'utf8')
        fs.writeFileSync(path.join(testLibrary, 'README.md'), readmeOriginal)
        // ST4: session.json 应含 tabs 数组
        const sessionFile = path.join(app.getPath('userData'), 'session.json')
        let tabsPersisted = false
        try {
          const sess = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
          tabsPersisted = Array.isArray(sess.tabs) && sess.tabs.length >= 1
        } catch { tabsPersisted = false }
        // 贴图产物清理
        const assetsDir = path.join(testLibrary, 'assets')
        for (const f of fs.readdirSync(assetsDir)) {
          if (f.startsWith('paste-')) fs.unlinkSync(path.join(assetsDir, f))
        }
        const stOk = st.preserved && st.pasteOk && tabsPersisted
        console.log(`[stability-check] tabPreserved=${st.preserved} pasteImage=${st.pasteOk} sessionTabs=${tabsPersisted} ${stOk ? 'OK' : 'FAIL'}`)
        assertUiCheck('stability', stOk, { ...st, tabsPersisted })
        // regex search check: '/'-prefixed query in the search palette uses RegExp matching
        const regexCheck = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const direct = await window.mdr.searchText('Day \\\\d', true);
              document.dispatchEvent(new CustomEvent('mdr-test-palette', {detail: {mode: 'search'}}));
              await new Promise(r => setTimeout(r, 350));
              const input = document.querySelector('.palette-input');
              if (!input) return JSON.stringify({lines: 0, direct: direct.length});
              input.value = '/Day \\\\d/';
              input.dispatchEvent(new Event('input', {bubbles: true}));
              await new Promise(r => setTimeout(r, 2200));
              const lines = document.querySelectorAll('.pal-line').length;
              document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
              return JSON.stringify({lines, direct: direct.length});
            } catch (err) {
              return JSON.stringify({lines: 0, error: String(err)});
            }
          })()
        `)
        const rxc = JSON.parse(regexCheck)
        console.log(`[regex-check] lines=${rxc.lines} direct=${rxc.direct} ${rxc.lines >= 4 && rxc.direct >= 4 ? 'OK' : 'FAIL'}`)
        assertUiCheck('regex', rxc.lines >= 4 && rxc.direct >= 4, rxc)
        const focusShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-focus.png`), focusShot.toPNG())
        await win.webContents.executeJavaScript(`
          document.dispatchEvent(new CustomEvent('mdr-test-command', {detail: {id: 'toggle-focus'}}));
          document.dispatchEvent(new CustomEvent('mdr-test-command', {detail: {id: 'toggle-typewriter'}}));
        `)
        await new Promise((r) => setTimeout(r, 300))
        // theme & font scale verification
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent('mdr-test-theme', {detail: ${JSON.stringify({ theme: 'sepia' })}}))`,
        )
        await new Promise((r) => setTimeout(r, 900))
        const sepiaShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-sepia.png`), sepiaShot.toPNG())
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent('mdr-test-theme', {detail: ${JSON.stringify({ theme: 'dark' })}}))`,
        )
        await new Promise((r) => setTimeout(r, 1100))
        const darkShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-dark.png`), darkShot.toPNG())
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent('mdr-test-theme', {detail: ${JSON.stringify({ theme: 'light' })}}))`,
        )
        await new Promise((r) => setTimeout(r, 900))
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent('mdr-test-zoom', {detail: ${JSON.stringify({ scale: 1.3 })}}))`,
        )
        await new Promise((r) => setTimeout(r, 400))
        const zoomShot = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-zoom.png`), zoomShot.toPNG())
        // restore defaults for the next run
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent('mdr-test-theme', {detail: ${JSON.stringify({ theme: 'auto' })}}))`,
        )
        await win.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent('mdr-test-zoom', {detail: ${JSON.stringify({ scale: 1 })}}))`,
        )
        // macOS window chrome smoke: unsaved dot + represented file
        await win.webContents.executeJavaScript(
          `window.mdr.setWindowEdited(true).then(() => window.mdr.setWindowEdited(false))`,
        )
        console.log(`verify screenshots written (round ${round})`)
        console.log('verify screenshot written')
      } catch (err) {
        failed = true
        console.error('capture failed', err)
      } finally {
        // Exercise the same graceful shutdown used by menu Quit and updates.
        // Set a failure code only after all windows have closed.
        if (failed) app.once('will-quit', () => app.exit(1))
        app.once('quit', (_event, code) => console.log(`[quit-check] normal shutdown ${code}`))
        app.quit()
      }
    }, 8000)
  }
  return win
}

/** 测试用示例插件：验证 manifest -> 激活 -> 命令贡献 -> DOM 副作用全链路 */
async function writeSamplePlugin() {
  const dir = path.join(app.getPath('userData'), 'plugins', 'hello-inkleaf')
  await fs.promises.mkdir(dir, { recursive: true })
  const manifest = {
    id: 'hello-inkleaf',
    name: 'Hello Inkleaf',
    version: '0.1.0',
    engines: { inkleaf: '>=0.4.0' },
    main: 'main.mjs',
    activation: ['onCommand:hello-inkleaf.hello'],
    contributes: { commands: [{ id: 'hello-inkleaf.hello', title: '打个招呼' }] },
    permissions: ['commands', 'render'],
  }
  await fs.promises.writeFile(path.join(dir, 'ink.plugin.json'), JSON.stringify(manifest, null, 2))
  const code = [
    'let ran = false, bridgeIsolated = false',
    'export async function activate(ink) {',
    "  ink.commands.register({ id: 'hello-inkleaf.hello', title: '打个招呼', run: () => {",
    '    ran = true',
    "    const ownAbsent = typeof window.mdr === 'undefined'",
    '    let parentDenied = false',
    '    try { void parent.mdr } catch { parentDenied = true }',
    '    bridgeIsolated = ownAbsent && parentDenied',
    '  } })',
    '  ink.pipeline.registerPostProcessor(container => {',
    '    if (!ran) return',
    "    const marker = document.createElement('span')",
    "    marker.dataset.pluginDemo = '1'",
    '    marker.dataset.bridgeIsolated = String(bridgeIsolated)',
    "    marker.textContent = 'plugin command ran'",
    '    container.appendChild(marker)',
    '  })',
    '}',
    'export function deactivate() {}',
  ].join('\n')
  await fs.promises.writeFile(path.join(dir, 'main.mjs'), code)
  const probe = path.join(app.getPath('userData'), 'plugins', 'bridge-probe')
  await fs.promises.mkdir(probe, { recursive: true })
  await fs.promises.writeFile(path.join(probe, 'ink.plugin.json'), JSON.stringify({
    id: 'bridge-probe', name: 'Bridge isolation probe', version: '0.1.0',
    main: 'main.mjs', permissions: [], contributes: {},
  }))
  await fs.promises.writeFile(path.join(probe, 'main.mjs'), [
    'export function activate() {',
    "  if (typeof window.mdr !== 'undefined') throw new Error('child bridge exposed')",
    '  let blocked = false',
    '  try { void parent.mdr } catch { blocked = true }',
    "  if (!blocked) throw new Error('parent bridge readable')",
    "  parent.postMessage({kind: 'forged-bridge', method: 'writeFile'}, '*')",
    '}',
  ].join('\n'))
}

function buildMenu() {
  const send = (action: string) =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('menu', action))

  const template: Electron.MenuItemConstructorOptions[] = [
    process.platform === 'darwin' ? { role: 'appMenu', submenu: [
      { role: 'about' },
      { label: '检查更新…', click: () => send('check-updates') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] } : { label: 'Inkleaf', submenu: [
      { role: 'about', label: '关于墨页 · Inkleaf' },
      { label: '检查更新…', click: () => send('check-updates') },
      { type: 'separator' },
      { role: 'quit', label: '退出' },
    ] },
    {
      role: 'fileMenu',
      submenu: [
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => send('open-file') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        { label: '新建文件', accelerator: 'CmdOrCtrl+N', click: () => send('new-file') },
        { type: 'separator' },
        { label: '快速切换文件…', accelerator: 'CmdOrCtrl+P', click: () => send('quick-switch') },
        { label: '新标签页打开文件…', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
        { label: '在书库中搜索…', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('search') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { type: 'separator' },
        { label: '导出为 PDF…', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('export-pdf') },
        { label: '导出为 HTML…', accelerator: 'CmdOrCtrl+Shift+H', click: () => send('export-html') },
        { type: 'separator' },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('close-tab') },
        { label: '关闭书库', click: () => send('close-library') },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    // native edit menu supplies Cmd+C/V/X/Z/A to the editor
    { role: 'editMenu' },
    {
      label: '格式',
      submenu: [
        { label: '加粗', accelerator: 'CmdOrCtrl+B', click: () => send('fmt-bold') },
        { label: '斜体', accelerator: 'CmdOrCtrl+I', click: () => send('fmt-italic') },
        { label: '行内代码', accelerator: 'CmdOrCtrl+E', click: () => send('fmt-code') },
        { type: 'separator' },
        { label: '代码块', accelerator: 'CmdOrCtrl+Shift+K', click: () => send('fmt-codeblock') },
        { label: '链接', accelerator: 'CmdOrCtrl+K', click: () => send('fmt-link') },
        { type: 'separator' },
        { label: '插入图片…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('insert-image') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换书库栏', accelerator: 'CmdOrCtrl+\\', click: () => send('toggle-sidebar') },
        { label: '切换编辑面板', accelerator: 'CmdOrCtrl+1', click: () => send('toggle-editor') },
        { label: '切换预览面板', accelerator: 'CmdOrCtrl+2', click: () => send('toggle-preview') },
        { label: '切换大纲', accelerator: 'CmdOrCtrl+3', click: () => send('toggle-outline') },
        { label: '切换反向链接', accelerator: 'CmdOrCtrl+4', click: () => send('toggle-backlink') },
        { type: 'separator' },
        { label: '暖白纸面', click: () => send('theme-light') },
        { label: '羊皮纸', click: () => send('theme-sepia') },
        { label: '护眼绿', click: () => send('theme-green') },
        { label: '深色主题', click: () => send('theme-dark') },
        { label: '跟随系统', click: () => send('theme-auto') },
        { type: 'separator' },
        { label: '放大字号', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: '缩小字号', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: '重置字号', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-reset') },
        { type: 'separator' },
        { label: '专注模式', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('toggle-focus') },
        { label: '打字机滚动', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('toggle-typewriter') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
