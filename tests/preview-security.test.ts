import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const repository = process.cwd()
async function fixture() {
  const bundle = await build({ stdin: { contents: `export {renderPreview,clearPreview} from './preview';export {registerPostProcessor,registerCodeBlockProcessor} from './pipeline'`, resolveDir: path.join(repository, 'src/renderer/src') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', plugins: [{ name: 'controlled-preview', setup(build) {
    build.onResolve({ filter: /^dompurify$/ }, () => ({ path: 'purify', namespace: 'fixture' }))
    build.onResolve({ filter: /^\.\/theme$/ }, () => ({ path: 'theme', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'purify' ? `export default {sanitize:x=>x}` : `export const currentTheme=()=> 'light';export const onThemeChange=fn=>globalThis.__themeCallbacks.push(fn)` }))
    build.onLoad({ filter: /\/src\/renderer\/src\/preview\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace("import('mermaid').then", 'globalThis.__mermaidGate.then'), loader: 'ts' }))
  } }] })
  ;(globalThis as any).__themeCallbacks = []
  let resolveMermaid!: (value: unknown) => void
  ;(globalThis as any).__mermaidGate = new Promise(resolve => { resolveMermaid = resolve })
  const module = { exports: {} as any }
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, createRequire(path.join(repository, 'package.json')))
  return { api: module.exports as any, container: { innerHTML: '', querySelectorAll: () => [] }, scroller: { scrollTop: 0 }, resolveMermaid }
}

test('delayed theme/Mermaid initialization cannot replace a newly opened document', async () => {
  const { api, container, scroller, resolveMermaid } = await fixture()
  await api.renderPreview(scroller, container, '# A', '/a.md')
  const pending = (globalThis as any).__themeCallbacks[0]()
  await api.renderPreview(scroller, container, '# B', '/b.md')
  resolveMermaid({ default: { initialize() {} } })
  await pending
  assert.match(container.innerHTML, /id="b"/)
  assert.doesNotMatch(container.innerHTML, /id="a"/)
})

test('hook exceptions do not abort later processors or the next document render', async () => {
  const { api, container, scroller } = await fixture()
  let completed = 0
  api.registerPostProcessor(() => { throw Error('broken post hook') })
  api.registerPostProcessor(() => { completed++ })
  await api.renderPreview(scroller, container, '# A', '/a.md')
  await api.renderPreview(scroller, container, '# B', '/b.md')
  assert.equal(completed, 2)
  assert.match(container.innerHTML, /id="b"/)
})

test('a superseded async render stops before later hooks process the new document with old context', async () => {
  const { api, container, scroller } = await fixture()
  let release!: () => void
  const contexts: string[] = []
  api.registerPostProcessor(async (_container: unknown, ctx: { filePath: string }) => {
    if (ctx.filePath === '/a.md') await new Promise<void>(resolve => { release = resolve })
  })
  api.registerPostProcessor((_container: unknown, ctx: { filePath: string }) => { contexts.push(ctx.filePath) })
  const first = api.renderPreview(scroller, container, '# A', '/a.md')
  await new Promise(resolve => setTimeout(resolve, 0))
  await api.renderPreview(scroller, container, '# B', '/b.md')
  release()
  await first
  assert.deepEqual(contexts, ['/b.md'])
  assert.match(container.innerHTML, /id="b"/)
})

test('opaque post conversions retain FIFO order before trusted listener wiring', async () => {
  const { api, container, scroller } = await fixture()
  const order: string[] = []
  api.registerPostProcessor((host: { innerHTML: string }) => {
    order.push('listener-wiring')
    assert.match(host.innerHTML, /data-plugin-transformed/)
  })
  api.registerPostProcessor(async (host: { innerHTML: string }) => {
    order.push('opaque-transform')
    await Promise.resolve()
    host.innerHTML += '<span data-plugin-transformed="true"></span>'
  }, true)
  api.registerPostProcessor((host: { innerHTML: string }) => {
    order.push('opaque-second')
    assert.match(host.innerHTML, /data-plugin-transformed/)
  }, true)
  await api.renderPreview(scroller, container, '# A', '/a.md')
  assert.deepEqual(order, ['opaque-transform', 'opaque-second', 'listener-wiring'])
})

test('closing the document invalidates a pending theme render and clears its last metadata', async () => {
  const { api, container, scroller, resolveMermaid } = await fixture()
  await api.renderPreview(scroller, container, '# A', '/a.md')
  const pending = (globalThis as any).__themeCallbacks[0]()
  api.clearPreview(container)
  resolveMermaid({ default: { initialize() {} } })
  await pending
  assert.equal(container.innerHTML, '')
  await (globalThis as any).__themeCallbacks[0]()
  assert.equal(container.innerHTML, '')
})
