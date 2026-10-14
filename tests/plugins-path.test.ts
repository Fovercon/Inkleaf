import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'

const repository = process.cwd()
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'inkleaf-plugin-path-')))
  const root = path.join(directory, 'plugins')
  await mkdir(root)
  ;(globalThis as any).__pluginUserData = directory
  const bundle = await build({ entryPoints: ['src/main/plugins-host.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'mock-electron', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath:()=>globalThis.__pluginUserData};export const ipcMain={handle(){}}` }))
  } }] })
  const module = { exports: {} as any }
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, createRequire(path.join(repository, 'package.json')))
  const install = async (name: string, main: string, permissions: string[] = []) => {
    const plugin = path.join(root, name)
    await mkdir(plugin, { recursive: true })
    await writeFile(path.join(plugin, 'ink.plugin.json'), JSON.stringify({ id: name, version: '1.0.0', main, permissions }))
    return plugin
  }
  return { directory, root, install, api: module.exports as any }
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
