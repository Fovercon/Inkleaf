import { readProperties, editProperties, type PropertyChange, type PropertyValue } from '../../shared/markdown-tools'
import { element, input, toolDialog } from './toolDialog'

export interface DocumentToolsContext {
  selection(): { from: number; to: number }
  open(path: string, line?: number): Promise<unknown>
  edit(path: string, expected: string, next: string): Promise<void>
  path(): string | null
  root(): string | null
  content(): string
  save(): Promise<void>
  mutate<T>(operation: () => Promise<T>, paths: string[]): Promise<T>
}

export function lineDiff(before: string, after: string): string {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/)
  let start = 0, end = 0
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++
  while (end < Math.min(a.length, b.length) - start && a[a.length - end - 1] === b[b.length - end - 1]) end++
  if (start === a.length && start === b.length) return '内容相同'
  return [ ...a.slice(Math.max(0, start - 3), start).map(l => '  ' + l),
    ...a.slice(start, a.length - end).map(l => '− ' + l),
    ...b.slice(start, b.length - end).map(l => '+ ' + l),
    ...b.slice(b.length - end, b.length - end + 3).map(l => '  ' + l)].join('\n')
}

export function openHistory(ctx: DocumentToolsContext) {
  const file = ctx.path(); if (!file) return
  const d = toolDialog('文档历史', true)
  d.body.append(element('p', '历史仅保存在本机。选择一个版本，查看它与当前文档的差异。', 'tool-hint'))
  const settings = element('div', '', 'tool-row'), limit = input('每篇保留版本数', '100', 'number')
  limit.field.min = '2'; limit.field.max = '10000'; settings.append(limit.wrap)
  d.body.append(settings)
  const split = element('div', '', 'history-split'), list = element('div', '', 'history-list'), diff = element('pre', '', 'tool-diff')
  diff.setAttribute('aria-label', '历史版本与当前文档的差异'); split.append(list, diff); d.body.append(split)
  let expected = '', selected = ''
  const refresh = async () => {
    const state = await window.mdr.historyList(file); expected = state.current; limit.field.value = String(state.limit)
    selected = ''; diff.textContent = ''; list.replaceChildren()
    for (const entry of state.entries) {
      const b = d.button(`${new Date(entry.at).toLocaleString()} · ${entry.reason} · ${entry.bytes} 字节`, async () => {
        const version = await window.mdr.historyVersion(file, entry.id); selected = entry.id
        list.querySelectorAll('button').forEach(el => el.classList.toggle('selected', el === b))
        diff.textContent = lineDiff(version.content, expected)
      }, list)
    }
    d.status.textContent = `${state.entries.length} 个不同内容的版本。− 为历史内容，+ 为当前内容。`
  }
  d.button('保存数量', async () => {
    if (!await window.mdr.confirm({ title: '更改历史保留数量', message: '超出数量的旧版本会在下次记录时移除。', okLabel: '保存设置' })) return
    await window.mdr.historyLimit(Number(limit.field.value)); await refresh()
  }, settings)
  d.button('手动快照', async () => { await ctx.save(); await window.mdr.historyCapture(file); await refresh() })
  d.button('恢复所选版本', async () => {
    if (!selected) throw new Error('请先选择一个历史版本')
    if (!await window.mdr.confirm({ title: '恢复历史版本', message: '恢复前会保留当前内容的快照。', okLabel: '恢复' })) return
    await ctx.mutate(() => window.mdr.historyRestore(file, selected, expected), [file]); await refresh()
    d.status.textContent = '已恢复；恢复前内容也在历史中。'
  })
  void d.run(async () => { await ctx.save(); await refresh() })
}

export function openProperties(ctx: DocumentToolsContext) {
  const file = ctx.path(); if (!file) return
  const expected = ctx.content(), d = toolDialog('文档属性', true)
  d.body.append(element('p', '标题不会改文件名。列表每行一项；复杂属性请在源码中编辑。', 'tool-hint'))
  const rows: Array<{ key: HTMLInputElement; type: HTMLSelectElement; value: HTMLTextAreaElement; deleted: boolean; original?: string; existed: boolean }> = []
  const fields = element('div'); d.body.append(fields)
  const add = (key = '', value: unknown = '', existed = false) => {
    const row = element('div', '', 'tool-row'), keyInput = input('属性名', key)
    const type = element('select'); type.setAttribute('aria-label', `${key || '新属性'} 类型`)
    for (const [v, label] of [['string', '文本'], ['number', '数字'], ['boolean', '布尔'], ['null', '空值'], ['list', '文本列表']]) { const o = element('option', label); o.value = v; type.append(o) }
    type.value = Array.isArray(value) ? 'list' : value === null ? 'null' : typeof value
    const textarea = element('textarea'); textarea.rows = 2; textarea.setAttribute('aria-label', key || '新属性值')
    textarea.value = Array.isArray(value) ? value.join('\n') : value === null ? '' : String(value)
    const entry = { key: keyInput.field, type, value: textarea, deleted: false, original: existed ? key : undefined, existed }; rows.push(entry)
    row.append(keyInput.wrap, type, textarea)
    d.button('删除属性', () => { entry.deleted = true; row.remove() }, row); fields.append(row)
  }
  void d.run(() => {
    const properties = readProperties(expected)
    for (const key of ['title', 'date', 'tags']) {
      if (!properties.some(p => p.key === key)) add(key, key === 'tags' ? [] : '')
    }
    for (const p of properties) {
      if (p.editable) add(p.key, p.value, true)
      else d.body.append(element('p', `${p.key} · 复杂属性，保持原样`, 'tool-hint'))
    }
    d.button('添加属性', () => add())
    d.button('保存属性', async () => {
      const changes: PropertyChange[] = [], keys = new Set<string>()
      for (const r of rows) {
        if (r.deleted) { if (r.original) changes.push({ key: r.original, remove: true }); continue }
        const key = r.key.value.trim(), raw = r.value.value
        if (!key && !raw) continue
        if (keys.has(key)) throw new Error('属性名不能重复'); keys.add(key)
        if (!r.existed && !raw) continue
        let value: PropertyValue = raw
        if (r.type.value === 'number') { if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error(`${key} 须为数字`); value = Number(raw) }
        if (r.type.value === 'boolean') { if (!['true', 'false'].includes(raw)) throw new Error(`${key} 须为 true 或 false`); value = raw === 'true' }
        if (r.type.value === 'null') value = null
        if (r.type.value === 'list') value = [...new Set(raw.split('\n').map(v => v.trim()).filter(Boolean))]
        if (r.original && r.original !== key) changes.push({ key: r.original, remove: true })
        changes.push({ key, value })
      }
      const updated = editProperties(expected, changes)
      await ctx.edit(file, expected, updated); d.dialog.close()
    })
  })
}
