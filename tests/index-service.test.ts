import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DocumentIndex, parseFrontmatter } from '../src/main/document-index'

async function fixture(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'inkleaf-index-regression-'))
  const root = path.join(temporary, 'book'), cache = path.join(temporary, 'profile', 'index.json')
  await fs.mkdir(root)
  const index = new DocumentIndex(cache)
  t.after(async () => { index.clear(); await index.flush(); await fs.rm(temporary, { recursive: true, force: true }) })
  const write = async (relative: string, text: string) => {
    const file = path.join(root, relative)
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text)
    return file
  }
  return { temporary, root, cache, index, write }
}

test('frontmatter accepts data formats and refuses executable engines', async t => {
  assert.deepEqual(parseFrontmatter('---\ntags: [旅行, budget]\n---\n# Note\n').data.tags, ['旅行', 'budget'])
  assert.deepEqual(parseFrontmatter('---json\n{"tags":["json"]}\n---\n# Note').data.tags, ['json'])
  const global = globalThis as typeof globalThis & { __inkleafIndexExecution?: number }
  global.__inkleafIndexExecution = 0
  t.after(() => { delete global.__inkleafIndexExecution })
  const { root, index, write } = await fixture(t)
  const files: string[] = []
  for (const [i, header] of ['---js', '---javascript', '---JS', '\uFEFF---js', '--- js'].entries()) {
    const raw = `${header}\n({tags: [(globalThis.__inkleafIndexExecution = 1, "unsafe")]})\n---\n# Safe title\n`
    files.push(await write(`${i}.md`, raw))
    assert.deepEqual(parseFrontmatter(raw).data, {})
  }
  await index.build(root, files)
  for (const file of files) assert.equal((await index.peek(file))?.title, 'Safe title')
  assert.equal(global.__inkleafIndexExecution, 0, 'Neither automatic indexing nor hover may execute document JavaScript')
})

test('malformed, cyclic and YAML executable values do not crash the index', async t => {
  const { root, index, write } = await fixture(t)
  const a = await write('A.md', '---\ntags: [broken\n---\n# A\n')
  const b = await write('B.md', '---\nself: &self {nested: *self}\n---\n# B\n')
  const c = await write('C.md', '---\nfn: !!js/function >\n  function () { return 1; }\n---\n# C\n')
  await index.build(root, [a, b, c]); await index.flush()
  assert.equal(index.names().filter(n => /\/[ABC]\.md$/.test(n.path)).length, 3)
})

test('valid persistent cache restores names, tags and original-source backlink lines', async t => {
  const { root, cache, index, write } = await fixture(t)
  const a = await write('A.md', '---\ntags: [one]\n---\n# A\n[[B]]\n')
  const b = await write('B.md', '# B\n')
  await index.build(root, [a, b]); await index.flush()
  const reopened = new DocumentIndex(cache)
  t.after(() => reopened.clear())
  assert.equal(await reopened.load(root, [a, b]), true)
  assert.equal(reopened.resolve('A'), a)
  assert.deepEqual(reopened.tags(), [{ tag: 'one', count: 1 }])
  assert.deepEqual(reopened.backlinks('B'), [{ path: a, line: 5 }])
})

test('reopening rejects stale content even when file size and mtime are unchanged', async t => {
  const { root, cache, index, write } = await fixture(t)
  const a = await write('A.md', '---\ntags: [old]\n---\n# A\n')
  await index.build(root, [a]); await index.flush()
  const previous = await fs.stat(a)
  await fs.writeFile(a, '---\ntags: [new]\n---\n# A\n'); await fs.utimes(a, previous.atime, previous.mtime)
  const reopened = new DocumentIndex(cache)
  t.after(() => reopened.clear())
  assert.equal(await reopened.load(root, [a]), false)
  await reopened.build(root, [a])
  assert.deepEqual(reopened.tags(), [{ tag: 'new', count: 1 }])
})

test('cache validation detects files added, deleted or renamed while closed', async t => {
  const { root, cache, index, write } = await fixture(t)
  const a = await write('A.md', '# A\n')
  await index.build(root, [a]); await index.flush()
  const b = await write('B.md', '# B\n')
  const reopened = new DocumentIndex(cache)
  t.after(() => reopened.clear())
  assert.equal(await reopened.load(root, [a, b]), false)
  await fs.rename(a, path.join(root, 'Renamed.md'))
  assert.equal(await reopened.load(root, [path.join(root, 'Renamed.md'), b]), false)
  await reopened.build(root, [path.join(root, 'Renamed.md'), b])
  assert.equal(reopened.resolve('A'), path.join(root, 'Renamed.md'), 'Existing title remains searchable after rename')
  assert.equal(reopened.resolve('Renamed'), path.join(root, 'Renamed.md'))
  assert.equal(reopened.names().some(n => n.path === a), false)
})

test('issue references and heading anchors are not tags, but real inline tags are', async t => {
  const { root, index, write } = await fixture(t)
  const a = await write('A.md', [
    '---',
    'tags: [2026-q4]',
    '---',
    '## 目录',
    '1. [系统全景视图](#1-系统全景视图)',
    '2. [API 设计](#api-设计)',
    '',
    'feat(extensions): support multiple active catalogs simultaneously (#1720)',
    'Review PR #37 before merge, then see #1943.',
    '',
    '真标签: #入门 #pr-1720 (备查 #note)',
  ].join('\n'))
  await index.build(root, [a])
  assert.deepEqual(index.tags().map(c => c.tag).sort(), ['2026-q4', 'note', 'pr-1720', '入门'])
  assert.deepEqual(index.filesByTag('1720'), [], 'A bare issue number must never become a tag')
  assert.deepEqual(index.filesByTag('1-系统全景视图'), [], 'A heading anchor must never become a tag')
})

test('a cache from the previous index format is rejected and rebuilt', async t => {
  const { root, cache, index, write } = await fixture(t)
  const a = await write('A.md', '# A\n#legacy\n')
  await index.build(root, [a]); await index.flush()
  const raw = JSON.parse(await fs.readFile(cache, 'utf8')) as { version: number }
  raw.version = 2
  await fs.writeFile(cache, JSON.stringify(raw))
  const reopened = new DocumentIndex(cache)
  t.after(() => reopened.clear())
  assert.equal(await reopened.load(root, [a]), false, 'Old-format caches must force a full rescan')
  await reopened.build(root, [a])
  assert.deepEqual(reopened.tags(), [{ tag: 'legacy', count: 1 }])
})

async function pauseFirstRead(file: string) {
  const original = fs.readFile
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { reached = resolve })
  let intercepted = false
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const value = await original(...args)
    if (String(args[0]) === file && !intercepted) { intercepted = true; reached(); await gate }
    return value
  }) as typeof fs.readFile
  return { entered, release, restore: () => { fs.readFile = original; release() } }
}

test('a slow scan cannot insert documents from the previous library', async t => {
  const { temporary, root, index, write } = await fixture(t)
  const a = await write('A.md', '# A\n#old\n')
  const other = path.join(temporary, 'other'); await fs.mkdir(other)
  const b = path.join(other, 'B.md'); await fs.writeFile(b, '# B\n#new\n')
  const paused = await pauseFirstRead(a)
  try {
    const slow = index.build(root, [a]); await paused.entered
    await index.build(other, [b]); paused.release(); await slow
    assert.equal(index.resolve('A'), null); assert.equal(index.resolve('B'), b)
    assert.deepEqual(index.tags(), [{ tag: 'new', count: 1 }])
  } finally { paused.restore() }
})

test('clear cancels an in-flight scan instead of resurrecting a closed library', async t => {
  const { root, index, write } = await fixture(t)
  const a = await write('A.md', '# A\n')
  const paused = await pauseFirstRead(a)
  try {
    const slow = index.build(root, [a]); await paused.entered
    index.clear(); paused.release(); await slow
    assert.deepEqual(index.names(), [])
  } finally { paused.restore() }
})

test('a file change during scanning wins over the stale read', async t => {
  const { root, index, write } = await fixture(t)
  const a = await write('A.md', '# A\n#old\n')
  const paused = await pauseFirstRead(a)
  try {
    const scan = index.build(root, [a]); await paused.entered
    await fs.writeFile(a, '# A\n#new\n'); await index.update(a)
    paused.release(); await scan
    assert.deepEqual(index.tags(), [{ tag: 'new', count: 1 }])
  } finally { paused.restore() }
})

test('a deletion during scanning cannot reinsert the deleted document', async t => {
  const { root, index, write } = await fixture(t)
  const a = await write('folder/A.md', '# A\n')
  const paused = await pauseFirstRead(a)
  try {
    const scan = index.build(root, [a]); await paused.entered
    index.remove(path.dirname(a)); paused.release(); await scan
    assert.equal(index.resolve('A'), null)
  } finally { paused.restore() }
})

test('qualified wikilinks select the requested directory with duplicate basenames', async t => {
  const { root, index, write } = await fixture(t)
  const a = await write('one/Same.md', '# First\n'), b = await write('two/Same.markdown', '# Second\n')
  await index.build(root, [a, b])
  assert.equal(index.resolve('two/Same'), b); assert.equal(index.resolve('two/Same.markdown'), b)
  assert.equal(index.resolve('missing/Same'), null)
})

test('files and symlinks outside the library cannot be indexed or peeked', async t => {
  const { temporary, root, index, write } = await fixture(t)
  const a = await write('A.md', '# A\n')
  const outside = path.join(temporary, 'outside.md'); await fs.writeFile(outside, '# Outside\n')
  const link = path.join(root, 'Link.md'); await fs.symlink(outside, link)
  await index.build(root, [a, outside, link]); await index.update(outside)
  assert.equal(index.resolve('Outside'), null); assert.equal(index.resolve('Link'), null)
  assert.equal(await index.peek(outside), null); assert.equal(await index.peek(link), null)
})
