// CI-only integration: the packaged native helper installs a real AppImage,
// then its normal renderer/preload initialization writes the genuine boot ACK.
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
  throw new Error('This integration uses an ephemeral GitHub Linux runner profile only')
}
const [input, helperInput] = process.argv.slice(2)
if (!input || !helperInput || !process.env.DISPLAY) throw new Error('Pass the real AppImage and extracted helper paths inside Xvfb')
const root = await realpath(process.cwd())
const image = await realpath(input)
const helper = await realpath(helperInput)
if (!image.startsWith(path.join(root, 'dist') + path.sep) || !helper.startsWith(path.join(root, '.linux-appimage-smoke') + path.sep)) throw new Error('Expected release assets from this CI workspace')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const fixture = await mkdtemp(path.join(root, '.linux-update-boot-'))
const target = path.join(fixture, 'Inkleaf.AppImage')
const job = await mkdtemp(path.join(fixture, '.inkleaf-update-'))
await chmod(job, 0o700)
const staged = path.join(job, 'Inkleaf.AppImage')
const ack = path.join(job, 'boot-ack')
const result = path.join(job, 'result.json')
const backup = path.join(job, 'previous.AppImage')
const updates = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'my-markdown-reader', 'updates')
const ticket = path.join(updates, 'transaction.json')
const nonce = randomBytes(24).toString('hex')
let wroteTicket = false
let child
let mayHaveLaunched = false
let appStopped = false
const processDiagnostics = new Map()
const digest = async filename => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}
async function ownedAppProcesses() {
  const found = []
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name), proc = path.join('/proc', entry.name)
    try {
      // /proc directory ownership can become root when Chromium disables
      // dumpability. Use the actual process real/effective UIDs from status.
      const status = await readFile(path.join(proc, 'status'), 'utf8')
      const uids = status.match(/^Uid:\s+(\d+)\s+(\d+)/m)
      if (!uids || Number(uids[1]) !== process.getuid() || Number(uids[2]) !== process.getuid()) continue
      const argv = (await readFile(path.join(proc, 'cmdline'))).toString('utf8').split('\0').filter(Boolean)
      const flag = argv.indexOf('--inkleaf-update')
      if (!((flag >= 0 && argv[flag + 1] === nonce) || argv.includes(`--inkleaf-update=${nonce}`)) || argv.some(arg => arg === '--type' || arg.startsWith('--type='))) continue
      let executable
      try { executable = await readlink(path.join(proc, 'exe')) }
      catch (error) {
        if (error.code !== 'EACCES') throw error
        // CI-only read access, no changes to sandbox or process permissions.
        executable = execFileSync('sudo', ['-n', 'readlink', path.join(proc, 'exe')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      }
      let environment = []
      let environmentReadable = true
      try { environment = (await readFile(path.join(proc, 'environ'))).toString('utf8').split('\0') }
      catch (error) { if (error.code === 'EACCES') environmentReadable = false; else throw error }
      const diagnostic = JSON.stringify({ pid, realUid: Number(uids[1]), effectiveUid: Number(uids[2]), executable,
        environmentReadable, hasAPPIMAGE: environment.some(value => value.startsWith('APPIMAGE=')), appImageMatches: environment.includes(`APPIMAGE=${target}`) })
      if (processDiagnostics.get(pid) !== diagnostic) { console.log('[boot-process]', diagnostic); processDiagnostics.set(pid, diagnostic) }
      if (executable === target && argv[0] === target) found.push({ pid, kind: 'runtime' })
      else if (path.basename(executable) === 'inkleaf' && executable.startsWith('/tmp/.mount_Inklea')) {
        assert.ok(!argv.includes('--no-sandbox') && !argv.includes('--disable-setuid-sandbox'))
        // uid + exact nonce + trusted mounted executable are the authority.
        // /proc/environ is diagnostic only: dumpability/setenv can hide it.
        found.push({ pid, kind: 'electron' })
      }
    } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) continue
      // A CI-only readlink may race a process disappearing after SIGTERM.
      if (typeof error.status === 'number') {
        try { await stat(proc) } catch (gone) { if (gone.code === 'ENOENT') continue }
      }
      throw error
    }
  }
  return found
}
async function stopOwnedApp(requireRunning) {
  const running = await ownedAppProcesses()
  const main = running.filter(entry => entry.kind === 'electron')
  if (requireRunning) assert.equal(main.length, 1, 'Exactly one genuine updated Electron main process must be running')
  if (main.length > 1) throw new Error('Refusing to signal ambiguous application processes')
  if (main.length === 1) {
    // Recheck owner, mounted executable and exact nonce before signaling.
    const confirmed = (await ownedAppProcesses()).some(entry => entry.kind === 'electron' && entry.pid === main[0].pid)
    assert.ok(confirmed, 'The isolated main PID changed before graceful shutdown')
    console.log(`[boot-ack-check] requesting normal exit of nonce-bound main PID ${main[0].pid}`)
    process.kill(main[0].pid, 'SIGTERM')
  }
  const deadline = Date.now() + 30000
  const trackedPids = new Set(running.map(entry => entry.pid))
  while (Date.now() < deadline) {
    const remaining = await ownedAppProcesses()
    for (const entry of remaining) trackedPids.add(entry.pid)
    for (const pid of trackedPids) {
      try { await stat(path.join('/proc', String(pid))) }
      catch (error) { if (error.code === 'ENOENT') trackedPids.delete(pid); else throw error }
    }
    if (remaining.length === 0 && trackedPids.size === 0) { appStopped = true; return }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The isolated updated AppImage did not stop after SIGTERM; its image and backup are retained')
}
try {
  await copyFile(image, target)
  await copyFile(image, staged)
  await chmod(target, 0o700)
  await chmod(staged, 0o700)
  const original = await stat(target), prepared = await stat(staged)
  const sha256 = await digest(image)
  await mkdir(updates, { recursive: true, mode: 0o700 })
  // Refuse to overwrite even an unexpected CI transaction; no real profile is used.
  await writeFile(ticket, JSON.stringify({ nonce, version: pkg.version, target, job, ack, result }), { flag: 'wx', mode: 0o600 })
  wroteTicket = true
  const environment = { ...process.env }
  delete environment.MDR_TEST
  delete environment.MDR_ROUND
  delete environment.ELECTRON_RUN_AS_NODE
  const completion = new Promise((resolve, reject) => {
    child = spawn(helper, [target, staged, image, sha256, '2147483647', ack, nonce, pkg.version, result], { cwd: root, env: environment, stdio: 'inherit' })
    mayHaveLaunched = true
    child.once('error', reject)
    // Use exit, not close: the new GUI deliberately outlives the helper.
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const deadline = Date.now() + 120000
  let receipt
  while (Date.now() < deadline) {
    try { receipt = JSON.parse(await readFile(result, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (receipt?.state === 'installed') break
    if (receipt && ['error', 'rolled-back', 'needs-recovery'].includes(receipt.state)) throw new Error(`Native installation failed: ${JSON.stringify(receipt)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(receipt?.state, 'installed', 'A real packaged renderer must acknowledge its new installation')
  const exited = await completion
  assert.equal(exited.code, 0)
  assert.equal(await readFile(ack, 'utf8'), nonce)
  assert.equal(receipt.version, pkg.version)
  assert.equal(receipt.backupPath, backup)
  assert.equal(await digest(target), sha256)
  assert.equal(await digest(backup), sha256)
  const installed = await stat(target), retained = await stat(backup)
  assert.equal(installed.ino, prepared.ino, 'The prepared real AppImage inode must replace target atomically')
  assert.equal(retained.ino, original.ino, 'The previous real AppImage must remain as backup')
  assert.equal(installed.nlink, 1)
  assert.equal(retained.nlink, 1)
  await stopOwnedApp(true)
  await mkdir('verify', { recursive: true })
  await writeFile(`verify/linux-${process.arch}-boot-ack.json`, JSON.stringify({ state: receipt.state, version: pkg.version, targetSha256: sha256, backupSha256: sha256, genuineRendererAck: true, atomicReplacement: true, gracefulExit: true }, null, 2) + '\n')
  console.log(`[boot-ack-check] installed ${pkg.version} with real AppImage, native helper, renderer ACK, backup and graceful exit`)
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (mayHaveLaunched && !appStopped) await stopOwnedApp(false).catch(error => console.error(error.message))
  if (!mayHaveLaunched || appStopped) {
    if (wroteTicket) await rm(ticket, { force: true })
    await rm(fixture, { recursive: true, force: true })
  } else console.error(`Retained running-image fixture for diagnostics: ${fixture}`)
}
