import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import path from 'node:path'

const repository = process.cwd()
async function fixture(list: unknown[] = [], factory?: (...args: any[]) => any, storage = new Map<string, string>()) {
  const bundle = await build({ stdin: { contents: `export * from './pluginRuntime';export * from './commands';export * from './pipeline'`, resolveDir: path.join(repository, 'src/renderer/src') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', plugins: [{ name: 'controlled-sandbox', setup(build) {
    build.onResolve({ filter: /^\.\/externalPlugin$/ }, () => ({ path: 'sandbox', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const createPluginSandbox=(...args)=>globalThis.__pluginSandboxFactory(...args);export const sanitizePluginHtml=x=>x;` }))
  } }] })
  ;(globalThis as any).window = { mdr: { pluginsList: async () => list } }
  ;(globalThis as any).localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }
  ;(globalThis as any).__pluginSandboxFactory = factory ?? (() => { throw Error('unexpected sandbox') })
  const module = { exports: {} as any }
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, createRequire(path.join(repository, 'package.json')))
  return module.exports as any
}
const external = (permissions = ['commands']) => ({ id: 'demo', manifest: { permissions, contributes: { commands: [{ id: 'demo.run', title: 'Run' }] } }, mainUrl: 'inkplug://demo/main.mjs' })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('disabled declarations are removed, failed lazy activation terminates once and boot is idempotent', async () => {
  let starts = 0
  const api = await fixture([external()], () => { starts++; return { ready: Promise.reject(Error('load failed')), dispose() {} } })
  await api.bootPlugins()
  ;(globalThis as any).window.ink.disable('demo')
  assert.equal(api.getCommand('demo.run'), undefined)
  assert.equal(starts, 0)
  ;(globalThis as any).window.ink.enable('demo')
  await tick()
  assert.equal(starts, 1)
  assert.equal(api.getCommand('demo.run'), undefined)
  await api.bootPlugins()
  assert.equal(starts, 1)
  assert.equal(api.getCommand('demo.run'), undefined)
})

test('enable starts a newly discovered plugin, reports activation, and explicitly retries an error', async () => {
  let starts = 0
  const list: unknown[] = []
  const api = await fixture(list, (_url, _permissions, register) => ({
    ready: Promise.resolve().then(() => { if (++starts === 1) throw Error('first attempt failed'); register({ type: 'command', token: 'cb-1', id: 'demo.run', title: 'Run' }) }),
    invoke: async () => {}, dispose() {},
  }))
  await api.bootPlugins()
  list.push(external())
  await api.discoverExternalPlugins()
  assert.ok(api.getCommand('demo.run'), 'refresh must also register lazy commands')
  const states: string[] = []
  api.onPluginStateChange(() => states.push(api.pluginSnapshot()[0].state))
  assert.equal(await (globalThis as any).window.ink.enable('demo'), false)
  assert.match(api.pluginSnapshot()[0].message, /first attempt failed/)
  assert.equal(await (globalThis as any).window.ink.enable('demo'), true)
  assert.deepEqual(states, ['activating', 'error', 'activating', 'active'])
  assert.equal(api.pluginSnapshot()[0].message, undefined)
  assert.equal(starts, 2)
})

test('explicit enable and disable survive a fresh runtime, including render-only and bundled plugins', async () => {
  const storage = new Map<string, string>()
  const renderOnly = { ...external(), manifest: { permissions: ['render'] } }
  const sandbox = () => ({ ready: Promise.resolve(), dispose() {} })
  let api = await fixture([renderOnly], sandbox, storage)
  api.registerBundledPlugin('bundled.test', { permissions: [] }, () => {})
  await api.bootPlugins()
  await (globalThis as any).window.ink.enable('demo')
  ;(globalThis as any).window.ink.disable('bundled.test')
  api = await fixture([renderOnly], sandbox, storage)
  api.registerBundledPlugin('bundled.test', { permissions: [] }, () => {})
  await api.bootPlugins()
  assert.equal(api.pluginSnapshot().find((p: any) => p.id === 'demo').state, 'active')
  assert.equal(api.pluginSnapshot().find((p: any) => p.id === 'bundled.test').state, 'disabled')
  ;(globalThis as any).window.ink.disable('demo')
  api = await fixture([renderOnly], () => { throw Error('disabled plugin started') }, storage)
  await api.bootPlugins()
  assert.equal(api.pluginSnapshot()[0].state, 'disabled')
})

test('reload keeps a disabled plugin disabled and reloads active code without changing its preference', async () => {
  let starts = 0, disposed = 0
  const api = await fixture([{ ...external(), manifest: { permissions: [] } }], () => ({ ready: Promise.resolve().then(() => { starts++ }), dispose() { disposed++ } }))
  await api.bootPlugins()
  ;(globalThis as any).window.ink.disable('demo')
  await api.reloadPlugin('demo')
  assert.equal(starts, 0)
  assert.equal(api.pluginSnapshot()[0].state, 'disabled')
  await (globalThis as any).window.ink.enable('demo')
  await api.reloadPlugin('demo')
  assert.equal(starts, 2)
  assert.equal(disposed, 1)
  assert.equal(api.pluginSnapshot()[0].state, 'active')
})

test('discovery and uninstall failures preserve running commands; successful uninstall clears the preference', async () => {
  const storage = new Map<string, string>()
  const list = [external()]
  const sandbox = (_url: any, _permissions: any, register: any) => ({
    ready: Promise.resolve().then(() => register({ type: 'command', token: 'cb-1', id: 'demo.run', title: 'Run' })), dispose() {},
  })
  const api = await fixture(list, sandbox, storage)
  await api.bootPlugins()
  await (globalThis as any).window.ink.enable('demo')
  const bridge = (globalThis as any).window.mdr
  bridge.pluginsList = async () => { throw Error('disk unavailable') }
  await assert.rejects(api.discoverExternalPlugins(), /disk unavailable/)
  assert.equal(api.pluginSnapshot()[0].state, 'active')
  bridge.pluginsUninstall = async () => ({ ok: false, error: 'trash unavailable' })
  await assert.rejects(api.uninstallPlugin('demo'), /trash unavailable/)
  assert.ok(api.getCommand('demo.run'))
  assert.equal(api.pluginSnapshot()[0].state, 'active')
  bridge.pluginsUninstall = async () => ({ ok: true })
  await api.uninstallPlugin('demo')
  assert.equal(api.pluginSnapshot().length, 0)
  assert.equal(api.getCommand('demo.run'), undefined)
  const fresh = await fixture(list, sandbox, storage)
  await fresh.bootPlugins()
  assert.equal(fresh.pluginSnapshot()[0].state, 'registered', 'reinstalled plugin needs a new enable choice')
})

test('host permission checks reject a forged registration from a zero-permission sandbox', async () => {
  const api = await fixture([{ ...external([]), manifest: { permissions: [] } }], (_url, _permissions, register) => ({
    ready: Promise.resolve().then(() => register({ type: 'command', token: 'cb-1', id: 'demo.run', title: 'Forbidden' })), dispose() {},
  }))
  await api.bootPlugins()
  assert.equal(await (globalThis as any).window.ink.activate('demo'), false)
  assert.equal(api.getCommand('demo.run'), undefined)
  assert.equal((globalThis as any).window.ink.list()[0].state, 'error')
})

test('reloading changed metadata starts exactly one replacement instance', async () => {
  let starts = 0
  const list = [{ ...external(), manifest: { permissions: [], version: '1.0.0' } }]
  const api = await fixture(list, () => ({ ready: Promise.resolve().then(() => { starts++ }), dispose() {} }))
  await api.bootPlugins()
  await (globalThis as any).window.ink.enable('demo')
  list[0].manifest.version = '1.0.1'
  assert.equal(await api.reloadPlugin('demo'), true)
  assert.equal(starts, 2)
  assert.equal(api.pluginSnapshot()[0].version, '1.0.1')
})

test('invalid saved data falls back safely and storage failures leave the running state unchanged', async () => {
  const storage = new Map([['inkleaf:plugin-preferences:v1', '{invalid json']])
  const api = await fixture([], undefined, storage)
  api.registerBundledPlugin('bundled.test', { permissions: [] }, () => {})
  await api.bootPlugins()
  assert.equal(api.pluginSnapshot()[0].state, 'active')
  ;(globalThis as any).localStorage.setItem = () => { throw Error('quota exceeded') }
  assert.throws(() => (globalThis as any).window.ink.disable('bundled.test'), /保存插件设置/)
  assert.equal(api.pluginSnapshot()[0].state, 'active')
})

test('external commands activate once, run through only their private sandbox, and survive repeated boot', async () => {
  let starts = 0, calls = 0, disposed = 0
  const api = await fixture([external()], (_url, _permissions, register) => {
    starts++
    return { ready: Promise.resolve().then(() => register({ type: 'command', token: 'cb-1', id: 'demo.run', title: 'Run' })),
      invoke: async (type: string, token: string) => { assert.equal(type, 'command'); assert.equal(token, 'cb-1'); calls++ }, dispose() { disposed++ } }
  })
  await api.bootPlugins()
  await api.getCommand('demo.run').run()
  assert.equal(calls, 1)
  assert.equal(starts, 1)
  await api.bootPlugins()
  await api.getCommand('demo.run').run()
  assert.equal(calls, 2)
  ;(globalThis as any).window.ink.disable('demo')
  assert.equal(api.getCommand('demo.run'), undefined)
  assert.equal(disposed, 1)
})

test('failed activation rolls back its command and render contributions without deleting host commands', async () => {
  const api = await fixture()
  let coreRan = 0
  api.registerCommand({ id: 'save', title: 'Save', run: () => coreRan++ })
  api.registerBundledPlugin('bad', { permissions: ['commands', 'render'] }, (ink: any) => {
    ink.commands.register({ id: 'bad.run', title: 'Partial', run() {} })
    ink.pipeline.registerPostProcessor(() => {})
    throw Error('activation failed after contributions')
  })
  await api.bootPlugins()
  assert.equal(api.getCommand('bad.run'), undefined)
  assert.equal(api.listPostProcessors().length, 0)
  api.runCommand('save')
  assert.equal(coreRan, 1)
  api.registerBundledPlugin('collision', { permissions: ['commands'] }, (ink: any) => ink.commands.register({ id: 'save', title: 'Overwrite', run() {} }))
  assert.equal(await (globalThis as any).window.ink.activate('collision'), false)
  api.runCommand('save')
  assert.equal(coreRan, 2)
})

test('concurrent activation is deduplicated and a disabled token cannot add late contributions or reactivate', async () => {
  const api = await fixture()
  let release!: () => void, captured: any, calls = 0
  api.registerBundledPlugin('slow', { permissions: ['commands'] }, async (ink: any) => {
    calls++; captured = ink
    await new Promise<void>(resolve => { release = resolve })
  })
  api.initPluginRuntime()
  const first = (globalThis as any).window.ink.activate('slow')
  const second = (globalThis as any).window.ink.activate('slow')
  await tick()
  assert.equal(calls, 1)
  ;(globalThis as any).window.ink.disable('slow')
  assert.throws(() => captured.commands.register({ id: 'slow.late', title: 'Late', run() {} }), /停用/)
  release()
  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.equal((globalThis as any).window.ink.list()[0].state, 'disabled')
})

test('a failing render hook is retired and leaves subsequent hooks runnable', async () => {
  const api = await fixture()
  let good = 0
  api.registerBundledPlugin('bad-render', { permissions: ['render'] }, (ink: any) => ink.pipeline.registerPostProcessor(() => { throw Error('render failed') }))
  api.registerBundledPlugin('good-render', { permissions: ['render'] }, (ink: any) => ink.pipeline.registerPostProcessor(() => { good++ }))
  await api.bootPlugins()
  for (const hook of api.listPostProcessors()) await hook({}, { filePath: '/a.md', baseDir: '/' })
  assert.equal(good, 1)
  assert.equal(api.listPostProcessors().length, 1)
  assert.equal((globalThis as any).window.ink.list().find((p: any) => p.id === 'bad-render').state, 'error')
})

test('lazy command load failure executes a single activation and retires its stub', async () => {
  let calls = 0
  const api = await fixture([external()], () => {
    calls++
    return { ready: Promise.reject(Error('missing activate')), dispose() {} }
  })
  await api.bootPlugins()
  const stub = api.getCommand('demo.run')
  await stub.run()
  await tick()
  assert.equal(calls, 1)
  assert.equal(api.getCommand('demo.run'), undefined)
})

test('code-block ownership refuses core-handler replacement and exact unregister leaves a newer handler intact', async () => {
  const api = await fixture()
  const core = () => {}
  api.registerCodeBlockProcessor('mermaid', core)
  api.registerBundledPlugin('collision', { permissions: ['render'] }, (ink: any) => ink.pipeline.registerCodeBlockProcessor('mermaid', () => {}))
  api.initPluginRuntime()
  assert.equal(await (globalThis as any).window.ink.activate('collision'), false)
  assert.equal(api.getCodeBlockProcessor('mermaid'), core)
  api.unregisterCodeBlockProcessor('mermaid', () => {})
  assert.equal(api.getCodeBlockProcessor('mermaid'), core)
})

test('rediscovery of an uninstalled plugin releases its frame and every owned command', async () => {
  let disposed = 0
  const list = [external()]
  const api = await fixture(list, (_url, _permissions, register) => ({
    ready: Promise.resolve().then(() => register({ type: 'command', token: 'cb-1', id: 'demo.run', title: 'Run' })),
    invoke: async () => {}, dispose() { disposed++ },
  }))
  await api.bootPlugins()
  assert.equal(await (globalThis as any).window.ink.activate('demo'), true)
  list.splice(0)
  await api.bootPlugins()
  assert.equal(api.getCommand('demo.run'), undefined)
  assert.equal(disposed, 1)
  assert.equal((globalThis as any).window.ink.list().length, 0)
})
