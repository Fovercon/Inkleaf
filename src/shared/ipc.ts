/**
 * IPC 契约中心：集中定义通道名与跨进程载荷类型。
 * 主进程 handler 与 preload 桥必须从此处引用通道名与载荷类型，禁止手写字符串。
 * update:* 通道由 main/updater.ts 管理，相关类型见 shared/updates.ts。
 */

// ---------- 跨进程载荷类型 ----------

export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

export interface TextHit {
  path: string
  line: number
  text: string
}

export interface OpResult {
  ok: boolean
  error?: string
}

export interface ConfirmOptions {
  title: string
  message: string
  okLabel?: string
}

export interface FsEvent {
  event: string
  path: string
}

export interface TagCount {
  tag: string
  count: number
}

export interface Backlink {
  path: string
  line: number
}

export interface ImageResolution {
  url?: string
  path?: string
  error?: 'not-found' | 'forbidden' | 'unreadable' | 'invalid'
  message?: string
}

// ---------- 通道名 ----------

export const CH = {
  serviceGet: 'services:get', serviceSave: 'services:save', diagramRender: 'services:diagram',
  modelRun: 'services:model', modelCancel: 'services:cancel', modelChunk: 'services:chunk',
  // invoke（renderer -> main）
  dialogOpenFolder: 'dialog:openFolder',
  dialogOpenFile: 'dialog:openFile',
  dialogSaveNewFile: 'dialog:saveNewFile',
  dialogPickImage: 'dialog:pickImage',
  dialogConfirm: 'dialog:confirm',
  libOpen: 'lib:open',
  libClose: 'lib:close',
  libTree: 'lib:tree',
  libListFiles: 'lib:listFiles',
  indexTags: 'index:tags',
  indexBacklinks: 'index:backlinks',
  indexResolve: 'index:resolve',
  indexPeek: 'index:peek',
  indexFilesByTag: 'index:filesByTag',
  indexListNames: 'index:listNames',
  pluginsCatalog: 'plugins:catalog',
  pluginsCheckUpdates: 'plugins:checkUpdates',
  pluginsInstallCatalog: 'plugins:installCatalog',
  pluginsUpdateLocal: 'plugins:updateLocal',
  pluginsList: 'plugins:list',
  pluginsReveal: 'plugins:reveal',
  pluginsInstall: 'plugins:install',
  pluginsUninstall: 'plugins:uninstall',
  searchText: 'search:text',
  tagPreview: 'knowledge:tags',
  createDocument: 'knowledge:create',
  indexRelations: 'knowledge:relations',
  advancedSearch: 'knowledge:search',
  replacePreview: 'knowledge:preview',
  batchApply: 'knowledge:apply',
  historyList: 'history:list',
  historyVersion: 'history:version',
  historyCapture: 'history:capture',
  historyRestore: 'history:restore',
  historyLimit: 'history:limit',
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsWriteBinary: 'fs:writeBinary',
  fsRename: 'fs:rename',
  fsTrash: 'fs:trash',
  fsMkdir: 'fs:mkdir',
  fsExists: 'fs:exists',
  fsCopyImage: 'fs:copyImage',
  imageResolve: 'image:resolve',
  shellReveal: 'shell:reveal',
  sessionGet: 'session:get',
  sessionSet: 'session:set',
  exportSavePath: 'export:savePath',
  exportPdf: 'export:pdf',
  winEdited: 'win:edited',
  winFile: 'win:file',
  // send-only（renderer -> main）
  rendererReady: 'app:renderer-ready',
  // 推送（main -> renderer）
  menu: 'menu',
  openPath: 'open-path',
  fsEvent: 'fs:event',
} as const
