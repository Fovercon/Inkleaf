import { app, ipcMain, dialog, BrowserWindow, shell } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'

export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

let libraryRoot: string | null = null
let watcher: chokidar.FSWatcher | null = null

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
    const nodes: TreeNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: p, type: 'dir', children: await walk(p) })
      } else if (e.isFile() && /\.(md|markdown|mdx)$/i.test(e.name)) {
        nodes.push({ name: e.name, path: p, type: 'file' })
      }
    }
    // dirs first, keep name order within each group (stable sort)
    return nodes.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1))
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
  const emit = (event: string) => (p: string) => broadcast('fs:event', { event, path: p })
  watcher.on('add', emit('add')).on('unlink', emit('unlink')).on('change', emit('change'))
    .on('addDir', emit('addDir')).on('unlinkDir', emit('unlinkDir'))
}

async function stopWatch() {
  if (watcher) {
    await watcher.close().catch(() => {})
    watcher = null
  }
}

export function registerIpc() {
  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择 Markdown 书库文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog({
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:saveNewFile', async (e, dir: string, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: '新建 Markdown 文件',
      defaultPath: path.join(dir, defaultName),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('lib:open', async (_e, root: string) => {
    if (!fsSync.existsSync(root)) return null
    libraryRoot = root
    await startWatch(root)
    await patchSession({ libraryRoot: root })
    return readTree(root)
  })

  ipcMain.handle('lib:tree', () => (libraryRoot ? readTree(libraryRoot) : []))

  ipcMain.handle('lib:close', async () => {
    await stopWatch()
    libraryRoot = null
    await patchSession({ libraryRoot: null })
  })

  ipcMain.handle('fs:read', (_e, p: string) => fs.readFile(p, 'utf8'))

  ipcMain.handle('fs:write', async (_e, p: string, content: string) => {
    const tmp = p + '.mdr-tmp'
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, p)
  })

  ipcMain.handle('shell:reveal', (_e, p: string) => {
    shell.showItemInFolder(p)
  })

  ipcMain.handle('session:get', () => readSession())
  ipcMain.handle('session:set', (_e, s: Record<string, unknown>) => writeSession(s))
}
