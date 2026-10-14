import { app, ipcMain, dialog, BrowserWindow, shell, Menu } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import { CH, TreeNode, TextHit, ConfirmOptions, FsEvent, TagCount, Backlink } from '../shared/ipc'
import * as indexService from './index-service'

export type { TreeNode } from '../shared/ipc'

let libraryRoot: string | null = null
let watcher: chokidar.FSWatcher | null = null
/** cached flat .md file list for the quick switcher; invalidated on fs events */
let fileListCache: { root: string; files: string[] } | null = null

export const getLibraryRoot = () => libraryRoot

function broadcast(channel: string, payload?: unknown) {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload))
}

const sessionPath = () => path.join(app.getPath('userData'), 'session.json')

async function readSession(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(sessionPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function writeSession(s: Record<string, unknown>) {
  await fs.mkdir(path.dirname(sessionPath()), { recursive: true })
  await fs.writeFile(sessionPath(), JSON.stringify(s, null, 2))
  void rebuildDockMenu()
}

/** macOS dock menu: open actions + the five most recent files */
export async function rebuildDockMenu() {
  if (process.platform !== 'darwin' || !app.dock) return
  const session = await readSession()
  const recents = Array.isArray(session.recentFiles) ? (session.recentFiles as string[]) : []
  const send = (action: string) =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('menu', action))
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: '打开文件…', click: () => send('open-file') },
    { label: '打开文件夹…', click: () => send('open-folder') },
  ]
  if (recents.length) {
    template.push({ type: 'separator' })
    for (const p of recents.slice(0, 5)) {
      template.push({ label: p.split('/').pop() ?? p, click: () => send(`open-path:${p}`) })
    }
  }
  app.dock.setMenu(Menu.buildFromTemplate(template))
}

async function patchSession(patch: Record<string, unknown>) {
  const s = await readSession()
  Object.assign(s, patch)
  await writeSession(s)
}

async function readTree(root: string): Promise<TreeNode[]> {
  const walk = async (dir: string): Promise<TreeNode[]> => {
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    const files: TreeNode[] = []
    const dirs: TreeNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) dirs.push({ name: e.name, path: p, type: 'dir' })
      else if (e.isFile() && /\.(md|markdown|mdx)$/i.test(e.name)) files.push({ name: e.name, path: p, type: 'file' })
    }
    // walk subdirectories in parallel, then attach children
    const children = await Promise.all(dirs.map((d) => walk(d.path)))
    dirs.forEach((d, i) => {
      d.children = children[i]
    })
    // dirs first, keep name order within each group
    return [...dirs, ...files]
  }
  return walk(root)
}

async function startWatch(root: string) {
  await stopWatch()
  watcher = chokidar.watch(root, {
    ignored: /(^|[/\\])\.|node_modules/,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 60 },
  })
  const emit = (event: string) => (p: string) => {
    fileListCache = null
    if (event === 'unlink' || event === 'unlinkDir') indexService.unindexPath(p)
    else void indexService.indexFile(p)
    broadcast(CH.fsEvent, { event, path: p })
  }
  watcher.on('add', emit('add')).on('unlink', emit('unlink')).on('change', emit('change'))
    .on('addDir', emit('addDir')).on('unlinkDir', emit('unlinkDir'))
}

export async function stopWatch() {
  if (watcher) {
    await watcher.close().catch(() => {})
    watcher = null
  }
}

export function registerIpc() {
  ipcMain.handle(CH.dialogOpenFolder, async () => {
    const r = await dialog.showOpenDialog({
      title: '选择 Markdown 书库文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle(CH.dialogOpenFile, async () => {
    const r = await dialog.showOpenDialog({
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle(CH.dialogSaveNewFile, async (e, dir: string, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: '新建 Markdown 文件',
      defaultPath: path.join(dir, defaultName),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle(CH.libOpen, async (_e, root: string) => {
    if (!fsSync.existsSync(root)) return null
    libraryRoot = root
    // tree first so the UI fills fast; the watcher can warm up afterwards
    const tree = await readTree(root)
    void startWatch(root).catch(() => {})
    void (async () => {
      if (!(await indexService.loadPersistedIndex(root))) {
        await indexService.buildIndex(root, await listFiles())
      }
    })()
    await patchSession({ libraryRoot: root })
    return tree
  })

  ipcMain.handle(CH.libTree, () => (libraryRoot ? readTree(libraryRoot) : []))

  async function listFiles(): Promise<string[]> {
    const root = libraryRoot
    if (!root) return []
    if (fileListCache && fileListCache.root === root) return fileListCache.files
    const files: string[] = []
    const walk = async (dir: string) => {
      let entries: fsSync.Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile() && /\.(md|markdown|mdx)$/i.test(e.name)) files.push(p)
      }
    }
    await walk(root)
    fileListCache = { root, files }
    return files
  }

  ipcMain.handle(CH.libListFiles, () => listFiles())

  ipcMain.handle(CH.searchText, async (_e, query: string) => {
    const root = libraryRoot
    if (!root || !query.trim()) return []
    const ql = query.toLowerCase()
    const files = await listFiles()
    const results: TextHit[] = []
    for (const f of files) {
      if (results.length >= 300) break
      try {
        const lines = (await fs.readFile(f, 'utf8')).split('\n')
        let count = 0
        for (let i = 0; i < lines.length && count < 20; i++) {
          if (lines[i].toLowerCase().includes(ql)) {
            results.push({ path: f, line: i + 1, text: lines[i].trim().slice(0, 160) })
            count++
          }
        }
      } catch {
        /* unreadable file — skip */
      }
    }
    return results
  })

  ipcMain.handle(CH.libClose, async () => {
    await stopWatch()
    libraryRoot = null
    indexService.clearIndex()
    await patchSession({ libraryRoot: null })
  })

  ipcMain.handle(CH.fsRead, (_e, p: string) => fs.readFile(p, 'utf8'))

  ipcMain.handle(CH.fsWrite, async (_e, p: string, content: string) => {
    const tmp = p + '.mdr-tmp'
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, p)
  })

  // used for pasted images; creates parent directories as needed
  ipcMain.handle(CH.fsWriteBinary, async (_e, p: string, base64: string) => {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, Buffer.from(base64, 'base64'))
  })

  ipcMain.handle(CH.fsRename, async (_e, oldPath: string, newPath: string) => {
    if (fsSync.existsSync(newPath)) return { ok: false, error: '同名文件已存在' }
    try {
      await fs.rename(oldPath, newPath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(CH.fsTrash, (_e, p: string) => shell.trashItem(p))

  ipcMain.handle(CH.fsMkdir, (_e, dir: string) => fs.mkdir(dir, { recursive: true }))

  ipcMain.handle(CH.fsExists, (_e, p: string) => fsSync.existsSync(p))

  ipcMain.handle(CH.dialogPickImage, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: '插入图片',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'] }],
    }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : r.filePaths[0]
  })

  // copies an image into <docDir>/assets with a timestamped name; returns the destination path
  ipcMain.handle(CH.fsCopyImage, async (_e, src: string, destDir: string) => {
    try {
      await fs.mkdir(destDir, { recursive: true })
      const name = src.split('/').pop() ?? 'image.png'
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '.png'
      const dest = path.join(destDir, `img-${Date.now()}${ext}`)
      await fs.copyFile(src, dest)
      return dest
    } catch {
      return null
    }
  })

  ipcMain.handle(CH.dialogConfirm, async (e, opts: { title: string; message: string; okLabel?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', opts.okLabel ?? '确定'],
      defaultId: 1,
      cancelId: 0,
      title: opts.title,
      message: opts.message,
    })
    return r.response === 1
  })

  ipcMain.handle(CH.exportSavePath, async (e, defaultName: string, ext: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: '导出',
      defaultPath: defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle(CH.exportPdf, async (_e, html: string, target: string) => {
    const tmp = path.join(app.getPath('temp'), `mdr-export-${Date.now()}.html`)
    await fs.writeFile(tmp, html, 'utf8')
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    try {
      await win.loadFile(tmp)
      await new Promise((r) => setTimeout(r, 500)) // let embedded fonts/images settle
      const buf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.7, bottom: 0.7, left: 0.6, right: 0.6 },
      })
      await fs.writeFile(target, buf)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    } finally {
      win.destroy()
      await fs.unlink(tmp).catch(() => {})
    }
  })

  ipcMain.handle(CH.shellReveal, (_e, p: string) => {
    // CI has no desktop file manager. xdg-open's browser fallback can inherit
    // the test log pipe and keep it open after Electron has exited.
    if (process.env.MDR_TEST) return
    shell.showItemInFolder(p)
  })

  ipcMain.handle(CH.indexTags, (): TagCount[] => indexService.queryTags())
  ipcMain.handle(CH.indexBacklinks, (_e, name: string): Backlink[] => indexService.queryBacklinks(name))
  ipcMain.handle(CH.indexResolve, (_e, name: string): string | null => indexService.resolveName(name))

  ipcMain.handle(CH.sessionGet, () => readSession())
  ipcMain.handle(CH.sessionSet, (_e, s: Record<string, unknown>) => writeSession(s))

  // macOS window chrome: unsaved dot + proxy file icon in the titlebar
  ipcMain.handle(CH.winEdited, (_e, edited: boolean) => {
    if (process.platform === 'darwin') BrowserWindow.getAllWindows().forEach((w) => w.setDocumentEdited(edited))
  })
  ipcMain.handle(CH.winFile, (_e, p: string | null) => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (p) {
        if (process.platform === 'darwin') w.setRepresentedFilename(p)
        w.setTitle(p.split('/').pop() ?? '墨页 · Inkleaf')
      } else {
        if (process.platform === 'darwin') w.setRepresentedFilename('')
        w.setTitle('墨页 · Inkleaf')
      }
    })
  })
}
