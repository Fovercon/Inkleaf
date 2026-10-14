import assert from 'node:assert/strict'
import test from 'node:test'
import MarkdownIt from 'markdown-it'
import { classifyImageSource, describeImageFailure, localImageMarkdownPlugin } from '../src/renderer/src/localImages'

test('local image classification leaves absolute, file URL, percent and Unicode filenames to the main resolver', () => {
  for (const source of ['assets/pic.png', '../pictures/pic.png', '/home/me/图 50%.png', 'assets/图%20片%25%23%3F.png', '图#?.png', '进度50%.png', 'file:///home/me/%E5%9B%BE%20%25%23%3F.png', 'file://localhost/home/me/pic.png', 'mdasset://local/home/me/pic.png']) {
    assert.equal(classifyImageSource(source), 'local', source)
  }
})

test('HTTP, data and blob image URLs retain their original kind while invalid schemes fail closed', () => {
  for (const source of ['https://example.com/a.png?x=1#part', 'http://example.com/a.png']) assert.equal(classifyImageSource(source), 'remote')
  for (const source of ['data:image/png;base64,AAAA', 'data:image/svg+xml,%3Csvg%3E', 'blob:app://local/123']) assert.equal(classifyImageSource(source), 'inline')
  for (const source of ['', ' ', 'a\0b.png', 'javascript:alert(1)', 'vbscript:foo', 'ftp://example.com/a.png', 'http:foo']) assert.equal(classifyImageSource(source), 'invalid', source)
})

test('image parser supports file, blob and mdasset images without opening ordinary file links', () => {
  const md = new MarkdownIt().use(localImageMarkdownPlugin)
  for (const source of ['file:///home/me/%E5%9B%BE%20%25%23%3F.png', 'blob:app://local/123', 'mdasset://local/home/me/pic.png']) {
    assert.match(md.render(`![alt](${source})`), /<img\b/, source)
  }
  assert.doesNotMatch(md.render('[file](file:///home/me/private.md)'), /<a\b/)
  assert.doesNotMatch(md.render('![unsafe](javascript:alert(1))'), /<img\b/)
})

test('a literal percent filename and a subsequent image both parse without URI exceptions', () => {
  const md = new MarkdownIt().use(localImageMarkdownPlugin)
  const html = md.render('![percent](<进度50%.png>)\n\n![next](next.png)')
  assert.equal((html.match(/<img\b/g) ?? []).length, 2)
  assert.match(html, /50%25\.png/)
  assert.match(html, /next\.png/)
})

test('local diagnostics use the authoritative error and resolved path verbatim', () => {
  const path = '/home/me/图 50%#?.png'
  for (const error of ['not-found', 'forbidden', 'unreadable', 'invalid'] as const) {
    const detail = describeImageFailure('relative.png', { error, path, message: '具体诊断' })
    assert.equal(detail.error, error)
    assert.equal(detail.reason, '具体诊断')
    assert.equal(detail.path, path)
  }
  assert.equal(describeImageFailure('', { error: 'invalid' }).path, '（未提供图片地址）')
})

test('browser load errors do not invent a HTTP permission or missing-file diagnosis', () => {
  const available = describeImageFailure('local.png', { url: 'mdasset://local/lib/local.png', path: '/lib/local.png' }, true)
  assert.equal(available.error, 'decode')
  assert.equal(available.path, '/lib/local.png')
  const remote = describeImageFailure('https://example.com/image.png', { error: 'forbidden', message: 'Local files only' }, true)
  assert.equal(remote.error, 'network')
  assert.doesNotMatch(remote.reason, /403|404|目录/)
  assert.equal(describeImageFailure('data:image/png;base64,broken', { error: 'invalid' }, true).error, 'decode')
})
