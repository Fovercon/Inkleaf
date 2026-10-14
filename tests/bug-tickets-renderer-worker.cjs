const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const { TrustedLocalAssets, handleLocalAsset } = require(process.argv[5])
const fixture = process.argv[6]
const ROOT = path.join(fixture, 'library'), NEXT = path.join(fixture, 'next-library'), OUTSIDE = path.join(fixture, 'outside')
const NOTE = path.join(ROOT, 'Note.md'), EXTERNAL = path.join(OUTSIDE, 'Other.md')
const IMAGE_DOC = path.join(ROOT, 'notes', 'Images.md'), OLD_DOC = path.join(ROOT, 'notes', 'Old.md'), NEW_DOC = path.join(ROOT, 'notes', 'New.md')
const assetUrl = filename => 'mdasset://local' + pathToFileURL(filename).pathname
const contexts = new Map(), checks = []
let resultCode = 0, deadline
protocol.registerSchemesAsPrivileged([{ scheme: 'mdasset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
app.setPath('userData', process.argv[4])
app.on('window-all-closed', () => {})
app.on('will-quit', () => { if (resultCode) app.exit(resultCode) })
const finish = code => {
  clearTimeout(deadline)
  resultCode = code
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.quit()
}
const contextFor = event => {
  const context = contexts.get(event.sender.id)
  assert.ok(context, 'IPC came from an unexpected renderer')
  return context
}
async function treeFor(directory) {
  const nodes = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) nodes.push({ name: entry.name, path: filename, type: 'dir', children: await treeFor(filename) })
    else if (/\.(md|markdown|mdx)$/i.test(entry.name)) nodes.push({ name: entry.name, path: filename, type: 'file' })
  }
  return nodes
}
const flatten = nodes => nodes.flatMap(node => node.type === 'file' ? [node.path] : flatten(node.children || []))
ipcMain.on('bug-regression:initialUi', event => { event.returnValue = contextFor(event).ui })
ipcMain.handle('bug-regression:session', event => contextFor(event).session)
ipcMain.handle('bug-regression:setSession', (event, session) => { contextFor(event).session = session })
ipcMain.handle('bug-regression:selectFolder', event => { const context = contextFor(event); context.folderSelections++; return context.selectedFolder })
ipcMain.handle('bug-regression:selectFile', event => { const context = contextFor(event); context.fileSelections++; return context.selectedFile })
ipcMain.handle('bug-regression:openLibrary', async (event, directory) => {
  const context = contextFor(event)
  context.openCalls.push(directory)
  if (context.openGate) await context.openGate
  if (context.failOpen) throw new Error('Fixture directory unavailable')
  const nodes = await treeFor(directory)
  context.libraryRoot = directory
  context.access.setLibraryRoot(directory)
  return nodes
})
ipcMain.handle('bug-regression:tree', event => {
  const context = contextFor(event)
  context.treeCalls++
  return context.libraryRoot ? treeFor(context.libraryRoot) : []
})
ipcMain.handle('bug-regression:files', async event => {
  const context = contextFor(event)
  return context.libraryRoot ? flatten(await treeFor(context.libraryRoot)) : []
})
ipcMain.handle('bug-regression:closeLibrary', event => {
  const context = contextFor(event)
  context.libraryRoot = null
  context.access.setLibraryRoot(null)
})
ipcMain.handle('bug-regression:read', async (event, filename) => {
  const context = contextFor(event)
  context.reads.push(filename)
  const epoch = context.access.epoch
  const text = await fs.readFile(filename, 'utf8')
  await context.access.registerDocument(filename, epoch)
  return text
})
ipcMain.handle('bug-regression:write', async (event, filename, text) => {
  const context = contextFor(event)
  context.writeAttempts.push(filename)
  if (context.failWrites) throw new Error('Fixture disk full')
  await fs.writeFile(filename, text)
})
ipcMain.handle('bug-regression:resolveImage', (event, source, documentPath) => contextFor(event).access.resolveImage(source, documentPath))
ipcMain.handle('bug-regression:exists', async (event, filename) => { contextFor(event); try { await fs.access(filename); return true } catch { return false } })
ipcMain.handle('bug-regression:confirm', (event, options) => { contextFor(event).dialogs.push(options); return false })

const run = (window, code) => window.webContents.executeJavaScript(code)
const snapshot = window => run(window, 'window.__bugRegression.snapshot()')
const idle = window => run(window, 'window.__bugRegression.waitIdle()')
const open = (window, filename) => run(window, 'window.__bugRegression.openFile(' + JSON.stringify(filename) + ')')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, message, milliseconds = 5000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) { if (await predicate()) return; await sleep(20) }
  throw new Error('Timed out: ' + message)
}
async function click(window, selector) {
  const point = await run(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) throw Error('Missing click target: ' + ${JSON.stringify(selector)})
    const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    if (!rect.width || !rect.height || !hit || !(element === hit || element.contains(hit))) throw Error('Click target is covered: ' + ${JSON.stringify(selector)})
    return { x: Math.round(x), y: Math.round(y) }
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
}
async function settled(window) {
  await until(async () => !(await snapshot(window)).busy, 'library loading to finish')
  await idle(window)
}
async function scenario(name, session, exercise, ui = {}) {
  const window = new BrowserWindow({
    width: 1360, height: 880, show: false,
    webPreferences: { partition: 'bug-tickets-' + checks.length, preload: process.argv[3], sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const id = window.webContents.id
  const context = {
    session, ui, libraryRoot: null, access: new TrustedLocalAssets(),
    selectedFolder: null, selectedFile: null, folderSelections: 0, fileSelections: 0,
    openCalls: [], treeCalls: 0, reads: [], writeAttempts: [], dialogs: [],
    openGate: null, failOpen: false, failWrites: false, protocolCalls: [], protocolPause: null,
  }
  contexts.set(id, context)
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.log('BUG_RENDERER ' + message) })
  window.webContents.session.protocol.handle('mdasset', async request => {
    context.protocolCalls.push(request.url)
    if (context.protocolPause?.url === request.url) await context.protocolPause.gate
    // Production access control, path parsing, MIME and filesystem response are used unchanged.
    return handleLocalAsset(request.url, context.access)
  })
  const ready = new Promise(resolve => {
    const handler = event => {
      if (event.sender.id === id) { ipcMain.removeListener('bug-regression:ready', handler); resolve() }
    }
    ipcMain.on('bug-regression:ready', handler)
  })
  try {
    await window.loadFile(process.argv[2]); await ready; await idle(window)
    assert.equal(await run(window, 'window.mdr.sandboxed'), true, 'The fixture preload must remain sandboxed')
    await exercise(window, context)
    checks.push(name)
    console.log('BUG_TICKETS_CASE PASS ' + name)
  } finally {
    window.destroy()
    contexts.delete(id)
  }
}
async function fixtures() {
  for (const directory of [ROOT, NEXT, OUTSIDE, path.join(ROOT, 'notes'), path.join(ROOT, 'assets'), path.join(fixture, 'empty-library')]) await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(NOTE, '# Note\nFIRST LIBRARY DOCUMENT')
  await fs.writeFile(path.join(NEXT, 'Next.md'), '# Next library')
  await fs.writeFile(EXTERNAL, '# External\nOUTSIDE DOCUMENT SELECTED BY USER')
  const png = await fs.readFile(process.argv[7])
  for (const filename of [path.join(ROOT, 'notes', 'relative.png'), path.join(ROOT, 'assets', 'parent.png'), path.join(ROOT, 'notes', '中文 空格%?#.png'), path.join(ROOT, 'notes', 'raw%photo.png'), path.join(OUTSIDE, 'outside.png')]) await fs.writeFile(filename, png)
  await fs.writeFile(path.join(ROOT, 'notes', 'corrupt.png'), 'not an image')
  await fs.writeFile(path.join(ROOT, 'notes', 'slow.png'), 'delayed corrupt image')
  const relative = 'relative.png', parent = '../assets/parent.png', absolute = path.join(ROOT, 'assets', 'parent.png')
  const file = pathToFileURL(path.join(ROOT, 'assets', 'parent.png')).href
  const special = encodeURIComponent('中文 空格%?#.png'), barePercent = 'raw%photo.png'
  const lines = [['relative', relative], ['parent', parent], ['absolute', absolute], ['file-url', file], ['special-name', special], ['raw-special', '中文 空格%?#.png'], ['bare-percent', barePercent], ['bad-percent', 'missing%ZZ.png'], ['after-bad', relative], ['missing', 'missing.png'], ['forbidden', path.join(OUTSIDE, 'outside.png')], ['corrupt', 'corrupt.png']]
    .map(([alt, source]) => alt === 'bare-percent' || alt === 'bad-percent'
      ? `<img alt="${alt}" src="${source}">`
      : `![${alt}](<${source}>)`)
  await fs.writeFile(IMAGE_DOC, '# Local image cases\n\n' + lines.join('\n\n'))
  await fs.writeFile(OLD_DOC, '# OLD RENDER\n\n![old-delayed](slow.png)')
  await fs.writeFile(NEW_DOC, '# NEW RENDER\n\n![new-current](relative.png)')
}

app.whenReady().then(async () => {
  deadline = setTimeout(() => { console.error('BUG_TICKETS_UI FAIL timeout'); finish(1) }, 105000)
  await fixtures()
  await scenario('first library selection leaves its file tree uncovered and clickable', {}, async (window, context) => {
    context.selectedFolder = ROOT
    assert.equal((await snapshot(window)).welcome, true)
    await click(window, '#empty-open-folder')
    await until(() => context.openCalls.length === 1, 'initial library IPC'); await settled(window)
    const state = await snapshot(window)
    assert.equal(state.libraryRoot, ROOT); assert.equal(state.currentFile, null)
    assert.equal(state.welcome, false); assert.equal(state.libraryEmpty, true)
    assert.equal(context.reads.length, 0, 'Choosing a library must not auto-open a document')
    assert.deepEqual(context.openCalls, [ROOT]); assert.equal(context.treeCalls, 0, 'Opening a library must use its returned tree, with no second scan')
    await click(window, '.tree-row[data-path=' + JSON.stringify(NOTE) + ']')
    await until(() => context.reads.includes(NOTE), 'native tree row click'); await idle(window)
    assert.equal((await snapshot(window)).editorPath, NOTE)
  })
  await scenario('opening a library overrides persisted recent and collapsed sidebar state', {}, async (window, context) => {
    const before = await snapshot(window)
    assert.equal(before.collapsed, true); assert.equal(before.sidebarTab, 'recent', 'Saved preferences must actually be loaded')
    context.selectedFolder = ROOT
    await click(window, '#empty-open-folder')
    await until(() => context.openCalls.length === 1, 'library IPC with collapsed sidebar'); await settled(window)
    const state = await snapshot(window)
    assert.equal(state.collapsed, false); assert.equal(state.sidebarTab, 'files')
    assert.equal(await run(window, 'document.getElementById("tab-files").classList.contains("active")'), true)
    await click(window, '.tree-row[data-path=' + JSON.stringify(NOTE) + ']')
    await until(() => context.reads.includes(NOTE), 'expanded sidebar row click'); await idle(window)
    assert.equal((await snapshot(window)).editorPath, NOTE); assert.equal(context.treeCalls, 0)
  }, { collapsed: { sidebar: true }, sidebarTab: 'recent' })
  await scenario('delayed library opening shows loading and disables duplicate actions until success', {}, async (window, context) => {
    let release
    context.openGate = new Promise(resolve => { release = resolve }); context.selectedFolder = ROOT
    await click(window, '#empty-open-folder')
    await until(() => context.openCalls.length === 1, 'delayed library IPC')
    const loading = await snapshot(window)
    assert.equal(loading.busy, true); assert.equal(loading.feedbackHidden, false); assert.match(loading.feedback, /正在打开书库/)
    assert.equal(await run(window, '["btn-open-folder","empty-open-folder","btn-open-file","empty-open-file","btn-new-file"].every(id=>document.getElementById(id).disabled)'), true)
    assert.equal(await run(window, 'document.getElementById("sidebar").getAttribute("aria-busy")'), 'true')
    await run(window, 'document.getElementById("empty-open-folder").click()')
    assert.equal(context.folderSelections, 1)
    release(); await settled(window)
    const state = await snapshot(window)
    assert.equal(state.busy, false); assert.equal(state.feedbackHidden, true); assert.equal(state.libraryRoot, ROOT)
    assert.equal(await run(window, 'document.getElementById("btn-open-folder").disabled'), false)
    assert.equal(context.treeCalls, 0)
  })
  await scenario('failed delayed library opening clears busy state and permits retry', {}, async (window, context) => {
    let release
    context.openGate = new Promise(resolve => { release = resolve }); context.failOpen = true; context.selectedFolder = ROOT
    await click(window, '#empty-open-folder'); await until(() => context.openCalls.length === 1, 'failed delayed library IPC')
    assert.equal((await snapshot(window)).busy, true)
    release(); await settled(window)
    const failed = await snapshot(window)
    assert.equal(failed.busy, false); assert.equal(failed.libraryRoot, null); assert.equal(failed.welcome, true)
    assert.equal(failed.feedbackHidden, false); assert.match(failed.feedback, /无法打开/)
    assert.equal(await run(window, 'document.getElementById("empty-open-folder").disabled'), false)
    context.failOpen = false; context.openGate = null
    await click(window, '#empty-open-folder'); await until(() => context.openCalls.length === 2, 'retry library IPC'); await settled(window)
    assert.equal((await snapshot(window)).libraryRoot, ROOT); assert.equal((await snapshot(window)).feedbackHidden, true)
  })
  await scenario('an empty library displays its central empty view without hiding the sidebar', {}, async (window, context) => {
    context.selectedFolder = path.join(fixture, 'empty-library')
    await click(window, '#empty-open-folder'); await until(() => context.openCalls.length === 1, 'empty library IPC'); await settled(window)
    const state = await snapshot(window)
    assert.equal(state.welcome, false); assert.equal(state.libraryEmpty, true)
    assert.equal(await run(window, 'document.getElementById("library-empty-title").textContent'), '书库还是空的')
    assert.equal(await run(window, 'document.getElementById("library-new-file").disabled'), false)
    assert.equal(context.reads.length, 0); assert.equal(context.treeCalls, 0)
  })
  await scenario('restart without a last file switches to the parent of a user-selected external Markdown document', { libraryRoot: ROOT }, async (window, context) => {
    assert.equal((await snapshot(window)).currentFile, null)
    context.selectedFile = EXTERNAL
    await click(window, '#btn-open-file'); await until(() => context.reads.includes(EXTERNAL), 'external file read'); await settled(window)
    const state = await snapshot(window)
    assert.equal(state.libraryRoot, OUTSIDE); assert.equal(state.editorPath, EXTERNAL)
    assert.match(state.content, /OUTSIDE DOCUMENT SELECTED BY USER/)
    assert.deepEqual(context.openCalls, [ROOT, OUTSIDE]); assert.equal(context.treeCalls, 0)
    assert.equal(await run(window, '!!document.querySelector(' + JSON.stringify('.tree-row[data-path=' + JSON.stringify(EXTERNAL) + ']') + ')'), true)
    const image = await context.access.resolveImage('outside.png', EXTERNAL)
    assert.ok(image.url, 'The selected external document must gain its own parent image access')
  })
  await scenario('a failed save prevents library switching and preserves the dirty document', { libraryRoot: ROOT, lastFile: NOTE }, async (window, context) => {
    await run(window, 'window.__bugRegression.editor.typeText(" UNSAVED LIBRARY CHANGE")')
    context.failWrites = true; context.selectedFolder = NEXT
    await click(window, '#btn-open-folder')
    await until(async () => /未能保存/.test((await snapshot(window)).feedback), 'save failure feedback'); await settled(window)
    const state = await snapshot(window)
    assert.equal(state.libraryRoot, ROOT); assert.equal(state.editorPath, NOTE); assert.equal(state.dirty, true)
    assert.match(state.content, /UNSAVED LIBRARY CHANGE/); assert.deepEqual(context.openCalls, [ROOT])
    assert.ok(context.writeAttempts.includes(NOTE)); assert.equal(context.treeCalls, 0)
    assert.equal(await run(window, 'document.getElementById("btn-open-folder").disabled'), false)
  })
  await scenario('local image URLs decode in Chromium and errors are visible without aborting subsequent images', { libraryRoot: ROOT, lastFile: IMAGE_DOC }, async (window, context) => {
    const valid = ['relative', 'parent', 'absolute', 'file-url', 'special-name', 'raw-special', 'bare-percent', 'after-bad']
    for (const alt of valid) {
      const image = await run(window, `(async()=>{
        const image=document.querySelector('#preview img[alt='+${JSON.stringify(JSON.stringify(alt))}+']')
        if(!image)throw Error('Missing valid image '+${JSON.stringify(alt)})
        image.loading='eager'
        const deadline=Date.now()+5000
        while(!image.getAttribute('src')?.startsWith('mdasset://')){
          if(!image.isConnected||Date.now()>deadline)throw Error('Image resolution failed '+${JSON.stringify(alt)})
          await new Promise(resolve=>setTimeout(resolve,10))
        }
        await image.decode()
        return {width:image.naturalWidth,height:image.naturalHeight,url:image.src}
      })()`)
      assert.ok(image.width > 0 && image.height > 0, 'Chromium must decode ' + alt)
      assert.match(image.url, /^mdasset:\/\/local\//)
    }
    await run(window, 'for(const image of document.querySelectorAll("#preview img"))image.loading="eager"')
    await until(async () => await run(window, 'document.querySelectorAll("#preview .image-error").length') === 4, 'four image failure placeholders')
    const errors = await run(window, '[...document.querySelectorAll("#preview .image-error")].map(el=>({kind:el.dataset.imageError,alt:el.querySelector(".image-error-alt")?.textContent,reason:el.querySelector(".image-error-reason")?.textContent,path:el.querySelector(".image-error-path")?.textContent}))')
    assert.equal(errors.find(error => error.alt?.includes('missing'))?.kind, 'not-found')
    assert.equal(errors.find(error => error.alt?.includes('forbidden'))?.kind, 'forbidden')
    assert.equal(errors.find(error => error.alt?.includes('corrupt'))?.kind, 'decode')
    assert.ok(errors.find(error => error.alt?.includes('bad-percent')))
    assert.ok(errors.every(error => error.reason && error.path), 'Every failed image needs an actionable visible reason and path')
    const statuses = await run(window, `Promise.all([${JSON.stringify(assetUrl(path.join(OUTSIDE, 'outside.png')))},${JSON.stringify(assetUrl(path.join(ROOT, 'notes', 'missing.png')))}].map(async url=>(await fetch(url)).status))`)
    assert.deepEqual(statuses, [403, 404], 'The actual production protocol response must distinguish forbidden and missing images')
    for (const filename of ['relative.png', '中文 空格%?#.png', 'raw%photo.png']) {
      assert.ok(context.protocolCalls.includes(assetUrl(path.join(ROOT, 'notes', filename))), 'The actual protocol must serve ' + filename)
    }
  })
  await scenario('an old delayed image load cannot add errors to a newly opened document', { libraryRoot: ROOT }, async (window, context) => {
    let release
    const slowUrl = assetUrl(path.join(ROOT, 'notes', 'slow.png'))
    context.protocolPause = { url: slowUrl, gate: new Promise(resolve => { release = resolve }) }
    assert.equal(await open(window, OLD_DOC), true)
    await run(window, 'document.querySelector("#preview img").loading="eager"')
    await until(() => context.protocolCalls.includes(slowUrl), 'old delayed image request')
    assert.equal(await open(window, NEW_DOC), true)
    await run(window, '(async()=>{const image=document.querySelector("#preview img");image.loading="eager";const end=Date.now()+5000;while(!image.getAttribute("src")?.startsWith("mdasset://")){if(!image.isConnected||Date.now()>end)throw Error("New image resolution failed");await new Promise(resolve=>setTimeout(resolve,10))}await image.decode()})()')
    release(); await sleep(200)
    const preview = await run(window, '({text:document.getElementById("preview").textContent,errors:document.querySelectorAll("#preview .image-error").length,alts:[...document.querySelectorAll("#preview img")].map(image=>image.alt)})')
    assert.match(preview.text, /NEW RENDER/); assert.doesNotMatch(preview.text, /OLD RENDER|old-delayed/)
    assert.equal(preview.errors, 0); assert.deepEqual(preview.alts, ['new-current'])
  })
  console.log('BUG_TICKETS_UI PASS ' + JSON.stringify({ checks: checks.length, names: checks }))
  finish(0)
}).catch(error => { console.error('BUG_TICKETS_UI FAIL', error); finish(1) })
