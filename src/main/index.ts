import { app, BrowserWindow, Menu, protocol, net, shell, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { registerIpc, getLibraryRoot, rebuildDockMenu } from './ipc'
import { initializeUpdater } from './updater'
import { markdownFromArguments } from './openPath'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'mdasset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
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

    registerIpc()
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
  win.webContents.on('did-start-loading', () => readyWindows.delete(win.webContents.id))
  win.webContents.once('destroyed', () => readyWindows.delete(win.webContents.id))
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
      try {
        const expectedPlatform = process.platform
        const expectedShortcut = process.platform === 'darwin' ? '⌘O' : 'Ctrl+O'
        const platformOk = await win.webContents.executeJavaScript(`(() => {
          return window.mdr.platform === ${JSON.stringify(expectedPlatform)}
            && document.body.dataset.platform === ${JSON.stringify(expectedPlatform)}
            && window.mdr.sandboxed === true
            && typeof window.mdr.readFile === 'function'
            && document.getElementById('btn-open-file').title.includes(${JSON.stringify(expectedShortcut)});
        })()`)
        if (!platformOk || !readyWindows.has(win.webContents.id)) {
          throw new Error('Platform shortcuts, isolated preload or sandbox startup failed')
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
        app.exit(failed ? 1 : 0)
      }
    }, 8000)
  }
  return win
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
        { label: '在书库中搜索…', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('search') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { type: 'separator' },
        { label: '导出为 PDF…', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('export-pdf') },
        { label: '导出为 HTML…', accelerator: 'CmdOrCtrl+Shift+H', click: () => send('export-html') },
        { type: 'separator' },
        { label: '关闭书库', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('close-library') },
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
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
