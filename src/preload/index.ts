import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
  saveNewFile: (dir: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveNewFile', dir, defaultName),
  openLibrary: (root: string): Promise<import('../main/ipc').TreeNode[] | null> =>
    ipcRenderer.invoke('lib:open', root),
  readTree: (): Promise<import('../main/ipc').TreeNode[]> => ipcRenderer.invoke('lib:tree'),
  closeLibrary: (): Promise<void> => ipcRenderer.invoke('lib:close'),
  readFile: (p: string): Promise<string> => ipcRenderer.invoke('fs:read', p),
  writeFile: (p: string, content: string): Promise<void> => ipcRenderer.invoke('fs:write', p, content),
  writeBinary: (p: string, base64: string): Promise<void> => ipcRenderer.invoke('fs:writeBinary', p, base64),
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
