import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
const root = process.cwd(), temporary = await mkdtemp(path.join(tmpdir(), 'inkleaf-knowledge-'))
const require = createRequire(import.meta.url)
try {
  await symlink(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'dir')
  const hooks = `\nimport { undo as knowledgeUndo } from '@codemirror/commands';
  Object.assign(window, { __knowledge: { exportHtml: () => buildStandaloneHtml(preview, 'Knowledge test'), getState, editor, tabs, tree, runtime, documentTools, openFile, openLibrary, saveAllDocuments,
  undo: () => knowledgeUndo(editor.view), idle: async () => { await navigation; await sessionSave } } });`
  await build({ stdin: { contents: await readFile('src/renderer/src/main.ts', 'utf8') + hooks, resolveDir: path.join(root, 'src/renderer/src'), loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', splitting: true, outdir: temporary, entryNames: 'renderer', chunkNames: 'chunks/[name]-[hash]', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, logLevel: 'silent' })
  await build({ entryPoints: { host: 'src/main/ipc.ts', preload: 'src/preload/index.ts' }, bundle: true, format: 'cjs', platform: 'node', outdir: temporary, outExtension: { '.js': '.cjs' }, external: ['electron', 'chokidar'], logLevel: 'silent' })
  await writeFile(path.join(temporary, 'index.html'), await readFile('src/renderer/index.html'))
  const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules') }; delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [path.join(root, 'tests/knowledge-renderer-worker.cjs'), temporary], { env, stdio: 'inherit', timeout: 120000 })
} finally { await rm(temporary, { force: true, recursive: true }) }
