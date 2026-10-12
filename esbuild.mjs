import { build } from 'esbuild'
import { cp, rm } from 'node:fs/promises'
import path from 'node:path'

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
console.log('build done')
