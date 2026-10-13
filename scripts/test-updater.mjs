import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-updater-tests-'))
try {
  const output = path.join(temporary, 'updater.test.cjs')
  await build({
    entryPoints: [path.join(root, 'tests', 'updater.test.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'warning',
    legalComments: 'none'
  })
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit', cwd: root })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  await rm(temporary, { recursive: true, force: true })
}
