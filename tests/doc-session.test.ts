import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EditorState } from '@codemirror/state'
import { history, undoDepth } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { TabManager } from '../src/renderer/src/docSession'
import { EditorPane } from '../src/renderer/src/editor'

const paths = Array.from({ length: 12 }, (_, index) => `/library/F${index}.md`)

test('closing a background tab preserves the actual active session', () => {
  const tabs = new TabManager()
  tabs.restorePaths(['/A.md', '/B.md', '/C.md'], 2)
  assert.equal(tabs.close(0)?.path, '/C.md')
  assert.equal(tabs.activeIndex, 1)
  assert.equal(tabs.close(1)?.path, '/B.md')
  assert.equal(tabs.activePath, '/B.md')
})

test('default replacement at the twelve-tab limit replaces only the active tab', () => {
  const tabs = new TabManager()
  tabs.restorePaths(paths, 5)
  tabs.activate('/library/NEW.md')
  assert.equal(tabs.count, 12)
  assert.deepEqual(paths.filter(path => !tabs.paths().includes(path)), ['/library/F5.md'])
})

test('new tabs evict only a clean inactive session and correctly shift the active index', () => {
  const tabs = new TabManager()
  tabs.restorePaths(paths, 5)
  tabs.get(0)!.dirty = true
  tabs.activate('/library/NEW.md', { newTab: true })
  assert.equal(tabs.count, 12)
  assert.ok(tabs.paths().includes('/library/F0.md'))
  assert.ok(tabs.paths().includes('/library/F5.md'))
  assert.equal(tabs.activePath, '/library/NEW.md')
  assert.deepEqual(paths.filter(path => !tabs.paths().includes(path)), ['/library/F1.md'])
})

test('dirty buffers cannot be evicted, replaced, closed, or duplicated', () => {
  const tabs = new TabManager()
  tabs.restorePaths(paths, 5)
  for (const session of tabs.all()) session.dirty = true
  assert.throws(() => tabs.activate('/NEW.md', { newTab: true }), /上限/)
  assert.throws(() => tabs.activate('/NEW.md'), /保存/)
  assert.throws(() => tabs.close(), /保存/)
  assert.deepEqual(tabs.paths(), paths)
  tabs.activate(paths[5], { newTab: true })
  assert.equal(tabs.count, 12)
  assert.equal(tabs.activePath, paths[5])
})

test('folder rename and delete migrate or remove every matching tab without matching siblings', () => {
  const tabs = new TabManager()
  tabs.restorePaths(['/book/A.md', '/book/sub/B.md', '/book-other/C.md'], 1)
  tabs.rename('/book', '/renamed', true)
  assert.deepEqual(tabs.paths(), ['/renamed/A.md', '/renamed/sub/B.md', '/book-other/C.md'])
  assert.equal(tabs.activePath, '/renamed/sub/B.md')
  assert.equal(tabs.removePath('/renamed', true)?.path, '/book-other/C.md')
  assert.deepEqual(tabs.paths(), ['/book-other/C.md'])
})

test('external invalidation drops clean snapshots while preserving unsaved buffers', () => {
  const tabs = new TabManager()
  tabs.restorePaths(['/A.md', '/B.md'], 0)
  tabs.capturePath('/A.md', { doc: 'clean' }, 10, false)
  tabs.capturePath('/B.md', { doc: 'unsaved' }, 20, true)
  tabs.invalidate('/A.md'); tabs.invalidate('/B.md')
  assert.equal(tabs.get(0)!.editorJSON, null)
  assert.deepEqual(tabs.get(1)!.editorJSON, { doc: 'unsaved' })
  assert.equal(tabs.get(1)!.dirty, true)
  assert.equal(tabs.get(1)!.stale, true)
})

test('restored paths are unique, bounded, and keep the requested active file', () => {
  const tabs = new TabManager()
  const restore = Array.from({ length: 20 }, (_, index) => `/F${index}.md`)
  tabs.restorePaths([...restore, restore[0]], 19)
  assert.equal(tabs.count, 12)
  assert.equal(tabs.activePath, '/F19.md')
})

function fakeEditor(doc = 'original') {
  const editor = new EditorPane()
  const view = {
    state: EditorState.create({ doc, extensions: [history()] }),
    setState(state: EditorState) { this.state = state },
  }
  editor.view = view as unknown as EditorView
  editor.setPath('/A.md')
  return { editor, view }
}

test('editor state round-trip preserves undo history and a fresh document starts with none', () => {
  const { editor, view } = fakeEditor()
  view.state = view.state.update({ changes: { from: view.state.doc.length, insert: ' edit' } }).state
  assert.equal(undoDepth(view.state), 1)
  const snapshot = editor.exportState()
  editor.loadState(snapshot)
  assert.equal(undoDepth(view.state), 1)
  assert.equal(editor.getContent(), 'original edit')
  editor.openFile('/B.md', 'B content')
  assert.equal(undoDepth(view.state), 0)
  assert.equal(editor.getContent(), 'B content')
})

test('a corrupt serialized state does not erase the existing document', () => {
  const { editor } = fakeEditor()
  assert.throws(() => editor.loadState({ doc: 'bad', selection: { ranges: [{ anchor: -1 }] } }))
  assert.equal(editor.getContent(), 'original')
})

function installWindow(writeFile: (path: string, content: string) => Promise<void>) {
  const globals = globalThis as unknown as { window?: unknown }
  const previous = globals.window
  globals.window = { mdr: { writeFile }, setTimeout, clearTimeout }
  return () => { globals.window = previous }
}

test('concurrent saves are serialized and edits made during a write are flushed before clearing dirty', async t => {
  const { editor, view } = fakeEditor()
  editor.setDirty(true)
  let complete!: () => void
  const gate = new Promise<void>(resolve => { complete = resolve })
  const writes: string[] = []
  t.after(installWindow(async (_path, text) => { writes.push(text); if (writes.length === 1) await gate }))
  const first = editor.saveNow()
  view.state = view.state.update({ changes: { from: view.state.doc.length, insert: ' later' } }).state
  assert.equal(editor.saveNow(), first)
  assert.equal(editor.isDirty(), true)
  complete()
  await first
  assert.deepEqual(writes, ['original', 'original later'])
  assert.equal(editor.isDirty(), false)
  assert.equal(editor.lastSavedPath, '/A.md')
})

test('failed writes keep the dirty document and allow a later successful retry', async t => {
  const { editor } = fakeEditor('unsaved content')
  editor.setDirty(true)
  let fail = true
  t.after(installWindow(async () => { if (fail) throw new Error('disk full') }))
  await assert.rejects(editor.saveNow(), /disk full/)
  assert.equal(editor.isDirty(), true)
  assert.equal(editor.getContent(), 'unsaved content')
  fail = false
  await editor.saveNow()
  assert.equal(editor.isDirty(), false)
})
