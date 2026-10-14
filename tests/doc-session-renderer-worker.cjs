const assert = require('node:assert/strict')
const { app, BrowserWindow, ipcMain } = require('electron')
app.setPath('userData', process.argv[4])
app.on('window-all-closed', () => {})
const ROOT = '/doc-session-fixture'
const A = ROOT + '/A.md', B = ROOT + '/B.md', C = ROOT + '/C.md'
const contexts = new Map(), checks = []
const contextFor = event => {
  const context = contexts.get(event.sender.id)
  assert.ok(context, 'IPC came from an unexpected renderer')
  return context
}
ipcMain.handle('doc-regression:session', event => contextFor(event).session)
ipcMain.handle('doc-regression:setSession', (event, session) => { contextFor(event).session = session })
ipcMain.handle('doc-regression:files', event => [...contextFor(event).files.keys()])
ipcMain.handle('doc-regression:tree', event => {
  const context = contextFor(event)
  return context.closedLibrary ? [] : [...context.files.keys()].map(path => ({ path, name: path.split('/').pop(), type: 'file' }))
})
ipcMain.handle('doc-regression:closeLibrary', event => { contextFor(event).closedLibrary++ })
ipcMain.handle('doc-regression:read', async (event, path) => {
  const context = contextFor(event)
  context.reads.push(path)
  if (context.pauseRead?.path === path) await context.pauseRead.gate
  if (!context.files.has(path)) throw Error('Missing file: ' + path)
  return context.files.get(path)
})
ipcMain.handle('doc-regression:write', async (event, path, content) => {
  const context = contextFor(event)
  context.attempts.push({ path, content })
  if (context.failWrites) throw Error('disk full')
  if (context.pauseWrite) {
    const gate = context.pauseWrite
    context.pauseWrite = null
    await gate
  }
  context.writes.push({ path, content })
  context.files.set(path, content)
})
ipcMain.handle('doc-regression:rename', async (event, oldPath, newPath) => {
  const context = contextFor(event)
  context.renameAttempts++
  if (context.pauseRename) await context.pauseRename
  for (const [path, content] of [...context.files]) {
    if (path === oldPath || path.startsWith(oldPath + '/')) {
      context.files.set(newPath + path.slice(oldPath.length), content)
      context.files.delete(path)
    }
  }
  return { ok: true }
})
ipcMain.handle('doc-regression:trash', (event, path) => {
  const context = contextFor(event)
  context.trashAttempts++
  for (const key of [...context.files.keys()]) if (key === path || key.startsWith(path + '/')) context.files.delete(key)
})
ipcMain.handle('doc-regression:exists', (event, path) => contextFor(event).files.has(path))
ipcMain.handle('doc-regression:confirm', (event, options) => {
  const context = contextFor(event)
  context.dialogs.push(options)
  return options.title === '移到废纸篓' ? true : false
})
ipcMain.handle('doc-regression:resolve', (event, name) => {
  const paths = [...contextFor(event).files.keys()]
  return paths.find(path => path.split('/').pop().replace(/\.md$/, '') === name) || null
})
const run = (window, code) => window.webContents.executeJavaScript(code)
const snapshot = window => run(window, 'window.__docRegression.snapshot()')
const idle = window => run(window, 'window.__docRegression.waitIdle()')
const open = (window, path, newTab = false) => run(window, 'window.__docRegression.openFile(' + JSON.stringify(path) + ', {newTab:' + newTab + '})')
const type = (window, text) => run(window, 'window.__docRegression.editor.typeText(' + JSON.stringify(text) + ')')
const delay = (window, milliseconds = 350) => run(window, 'new Promise(resolve => setTimeout(resolve, ' + milliseconds + '))')
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('Timed out waiting for an IPC boundary')
}
async function scenario(name, session, exercise, customFiles = []) {
  const window = new BrowserWindow({
    width: 1200, height: 780, show: false,
    webPreferences: { preload: process.argv[3], sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const id = window.webContents.id
  const context = {
    session, files: new Map([[A, '# A document\nA ORIGINAL'], [B, '# B document\nB ORIGINAL'], [C, '# C document\nC ORIGINAL'], ...customFiles]),
    reads: [], writes: [], attempts: [], dialogs: [], failWrites: false, pauseWrite: null,
    pauseRead: null, pauseRename: null, renameAttempts: 0, trashAttempts: 0, closedLibrary: 0,
  }
  contexts.set(id, context)
  const ready = new Promise(resolve => {
    const handler = event => {
      if (event.sender.id === id) { ipcMain.removeListener('doc-regression:ready', handler); resolve() }
    }
    ipcMain.on('doc-regression:ready', handler)
  })
  try {
    await window.loadFile(process.argv[2])
    await ready
    await idle(window)
    assert.equal(await run(window, 'window.mdr.sandboxed'), true)
    await exercise(window, context)
    checks.push(name)
    console.log('DOC_SESSION_CASE PASS ' + name)
  } finally {
    window.destroy()
    contexts.delete(id)
  }
}
app.whenReady().then(async () => {
  const deadline = setTimeout(() => { console.error('DOC_SESSION_UI FAIL timeout'); app.exit(1) }, 65000)
  await scenario('restore-actual-active-document', { libraryRoot: ROOT, lastFile: B, tabs: [A, B], activeIndex: 1 }, async (window, context) => {
    const state = await snapshot(window)
    assert.equal(state.editorPath, B); assert.equal(state.currentFile, B); assert.equal(state.activePath, B)
    assert.equal(state.content, context.files.get(B)); assert.equal(state.empty, false)
    assert.deepEqual(context.reads, [B])
  })
  await scenario('close-active-saves-the-surviving-document', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await open(window, B, true)
    await run(window, 'window.__docRegression.closeTabUi(1)')
    await idle(window)
    const state = await snapshot(window)
    assert.equal(state.editorPath, A); assert.equal(state.currentFile, A); assert.equal(state.activePath, A)
    assert.equal(state.content, context.files.get(A))
    await type(window, ' AFTER CLOSE'); await run(window, 'window.__docRegression.saveAllDocuments()')
    assert.equal(context.writes.at(-1).path, A); assert.equal(context.files.get(B), '# B document\nB ORIGINAL')
  })
  await scenario('close-background-preserves-active-identity', { libraryRoot: ROOT, lastFile: A }, async window => {
    await open(window, B, true); await open(window, C, true)
    await run(window, 'window.__docRegression.closeTabUi(0)'); await idle(window)
    const state = await snapshot(window)
    assert.deepEqual(state.paths, [B, C]); assert.equal(state.activeIndex, 1); assert.equal(state.editorPath, C)
  })
  await scenario('close-active-with-vanished-neighbor-clears-document', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await open(window, B, true); context.files.delete(A)
    await run(window, 'window.__docRegression.closeTabUi(1)'); await idle(window)
    const state = await snapshot(window)
    assert.deepEqual(state.paths, []); assert.equal(state.editorPath, null); assert.equal(state.currentFile, null)
    assert.equal(state.empty, false); assert.equal(state.libraryEmpty, true); assert.equal(context.files.has(A), false)
  })
  await scenario('close-active-pauses-input-during-neighbor-read', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await open(window, B, true)
    let release
    context.pauseRead = { path: A, gate: new Promise(resolve => { release = resolve }) }
    const readCount = context.reads.length
    const closing = run(window, 'window.__docRegression.closeTabUi(1)')
    await until(() => context.reads.length > readCount)
    await type(window, ' SHOULD NOT EDIT CLOSED B')
    release(); await closing; await idle(window)
    assert.equal((await snapshot(window)).editorPath, A)
    assert.equal(context.files.get(B), '# B document\nB ORIGINAL')
    assert.equal(context.attempts.some(write => write.path === B), false)
  })
  await scenario('rename-inactive-migrates-cached-path', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await open(window, B, true)
    const renamed = ROOT + '/A-renamed.md'
    await run(window, 'window.__docRegression.tree.applyRename(' + JSON.stringify(A) + ', "A-renamed.md")')
    await idle(window)
    assert.deepEqual((await snapshot(window)).paths, [renamed, B])
    await open(window, renamed); await type(window, ' AFTER RENAME'); await run(window, 'window.__docRegression.saveAllDocuments()')
    assert.equal(context.files.has(A), false); assert.equal(context.writes.at(-1).path, renamed)
  })
  await scenario('active-dirty-rename-does-not-recreate-old-path', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await type(window, ' UNSAVED RENAME')
    let release
    context.pauseRename = new Promise(resolve => { release = resolve })
    const operation = run(window, 'window.__docRegression.tree.applyRename(' + JSON.stringify(A) + ', "A-renamed.md")')
    await until(() => context.renameAttempts === 1)
    await type(window, ' SHOULD BE PAUSED')
    release(); await operation; await idle(window)
    const renamed = ROOT + '/A-renamed.md', state = await snapshot(window)
    assert.equal(state.editorPath, renamed); assert.equal(state.activePath, renamed)
    assert.match(context.files.get(renamed), /UNSAVED RENAME/); assert.doesNotMatch(state.content, /SHOULD BE PAUSED/)
    await type(window, ' AFTER MOVE'); await run(window, 'window.__docRegression.saveAllDocuments()')
    assert.equal(context.files.has(A), false); assert.match(context.files.get(renamed), /AFTER MOVE/)
  })
  await scenario('delete-inactive-and-dirty-active-does-not-resurrect', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await open(window, B, true)
    await run(window, 'window.__docRegression.tree.applyDelete({path:' + JSON.stringify(A) + ',name:"A.md",type:"file"})')
    await type(window, ' UNSAVED DELETED')
    await run(window, 'window.__docRegression.tree.applyDelete({path:' + JSON.stringify(B) + ',name:"B.md",type:"file"})')
    await idle(window); await delay(window, 50)
    const state = await snapshot(window)
    assert.deepEqual(state.paths, []); assert.equal(state.editorPath, null); assert.equal(state.currentFile, null)
    assert.equal(state.empty, false); assert.equal(state.libraryEmpty, true); assert.equal(context.files.has(A), false); assert.equal(context.files.has(B), false)
    assert.equal(context.trashAttempts, 2)
  })
  await scenario('batched-inactive-external-change-survives-next-save', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await open(window, B, true)
    context.files.set(A, '# External replacement\nEXTERNAL EDIT SHOULD SURVIVE')
    window.webContents.send('doc-regression:fs', { path: A, event: 'change' })
    window.webContents.send('doc-regression:fs', { path: C, event: 'change' })
    await delay(window); await idle(window); await open(window, A)
    assert.match((await snapshot(window)).content, /EXTERNAL EDIT SHOULD SURVIVE/)
    await type(window, ' NEXT EDIT'); await run(window, 'window.__docRegression.saveAllDocuments()')
    assert.match(context.files.get(A), /EXTERNAL EDIT SHOULD SURVIVE/)
  })
  await scenario('missing-cached-file-is-validated-without-watch', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await open(window, B, true); context.files.delete(A)
    assert.equal(await open(window, A), false)
    const state = await snapshot(window)
    assert.deepEqual(state.paths, [B]); assert.equal(state.editorPath, B); assert.equal(context.files.has(A), false)
  })
  await scenario('save-failure-blocks-switch-close-library-and-mutation', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await type(window, ' UNSAVED CONTENT'); context.failWrites = true
    assert.equal(await open(window, B, true), false)
    await run(window, 'window.__docRegression.closeTabUi(0)')
    await run(window, 'window.__docRegression.closeLibrary()')
    await run(window, 'window.__docRegression.tree.applyRename(' + JSON.stringify(A) + ', "blocked.md")')
    await run(window, 'window.__docRegression.tree.applyDelete({path:' + JSON.stringify(A) + ',name:"A.md",type:"file"})')
    let state = await snapshot(window)
    assert.equal(state.editorPath, A); assert.equal(state.dirty, true); assert.deepEqual(state.paths, [A])
    assert.equal(context.closedLibrary, 0); assert.equal(context.renameAttempts, 0); assert.equal(context.trashAttempts, 0)
    context.failWrites = false
    await run(window, 'window.__docRegression.closeLibrary()'); await idle(window)
    state = await snapshot(window)
    assert.match(context.files.get(A), /UNSAVED CONTENT/); assert.deepEqual(state.paths, [])
    assert.equal(state.editorPath, null); assert.equal(state.libraryRoot, null); assert.equal(state.preview, '')
    assert.deepEqual(context.session.tabs, [])
  })
  await scenario('typing-during-inflight-save-is-flushed-before-switch', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await type(window, ' FIRST INPUT')
    let release
    context.pauseWrite = new Promise(resolve => { release = resolve })
    const switching = open(window, B, true)
    await until(() => context.attempts.length > 0)
    await type(window, ' LATER INPUT'); release(); await switching
    assert.match(context.files.get(A), /FIRST INPUT/); assert.match(context.files.get(A), /LATER INPUT/)
    assert.equal((await snapshot(window)).editorPath, B)
  })
  await scenario('typing-during-target-read-is-flushed-before-switch', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    let release
    context.pauseRead = { path: B, gate: new Promise(resolve => { release = resolve }) }
    const switching = open(window, B, true)
    await until(() => context.reads.includes(B))
    await type(window, ' INPUT DURING READ'); release(); await switching
    assert.match(context.files.get(A), /INPUT DURING READ/)
    await open(window, A)
    assert.match((await snapshot(window)).content, /INPUT DURING READ/)
  })
  await scenario('undo-and-dark-theme-survive-document-roundtrip', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    await run(window, 'document.dispatchEvent(new CustomEvent("mdr-test-theme", {detail:{theme:"dark"}}))')
    await type(window, ' UNDO MARK'); await open(window, B, true); await open(window, A)
    const state = await snapshot(window)
    assert.equal(state.undoDepth, 1); assert.equal(state.editorDark, true)
    assert.equal(await run(window, 'window.__docRegression.undo()'), true)
    await run(window, 'window.__docRegression.saveAllDocuments()')
    assert.doesNotMatch(context.files.get(A), /UNDO MARK/)
  })
  await scenario('cross-document-wikilink-anchor-resolves-after-load', { libraryRoot: ROOT, lastFile: A }, async window => {
    await delay(window, 50)
    assert.equal(await run(window, '!!document.querySelector("a[data-wikilink]")'), true)
    await run(window, 'document.querySelector("a[data-wikilink]").click()'); await idle(window)
    const state = await snapshot(window)
    assert.equal(state.editorPath, B); assert.equal(state.jumpLine, 3)
  }, [[A, '# Source\n[[B#Destination]]'], [B, 'Before heading\n\n## Destination\n\nTarget body']])
  await scenario('twelve-tab-replacement-and-dirty-limit-protection', { libraryRoot: ROOT, lastFile: A }, async (window, context) => {
    const paths = Array.from({ length: 13 }, (_, index) => ROOT + '/F' + index + '.md')
    paths.forEach(path => context.files.set(path, '# ' + path))
    await open(window, paths[0]); for (const path of paths.slice(1, 12)) await open(window, path, true)
    await open(window, paths[5]); await open(window, paths[12])
    let state = await snapshot(window)
    assert.equal(state.paths.length, 12); assert.equal(state.paths.includes(paths[5]), false)
    assert.equal(state.paths.includes(paths[0]), true); assert.equal(state.paths.includes(paths[6]), true)
    await run(window, 'for (const item of window.__docRegression.tabs.all()) if (item.path !== window.__docRegression.editor.currentPath) item.dirty = true')
    const overflow = ROOT + '/Overflow.md'; context.files.set(overflow, '# Overflow')
    assert.equal(await open(window, overflow, true), false)
    state = await snapshot(window)
    assert.equal(state.paths.length, 12); assert.equal(state.editorPath, paths[12]); assert.equal(state.paths.includes(overflow), false)
  })
  clearTimeout(deadline)
  console.log('DOC_SESSION_UI PASS ' + JSON.stringify({ checks: checks.length, names: checks }))
  app.exit(0)
}).catch(error => { console.error('DOC_SESSION_UI FAIL', error); app.exit(1) })
