import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { markdownFromArguments } from '../src/main/openPath'

test('desktop file arguments accept local absolute, relative and escaped URI filenames', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'inkleaf-open-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, '读书 笔记.MD')
  writeFileSync(filename, '# Notes')
  assert.equal(markdownFromArguments([filename], '/'), filename)
  assert.equal(markdownFromArguments([path.basename(filename)], directory), filename)
  assert.equal(markdownFromArguments([pathToFileURL(filename).href], '/'), filename)
})

test('file association ignores switches, update nonce and nonexistent/non-Markdown paths', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'inkleaf-open-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const selected = path.join(directory, 'selected.markdown')
  const nonce = path.join(directory, 'nonce.md')
  writeFileSync(selected, '# Selected')
  writeFileSync(nonce, '# Not selected')
  writeFileSync(path.join(directory, 'text.txt'), 'text')
  mkdirSync(path.join(directory, 'folder.md'))
  assert.equal(markdownFromArguments(['--inkleaf-update', nonce, '--disable-gpu', 'missing.md', 'folder.md', 'text.txt', selected], directory), selected)
  assert.equal(markdownFromArguments(['--inkleaf-update', nonce], directory), null)
  assert.equal(markdownFromArguments(['file://remote-server/notes.md', 'https://example.com/notes.md', 'missing.md'], directory), null)
})

test('option terminator permits filenames beginning with a dash', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'inkleaf-open-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, '-notes.md')
  writeFileSync(filename, '# Notes')
  assert.equal(markdownFromArguments(['-notes.md'], directory), null)
  assert.equal(markdownFromArguments(['--', '-notes.md'], directory), filename)
})
