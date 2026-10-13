import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-platform-tests-'))
try {
  const output = path.join(temporary, 'platform.test.cjs')
  await build({ entryPoints: ['tests/platform.test.ts'], outfile: output, bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' })
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { await rm(temporary, { recursive: true, force: true }) }
