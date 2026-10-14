import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { TrustedLocalAssets, handleLocalAsset } from '../src/main/local-assets'

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR+0AAAAASUVORK5CYII=', 'base64')
const urlFor = (filename: string) => 'mdasset://local' + pathToFileURL(filename).pathname
async function fixture(t: TestContext) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inkleaf-local-assets-')))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'library'), directory = path.join(root, 'notes')
  await fs.mkdir(directory, { recursive: true })
  const doc = path.join(directory, 'A.md'), image = path.join(directory, 'picture.png')
  await fs.writeFile(doc, '# A\n'); await fs.writeFile(image, pixel)
  const assets = new TrustedLocalAssets()
  assets.setLibraryRoot(root)
  await assets.registerDocument(doc)
  return { temporary, root, directory, doc, image, assets }
}

test('relative, parent, absolute and file URI images round-trip through the real protocol response', async t => {
  const { root, doc, image, assets } = await fixture(t)
  const parentImage = path.join(root, 'parent.png'); await fs.writeFile(parentImage, pixel)
  for (const [source, expected] of [
    ['picture.png', image], [image, image], [pathToFileURL(image).href, image],
    ['../parent.png', parentImage], [urlFor(image), image],
  ]) {
    const result = await assets.resolveImage(source, doc)
    assert.equal(result.error, undefined, source)
    assert.equal(result.path, expected)
    assert.equal('realFile' in result, false)
    const response = await handleLocalAsset(result.url!, assets)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pixel)
  }
})

test('Chinese, spaces, literal percent, hash and query characters survive exactly one decoding', async t => {
  const { directory, doc, assets } = await fixture(t)
  for (const name of ['中文 空格.png', '进度50%.PNG', 'literal%20.png', '图#问?.png', '%ZZ.png']) {
    const filename = path.join(directory, name); await fs.writeFile(filename, pixel)
    const result = await assets.resolveImage(encodeURIComponent(name), doc)
    assert.equal(result.path, filename)
    assert.equal(result.error, undefined)
    assert.equal((await handleLocalAsset(result.url!, assets)).status, 200)
  }
  assert.equal((await assets.resolveImage('picture.png?cache=1#thumbnail', doc)).error, undefined)
  const rawPercent = path.join(directory, 'raw50%.png'); await fs.writeFile(rawPercent, pixel)
  assert.equal((await assets.resolveImage('raw50%.png', doc)).path, rawPercent)
  const literal = path.join(directory, '图#问?.png')
  assert.equal((await assets.resolveImage('图#问?.png', doc)).path, literal)
  assert.equal((await assets.resolveImage(literal, doc)).path, literal)
})

test('a successfully opened standalone document authorizes only its own parent directory', async t => {
  const { temporary, doc, image } = await fixture(t)
  const assets = new TrustedLocalAssets()
  assert.equal((await assets.resolveImage(image, doc)).error, 'forbidden')
  assert.equal((await handleLocalAsset(urlFor(image), assets)).status, 403)
  await assets.registerDocument(doc)
  assert.equal((await assets.resolveImage('picture.png', doc)).error, undefined)
  assert.equal((await handleLocalAsset(urlFor(image), assets)).status, 200)
  const sibling = path.join(temporary, 'sibling.png'); await fs.writeFile(sibling, pixel)
  assert.equal((await assets.resolveImage(sibling, doc)).error, 'forbidden')
  assert.equal((await handleLocalAsset(urlFor(sibling), assets)).status, 403)
})

test('a library and its similarly named sibling have different access boundaries', async t => {
  const { root, doc, assets } = await fixture(t)
  const sibling = root + '-other'; await fs.mkdir(sibling)
  const forbidden = path.join(sibling, 'picture.png'); await fs.writeFile(forbidden, pixel)
  assert.equal((await assets.resolveImage(forbidden, doc)).error, 'forbidden')
  assert.equal((await handleLocalAsset(urlFor(forbidden), assets)).status, 403)
  assert.equal((await assets.resolveImage('../../library-other/picture.png', doc)).error, 'forbidden')
})

test('escaping file and directory symlinks are refused while an internal alias works', async t => {
  const { temporary, directory, doc, image, assets } = await fixture(t)
  const outside = path.join(temporary, 'outside'); await fs.mkdir(outside)
  const secret = path.join(outside, 'secret.png'); await fs.writeFile(secret, pixel)
  const escaped = path.join(directory, 'escape.png'), folder = path.join(directory, 'escape-folder')
  await fs.symlink(secret, escaped); await fs.symlink(outside, folder)
  await fs.symlink(image, path.join(directory, 'alias.png'))
  for (const source of ['escape.png', 'escape-folder/secret.png']) {
    const result = await assets.resolveImage(source, doc)
    assert.equal(result.error, 'forbidden')
    assert.equal((await handleLocalAsset(urlFor(path.join(directory, source)), assets)).status, 403)
  }
  assert.equal((await assets.resolveImage('alias.png', doc)).error, undefined)
})

test('missing, invalid and unreadable images have distinct actionable diagnostics', async t => {
  const { directory, doc, image, assets } = await fixture(t)
  const missing = await assets.resolveImage('missing.png', doc)
  assert.equal(missing.error, 'not-found'); assert.match(missing.message!, /不存在/)
  assert.equal((await handleLocalAsset(urlFor(path.join(directory, 'missing.png')), assets)).status, 404)
  const text = path.join(directory, 'private.txt'); await fs.writeFile(text, 'not an image')
  assert.equal((await assets.resolveImage('private.txt', doc)).error, 'invalid')
  assert.equal((await assets.resolveImage('javascript:alert(1)', doc)).error, 'invalid')
  assert.equal((await assets.resolveImage('file://other-host/secret.png', doc)).error, 'invalid')
  const original = fs.access
  fs.access = async (filename, mode) => {
    if (filename === image) throw Object.assign(new Error('Denied'), { code: 'EACCES' })
    return original(filename, mode)
  }
  try {
    const result = await assets.resolveImage('picture.png', doc)
    assert.equal(result.error, 'unreadable'); assert.match(result.message!, /权限/)
    assert.equal((await handleLocalAsset(urlFor(image), assets)).status, 500)
  } finally { fs.access = original }
})

test('malformed protocol URLs fail closed and a bad reference cannot stop the next image', async t => {
  const { doc, assets } = await fixture(t)
  for (const url of ['mdasset://other/a.png', 'mdasset://local:123/a.png', 'mdasset://user@local/a.png', 'file:///a.png', 'mdasset://local/%E0%A4%A', 'mdasset://local/%00.png']) {
    assert.equal((await handleLocalAsset(url, assets)).status, 400)
  }
  assert.equal((await assets.resolveImage('%E0%A4%A.png', doc)).error, 'not-found')
  assert.equal((await assets.resolveImage('picture.png', doc)).error, undefined)
})

test('closing or switching libraries revokes every previously opened document directory', async t => {
  const { root, doc, image, assets } = await fixture(t)
  assets.setLibraryRoot(null)
  assert.equal((await assets.resolveImage(image, doc)).error, 'forbidden')
  assert.equal((await handleLocalAsset(urlFor(image), assets)).status, 403)
  assets.setLibraryRoot(root)
  assert.equal((await assets.resolveImage(image, doc)).error, 'forbidden', 'A newly selected root does not forge an opened document')
  await assets.registerDocument(doc)
  assert.equal((await assets.resolveImage(image, doc)).error, undefined)
})

test('a document read from a retired library cannot authorize its directory after closing', async t => {
  const { doc, image, assets } = await fixture(t)
  const epoch = assets.epoch
  assets.setLibraryRoot(null)
  await assets.registerDocument(doc, epoch)
  assert.equal((await handleLocalAsset(urlFor(image), assets)).status, 403)
})

test('a library switch while an image is being read prevents the old response from escaping', async t => {
  const { image, assets } = await fixture(t)
  const original = fs.readFile
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { reached = resolve })
  fs.readFile = (async (...args: any[]) => {
    const bytes = await (original as any)(...args)
    if (String(args[0]) === image) { reached(); await gate }
    return bytes
  }) as typeof fs.readFile
  try {
    const pending = handleLocalAsset(urlFor(image), assets)
    await entered
    assets.setLibraryRoot(null); release()
    assert.equal((await pending).status, 403)
  } finally { fs.readFile = original; release() }
})
