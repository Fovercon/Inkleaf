const { contextBridge, ipcRenderer } = require('electron')
const invoke = (name, ...args) => ipcRenderer.invoke('bug-regression:' + name, ...args)
const on = (name, callback) => {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on('bug-regression:' + name, listener)
  return () => ipcRenderer.removeListener('bug-regression:' + name, listener)
}
const update = { status: 'unsupported', currentVersion: '0.4.0', message: 'Isolated bug acceptance test' }
contextBridge.exposeInMainWorld('mdr', {
  platform: process.platform, sandboxed: process.sandboxed === true,
  fixtureUi: ipcRenderer.sendSync('bug-regression:initialUi'),
  rendererReady: () => ipcRenderer.send('bug-regression:ready'),
  getSession: () => invoke('session'), setSession: value => invoke('setSession', value),
  selectFolder: () => invoke('selectFolder'), selectFile: () => invoke('selectFile'),
  openLibrary: root => invoke('openLibrary', root), readTree: () => invoke('tree'), listFiles: () => invoke('files'),
  closeLibrary: () => invoke('closeLibrary'),
  readFile: path => invoke('read', path), writeFile: (path, content) => invoke('write', path, content),
  resolveImage: (source, documentPath) => invoke('resolveImage', source, documentPath),
  exists: path => invoke('exists', path), confirm: options => invoke('confirm', options),
  onFsEvent: callback => on('fs', callback), onOpenPath: callback => on('openPath', callback), onMenu: callback => on('menu', callback),
  indexResolve: async () => null, indexListNames: async () => [], indexTags: async () => [], indexBacklinks: async () => [],
  indexFilesByTag: async () => [], indexPeek: async () => null, pluginsList: async () => [],
  getUpdateState: async () => update, checkForUpdates: async () => update, downloadUpdate: async () => update,
  cancelUpdate: async () => update, installUpdate: async () => update, onUpdateState: () => () => {},
  setWindowEdited: async () => {}, setWindowFile: async () => {}, reveal: async () => {},
  rename: async () => ({ ok: true }), trash: async () => {}, writeBinary: async () => {}, mkdir: async () => {},
  searchText: async () => [], pathForFile: () => '', pickImage: async () => null, copyImage: async () => null,
  saveExportPath: async () => null, exportPdf: async () => ({ ok: true }), saveNewFile: async () => null,
})
