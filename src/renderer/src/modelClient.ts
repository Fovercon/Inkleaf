/** App-level model capability. UI and trusted bundled features share this client;
 * transport, validation, rate limits and credentials remain in the main process. */
import type { ModelRequest } from '../../shared/services'

interface Active { id: string; cancelled: boolean; done: Promise<unknown> }
let active: Active | undefined
export function createModelSession() {
  let disposed = false, own: Active | undefined
  return {
    async run(request: Omit<ModelRequest, 'id'>, onText: (text: string) => void): Promise<string> {
      if (disposed) throw new Error('会话已关闭')
      // Allow a closed surface to drain its cancellation before another takes over.
      if (active?.cancelled) await active.done.catch(() => {})
      if (disposed) throw new Error('会话已关闭')
      if (active) throw new Error('另一个模型请求正在进行，请先停止后再试')
      const job: Active = { id: crypto.randomUUID(), cancelled: false, done: Promise.resolve() }
      active = own = job
      let output = ''
      const off = window.mdr.onModelChunk(chunk => {
        if (disposed || job.cancelled || chunk.id !== job.id) return
        output += chunk.text; onText(output)
      })
      job.done = window.mdr.runModel({ ...request, id: job.id })
      try {
        const result = await job.done as string
        if (disposed || job.cancelled) throw new Error('请求已取消')
        return result
      } catch (error) {
        throw new Error(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '模型请求失败，请重试')
      } finally { off(); if (active === job) active = undefined; if (own === job) own = undefined }
    },
    cancel() {
      if (own) { own.cancelled = true; void window.mdr.cancelModel(own.id).catch(() => {}) }
    },
    dispose() { disposed = true; this.cancel() },
  }
}
