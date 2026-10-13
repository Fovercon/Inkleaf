import { app, BrowserWindow, ipcMain, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import type { UpdateState } from '../shared/updates'
import { RELEASE_API, selectRelease, selectManualRelease, validateDownloadHost, type UpdateCandidate, type ReleaseSummary } from './updatePolicy'
import { validateArchive } from './updateArchive'
import { appImageTarget, validateAppImageFile } from './linuxAppImage'

const execute = promisify(execFile)
let state: UpdateState
let candidate: UpdateCandidate | ReleaseSummary | null = null
let downloaded: string | null = null
let downloadAbort: AbortController | null = null
let installBusy = false
const cacheRoot = () => path.join(app.getPath('userData'), 'updates')
const transactionFile = () => path.join(cacheRoot(), 'transaction.json')
const manualMessage = '请在版本页面下载新版 deb，并使用系统包管理器安装更新；此安装方式不会自动替换应用。'

function automaticCandidate(): UpdateCandidate | null {
  return state.installationKind !== 'deb' && candidate && 'sha256' in candidate ? candidate : null
}

function setState(status: UpdateState['status'], message?: string, progress?: number) {
  state = { currentVersion: app.getVersion(), installationKind: state?.installationKind, status, message, progress,
    ...(candidate ? { version: candidate.version, releaseNotes: candidate.notes, releaseUrl: candidate.releaseUrl } : {}) }
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('update:state', state))
  return state
}
function reason(error: unknown) {
  if (error instanceof Error && error.message) return error.message.slice(0, 250)
  return '操作未完成，请稍后重试'
}
async function request(url: string, signal: AbortSignal, api = false): Promise<Response> {
  validateDownloadHost(url, api)
  // Electron 33's net.fetch rejects manual redirects before returning a 302.
  // ClientRequest lets us validate each redirect before explicitly following it.
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit' })
    let hops = 0, incoming: Readable | null = null
    const abort = () => { incoming?.destroy(new Error('下载已取消')); req.abort(); reject(new Error('请求已取消')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    const cleanup = () => signal.removeEventListener('abort', abort)
    req.setHeader('User-Agent', `Inkleaf/${app.getVersion()}`)
    req.setHeader('Cache-Control', 'no-cache')
    if (api) { req.setHeader('Accept', 'application/vnd.github+json'); req.setHeader('X-GitHub-Api-Version', '2022-11-28') }
    req.on('redirect', (_status, method, next) => {
      try {
        validateDownloadHost(next, api)
        if (++hops > 5 || method !== 'GET') throw new Error('更新服务器重定向无效')
        req.followRedirect()
      } catch (error) { req.abort(); cleanup(); reject(error) }
    })
    req.on('error', error => { cleanup(); reject(error) })
    req.on('abort', () => { cleanup(); reject(new Error('请求已取消')) })
    req.on('response', response => {
      try {
        // Electron's runtime response is a Node Readable; its declarations only
        // expose the events. Check that contract before adapting its body.
        if (!(response instanceof Readable)) throw new Error('更新服务器响应流无效')
        incoming = response
        const headers = new Headers()
        for (const [name, values] of Object.entries(response.headers)) {
          for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value)
        }
        incoming.once('end', cleanup); incoming.once('close', cleanup)
        const noBody = [204, 205, 304].includes(response.statusCode)
        const body = noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
        resolve(new Response(body, { status: response.statusCode, headers }))
        if (noBody) incoming.resume()
      } catch (error) {
        req.abort(); cleanup(); reject(error)
      }
    })
    req.end()
  })
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (downloadAbort || installBusy) return state
  if (['unsupported', 'checking', 'downloading', 'ready', 'installing'].includes(state.status)) return state
  setState('checking', '正在检查新版本…')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await request(RELEASE_API, controller.signal, true)
    if (res.status === 404) { candidate = null; return setState('up-to-date', '当前还没有发布新版本') }
    if (res.status === 403 || res.status === 429) throw new Error('更新检查暂时受限，请稍后重试')
    if (!res.ok) throw new Error(`更新服务器暂时不可用（${res.status}）`)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('更新信息为空')
    const chunks: Uint8Array[] = []; let length = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 2 * 1024 ** 2) { await reader.cancel(); throw new Error('更新信息过大') }
      chunks.push(value)
    }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    candidate = state.installationKind === 'deb' ? selectManualRelease(release, app.getVersion())
      : selectRelease(release, app.getVersion(), process.arch, process.platform)
    return candidate ? setState('available', state.installationKind === 'deb' ? `发现新版本 ${candidate.version}。${manualMessage}` : `发现新版本 ${candidate.version}`)
      : setState('up-to-date', state.installationKind === 'deb' ? `已经是最新版本。${manualMessage}` : '已经是最新版本')
  } catch (e) { return setState('error', controller.signal.aborted ? '检查更新超时，请检查网络后重试' : reason(e)) }
  finally { clearTimeout(timeout) }
}
export function downloadUpdate(): UpdateState {
  if (state.installationKind === 'deb') return setState(state.status, manualMessage)
  const update = automaticCandidate()
  if (!update || !['available', 'error'].includes(state.status) || downloadAbort || installBusy) return state
  const controller = new AbortController()
  downloadAbort = controller
  setState('downloading', '正在下载更新…', 0)
  void (async () => {
    let directory: string | null = null
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000)
    try {
      await fs.mkdir(cacheRoot(), { recursive: true, mode: 0o700 })
      directory = await fs.mkdtemp(path.join(cacheRoot(), 'download-'))
      const filename = path.join(directory, state.installationKind === 'appimage' ? 'update.AppImage' : 'update.zip')
      const res = await request(update.url, controller.signal)
      if (!res.ok || !res.body) throw new Error('更新包下载失败，请稍后重试')
      const reader = res.body.getReader(), hash = createHash('sha256')
      const file = await fs.open(filename, 'wx', 0o600)
      let received = 0, lastPercent = -1
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (controller.signal.aborted) throw new Error('下载已取消')
          received += value.byteLength
          if (received > update.size) { await reader.cancel(); throw new Error('更新包大小与发布信息不一致') }
          hash.update(value)
          // FileHandle.write may perform a short write; writeFile writes the full chunk.
          await file.writeFile(value)
          if (controller.signal.aborted) throw new Error('下载已取消')
          const percent = Math.floor(received / update.size * 100)
          if (percent !== lastPercent) { lastPercent = percent; setState('downloading', '正在下载更新…', percent) }
        }
        await file.sync()
      } finally { await file.close() }
      if (controller.signal.aborted) throw new Error('下载已取消')
      if (received !== update.size || hash.digest('hex') !== update.sha256) throw new Error('更新包完整性校验失败，请重新下载')
      if (state.installationKind === 'appimage') await validateAppImageFile(filename, process.arch)
      else await validateArchive(filename)
      if (controller.signal.aborted) throw new Error('下载已取消')
      downloaded = filename; directory = null
      setState('ready', '更新已下载，保存文档后即可重启安装', 100)
    } catch (e) {
      if (controller.signal.aborted) setState('available', '下载已取消，可以稍后继续')
      else setState('error', reason(e))
    } finally {
      clearTimeout(timer)
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
      if (downloadAbort === controller) downloadAbort = null
    }
  })()
  return state
}
export function cancelUpdate(): UpdateState {
  if (downloadAbort) { downloadAbort.abort(); return setState('downloading', '正在取消下载…', state.progress) }
  return state
}
async function regularWithin(bundle: string, filename: string) {
  const info = await fs.lstat(filename), real = await fs.realpath(filename)
  if (!info.isFile() || info.isSymbolicLink() || !real.startsWith(bundle + path.sep)) throw new Error('更新包应用文件无效')
}
async function validateBundle(bundle: string, version: string) {
  const info = await fs.lstat(bundle)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('更新包不是有效的应用')
  const real = await fs.realpath(bundle)
  const plist = path.join(real, 'Contents', 'Info.plist')
  await regularWithin(real, plist)
  const read = async (key: string) => (await execute('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim()
  if (await read('CFBundleIdentifier') !== 'com.fovercon.inkleaf' || await read('CFBundleShortVersionString') !== version || await read('CFBundleExecutable') !== 'Inkleaf') throw new Error('更新包的应用身份或版本不匹配')
  const executable = path.join(real, 'Contents', 'MacOS', 'Inkleaf')
  await regularWithin(real, executable)
  const file = await fs.open(executable, 'r'), header = Buffer.alloc(8)
  try { await file.read(header, 0, 8, 0) } finally { await file.close() }
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c) throw new Error('更新包不适合此 Mac 的处理器')
  await fs.access(executable, constants.X_OK)
}
export async function installUpdate(): Promise<UpdateState> {
  if (state.installationKind === 'deb') return setState(state.status, manualMessage)
  const update = automaticCandidate()
  if (!update || !downloaded || state.status !== 'ready' || installBusy) return state
  installBusy = true
  let job: string | null = null, launched = false
  let helperChild: ReturnType<typeof spawn> | null = null
  setState('installing', '正在准备重启安装…', 100)
  try {
    const linux = state.installationKind === 'appimage'
    const target = linux ? await appImageTarget(process.env.APPIMAGE, process.arch) : path.resolve(app.getPath('exe'), '../../..')
    const parent = path.dirname(target)
    if (!linux && (path.basename(target) !== 'Inkleaf.app' || target.includes('/AppTranslocation/') || target.startsWith('/Volumes/'))) throw new Error('请先把 Inkleaf 放进「应用程序」再更新')
    const actual = await fs.realpath(target)
    if (actual !== target || (await fs.lstat(target)).isSymbolicLink() || await fs.realpath(parent) !== parent) throw new Error('当前应用安装路径不支持自动更新')
    await fs.access(parent, constants.W_OK)
    job = await fs.mkdtemp(path.join(parent, '.inkleaf-update-'))
    await fs.chmod(job, 0o700)
    // Recheck the archive after download and before extraction.
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(downloaded)) hash.update(chunk)
    if ((await fs.stat(downloaded)).size !== update.size || hash.digest('hex') !== update.sha256) throw new Error('更新包完整性校验失败，请重新下载')
    const staged = path.join(job, linux ? 'Inkleaf.AppImage' : 'Inkleaf.app')
    if (linux) {
      await validateAppImageFile(downloaded, process.arch)
      await fs.copyFile(downloaded, staged, constants.COPYFILE_EXCL)
      await fs.chmod(staged, 0o700)
      await validateAppImageFile(staged, process.arch, true)
    } else {
      await validateArchive(downloaded)
      await execute('/usr/bin/ditto', ['-x', '-k', downloaded, job])
      await validateBundle(staged, update.version)
    }
    if ((await fs.stat(target)).dev !== (await fs.stat(staged)).dev) throw new Error('更新暂存目录必须与应用在同一磁盘')
    const helper = path.join(job, 'install-helper')
    await fs.copyFile(path.join(__dirname, 'inkleaf-update-helper'), helper, constants.COPYFILE_EXCL)
    await fs.chmod(helper, 0o700)
    const nonce = randomBytes(24).toString('hex'), ack = path.join(job, 'boot-ack'), result = path.join(job, 'result.json')
    await fs.writeFile(transactionFile(), JSON.stringify({ nonce, version: update.version, target, job, ack, result }), { mode: 0o600 })
    const child = spawn(helper, [target, staged, downloaded, update.sha256, String(process.pid), ack, nonce, update.version, result], { detached: true, stdio: 'ignore' })
    helperChild = child
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref(); launched = true
    // Do not quit until the independent helper confirms preflight succeeded.
    const deadline = Date.now() + 20000
    let prepared = false, exitCode: number | null = null
    child.once('exit', code => { exitCode = code ?? -1 })
    while (Date.now() < deadline) {
      try {
        const receipt = JSON.parse(await fs.readFile(result, 'utf8'))
        if (receipt.state === 'waiting') { prepared = true; break }
        if (receipt.state === 'error') throw new Error('更新准备失败，原应用仍保持不变')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      if (exitCode !== null) throw new Error('更新安装程序未能启动')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!prepared) { child.kill('SIGTERM'); throw new Error('更新准备超时，请重试') }
    setImmediate(() => app.quit())
    return state
  } catch (e) {
    // No filesystem mutation of the installed bundle has happened before the helper.
    if (helperChild && helperChild.exitCode === null) {
      helperChild.kill('SIGTERM')
      await Promise.race([new Promise(resolve => helperChild!.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))])
    }
    if (job && (!launched || helperChild?.exitCode !== null)) await fs.rm(job, { recursive: true, force: true }).catch(() => {})
    return setState('ready', `安装未开始：${reason(e)}。可以重试或手动替换应用。`, 100)
  } finally { installBusy = false }
}
async function acknowledgeStartup() {
  const i = process.argv.indexOf('--inkleaf-update')
  if (i < 0) return
  const nonce = process.argv[i + 1]
  if (!/^[a-f0-9]{48}$/.test(nonce ?? '')) return
  try {
    const ticket = JSON.parse(await fs.readFile(transactionFile(), 'utf8'))
    const target = process.platform === 'linux' ? await appImageTarget(process.env.APPIMAGE, process.arch) : path.resolve(app.getPath('exe'), '../../..')
    if (ticket.nonce !== nonce || ticket.version !== app.getVersion() || ticket.target !== target) return
    if (path.dirname(ticket.job) !== path.dirname(target) || !path.basename(ticket.job).startsWith('.inkleaf-update-') || ticket.ack !== path.join(ticket.job, 'boot-ack')) return
    const info = await fs.lstat(ticket.job)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) return
    await fs.writeFile(ticket.ack, nonce, { flag: 'wx', mode: 0o600 })
  } catch { /* Only the matching update launch can acknowledge this installation. */ }
}
export function initializeUpdater() {
  const installationKind = process.platform === 'darwin' ? 'mac-app' : process.platform === 'linux' ? process.env.APPIMAGE ? 'appimage' : 'deb' : undefined
  const supported = process.platform === 'darwin' ? process.arch === 'arm64' : process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch)
  state = { status: app.isPackaged && supported && !process.env.MDR_TEST ? 'idle' : 'unsupported', currentVersion: app.getVersion(), installationKind,
    message: !app.isPackaged ? '开发模式不安装更新，请使用安装后的 Inkleaf' : installationKind === 'deb' ? manualMessage : undefined }
  const handle = (channel: string, action: () => unknown) => ipcMain.handle(channel, event => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) throw new Error('更新请求来源无效')
    const url = new URL(frame.url)
    if (url.protocol !== 'app:' || url.hostname !== 'local' || url.username || url.password) throw new Error('更新请求来源无效')
    return action()
  })
  handle('update:getState', async () => { await acknowledgeStartup(); return state })
  handle('update:check', checkForUpdates)
  handle('update:download', downloadUpdate)
  handle('update:cancel', cancelUpdate)
  handle('update:install', installUpdate)
  if (state.status !== 'unsupported') {
    const timer = setTimeout(() => void checkForUpdates(), 15000); timer.unref()
    const interval = setInterval(() => void checkForUpdates(), 4 * 60 * 60 * 1000); interval.unref()
    app.once('before-quit', () => { clearTimeout(timer); clearInterval(interval); downloadAbort?.abort() })
  }
}
