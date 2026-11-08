import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CatalogState, PluginResult } from '../shared/plugins'
import type { ServiceSettings, ServiceSettingsInput, DiagramProvider, ModelRequest, ModelChunk } from '../shared/services'
import type { UpdateState } from '../shared/updates'
import type { HistoryList, HistoryVersion, SearchOptions, SearchReport, BatchPreview, BatchResult } from '../shared/knowledge'
import { CH, type TreeNode, type TextHit, type OpResult, type ConfirmOptions, type FsEvent, type TagCount, type Backlink, type ImageResolution } from '../shared/ipc'

const api = {
  serviceSettings: (): Promise<ServiceSettings> => ipcRenderer.invoke(CH.serviceGet),
  saveServiceSettings: (input: ServiceSettingsInput): Promise<ServiceSettings> => ipcRenderer.invoke(CH.serviceSave, input),
  renderPlantuml: (source: string): Promise<string> => ipcRenderer.invoke(CH.diagramRender, source),
  testDiagramService: (input: { url: string; provider: DiagramProvider }): Promise<void> => ipcRenderer.invoke(CH.diagramTest, input),
  runModel: (request: ModelRequest): Promise<string> => ipcRenderer.invoke(CH.modelRun, request),
  cancelModel: (id: string): Promise<void> => ipcRenderer.invoke(CH.modelCancel, id),
  onModelChunk: (cb: (chunk: ModelChunk) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, chunk: ModelChunk) => cb(chunk)
    ipcRenderer.on(CH.modelChunk, handler); return () => ipcRenderer.removeListener(CH.modelChunk, handler)
  },
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
  indexResolve: (name: string, from?: string): Promise<string | null> => ipcRenderer.invoke(CH.indexResolve, name, from),
  indexPeek: (p: string): Promise<{ title: string; excerpt: string } | null> => ipcRenderer.invoke(CH.indexPeek, p),
  indexFilesByTag: (tag: string): Promise<string[]> => ipcRenderer.invoke(CH.indexFilesByTag, tag),
  indexListNames: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke(CH.indexListNames),
  pluginsCatalog: (): Promise<CatalogState> => ipcRenderer.invoke(CH.pluginsCatalog),
  pluginsCheckUpdates: (): Promise<CatalogState> => ipcRenderer.invoke(CH.pluginsCheckUpdates),
  pluginsInstallCatalog: (id: string, version: string): Promise<PluginResult> => ipcRenderer.invoke(CH.pluginsInstallCatalog, id, version),
  pluginsUpdateLocal: (id: string): Promise<PluginResult> => ipcRenderer.invoke(CH.pluginsUpdateLocal, id),
  pluginsList: (): Promise<{ id: string; name: string; version: string; mainUrl: string; manifest: Record<string, unknown> }[]> => ipcRenderer.invoke(CH.pluginsList),
  pluginsReveal: (): Promise<void> => ipcRenderer.invoke(CH.pluginsReveal),
  pluginsInstall: (): Promise<{ ok: boolean; canceled?: boolean; error?: string; id?: string }> => ipcRenderer.invoke(CH.pluginsInstall),
  pluginsUninstall: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.pluginsUninstall, id),
  readFile: (p: string): Promise<string> => ipcRenderer.invoke(CH.fsRead, p),
  tagPreview: (from: string, to: string): Promise<BatchPreview> => ipcRenderer.invoke(CH.tagPreview, from, to),
  createDocument: (relative: string, content: string, existing = false, from?: string): Promise<string> => ipcRenderer.invoke(CH.createDocument, relative, content, existing, from),
  indexRelations: (target: string): Promise<{ backlinks: (Backlink & { context: string })[]; mentions: (Backlink & { context: string })[] }> => ipcRenderer.invoke(CH.indexRelations, target),
  advancedSearch: (options: SearchOptions): Promise<SearchReport> => ipcRenderer.invoke(CH.advancedSearch, options),
  replacePreview: (options: SearchOptions, replacement: string): Promise<BatchPreview> => ipcRenderer.invoke(CH.replacePreview, options, replacement),
  batchApply: (id: string, paths: string[]): Promise<BatchResult> => ipcRenderer.invoke(CH.batchApply, id, paths),
  historyList: (p: string): Promise<HistoryList> => ipcRenderer.invoke(CH.historyList, p),
  historyVersion: (p: string, id: string): Promise<HistoryVersion> => ipcRenderer.invoke(CH.historyVersion, p, id),
  historyCapture: (p: string): Promise<void> => ipcRenderer.invoke(CH.historyCapture, p),
  historyRestore: (p: string, id: string, expected: string): Promise<string> => ipcRenderer.invoke(CH.historyRestore, p, id, expected),
  historyLimit: (limit: number): Promise<void> => ipcRenderer.invoke(CH.historyLimit, limit),
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
