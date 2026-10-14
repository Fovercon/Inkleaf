// Compile focused TypeScript regressions to a temporary directory, then run node:test.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const inputs = process.argv.slice(2)
if (inputs.length === 0) throw new Error('Pass one or more tests/*.test.ts files')
const filenames = []
for (const input of inputs) {
  const filename = await realpath(path.resolve(root, input))
  if (!filename.startsWith(path.join(root, 'tests') + path.sep) || !filename.endsWith('.test.ts')) {
    throw new Error('Regression entry points must be *.test.ts files inside tests/')
  }
  filenames.push(filename)
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-unit-tests-'))
try {
  const outputs = []
  for (const [index, filename] of filenames.entries()) {
    const outfile = path.join(temporary, `${index}-${path.basename(filename, '.ts')}.cjs`)
    await build({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'esbuild'], outfile })
    outputs.push(outfile)
  }
  const environment = { ...process.env, NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) }
  execFileSync(process.execPath, ['--test', ...outputs], { cwd: root, env: environment, stdio: 'inherit' })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
