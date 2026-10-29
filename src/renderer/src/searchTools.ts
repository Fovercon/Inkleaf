import { element, input, toolDialog, type ToolDialog } from './toolDialog'
import { lineDiff, type DocumentToolsContext } from './documentTools'
import type { BatchPreview, SearchOptions } from '../../shared/knowledge'

/** Reviewable per-file changes; main process owns the actual prepared contents. */
export function showBatch(d: ToolDialog, preview: BatchPreview, ctx: DocumentToolsContext) {
  const box = element('section', '', 'batch-preview'), selected = new Set(preview.files.map(f => f.path))
  d.body.querySelector('.batch-preview')?.remove(); d.body.append(box)
  box.append(element('p', `${preview.files.length} 个文件将修改。取消或关闭不会写入。`, 'tool-hint'))
  for (const file of preview.files) {
    const details = element('details'), summary = element('summary'), label = element('label')
    const checked = element('input'); checked.type = 'checkbox'; checked.checked = true
    checked.setAttribute('aria-label', `修改 ${file.path}`)
    checked.onchange = () => checked.checked ? selected.add(file.path) : selected.delete(file.path)
    checked.onclick = e => e.stopPropagation()
    label.append(checked, document.createTextNode(` ${file.path.slice(preview.root.length + 1)} · ${file.count} 处`)); summary.append(label)
    const diff = element('pre', lineDiff(file.before, file.after), 'tool-diff'); details.append(summary, diff); box.append(details)
  }
  d.button('应用选中文件', async () => {
    if (!selected.size) throw new Error('请至少选择一个文件')
    const result = await ctx.mutate(() => window.mdr.batchApply(preview.id, [...selected]), [...selected])
    box.replaceChildren(element('h3', `完成 ${result.completed.length} 个文件`))
    const report = element('pre', [
      ...result.completed.map(p => '已完成：' + p),
      ...(result.failed ? ['失败：' + result.failed.path + '\n' + result.failed.error] : []),
      ...result.pending.map(p => '未处理：' + p),
    ].join('\n'), 'tool-diff')
    box.append(report)
    d.status.textContent = result.failed ? '操作已停止。已完成文件可从文档历史恢复；其余文件请重新预览。' : '修改已保存，旧内容可从文档历史恢复。'
  }, box).disabled = !preview.files.length
}

export function openAdvancedSearch(ctx: DocumentToolsContext) {
  if (!ctx.root()) return
  const d = toolDialog('书库搜索与替换', true), form = element('div', '', 'tool-row')
  const fields = {
    query: input('搜索内容'), path: input('路径包含'), tag: input('标签（含子标签）'),
    propertyKey: input('属性名'), propertyValue: input('属性值（可选）'), replacement: input('替换为'),
  }
  Object.values(fields).forEach(f => form.append(f.wrap)); d.body.append(form)
  const optionsRow = element('div', '', 'tool-row'), flags = new Map<string, HTMLInputElement>()
  for (const [key, title] of [['caseSensitive', '区分大小写'], ['wholeWord', '全字匹配'], ['regex', '正则表达式']]) {
    const label = element('label'), field = element('input'); field.type = 'checkbox'; field.setAttribute('aria-label', title)
    label.append(field, document.createTextNode(' ' + title)); optionsRow.append(label); flags.set(key, field)
  }
  d.body.append(optionsRow, element('p', '过滤条件同时生效。路径按相对路径包含匹配；正则替换支持 $1、$2 等捕获组。全字以字母、数字和下划线划界。', 'tool-hint'))
  const results = element('div', '', 'search-results'); d.body.append(results)
  const invalidate = () => d.body.querySelector('.batch-preview')?.remove()
  form.addEventListener('input', invalidate); optionsRow.addEventListener('input', invalidate)
  const options = (): SearchOptions => ({ query: fields.query.field.value, path: fields.path.field.value.trim(), tag: fields.tag.field.value.trim().replace(/^#/, ''), propertyKey: fields.propertyKey.field.value.trim(), propertyValue: fields.propertyValue.field.value, ...Object.fromEntries([...flags].map(([k, v]) => [k, v.checked])) })
  d.button('搜索', async () => {
    invalidate(); await ctx.save(); const result = await window.mdr.advancedSearch(options()); results.replaceChildren()
    for (const match of result.matches) {
      const b = d.button(`${match.path.slice(ctx.root()!.length + 1)}:${match.line}  ${match.text}`, async () => { d.dialog.close(); await ctx.open(match.path, match.line) }, results)
      b.className = 'search-hit'
    }
    d.status.textContent = `${result.files} 篇文档，${result.total} 处匹配${result.truncated ? '；仅显示前 1000 条，请缩小范围' : ''}`
  })
  d.button('预览替换', async () => {
    await ctx.save(); const preview = await window.mdr.replacePreview(options(), fields.replacement.field.value)
    results.replaceChildren(); showBatch(d, preview, ctx)
  })
}

export function openTagRename(ctx: DocumentToolsContext, initial = '') {
  if(!ctx.root()) return
  const d=toolDialog('标签批量改名',true), from=input('原标签',initial), to=input('新标签')
  for(const f of [from.field,to.field]) f.addEventListener('input',()=>d.body.querySelector('.batch-preview')?.remove())
  d.body.append(from.wrap,to.wrap,element('p','同时处理精确标签及其子层级。代码、链接和普通文字保持原样。','tool-hint'))
  d.button('预览改名',async()=>{ await ctx.save(); showBatch(d,await window.mdr.tagPreview(from.field.value.trim().replace(/^#/,''),to.field.value.trim().replace(/^#/,'')),ctx) })
}
