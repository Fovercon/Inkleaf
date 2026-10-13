import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { UpdateState } from '../shared/updates'

const api = {
  platform: process.platform,
  sandboxed: process.sandboxed === true,
  rendererReady: (): void => ipcRenderer.send('app:renderer-ready'),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:getState'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  cancelUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:cancel'),
  installUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb: (state: UpdateState) => void) => {
    const h = (_e: Electron.IpcRendererEvent, state: UpdateState) => cb(state)
    ipcRenderer.on('update:state', h)
    return () => ipcRenderer.removeListener('update:state', h)
  },
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
  saveNewFile: (dir: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveNewFile', dir, defaultName),
  openLibrary: (root: string): Promise<import('../main/ipc').TreeNode[] | null> =>
    ipcRenderer.invoke('lib:open', root),
  readTree: (): Promise<import('../main/ipc').TreeNode[]> => ipcRenderer.invoke('lib:tree'),
  listFiles: (): Promise<string[]> => ipcRenderer.invoke('lib:listFiles'),
  searchText: (query: string): Promise<{ path: string; line: number; text: string }[]> =>
    ipcRenderer.invoke('search:text', query),
  closeLibrary: (): Promise<void> => ipcRenderer.invoke('lib:close'),
  readFile: (p: string): Promise<string> => ipcRenderer.invoke('fs:read', p),
  writeFile: (p: string, content: string): Promise<void> => ipcRenderer.invoke('fs:write', p, content),
  writeBinary: (p: string, base64: string): Promise<void> => ipcRenderer.invoke('fs:writeBinary', p, base64),
  rename: (oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:rename', oldPath, newPath),
  trash: (p: string): Promise<void> => ipcRenderer.invoke('fs:trash', p),
  mkdir: (p: string): Promise<void> => ipcRenderer.invoke('fs:mkdir', p),
  exists: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:exists', p),
  pickImage: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickImage'),
  copyImage: (src: string, destDir: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:copyImage', src, destDir),
  confirm: (opts: { title: string; message: string; okLabel?: string }): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm', opts),
  saveExportPath: (defaultName: string, ext: string): Promise<string | null> =>
    ipcRenderer.invoke('export:savePath', defaultName, ext),
  exportPdf: (html: string, target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('export:pdf', html, target),
  setWindowEdited: (edited: boolean): Promise<void> => ipcRenderer.invoke('win:edited', edited),
  setWindowFile: (p: string | null): Promise<void> => ipcRenderer.invoke('win:file', p),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke('shell:reveal', p),
  getSession: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('session:get'),
  setSession: (s: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('session:set', s),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  onMenu: (cb: (action: string) => void) => {
    const h = (_e: Electron.IpcRendererEvent, action: string) => cb(action)
    ipcRenderer.on('menu', h)
    return () => ipcRenderer.removeListener('menu', h)
  },
  onFsEvent: (cb: (ev: { event: string; path: string }) => void) => {
    const h = (_e: Electron.IpcRendererEvent, ev: { event: string; path: string }) => cb(ev)
    ipcRenderer.on('fs:event', h)
    return () => ipcRenderer.removeListener('fs:event', h)
  },
  onOpenPath: (cb: (p: string) => void) => {
    const h = (_e: Electron.IpcRendererEvent, p: string) => cb(p)
    ipcRenderer.on('open-path', h)
    return () => ipcRenderer.removeListener('open-path', h)
  },
}

contextBridge.exposeInMainWorld('mdr', api)

export type MdrApi = Readonly<typeof api>
