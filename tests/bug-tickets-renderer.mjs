// Exercise the actual renderer and local-asset service without touching out/ or a user's profile.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'inkleaf-bug-tickets-'))
const require = createRequire(import.meta.url)
const hooks = [
  'Object.assign(window, { __bugRegression: {',
  '  openLibrary, openFolderAction, openFileAction, openFile, tree, editor, tabs, runtime,',
  '  waitIdle: async () => { await navigation; await sessionSave },',
  '  snapshot: () => ({ libraryRoot: runtime.libraryRoot, currentFile: runtime.currentFile,',
  '    editorPath: editor.currentPath, content: editor.getContent(), dirty: editor.isDirty(),',
  '    collapsed: getState().collapsed.sidebar, sidebarTab: getState().sidebarTab,',
  "    welcome: document.getElementById('empty-state').classList.contains('visible'),",
  "    libraryEmpty: document.getElementById('library-empty').classList.contains('visible'),",
  "    feedback: document.getElementById('library-feedback').textContent,",
  "    feedbackHidden: document.getElementById('library-feedback').hidden,",
  "    busy: document.body.classList.contains('library-loading'), preview: preview.textContent })",
  '} })',
].join('\n')

try {
  const source = await readFile(path.join(root, 'src/renderer/src/main.ts'), 'utf8')
  await build({
    stdin: { contents: source + '\n' + hooks, resolveDir: path.join(root, 'src/renderer/src'), sourcefile: 'bug-regression-main.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'browser', splitting: true, outdir: temporary,
    entryNames: 'renderer', chunkNames: 'chunks/[name]-[hash]', assetNames: 'assets/[name]-[hash]',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, logLevel: 'silent',
  })
  await build({
    entryPoints: [path.join(root, 'src/main/local-assets.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    outfile: path.join(temporary, 'local-assets.cjs'), logLevel: 'silent',
  })
  // Seed saved UI preferences before the real state module is evaluated.
  await writeFile(path.join(temporary, 'seed.js'), "localStorage.setItem('mdr.ui.v1', JSON.stringify(window.mdr.fixtureUi || {}))")
  const html = (await readFile(path.join(root, 'src/renderer/index.html'), 'utf8'))
    .replace('<script type="module" src="./renderer.js"></script>', '<script src="./seed.js"></script>\n<script type="module" src="./renderer.js"></script>')
  await writeFile(path.join(temporary, 'index.html'), html)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [
    path.join(root, 'tests/bug-tickets-renderer-worker.cjs'), path.join(temporary, 'index.html'),
    path.join(root, 'tests/bug-tickets-renderer-preload.cjs'), path.join(temporary, 'profile'),
    path.join(temporary, 'local-assets.cjs'), path.join(temporary, 'fixtures'), path.join(root, 'build/inkleaf-icon.png'),
    '--disable-gpu',
  ], { cwd: root, env: environment, stdio: 'inherit', timeout: 120000 })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
