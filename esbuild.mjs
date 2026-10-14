import { build } from 'esbuild'
import { cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const OUT = 'out'
await rm(OUT, { recursive: true, force: true })

const common = { bundle: true, sourcemap: false, target: 'es2022', logLevel: 'info', legalComments: 'none' }

// main + preload: CJS for Electron
await build({
  ...common,
  entryPoints: { main: 'src/main/index.ts', preload: 'src/preload/index.ts' },
  outdir: OUT,
  format: 'cjs',
  platform: 'node',
  external: ['electron', 'chokidar'],
})

// renderer: ESM with code splitting so mermaid / code languages load lazily
await build({
  ...common,
  entryPoints: { renderer: 'src/renderer/src/main.ts' },
  outdir: path.join(OUT, 'renderer'),
  format: 'esm',
  platform: 'browser',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  conditions: ['browser', 'module', 'import'],
})

await cp('src/renderer/index.html', path.join(OUT, 'renderer', 'index.html'))
await cp('src/renderer/plugin-sandbox.html', path.join(OUT, 'renderer', 'plugin-sandbox.html'))
await cp('src/renderer/plugin-sandbox.mjs', path.join(OUT, 'renderer', 'plugin-sandbox.mjs'))
await cp('build/inkleaf-icon.png', path.join(OUT, 'icon.png'))
if (process.platform === 'darwin') {
  execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=11.0', '-O2', '-Wall', '-Wextra', '-Wno-deprecated-declarations',
    'scripts/update-helper.c', '-o', path.join(OUT, 'inkleaf-update-helper')], { stdio: 'inherit' })
}
if (process.platform === 'linux') {
  execFileSync('gcc', ['-O2', '-Wall', '-Wextra', 'scripts/update-helper-linux.c', '-o', path.join(OUT, 'inkleaf-update-helper')], { stdio: 'inherit' })
}
console.log('build done')
