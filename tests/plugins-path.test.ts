import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'

const repository = process.cwd()
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'inkleaf-plugin-path-')))
  const root = path.join(directory, 'plugins')
  await mkdir(root)
  ;(globalThis as any).__pluginUserData = directory
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  const bridge = { handlers, selected: '', trash: async (target: string) => rm(target, { recursive: true }), openError: '', confirm: true, failCommit: false }
  ;(globalThis as any).__pluginHostFixture = bridge
  const bundle = await build({ entryPoints: ['src/main/plugins-host.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'mock-electron', setup(build) {
    build.onResolve({ filter: /^node:fs\/promises$/ }, args => args.namespace === 'fixture-fs' ? { path: args.path, external: true } : { path: 'fs', namespace: 'fixture-fs' })
    build.onLoad({ filter: /.*/, namespace: 'fixture-fs' }, () => ({ contents: `const fs=require('node:fs/promises');export default {...fs,rename:async(from,to)=>{if(globalThis.__pluginHostFixture.failCommit&&from.endsWith('/payload'))throw Error('simulated commit failure');return fs.rename(from,to)}}` }))
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `const f=globalThis.__pluginHostFixture;export const app={getPath:()=>globalThis.__pluginUserData,getVersion:()=> '0.5.1'};export const ipcMain={handle:(id,fn)=>f.handlers.set(id,fn)};export const dialog={showMessageBox:async()=>({response:f.confirm?1:0}),showOpenDialog:async()=>({canceled:!f.selected,filePaths:f.selected?[f.selected]:[]})};export const shell={trashItem:path=>f.trash(path),openPath:async()=>f.openError}` }))
  } }] })
  const module = { exports: {} as any }
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, createRequire(path.join(repository, 'package.json')))
  const install = async (name: string, main: string, permissions: string[] = []) => {
    const plugin = path.join(root, name)
    await mkdir(plugin, { recursive: true })
    await writeFile(path.join(plugin, 'ink.plugin.json'), JSON.stringify({ id: name, version: '1.0.0', main, permissions }))
    return plugin
  }
  module.exports.registerPluginIpc()
  return { directory, root, install, api: module.exports as any, bridge, invoke: (channel: string, ...args: unknown[]) => handlers.get('plugins:' + channel)!(null, ...args) }
}

test('manifest and protocol consistently serve Unicode paths within their own plugin', async t => {
  const { directory, install, api } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const plugin = await install('valid', '入口 文件.mjs')
  await writeFile(path.join(plugin, '入口 文件.mjs'), 'export function activate() {}')
  const discovered = await api.listPlugins()
  assert.equal(discovered.length, 1)
  assert.equal(await api.resolvePluginFile(discovered[0].mainUrl), path.join(plugin, '入口 文件.mjs'))
})

test('folder install uses manifest identity, rejects duplicates, and serializes concurrent requests', async t => {
  const { directory, root, bridge, invoke } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  bridge.selected = path.join(directory, 'My Download v1')
  await mkdir(bridge.selected)
  await writeFile(path.join(bridge.selected, 'ink.plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', permissions: [], main: 'main.mjs' }))
  await writeFile(path.join(bridge.selected, 'main.mjs'), 'export function activate() {}')
  const results = await Promise.all([invoke('install'), invoke('install')])
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.equal(results.find(r => r.ok).id, 'demo')
  assert.deepEqual(await readdir(root), ['demo'])
  assert.match(await readFile(path.join(root, 'demo', 'main.mjs'), 'utf8'), /activate/)
})

test('unsafe or failed copies leave no partial install; cancellation is explicit', async t => {
  const { directory, root, bridge, invoke } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  assert.equal((await invoke('install')).canceled, true)
  bridge.selected = path.join(directory, 'download')
  await mkdir(bridge.selected)
  await writeFile(path.join(bridge.selected, 'ink.plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', permissions: [] }))
  await writeFile(path.join(bridge.selected, 'main.mjs'), 'export function activate() {}')
  await symlink(directory, path.join(bridge.selected, 'escape'))
  assert.equal((await invoke('install')).ok, false)
  assert.deepEqual(await readdir(root), [])
  bridge.selected = directory
  await writeFile(path.join(directory, 'ink.plugin.json'), JSON.stringify({ id: 'ancestor', version: '1.0.0', permissions: [] }))
  await writeFile(path.join(directory, 'main.mjs'), '')
  assert.equal((await invoke('install')).ok, false, 'cannot copy an ancestor of the plugin root into itself')
  assert.deepEqual(await readdir(root), [])
})

test('uninstall resolves legacy folder names by manifest ID and reports trash failures without deletion', async t => {
  const { directory, root, install, bridge, invoke } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const folder = await install('old-folder', 'main.mjs')
  await writeFile(path.join(folder, 'main.mjs'), '')
  await writeFile(path.join(folder, 'ink.plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', permissions: [] }))
  const trash = bridge.trash
  bridge.trash = async () => { throw Error('trash unavailable') }
  const failed = await invoke('uninstall', 'demo')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /trash unavailable/)
  assert.deepEqual(await readdir(root), ['old-folder'])
  bridge.trash = trash
  assert.equal((await invoke('uninstall', 'demo')).ok, true)
  assert.deepEqual(await readdir(root), [])
  assert.equal((await invoke('uninstall', '../outside')).ok, false)
})

test('directory scan and reveal failures are surfaced rather than looking like an empty plugin collection', async t => {
  const { directory, root, api, bridge, invoke } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  bridge.openError = 'no file manager'
  await assert.rejects(invoke('reveal'), /no file manager/)
  await rm(root, { recursive: true })
  await writeFile(root, 'not a directory')
  await assert.rejects(api.listPlugins())
})

test('encoded traversal, cross-plugin paths, and escaping main symlinks fail closed', async t => {
  const { directory, install, api } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const valid = await install('valid', 'main.mjs')
  const peer = await install('peer', 'main.mjs')
  await writeFile(path.join(valid, 'main.mjs'), 'export function activate() {}')
  await writeFile(path.join(peer, 'main.mjs'), 'export function activate() {}')
  await writeFile(path.join(directory, 'outside.mjs'), 'export function activate() {}')
  const escaping = await install('escaping', 'main.mjs')
  await symlink(path.join(directory, 'outside.mjs'), path.join(escaping, 'main.mjs'))
  assert.deepEqual((await api.listPlugins()).map((p: any) => p.id).sort(), ['peer', 'valid'])
  for (const url of ['inkplug://valid/..%2fpeer/main.mjs', 'inkplug://escaping/main.mjs', 'inkplug://valid/%00.mjs', 'inkplug://valid/main.mjs?x=1', 'inkplug://valid/main.mjs#x']) {
    assert.equal(await api.resolvePluginFile(url), null, url)
  }
})

test('unknown capabilities and colliding command namespaces are rejected at discovery', async t => {
  const { directory, install, api } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const unknown = await install('unknown', 'main.mjs', ['documents:write'])
  await writeFile(path.join(unknown, 'main.mjs'), 'export function activate() {}')
  const collision = await install('collision', 'main.mjs', ['commands'])
  await writeFile(path.join(collision, 'main.mjs'), 'export function activate() {}')
  await writeFile(path.join(collision, 'ink.plugin.json'), JSON.stringify({ id: 'collision', version: '1.0.0', main: 'main.mjs', permissions: ['commands'], contributes: { commands: [{ id: 'save', title: 'Overwrite core' }] } }))
  assert.deepEqual(await api.listPlugins(), [])
})


test('catalog installation validates actual packages and does not auto-enable them', async t => {
  const { directory, root, invoke } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const catalog = await invoke('catalog')
  assert.equal(catalog.source, 'bundled')
  assert.equal(catalog.entries.length, 3)
  assert.equal(catalog.entries.some((p: any) => p.files || p.hashes), false, 'executable payloads must not cross IPC')
  assert.equal((await invoke('installCatalog', 'inkleaf.reading-time', '1.0.0')).ok, true)
  const manifest = JSON.parse(await readFile(path.join(root, 'inkleaf.reading-time', 'ink.plugin.json'), 'utf8'))
  assert.equal(manifest.id, 'inkleaf.reading-time')
  assert.deepEqual(manifest.permissions, ['render'])
  assert.equal((await invoke('installCatalog', 'bundled.callout', '0.1.1')).ok, false)
  assert.equal((await invoke('installCatalog', 'inkleaf.external-links', '99.0.0')).ok, false)
})

test('local updates enforce identity, strictly newer versions and explicit native confirmation', async t => {
  const { directory, root, install, bridge, invoke, api } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const current = await install('legacy-folder', 'main.mjs')
  await writeFile(path.join(current, 'main.mjs'), 'old code')
  await writeFile(path.join(current, 'ink.plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', permissions: [] }))
  const source = path.join(directory, 'new version'); await mkdir(source)
  bridge.selected = source
  const manifest = { id: 'other', version: '2.0.0', main: 'main.mjs', permissions: ['render'] }
  const save = () => writeFile(path.join(source, 'ink.plugin.json'), JSON.stringify(manifest))
  await writeFile(path.join(source, 'main.mjs'), 'new code'); await save()
  assert.equal((await invoke('updateLocal', 'demo')).ok, false)
  manifest.id = 'demo'; manifest.version = '1.0.0'; await save()
  assert.equal((await invoke('updateLocal', 'demo')).ok, false)
  manifest.version = '2.0.0'; await save(); bridge.confirm = false
  assert.equal((await invoke('updateLocal', 'demo')).canceled, true)
  assert.equal(await readFile(path.join(current, 'main.mjs'), 'utf8'), 'old code')
  bridge.confirm = true
  assert.equal((await invoke('updateLocal', 'demo')).ok, true)
  assert.equal(await readFile(path.join(current, 'main.mjs'), 'utf8'), 'new code')
  assert.equal((await api.listPlugins())[0].version, '2.0.0')
  assert.deepEqual(await readdir(root), ['legacy-folder'], 'successful update leaves no transaction debris')
})

test('unsafe or incompatible upgrades preserve the original plugin', async t => {
  const { directory, install, bridge, invoke } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const current = await install('demo', 'main.mjs'); await writeFile(path.join(current, 'main.mjs'), 'old code')
  const source = path.join(directory, 'new'); await mkdir(source); bridge.selected = source
  await writeFile(path.join(source, 'main.mjs'), 'new code')
  const manifest = { id: 'demo', version: '2.0.0', minAppVersion: '99.0.0', permissions: [] }
  await writeFile(path.join(source, 'ink.plugin.json'), JSON.stringify(manifest))
  assert.equal((await invoke('updateLocal', 'demo')).ok, false)
  manifest.minAppVersion = '0.5.1'
  await writeFile(path.join(source, 'ink.plugin.json'), JSON.stringify(manifest))
  await symlink(directory, path.join(source, 'escape'))
  assert.equal((await invoke('updateLocal', 'demo')).ok, false)
  assert.equal(await readFile(path.join(current, 'main.mjs'), 'utf8'), 'old code')
})

test('a fresh host restores an interrupted upgrade before discovering plugins', async t => {
  const { directory, root, api } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stage = path.join(root, '.upgrade-11111111-1111-1111-1111-111111111111')
  const previous = path.join(stage, 'previous'); await mkdir(previous, { recursive: true })
  await writeFile(path.join(stage, 'transaction.json'), JSON.stringify({ target: 'demo' }))
  await writeFile(path.join(previous, 'ink.plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', permissions: [] }))
  await writeFile(path.join(previous, 'main.mjs'), 'original')
  assert.equal((await api.listPlugins())[0].version, '1.0.0')
  assert.deepEqual(await readdir(root), ['demo'])
})


test('a failed commit rolls back the moved version and removes transaction files', async t => {
  const { directory, root, install, bridge, invoke, api } = await fixture()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const current = await install('demo', 'main.mjs'); await writeFile(path.join(current, 'main.mjs'), 'old code')
  const source = path.join(directory, 'new'); await mkdir(source); bridge.selected = source
  await writeFile(path.join(source, 'main.mjs'), 'new code')
  await writeFile(path.join(source, 'ink.plugin.json'), JSON.stringify({ id: 'demo', version: '2.0.0', permissions: [] }))
  bridge.failCommit = true
  const failed = await invoke('updateLocal', 'demo')
  assert.equal(failed.ok, false); assert.match(failed.error, /simulated commit failure/)
  assert.equal(await readFile(path.join(current, 'main.mjs'), 'utf8'), 'old code')
  assert.equal((await api.listPlugins())[0].version, '1.0.0')
  assert.deepEqual(await readdir(root), ['demo'])
})
