import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { DocumentHistory } from './document-history'
import { readProperties, documentTags, renameTag } from '../shared/markdown-tools'
import type { BatchFile, BatchPreview, BatchResult, SearchOptions, SearchReport } from '../shared/knowledge'

/** User regex runs in a disposable worker with a hard deadline, never on Electron's event loop. */
export function matchDocuments(files: { path: string; content: string }[], options: SearchOptions, replacement?: string, timeout = 1500): Promise<{ report: SearchReport; changes: BatchFile[] }> {
  if (typeof options?.query !== 'string' || options.query.length > 2000) return Promise.reject(new Error('查询为空或超过 2000 字符'))
  if (replacement !== undefined && (!options.query || typeof replacement !== 'string' || replacement.length > 100000)) return Promise.reject(new Error('替换需要非空查询，替换文本不能超过 100000 字符'))
  const source = String.raw`
    const { parentPort, workerData: { files, options: o, replacement } } = require('node:worker_threads');
    try {
      let pattern = o.regex ? o.query : o.query.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
      if (o.wholeWord) pattern = '(?<![\\p{L}\\p{N}_])(?:' + pattern + ')(?![\\p{L}\\p{N}_])';
      const re = new RegExp(pattern, 'gu' + (o.caseSensitive ? '' : 'i'));
      const report = { matches: [], total: 0, files: 0, truncated: false }, changes = [];
      for (const f of files) {
        let count = 0, line = 1, last = 0;
        if (!o.query) { if(report.matches.length<1000) report.matches.push({path:f.path,line:1,text:f.content.split(/\r?\n/)[0].slice(0,200)}); else report.truncated=true; report.files++; continue }
        for (const m of f.content.matchAll(re)) {
          count++; report.total++;
          if (count > 100000) throw Error('匹配过多，请缩小查询范围');
          if (report.matches.length < 1000) {
            line += (f.content.slice(last,m.index).match(/\n/g)||[]).length; last=m.index;
            const start=f.content.lastIndexOf('\n',Math.max(0,m.index-1))+1, end=f.content.indexOf('\n',m.index);
            report.matches.push({path:f.path,line,text:f.content.slice(start,end<0?undefined:end).slice(0,300)});
          } else report.truncated=true;
        }
        if (count) report.files++;
        if (count && replacement !== undefined) {
          const after = o.regex ? f.content.replace(re,replacement) : f.content.replace(re,()=>replacement);
          if (after.length > 16000000) throw Error('替换后的文档过大，请缩小范围');
          if (after !== f.content) changes.push({path:f.path,count,before:f.content,after});
        }
      }
      parentPort.postMessage({report, changes});
    } catch(error) { parentPort.postMessage({error:error.message}) }
  `
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { files, options, replacement }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('搜索超时，正则可能过于复杂；请缩小范围或简化表达式')) }, timeout)
    worker.once('message', result => { clearTimeout(timer); void worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result) })
    worker.once('error', error => { clearTimeout(timer); reject(error) })
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('搜索已停止或超出资源限制')) })
  })
}
export class KnowledgeService {
  private previews = new Map<string, BatchPreview & { at: number; epoch: string }>()
  constructor(private root: () => string | null, private epoch: () => string, private files: () => Promise<string[]>, private history: DocumentHistory, private changed: (file: string) => Promise<void> = async () => {}) {}
  async inside(file: string, root = this.root()): Promise<string> {
    if (!root || !/\.(md|markdown|mdx)$/i.test(file)) throw new Error('请选择当前书库中的 Markdown 文件')
    const [r, f] = await Promise.all([fs.realpath(root), fs.realpath(file)])
    const relative = path.relative(r, f)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !(await fs.stat(f)).isFile()) throw new Error('路径不在当前书库中')
    return f
  }
  private assertEpoch(epoch: string) { if (this.epoch() !== epoch || !this.root()) throw new Error('书库已切换，请重新预览') }
  private async documents(options: SearchOptions) {
    const root = this.root(); if (!root) throw new Error('请先打开书库')
    const files = await this.files(), result: { path: string; content: string }[] = []
    let bytes = 0
    for (const file of files) {
      if (options.path && !path.relative(root, file).replace(/\\/g, '/').includes(options.path)) continue
      await this.inside(file, root)
      const size = (await fs.stat(file)).size
      if (size > 8_000_000 || (bytes += size) > 64_000_000) throw new Error('搜索范围超过 64 MB 或单篇超过 8 MB，请使用路径过滤缩小范围')
      const content = await fs.readFile(file, 'utf8')
      if (options.tag || options.propertyKey) {
        let properties: ReturnType<typeof readProperties> = []
        try { properties = readProperties(content) } catch { if(options.propertyKey) continue }
        if (options.propertyKey) {
          const property = properties.find(p => p.key === options.propertyKey)
          if (!property || options.propertyValue !== undefined && options.propertyValue !== '' && (Array.isArray(property.value) ? !property.value.includes(options.propertyValue) : String(property.value) !== options.propertyValue)) continue
        }
        if (options.tag) {
          if (!documentTags(content).some(t => t === options.tag || t.startsWith(options.tag + '/'))) continue
        }
      }
      result.push({ path: file, content })
    }
    return result
  }
  async search(options: SearchOptions): Promise<SearchReport> {
    const epoch = this.epoch(), documents = await this.documents(options)
    const { report } = await matchDocuments(documents, options); this.assertEpoch(epoch); return report
  }
  async preview(options: SearchOptions, replacement: string): Promise<BatchPreview> {
    const epoch = this.epoch(), documents = await this.documents(options)
    const { changes } = await matchDocuments(documents, options, replacement); this.assertEpoch(epoch)
    return this.remember(changes, epoch)
  }
  async tagPreview(from: string, to: string): Promise<BatchPreview> {
    renameTag('',from,to)
    const epoch=this.epoch(), documents=await this.documents({query:''}), changes: BatchFile[]=[]
    for(const doc of documents) {
      if(!documentTags(doc.content).some(t=>t===from || t.startsWith(from+'/'))) continue
      const result=renameTag(doc.content,from,to)
      if(result.content!==doc.content) changes.push({path:doc.path,before:doc.content,after:result.content,count:result.count})
    }
    this.assertEpoch(epoch); return this.remember(changes,epoch)
  }
  async create(relative: string, content: string, openExisting = false, from?: string): Promise<string> {
    const root=this.root(), epoch=this.epoch()
    if(!root || typeof relative!=='string' || !relative.trim() || /[\x00-\x1f]/.test(relative) || path.isAbsolute(relative) || relative.includes('\\') || typeof content!=='string') throw new Error('请输入书库内的相对路径')
    if(from) await this.inside(from,root)
    const base=from && /^\.\.?\//.test(relative)?path.dirname(from):root
    const target=path.resolve(base,/\.(md|markdown|mdx)$/i.test(relative)?relative:relative+'.md')
    const rel=path.relative(root,target)
    if(rel==='..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel) || rel.split(path.sep).some(p=>p.startsWith('.'))) throw new Error('新文档必须位于当前书库的可见目录中')
    const realRoot=await fs.realpath(root)
    let parent=root
    for(const segment of rel.split(path.sep).slice(0,-1)) {
      this.assertEpoch(epoch); parent=path.join(parent,segment)
      await fs.mkdir(parent).catch(error=>{if(error.code!=='EEXIST') throw error})
      const real=await fs.realpath(parent), delta=path.relative(realRoot,real)
      if(delta==='..'||delta.startsWith('..'+path.sep)||path.isAbsolute(delta)||!(await fs.stat(real)).isDirectory()) throw new Error('目标目录越出书库或不是文件夹')
    }
    this.assertEpoch(epoch)
    let handle
    try { handle=await fs.open(target,'wx',0o600) }
    catch(error) { if((error as NodeJS.ErrnoException).code==='EEXIST' && openExisting) { await this.inside(target,root); return target } throw new Error('文档已存在或无法创建，未覆盖原文') }
    try { await handle.writeFile(content,'utf8') }
    catch(error) { await handle.close(); await fs.rm(target,{force:true}); throw error }
    await handle.close(); await this.changed(target); return target
  }
  private remember(files: BatchFile[], epoch: string): BatchPreview {
    for (const [id, p] of this.previews) if (Date.now() - p.at > 900000) this.previews.delete(id)
    while (this.previews.size >= 3) this.previews.delete(this.previews.keys().next().value!)
    const preview = { id: randomUUID(), root: this.root()!, files }
    this.previews.set(preview.id, { ...preview, at: Date.now(), epoch }); return preview
  }
  async apply(id: string, paths: string[]): Promise<BatchResult> {
    const preview = this.previews.get(id)
    if (!preview || Date.now() - preview.at > 900000) throw new Error('预览已过期，请重新生成')
    this.assertEpoch(preview.epoch)
    if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length || paths.some(p => !preview.files.some(f => f.path === p))) throw new Error('请选择预览中的文件')
    const selected = preview.files.filter(f => paths.includes(f.path))
    // All-file preflight happens before the first write; each queued write compares again.
    for (const file of selected) {
      await this.inside(file.path, preview.root)
      if (await fs.readFile(file.path, 'utf8') !== file.before) throw new Error(`文件已变化，整批尚未开始：${file.path}`)
    }
    this.assertEpoch(preview.epoch); this.previews.delete(id)
    const result: BatchResult = { completed: [], pending: selected.map(f => f.path) }
    for (const file of selected) {
      try {
        this.assertEpoch(preview.epoch); await this.inside(file.path, preview.root)
        await this.history.write(file.path, file.after, file.before, '批量修改前')
        result.completed.push(file.path); result.pending.shift()
        await this.changed(file.path)
      } catch (error) {
        result.failed = { path: file.path, error: error instanceof Error ? error.message : String(error) }
        if (result.pending[0] === file.path) result.pending.shift()
        break
      }
    }
    return result
  }
}
