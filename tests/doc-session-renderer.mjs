// Bundle the real source renderer into a disposable directory; production code gets no test hooks.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'inkleaf-doc-session-'))
const require = createRequire(import.meta.url)
const hooks = [
  "import { undo as regressionUndo, undoDepth as regressionUndoDepth } from '@codemirror/commands'",
  "import { EditorView as RegressionEditorView } from '@codemirror/view'",
  'let regressionJumpLine = null',
  'const regressionScrollToLine = editor.scrollToLine.bind(editor)',
  'editor.scrollToLine = line => { regressionJumpLine = line; regressionScrollToLine(line) }',
  'Object.assign(window, { __docRegression: {',
  '  openFile, closeTabUi, closeLibrary, saveAllDocuments, tree, editor, tabs, runtime,',
  '  waitIdle: async () => { await navigation; await sessionSave },',
  '  undo: () => regressionUndo(editor.view),',
  '  snapshot: () => ({ activePath: tabs.activePath, activeIndex: tabs.activeIndex, paths: tabs.paths(),',
  '    editorPath: editor.currentPath, currentFile: runtime.currentFile, libraryRoot: runtime.libraryRoot,',
  '    content: editor.getContent(), dirty: editor.isDirty(), undoDepth: regressionUndoDepth(editor.view.state),',
  '    editorDark: editor.view.state.facet(RegressionEditorView.darkTheme), jumpLine: regressionJumpLine,',
  "    empty: document.getElementById('empty-state').classList.contains('visible'), preview: preview.textContent })",
  '} })',
].join('\n')
try {
  const source = await readFile(path.join(root, 'src/renderer/src/main.ts'), 'utf8')
  await build({
    stdin: { contents: source + '\n' + hooks, resolveDir: path.join(root, 'src/renderer/src'), sourcefile: 'document-regression-main.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'browser', splitting: true, outdir: temporary,
    entryNames: 'renderer', chunkNames: 'chunks/[name]-[hash]', assetNames: 'assets/[name]-[hash]',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, logLevel: 'silent',
  })
  await writeFile(path.join(temporary, 'index.html'), await readFile(path.join(root, 'src/renderer/index.html')))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [
    path.join(root, 'tests/doc-session-renderer-worker.cjs'), path.join(temporary, 'index.html'),
    path.join(root, 'tests/doc-session-renderer-preload.cjs'), path.join(temporary, 'profile'),
  ], { cwd: root, env, stdio: 'inherit', timeout: 90000 })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
