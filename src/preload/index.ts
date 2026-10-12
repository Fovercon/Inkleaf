import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
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
  confirm: (opts: { title: string; message: string; okLabel?: string }): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm', opts),
  saveExportPath: (defaultName: string, ext: string): Promise<string | null> =>
    ipcRenderer.invoke('export:savePath', defaultName, ext),
  exportPdf: (html: string, target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('export:pdf', html, target),
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
}

contextBridge.exposeInMainWorld('mdr', api)

export type MdrApi = typeof api
