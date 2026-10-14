import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { build } from 'esbuild'

const repository = process.cwd()
const delay = () => new Promise(resolve => setTimeout(resolve, 2))
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 250; i++) { if (check()) return; await delay() }
  assert.fail(message)
}
class Watcher {
  private handlers = new Map<string, (file: string) => void>()
  closed = false
  constructor(readonly root: string) {}
  on(event: string, fn: (file: string) => void) { this.handlers.set(event, fn); return this }
  emit(event: string, file: string) { this.handlers.get(event)?.(file) }
  async close() { this.closed = true }
}
async function fixture(t: TestContext) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inkleaf-ipc-race-')))
  const root = path.join(temporary, 'library'), profile = path.join(temporary, 'profile')
  await fs.mkdir(root); await fs.mkdir(profile)
  const a = path.join(root, 'A.md'), raw = '# A\n#initial\n'
  await fs.writeFile(a, raw)
  const cache = path.join(profile, 'index.json'), session = path.join(profile, 'session.json')
  await fs.writeFile(cache, JSON.stringify({ version: 2, root, entries: [{ path: a, title: 'A', tags: ['initial'], links: [], frontmatter: {}, sha256: createHash('sha256').update(raw).digest('hex') }] }))
  const handlers = new Map<string, (...args: any[]) => any>(), watchers: Watcher[] = []
  Object.assign(globalThis, { __ipcRaceProfile: profile, __ipcRaceHandlers: handlers, __ipcRaceWatch: (root: string) => { const watcher = new Watcher(root); watchers.push(watcher); return watcher } })
  const bundle = await build({ stdin: { contents: `export {registerIpc,getLibraryRoot} from './src/main/ipc';export {resolveName,queryTags,listNames} from './src/main/index-service';export {CH} from './src/shared/ipc'`, resolveDir: repository }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', plugins: [{ name: 'controlled-host', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onResolve({ filter: /^chokidar$/ }, () => ({ path: 'chokidar', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
      ? `export const app={getPath:()=>globalThis.__ipcRaceProfile};export const ipcMain={handle:(channel,fn)=>globalThis.__ipcRaceHandlers.set(channel,fn)};export const BrowserWindow={getAllWindows:()=>[],fromWebContents:()=>null};export const dialog={};export const shell={};export const Menu={};`
      : `export default {watch:root=>globalThis.__ipcRaceWatch(root)}` }))
  } }] })
  const module = { exports: {} as any }
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, createRequire(path.join(repository, 'package.json')))
  const api = module.exports
  api.registerIpc()
  const invoke = (channel: string, ...args: any[]) => handlers.get(channel)!({}, ...args)
  t.after(async () => { await invoke(api.CH.libClose); await fs.rm(temporary, { recursive: true, force: true }) })
  return { api, invoke, root, profile, temporary, a, cache, session, watchers }
}
async function pause(method: 'readFile' | 'readdir' | 'writeFile', filename: string) {
  const original = fs[method]
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { reached = resolve })
  let intercepted = false
  ;(fs as any)[method] = async (...args: any[]) => {
    const result = await (original as any)(...args)
    if (String(args[0]) === filename && !intercepted) { intercepted = true; reached(); await gate }
    return result
  }
  return { entered, release, restore() { (fs as any)[method] = original; release() } }
}

test('a file added while startup cache validation is paused remains in the rebuilt index', async t => {
  const { api, invoke, root, a, cache, watchers } = await fixture(t)
  const paused = await pause('readFile', cache)
  try {
    await invoke(api.CH.libOpen, root)
    await paused.entered
    const c = path.join(root, 'C.md')
    await fs.writeFile(c, '# C\n#added\n')
    assert.equal(watchers.length, 1)
    watchers[0].emit('add', c)
    await until(() => api.resolveName('C') === c, 'The add event must update the in-flight cache generation')
    paused.release()
    await until(() => api.resolveName('A') === a && api.resolveName('C') === c, 'Fresh startup rebuilding must retain the added file')
    assert(api.queryTags().some((tag: { tag: string }) => tag.tag === 'added'))
    assert((await invoke(api.CH.libListFiles)).includes(c))
  } finally { paused.restore() }
})

test('a watcher event during file enumeration forces a rescan and cannot refill an old cache', async t => {
  const { api, invoke, root, a, watchers } = await fixture(t)
  await invoke(api.CH.libOpen, root)
  await until(() => api.resolveName('A') === a, 'Initial index must finish before exercising the cached scanner')
  watchers[0].emit('change', a)
  const paused = await pause('readdir', root)
  try {
    const listing = invoke(api.CH.libListFiles)
    await paused.entered
    const c = path.join(root, 'C.md'); await fs.writeFile(c, '# C\n')
    watchers[0].emit('add', c)
    paused.release()
    assert((await listing).includes(c), 'The scan that captured the old directory entries must retry')
    assert((await invoke(api.CH.libListFiles)).includes(c), 'A later cache hit must include the watcher addition')
  } finally { paused.restore() }
})

test('a paused old-root scan cannot resurrect cache or index after closing and opening another root', async t => {
  const { api, invoke, root, a, temporary, watchers } = await fixture(t)
  await invoke(api.CH.libOpen, root)
  await until(() => api.resolveName('A') === a, 'Initial index must finish')
  watchers[0].emit('change', a)
  const paused = await pause('readdir', root)
  try {
    const oldListing = invoke(api.CH.libListFiles)
    await paused.entered
    await invoke(api.CH.libClose)
    const other = path.join(temporary, 'other'); await fs.mkdir(other)
    const b = path.join(other, 'B.md'); await fs.writeFile(b, '# B\n')
    await invoke(api.CH.libOpen, other)
    await until(() => api.resolveName('B') === b, 'The new library must initialize independently')
    paused.release()
    assert.deepEqual(await oldListing, [])
    assert.equal(api.getLibraryRoot(), other)
    assert.deepEqual(await invoke(api.CH.libListFiles), [b])
    assert.equal(api.resolveName('A'), null)
    watchers[0].emit('change', a)
    assert.deepEqual(await invoke(api.CH.libListFiles), [b], 'Late old-watcher events must also be ignored')
  } finally { paused.restore() }
})

test('closing while library-open session persistence is pending returns no stale tree and preserves closed session', async t => {
  const { api, invoke, root, session } = await fixture(t)
  const paused = await pause('writeFile', session + '.tmp')
  try {
    const opening = invoke(api.CH.libOpen, root)
    await paused.entered
    const closing = invoke(api.CH.libClose)
    assert.equal(api.getLibraryRoot(), null)
    paused.release()
    assert.equal(await opening, null)
    await closing
    assert.equal(JSON.parse(await fs.readFile(session, 'utf8')).libraryRoot, null)
    assert.deepEqual(api.listNames(), [])
  } finally { paused.restore() }
})

test('opening a missing path or regular file keeps the current library and durable session', async t => {
  const { api, invoke, root, a, temporary, session, watchers } = await fixture(t)
  await invoke(api.CH.libOpen, root)
  await until(() => api.resolveName('A') === a, 'The previous library must initialize')
  assert.equal(await invoke(api.CH.libOpen, path.join(temporary, 'missing')), null)
  assert.equal(await invoke(api.CH.libOpen, a), null)
  assert.equal(api.getLibraryRoot(), root)
  assert.equal(JSON.parse(await fs.readFile(session, 'utf8')).libraryRoot, root)
  assert.equal(api.resolveName('A'), a)
  assert.equal(watchers.length, 1); assert.equal(watchers[0].closed, false)
})

test('a directory read failure keeps the old tree, index, watcher and image access', async t => {
  const { api, invoke, root, a, temporary, watchers } = await fixture(t)
  await invoke(api.CH.libOpen, root)
  await until(() => api.resolveName('A') === a, 'The old index must finish')
  await invoke(api.CH.fsRead, a)
  await fs.writeFile(path.join(root, 'old.png'), 'fixture image bytes')
  const inaccessible = path.join(temporary, 'inaccessible'); await fs.mkdir(inaccessible)
  const original = fs.readdir
  fs.readdir = (async (...args: any[]) => {
    if (String(args[0]) === inaccessible) throw Object.assign(new Error('Denied'), { code: 'EACCES' })
    return (original as any)(...args)
  }) as typeof fs.readdir
  try {
    assert.equal(await invoke(api.CH.libOpen, inaccessible), null)
    assert.equal(api.getLibraryRoot(), root)
    assert.equal(api.resolveName('A'), a)
    assert.equal(watchers[0].closed, false)
    assert.equal((await invoke(api.CH.imageResolve, 'old.png', a)).error, undefined)
  } finally { fs.readdir = original }
})

test('failed session persistence cannot partially switch the library or revoke its images', async t => {
  const { api, invoke, root, a, temporary, session, watchers } = await fixture(t)
  await invoke(api.CH.libOpen, root)
  await until(() => api.resolveName('A') === a, 'The old library must initialize')
  await invoke(api.CH.fsRead, a)
  await fs.writeFile(path.join(root, 'old.png'), 'fixture image bytes')
  const other = path.join(temporary, 'other'); await fs.mkdir(other)
  await fs.writeFile(path.join(other, 'B.md'), '# B')
  const original = fs.writeFile
  fs.writeFile = (async (...args: any[]) => {
    if (String(args[0]) === session + '.tmp') throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
    return (original as any)(...args)
  }) as typeof fs.writeFile
  try {
    assert.equal(await invoke(api.CH.libOpen, other), null)
    assert.equal(api.getLibraryRoot(), root)
    assert.equal(api.resolveName('A'), a)
    assert.equal(JSON.parse(await fs.readFile(session, 'utf8')).libraryRoot, root)
    assert.equal(watchers.length, 1); assert.equal(watchers[0].closed, false)
    assert.equal((await invoke(api.CH.imageResolve, 'old.png', a)).error, undefined)
  } finally { fs.writeFile = original }
})

test('a newer failed selection cancels and rolls back an older pending library persistence', async t => {
  const { api, invoke, root, a, temporary, session } = await fixture(t)
  await invoke(api.CH.libOpen, root)
  await until(() => api.resolveName('A') === a, 'The previous library must finish')
  const other = path.join(temporary, 'other'); await fs.mkdir(other)
  await fs.writeFile(path.join(other, 'B.md'), '# B')
  const paused = await pause('writeFile', session + '.tmp')
  try {
    const oldOpening = invoke(api.CH.libOpen, other)
    await paused.entered
    assert.equal(await invoke(api.CH.libOpen, path.join(temporary, 'missing')), null)
    paused.release()
    assert.equal(await oldOpening, null)
    assert.equal(api.getLibraryRoot(), root)
    assert.equal(JSON.parse(await fs.readFile(session, 'utf8')).libraryRoot, root)
    assert.equal(api.resolveName('A'), a)
  } finally { paused.restore() }
})
