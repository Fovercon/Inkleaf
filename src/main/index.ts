import { app, BrowserWindow, Menu, protocol, net, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { registerIpc, getLibraryRoot } from './ipc'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'mdasset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const RENDERER_ROOT = path.join(__dirname, 'renderer')

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

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
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
    buildMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.env.MDR_TEST || process.platform !== 'darwin') app.quit()
})

async function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 780,
    minHeight: 540,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafafa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
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
    ? `?test=1&lib=${encodeURIComponent(path.resolve(process.cwd(), 'test-library'))}`
    : ''
  await win.loadURL(`app://local/index.html${query}`)

  if (process.env.MDR_TEST) {
    // give the renderer time to load the library, render markdown + mermaid, then capture proof
    const round = process.env.MDR_ROUND ?? '0'
    setTimeout(async () => {
      try {
        const dir = path.join(process.cwd(), 'verify')
        fs.mkdirSync(dir, { recursive: true })
        const img = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}.png`), img.toPNG())
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
          `(() => { const cb = document.querySelector('#preview input[type=checkbox]:not(:checked)'); if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles: true})) } return !!cb })()`,
        )
        await new Promise((r) => setTimeout(r, 1000))
        const after = await win.webContents.executeJavaScript(
          `document.querySelectorAll('#preview input[type=checkbox]:checked').length`,
        )
        console.log(`[task-check] before=${before} after=${after} ${Number(after) === Number(before) + 1 ? 'OK' : 'FAIL'}`)
        const task = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dir, `round${round}-task.png`), task.toPNG())
        console.log(`verify screenshots written (round ${round})`)
        console.log('verify screenshot written')
      } catch (err) {
        console.error('capture failed', err)
      } finally {
        app.quit()
      }
    }, 8000)
  }
  return win
}

function buildMenu() {
  const send = (action: string) =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('menu', action))

  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      role: 'fileMenu',
      submenu: [
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => send('open-file') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        { label: '新建文件', accelerator: 'CmdOrCtrl+N', click: () => send('new-file') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
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
        { label: '浅色主题', click: () => send('theme-light') },
        { label: '深色主题', click: () => send('theme-dark') },
        { label: '跟随系统', click: () => send('theme-auto') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
