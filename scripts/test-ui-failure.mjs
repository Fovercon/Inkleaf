// Exercise the real app's UI assertion and graceful shutdown with one forced failure.
// Run after npm run build, under xvfb-run on Linux. No installation is modified.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const main = await readFile(path.join(root, 'out', 'main.js'), 'utf8')
assert.ok(main.includes('MDR_TEST_FAIL_CHECK'), 'Build the current app before testing its UI failure exit')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-ui-failure-'))
let child, timer, hardTimer, exited = false
try {
  // The app copies this fixture again into its private MDR_TEST profile.
  await cp(path.join(root, 'test-library'), path.join(temporary, 'test-library'), { recursive: true })
  const environment = { ...process.env, MDR_TEST: '1', MDR_TEST_FAIL_CHECK: 'render', MDR_ROUND: 'failure-injection' }
  delete environment.ELECTRON_RUN_AS_NODE
  const require = createRequire(import.meta.url)
  let output = '', truncated = false, timedOut = false
  const collect = data => {
    if (output.length + data.length > 2 * 1024 * 1024) truncated = true
    else output += data.toString('utf8')
  }
  const completion = new Promise((resolve, reject) => {
    child = spawn(require('electron'), [root, '--disable-gpu'], { cwd: temporary, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      exited = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      // Detached desktop services must not keep inherited output pipes alive.
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); resolve({ code, signal }) }, 50)
    })
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // A timeout is always a failure; this only bounds a hung private test PID.
      hardTimer = setTimeout(() => child.kill('SIGKILL'), 10000)
    }, 150000)
  })
  const result = await completion
  if (timedOut || truncated || result.code !== 1 || result.signal) console.error(output)
  assert.equal(timedOut, false, 'The injected failure must complete through graceful quit, not timeout')
  assert.equal(truncated, false, 'Unexpectedly excessive UI output')
  assert.equal(result.signal, null, 'The app must exit itself without being killed')
  assert.equal(result.code, 1, 'A false UI check must produce exit code 1')
  assert.match(output, /\[ui-failure-injection\] render/)
  assert.match(output, /\[ui-check-failed\] render:/)
  assert.doesNotMatch(output, /verify screenshot written/)
  assert.match(output, /\[quit-check\] watcher stopped/)
  assert.match(output, /\[quit-check\] window \d+ closed/)
  assert.match(output, /\[quit-check\] all windows closed; will quit/)
  console.log('[ui-failure-check] passed: render rejected with exit 1 after normal quit')
} finally {
  clearTimeout(timer)
  clearTimeout(hardTimer)
  if (child && !exited && child.pid) child.kill('SIGTERM')
  if (!child?.pid || exited) {
    if (child?.pid) await rm(path.join(os.tmpdir(), `inkleaf-ui-${child.pid}`), { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
  } else console.error(`Retained private UI fixture for a still-running test: ${temporary}`)
}
