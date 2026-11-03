import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CH } from '../shared/ipc'
import type { ModelRequest, ServiceSettings, ServiceSettingsInput } from '../shared/services'
import { modelPayload, modelStream, plantumlPath, readBounded, validateSettings } from './service-core'

interface Stored { plantumlUrl: string; provider: 'compatible' | 'ollama'; endpoint: string; model: string; encryptedKey?: string }
let settings: Stored = { plantumlUrl: '', provider: 'compatible', endpoint: '', model: '' }
let key = '', loadPromise: Promise<void> | undefined, storage: ServiceSettings['keyStorage'] = 'none'
const jobs = new Map<number, { id: string; abort: AbortController }>()
const diagramJobs = new Map<number, number>()
let writes = Promise.resolve()
const secure = () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
function file() { return path.join(app.getPath('userData'), 'services.json') }
function load(): Promise<void> {
  return loadPromise ??= loadSettings()
}
async function loadSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(file(), 'utf8'))
    const valid = validateSettings(saved)
    settings = { plantumlUrl: valid.plantumlUrl, provider: valid.provider, endpoint: valid.endpoint, model: valid.model }
    if (typeof saved.encryptedKey === 'string' && saved.encryptedKey.length < 32768 && secure()) {
      try {
        const secret = JSON.parse(safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64')))
        if (secret.endpoint === settings.endpoint && secret.provider === settings.provider && typeof secret.key === 'string') {
          key = secret.key; settings.encryptedKey = saved.encryptedKey; storage = 'encrypted'
        }
      } catch { /* keychain locked/unavailable: user can enter key again */ }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[services] settings unavailable; using defaults') }
}
function view(): ServiceSettings { return { plantumlUrl: settings.plantumlUrl, provider: settings.provider, endpoint: settings.endpoint, model: settings.model, hasKey: !!key, keyStorage: storage, secureStorage: secure() } }
function trust(event: IpcMainInvokeEvent) {
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('仅主窗口可使用连接服务')
  const url = new URL(event.senderFrame?.url || 'about:blank')
  if (!(url.protocol === 'app:' && url.hostname === 'local') && !(!app.isPackaged && url.protocol === 'file:')) throw new Error('不可信的服务调用来源')
}
async function save(input: ServiceSettingsInput) {
  await load(); const valid = validateSettings(input)
  let nextKey = key, encryptedKey = settings.encryptedKey, nextStorage = storage
  // A key belongs to a provider endpoint; never silently send it to a new server.
  if (valid.endpoint !== settings.endpoint || valid.provider !== settings.provider || valid.clearKey) { nextKey = ''; encryptedKey = undefined; nextStorage = 'none' }
  if (valid.key) {
    nextKey = valid.key
    if (valid.rememberKey && secure()) { encryptedKey = safeStorage.encryptString(JSON.stringify({ key: nextKey, endpoint: valid.endpoint, provider: valid.provider })).toString('base64'); nextStorage = 'encrypted' }
    else { encryptedKey = undefined; nextStorage = 'session' }
  }
  const next: Stored = { plantumlUrl: valid.plantumlUrl, provider: valid.provider, endpoint: valid.endpoint, model: valid.model, encryptedKey }
  await fs.mkdir(path.dirname(file()), { recursive: true })
  const temp = file() + '.tmp'
  await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await fs.chmod(temp, 0o600); await fs.rename(temp, file())
  settings = next; key = nextKey; storage = nextStorage; return view()
}
function networkError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return new Error('请求已取消或超时，请重试')
  // Never include a URL, headers, or provider response body in a user-facing error.
  return error instanceof Error && /^(服务|模型|请选择|请求|不支持)/.test(error.message) ? error : new Error('服务连接失败，请检查地址、网络和服务状态')
}
export function registerServiceIpc() {
  ipcMain.handle(CH.serviceGet, async event => { trust(event); await load(); return view() })
  ipcMain.handle(CH.serviceSave, async (event, input: ServiceSettingsInput) => {
    trust(event)
    const operation = writes.then(() => save(input)); writes = operation.then(() => {}, () => {}); return operation
  })
  ipcMain.handle(CH.diagramRender, async (event, source: string) => {
    trust(event); await load()
    if (!settings.plantumlUrl) throw new Error('请先在图表设置中配置 PlantUML 服务地址')
    const suffix = plantumlPath(source), owner = event.sender.id, count = diagramJobs.get(owner) ?? 0
    if (count >= 4) throw new Error('服务正忙，请稍后重试图表')
    diagramJobs.set(owner, count + 1)
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000)
    const destroyed = () => abort.abort(); event.sender.once('destroyed', destroyed)
    try {
      const response = await fetch(settings.plantumlUrl + suffix, { redirect: 'error', signal: abort.signal, headers: { Accept: 'image/svg+xml' } })
      if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}，请检查图表语法和地址`)
      const svg = await readBounded(response, 2 * 1024 * 1024)
      if (!/<svg\b/i.test(svg)) throw new Error('服务未返回 SVG 图像')
      return svg
    } catch (error) { throw networkError(error, abort.signal) }
    finally { clearTimeout(timer); event.sender.removeListener('destroyed', destroyed); const n = (diagramJobs.get(owner) ?? 1) - 1; if (n) diagramJobs.set(owner, n); else diagramJobs.delete(owner) }
  })
  ipcMain.handle(CH.modelCancel, (event, id: string) => {
    trust(event); const job = jobs.get(event.sender.id); if (job?.id === id) job.abort.abort()
  })
  ipcMain.handle(CH.modelRun, async (event, input: ModelRequest) => {
    trust(event); await load()
    const payload = modelPayload(settings, input)
    if (!settings.endpoint || !settings.model) throw new Error('请先配置模型服务地址和模型名称')
    if (jobs.has(event.sender.id)) throw new Error('请求正在进行，请先取消或等待完成')
    const abort = new AbortController(), owner = event.sender.id, job = { id: input.id, abort }
    jobs.set(owner, job)
    const destroyed = () => abort.abort(); event.sender.once('destroyed', destroyed)
    const timer = setTimeout(() => abort.abort(), 90000)
    const provider = settings.provider, endpoint = settings.endpoint, secret = key
    let result = ''
    const emit = (text: string) => {
      if (abort.signal.aborted) throw new Error('请求已取消')
      result += text; if (result.length > 200000) throw new Error('模型输出过长，请缩小选文后重试')
      if (!event.sender.isDestroyed()) event.sender.send(CH.modelChunk, { id: input.id, text })
    }
    try {
      const url = endpoint + (provider === 'ollama' ? '/api/chat' : '/chat/completions')
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(payload) })
      if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}，请检查凭据、额度和模型名称`)
      if ((response.headers.get('content-type') || '').includes('application/json') && !(response.headers.get('content-type') || '').includes('ndjson')) {
        const obj = JSON.parse(await readBounded(response, 2 * 1024 * 1024))
        if (obj.error) throw new Error('模型服务报告错误，请检查连接配置')
        const content = provider === 'ollama' ? obj.message?.content : obj.choices?.[0]?.message?.content
        if (typeof content !== 'string') throw new Error('模型服务返回格式不兼容')
        emit(content)
      } else {
        const stream = modelStream(provider, emit); await readBounded(response, 2 * 1024 * 1024, stream.push); stream.finish()
      }
      if (!result.trim()) throw new Error('模型没有返回文本内容')
      return result
    } catch (error) { throw networkError(error, abort.signal) }
    finally { clearTimeout(timer); event.sender.removeListener('destroyed', destroyed); if (jobs.get(owner) === job) jobs.delete(owner) }
  })
}
