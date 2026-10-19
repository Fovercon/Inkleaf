import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { UpdateState } from '../shared/updates'
import { CH, type TreeNode, type TextHit, type OpResult, type ConfirmOptions, type FsEvent, type TagCount, type Backlink, type ImageResolution } from '../shared/ipc'

const api = {
  platform: process.platform,
  sandboxed: process.sandboxed === true,
  rendererReady: (): void => ipcRenderer.send(CH.rendererReady),
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
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke(CH.dialogOpenFolder),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke(CH.dialogOpenFile),
  saveNewFile: (dir: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.dialogSaveNewFile, dir, defaultName),
  openLibrary: (root: string): Promise<TreeNode[] | null> =>
    ipcRenderer.invoke(CH.libOpen, root),
  readTree: (): Promise<TreeNode[]> => ipcRenderer.invoke(CH.libTree),
  listFiles: (): Promise<string[]> => ipcRenderer.invoke(CH.libListFiles),
  searchText: (query: string, isRegex?: boolean): Promise<TextHit[]> =>
    ipcRenderer.invoke(CH.searchText, query, isRegex),
  closeLibrary: (): Promise<void> => ipcRenderer.invoke(CH.libClose),
  indexTags: (): Promise<TagCount[]> => ipcRenderer.invoke(CH.indexTags),
  indexBacklinks: (name: string): Promise<Backlink[]> => ipcRenderer.invoke(CH.indexBacklinks, name),
  indexResolve: (name: string): Promise<string | null> => ipcRenderer.invoke(CH.indexResolve, name),
  indexPeek: (p: string): Promise<{ title: string; excerpt: string } | null> => ipcRenderer.invoke(CH.indexPeek, p),
  indexFilesByTag: (tag: string): Promise<string[]> => ipcRenderer.invoke(CH.indexFilesByTag, tag),
  indexListNames: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke(CH.indexListNames),
  pluginsList: (): Promise<{ id: string; name: string; version: string; mainUrl: string; manifest: Record<string, unknown> }[]> => ipcRenderer.invoke(CH.pluginsList),
  pluginsReveal: (): Promise<void> => ipcRenderer.invoke(CH.pluginsReveal),
  pluginsInstall: (): Promise<{ ok: boolean; error?: string; id?: string }> => ipcRenderer.invoke(CH.pluginsInstall),
  pluginsUninstall: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.pluginsUninstall, id),
  readFile: (p: string): Promise<string> => ipcRenderer.invoke(CH.fsRead, p),
  resolveImage: (source: string, documentPath: string): Promise<ImageResolution> =>
    ipcRenderer.invoke(CH.imageResolve, source, documentPath),
  writeFile: (p: string, content: string): Promise<void> => ipcRenderer.invoke(CH.fsWrite, p, content),
  writeBinary: (p: string, base64: string): Promise<void> => ipcRenderer.invoke(CH.fsWriteBinary, p, base64),
  rename: (oldPath: string, newPath: string): Promise<OpResult> =>
    ipcRenderer.invoke(CH.fsRename, oldPath, newPath),
  trash: (p: string): Promise<void> => ipcRenderer.invoke(CH.fsTrash, p),
  mkdir: (p: string): Promise<void> => ipcRenderer.invoke(CH.fsMkdir, p),
  exists: (p: string): Promise<boolean> => ipcRenderer.invoke(CH.fsExists, p),
  pickImage: (): Promise<string | null> => ipcRenderer.invoke(CH.dialogPickImage),
  copyImage: (src: string, destDir: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.fsCopyImage, src, destDir),
  confirm: (opts: ConfirmOptions): Promise<boolean> =>
    ipcRenderer.invoke(CH.dialogConfirm, opts),
  saveExportPath: (defaultName: string, ext: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.exportSavePath, defaultName, ext),
  exportPdf: (html: string, target: string): Promise<OpResult> =>
    ipcRenderer.invoke(CH.exportPdf, html, target),
  setWindowEdited: (edited: boolean): Promise<void> => ipcRenderer.invoke(CH.winEdited, edited),
  setWindowFile: (p: string | null): Promise<void> => ipcRenderer.invoke(CH.winFile, p),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke(CH.shellReveal, p),
  getSession: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(CH.sessionGet),
  setSession: (s: Record<string, unknown>): Promise<void> => ipcRenderer.invoke(CH.sessionSet, s),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  onMenu: (cb: (action: string) => void) => {
    const h = (_e: Electron.IpcRendererEvent, action: string) => cb(action)
    ipcRenderer.on(CH.menu, h)
    return () => ipcRenderer.removeListener(CH.menu, h)
  },
  onFsEvent: (cb: (ev: FsEvent) => void) => {
    const h = (_e: Electron.IpcRendererEvent, ev: FsEvent) => cb(ev)
    ipcRenderer.on(CH.fsEvent, h)
    return () => ipcRenderer.removeListener(CH.fsEvent, h)
  },
  onOpenPath: (cb: (p: string) => void) => {
    const h = (_e: Electron.IpcRendererEvent, p: string) => cb(p)
    ipcRenderer.on(CH.openPath, h)
    return () => ipcRenderer.removeListener(CH.openPath, h)
  },
}

contextBridge.exposeInMainWorld('mdr', api)

export type MdrApi = Readonly<typeof api>
