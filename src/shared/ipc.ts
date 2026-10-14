/**
 * IPC 契约中心 —— 通道名单一事实来源（docs/04 §六）。
 * 主进程 handler 与 preload 桥必须从此处引用通道名与载荷类型，禁止手写字符串。
 * 注意：update:* 家族暂随 updater 模块管理（见 main/updater.ts），待其稳定后并入。
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

// ---------- 通道名 ----------

export const CH = {
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
  searchText: 'search:text',
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsWriteBinary: 'fs:writeBinary',
  fsRename: 'fs:rename',
  fsTrash: 'fs:trash',
  fsMkdir: 'fs:mkdir',
  fsExists: 'fs:exists',
  fsCopyImage: 'fs:copyImage',
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
