const { contextBridge, ipcRenderer } = require('electron')
const update = { status: 'unsupported', currentVersion: '0.4.0', message: 'Isolated document regression' }
const invoke = (name, ...args) => ipcRenderer.invoke('doc-regression:' + name, ...args)
const on = (channel, callback) => {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on('doc-regression:' + channel, listener)
  return () => ipcRenderer.removeListener('doc-regression:' + channel, listener)
}
contextBridge.exposeInMainWorld('mdr', {
  platform: process.platform, sandboxed: process.sandboxed === true,
  rendererReady: () => ipcRenderer.send('doc-regression:ready'),
  getSession: () => invoke('session'), setSession: value => invoke('setSession', value),
  openLibrary: () => invoke('tree'), readTree: () => invoke('tree'), listFiles: () => invoke('files'),
  closeLibrary: () => invoke('closeLibrary'),
  readFile: path => invoke('read', path), writeFile: (path, content) => invoke('write', path, content),
  rename: (oldPath, newPath) => invoke('rename', oldPath, newPath), trash: path => invoke('trash', path),
  exists: path => invoke('exists', path), confirm: options => invoke('confirm', options),
  onFsEvent: callback => on('fs', callback), onOpenPath: callback => on('openPath', callback),
  onMenu: callback => on('menu', callback), indexResolve: name => invoke('resolve', name),
  indexListNames: async () => [], indexTags: async () => [], indexBacklinks: async () => [],
  indexFilesByTag: async () => [], indexPeek: async () => null, pluginsList: async () => [],
  getUpdateState: async () => update, checkForUpdates: async () => update, downloadUpdate: async () => update,
  cancelUpdate: async () => update, installUpdate: async () => update, onUpdateState: () => () => {},
  setWindowEdited: async () => {}, setWindowFile: async () => {}, reveal: async () => {},
  selectFile: async () => null, selectFolder: async () => null, writeBinary: async () => {},
  mkdir: async () => {}, searchText: async () => [], pathForFile: () => '',
  pickImage: async () => null, copyImage: async () => null, saveExportPath: async () => null,
  exportPdf: async () => ({ ok: true }), saveNewFile: async () => null,
})
