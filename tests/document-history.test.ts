import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DocumentHistory } from '../src/main/document-history'

async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-history-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'note.md'), storage = path.join(dir, 'history')
  await fs.writeFile(file, 'first\r\n')
  return { file, storage, history: new DocumentHistory(storage) }
}
test('versions survive restart, deduplicate and restore both ways with exact newline bytes', async t => {
  const { file, storage, history } = await fixture(t)
  await history.write(file, 'second\r\n'); await history.capture(file); await history.capture(file)
  const fresh = new DocumentHistory(storage), list = await fresh.list(file)
  assert.equal(list.entries.length, 2)
  await fresh.restore(file, list.entries[1].id, list.current)
  assert.equal(await fs.readFile(file, 'utf8'), 'first\r\n')
  await fresh.restore(file, list.entries[0].id, 'first\r\n')
  assert.equal(await fs.readFile(file, 'utf8'), 'second\r\n')
})
test('conflicts and broken history never overwrite a document', async t => {
  const { file, storage, history } = await fixture(t)
  const first = await history.list(file)
  await fs.writeFile(file, 'external')
  await assert.rejects(history.restore(file, first.entries[0].id, first.current), /变化/)
  const record = (await fs.readdir(storage)).find(n => n.endsWith('.json'))!
  await fs.writeFile(path.join(storage, record), 'broken')
  await assert.rejects(history.write(file, 'replacement'), /历史记录/)
  assert.equal(await fs.readFile(file, 'utf8'), 'external')
})
test('retention, concurrent saves and rename keep recoverable versions', async t => {
  const { file, storage, history } = await fixture(t)
  await history.setLimit(3)
  await Promise.all(['two', 'three', 'four'].map(text => history.write(file, text)))
  const list = await history.list(file)
  assert.equal(list.entries.length, 3)
  assert.equal(list.current, 'four')
  const target = file.replace('note', 'renamed')
  await history.relocate(file, target); await fs.rename(file, target)
  assert.equal((await new DocumentHistory(storage).list(target)).entries.length, 3)
  await assert.rejects(history.setLimit(0))
})

test('an unwritable history destination stops a save before replacing the original', async t => {
  const {file,storage}=await fixture(t)
  await fs.writeFile(storage,'this is a file, not a history directory')
  await assert.rejects(new DocumentHistory(storage).write(file,'replacement'))
  assert.equal(await fs.readFile(file,'utf8'),'first\r\n')
})
