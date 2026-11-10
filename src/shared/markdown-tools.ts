import MarkdownIt from 'markdown-it'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
export type PropertyValue = string | number | boolean | null | string[]
export interface Property { key: string; value: PropertyValue | unknown; editable: boolean }
export interface PropertyChange { key: string; value?: PropertyValue; remove?: boolean }
export const newline = (text: string) => text.includes('\r\n') ? '\r\n' : '\n'

export function frontmatter(text: string) {
  const first = /^(\uFEFF?---[^\r\n]*)(\r?\n)/.exec(text)
  if (!first) return { start: 0, end: 0, source: '', body: text, eol: newline(text), exists: false }
  if (!/^\uFEFF?---(?:ya?ml)?\s*$/.test(first[1])) throw new Error('属性面板仅支持 YAML 头部，请在源码中编辑此格式')
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm; closing.lastIndex = first[0].length
  const match = closing.exec(text)
  if (!match) throw new Error('YAML 头部缺少结束分隔线')
  const end = match.index + match[0].length
  return { start: first[0].length, end, source: text.slice(first[0].length, match.index), body: text.slice(end), eol: first[2], exists: true }
}
function propertyDocument(text: string) {
  const fm = frontmatter(text), doc = parseDocument(fm.source, { keepSourceTokens: true, uniqueKeys: true, strict: true })
  if (doc.errors.length || doc.warnings.length) throw new Error('YAML 无效：' + (doc.errors[0]?.message ?? doc.warnings[0]?.message))
  if (doc.contents && !isMap(doc.contents)) throw new Error('属性头部须为键值映射')
  return { fm, doc }
}
export function readProperties(text: string): Property[] {
  const { doc } = propertyDocument(text)
  if (!isMap(doc.contents)) return []
  return doc.contents.items.map(pair => {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('属性名称须为文本')
    const v = pair.value
    const editable = v === null || isScalar(v) && !v.anchor && !v.tag && ['string', 'number', 'boolean', 'object'].includes(typeof v.value) || isSeq(v) && !v.anchor && !v.tag && v.items.every(i => isScalar(i) && typeof i.value === 'string' && !i.anchor && !i.tag)
    return { key: pair.key.value, editable, value: editable ? v === null ? null : isScalar(v) ? v.value : isSeq(v) ? v.items.map(i => isScalar(i) ? i.value : null) : null : '[复杂属性，请在源码中编辑]' }
  })
}
export function editProperties(text: string, changes: PropertyChange[]): string {
  const { fm, doc } = propertyDocument(text), properties = readProperties(text)
  const edits: { from: number; to: number; insert: string }[] = [], additions: string[] = []
  const seen = new Set<string>()
  for (const change of changes) {
    const key = change.key
    if (!key.trim() || /[\r\n]/.test(key) || seen.has(key)) throw new Error('属性名不能为空、重复或含换行')
    seen.add(key)
    const existing = properties.find(p => p.key === key)
    if (existing && !existing.editable) throw new Error(`复杂属性 ${key} 请在源码中编辑`)
    if (!change.remove && (change.value === undefined || typeof change.value === 'number' && !Number.isFinite(change.value) || Array.isArray(change.value) && change.value.some(v => typeof v !== 'string'))) throw new Error('属性值无效')
    if (!change.remove && existing && JSON.stringify(existing.value) === JSON.stringify(change.value)) continue
    const pair = isMap(doc.contents) ? doc.contents.items.find(p => isScalar(p.key) && p.key.value === key) : undefined
    if (!pair) {
      if (!change.remove) additions.push(`${/^[A-Za-z_\p{L}][\w\p{L} /-]*$/u.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(change.value)}${fm.eol}`)
      continue
    }
    if (!isScalar(pair.key) || !pair.key.range) throw new Error('无法定位属性')
    const value = pair.value
    const range = (isScalar(value) || isSeq(value)) ? value.range : undefined
    if (!range) throw new Error('无法定位属性值，请在源码中编辑')
    if (change.remove) {
      const from = fm.source.lastIndexOf('\n', pair.key.range[0] - 1) + 1
      let after = range[2]
      if (fm.source[after-1] !== '\n') { const e = fm.source.indexOf('\n', after); after = e < 0 ? fm.source.length : e + 1 }
      edits.push({ from, to: after, insert: '' })
    } else {
      const old = fm.source.slice(range[0], range[1])
      // Block sequences/scalars include their terminating line break in the value range.
      const trailing = old.endsWith('\n') ? fm.eol : ''
      const needsSpace = range[0] > 0 && fm.source[range[0] - 1] === ':'
      edits.push({ from: range[0], to: range[1], insert: (needsSpace ? ' ' : '') + JSON.stringify(change.value) + trailing + (fm.source[range[1]] === '#' ? ' ' : '') })
    }
  }
  let source = fm.source
  for (const edit of edits.sort((a, b) => b.from - a.from)) source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to)
  if (additions.length) source += (source && !source.endsWith('\n') ? fm.eol : '') + additions.join('')
  if (source === fm.source) return text
  const result = fm.exists ? text.slice(0, fm.start) + source + text.slice(fm.start + fm.source.length) : `---${fm.eol}${source}---${fm.eol}${text}`
  propertyDocument(result) // Refuse an edit that would create an invalid header.
  return result
}

/** Mask non-prose without changing string offsets or source line numbers. */
const proseParser = new MarkdownIt({ html: true })
export function proseMask(text: string, links = true, header = true): string {
  let masked = text
  const blank = (s: string) => s.replace(/[^\r\n]/g, ' ')
  if (header) { try { const fm = frontmatter(text); if (fm.exists) masked = blank(text.slice(0, fm.end)) + text.slice(fm.end) } catch { /* invalid header stays text */ } }
  const env: { references?: Record<string, unknown> } = {}
  const tokens = proseParser.parse(masked, env)
  const starts = [0]; for (let i=0; i<text.length; i++) if(text[i]==='\n') starts.push(i+1)
  for(const token of tokens) {
    if(token.map && ['fence','code_block','html_block'].includes(token.type)) { const from=starts[token.map[0]],to=starts[token.map[1]]??text.length; masked=masked.slice(0,from)+blank(masked.slice(from,to))+masked.slice(to) }
  }
  let fence = '', fenceSize = 0
  masked = masked.replace(/[^\n]*(?:\n|$)/g, line => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) { if (m && m[1][0] === fence && m[1].length >= fenceSize && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = ''; return blank(line) }
    if (m) { fence = m[1][0]; fenceSize = m[1].length; return blank(line) }
    return /^(?: {4}|\t)/.test(line) ? blank(line) : line
  })
  masked = masked.replace(/(`+)([\s\S]*?)\1(?!`)/g, blank)
    .replace(/<!--[^]*?-->/g, blank).replace(/<[^>]+>/g, blank)
    .replace(/(?:https?:\/\/|mailto:|file:\/\/)[^\s<>]+/gi, blank)
    .replace(/^ {0,3}\[[^\]]+\]:[^\n]*/gm, blank)
  // Balanced destinations, escaped parentheses and reference-style links.
  const chars = masked.split('')
  for (let start = 0; start < masked.length; start++) {
    if (masked[start] !== '[' || start > 0 && masked[start-1] === '\\') continue
    if (masked[start+1] === '[') {
      const end = masked.indexOf(']]',start+2)
      if (end >= 0) { if (links) for(let j=start;j<end+2;j++) if(chars[j] !== '\n' && chars[j] !== '\r') chars[j]=' '; start=end+1 }
      continue
    }
    const close = masked.indexOf(']',start+1); if (close<0) continue
    let end = close+1
    if (masked[end] === '(') {
      let depth=1; end++
      for(;end<masked.length && depth;end++) { if(masked[end]==='\\') end++; else if(masked[end]==='(') depth++; else if(masked[end]===')') depth-- }
      if(depth) continue
    } else if(masked[end]==='[') { const e=masked.indexOf(']',end+1); if(e<0) continue; end=e+1 }
    else if (!links || !env.references?.[proseParser.utils.normalizeReference(masked.slice(start+1,close))]) continue
    for(let j=links?start:close+1;j<end;j++) if(chars[j]!=='\n' && chars[j]!=='\r') chars[j]=' '
    start=end-1
  }
  return chars.join('')
}
const tagPattern = /(?<![\\\]\p{L}\p{N}_])#(\p{L}[\p{L}\p{N}_/-]*)/gu
export function documentTags(text: string): string[] {
  const tags = new Set<string>()
  try { const v=readProperties(text).find(p=>p.key==='tags')?.value; for(const t of Array.isArray(v)?v:typeof v==='string'?v.split(/[，,\s]+/):[]) if(typeof t==='string' && t.trim()) tags.add(t.trim().replace(/^#/,'')) } catch { /* malformed YAML has no properties */ }
  for (const m of proseMask(text).matchAll(tagPattern)) tags.add(m[1])
  return [...tags]
}
export function renameTag(text: string, from: string, to: string): { content: string; count: number } {
  const valid = (s: string) => /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(s)
  if (!valid(from) || !valid(to)) throw new Error('标签只能包含文字、数字、下划线、连字符和非空斜线层级')
  if (from===to) return { content:text, count:0 }
  let count=0
  const convert = (tag:string) => { const plain=tag.replace(/^#/,''); if(plain===from || plain.startsWith(from+'/')) { count++; return to+plain.slice(from.length) } return tag }
  let content=text
  const properties=readProperties(text), property=properties.find(p=>p.key==='tags')
  if(property) {
    if(!property.editable) throw new Error('tags 为复杂属性，请先在源码中整理')
    const v=property.value, tags=Array.isArray(v)?v:typeof v==='string'?v.split(/[，,\s]+/).filter(Boolean):null
    if(tags) { const mapped=[...new Set(tags.map(t=>convert(String(t))))]; if(count) content=editProperties(content,[{key:'tags',value:mapped}]) }
  }
  const edits=[...proseMask(content).matchAll(tagPattern)].map(m=>({from:m.index!+1,to:m.index!+m[0].length,value:convert(m[1])})).filter(e=>content.slice(e.from,e.to)!==e.value)
  for(const edit of edits.reverse()) content=content.slice(0,edit.from)+edit.value+content.slice(edit.to)
  return {content,count}
}

export function localDate(date = new Date(), pattern = 'YYYY-MM-DD'): string {
  if(!['YYYY','MM','DD'].every(token=>pattern.includes(token))) throw new Error('日期格式须包含 YYYY、MM 和 DD')
  const values: Record<string,string>={YYYY:String(date.getFullYear()),MM:String(date.getMonth()+1).padStart(2,'0'),DD:String(date.getDate()).padStart(2,'0')}
  return pattern.replace(/YYYY|MM|DD/g,token=>values[token])
}
export function applyTemplate(template: string, title: string, date = new Date()): string {
  const values: Record<string,string>={title,date:localDate(date),time:`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`}
  return template.replace(/\{\{(title|date|time)\}\}/g,(_m,key:string)=>values[key])
}

export interface TableData { from: number; to: number; rows: string[][]; align: string[]; row: number; column: number; eol: string }
function tableCells(line:string): { cells:string[]; starts:number[] } {
  const cells:string[]=[],starts:number[]=[];let start=0,code=0
  for(let i=0;i<line.length;i++) {
    if(line[i]==='\\') {i++;continue}
    if(line[i]==='`') {let n=1;while(line[i+n]==='`')n++;if(!code)code=n;else if(code===n)code=0;i+=n-1;continue}
    if(line[i]==='|'&&!code) {cells.push(line.slice(start,i).trim());starts.push(start);start=i+1}
  }
  cells.push(line.slice(start).trim());starts.push(start)
  if(line.trimStart().startsWith('|')){cells.shift();starts.shift()}
  if(line.trimEnd().endsWith('|') && cells[cells.length-1]===''){cells.pop();starts.pop()}
  return {cells,starts}
}
export function tableAt(text:string,cursor:number):TableData {
  const lines=text.split(/\r?\n/), eol=newline(text), offsets=[0]
  for(let i=0;i<lines.length;i++) offsets.push(offsets[i]+lines[i].length+eol.length)
  const sourceLine=Math.max(0,offsets.findIndex((p,i)=>i+1<offsets.length&&cursor>=p&&cursor<offsets[i+1]))
  for(let separator=1;separator<lines.length;separator++) {
    const align=tableCells(lines[separator]).cells,header=tableCells(lines[separator-1]).cells
    if(!lines[separator].includes('|')||!align.length||align.length!==header.length||!align.every(c=>/^:?-{3,}:?$/.test(c)))continue
    let end=separator+1
    while(end<lines.length && lines[end].trim() && lines[end].includes('|') && tableCells(lines[end]).cells.length===header.length)end++
    if(sourceLine<separator-1||sourceLine>=end)continue
    // Code blocks are not tables.
    if(!proseMask(text,false,false).slice(offsets[separator-1],offsets[separator-1]+lines[separator-1].length).trim())throw new Error('代码块内不能编辑表格')
    const rows=[header,...lines.slice(separator+1,end).map(l=>tableCells(l).cells)]
    const starts=tableCells(lines[sourceLine]).starts,relative=cursor-offsets[sourceLine]
    let column=0;for(let i=0;i<starts.length;i++)if(relative>=starts[i])column=i
    return {from:offsets[separator-1],to:offsets[end-1]+lines[end-1].length,rows,align,row:sourceLine<=separator?0:sourceLine-separator,column,eol}
  }
  throw new Error('请先把光标放在有效 Markdown 表格内')
}
export type TableOperation='row-before'|'row-after'|'row-delete'|'column-before'|'column-after'|'column-delete'|'left'|'center'|'right'
export function editTable(text:string,cursor:number,operation:TableOperation,column?:number):string {
  const table=tableAt(text,cursor),{rows,align}=table,col=column??table.column
  if(!Number.isInteger(col)||col<0||col>=align.length)throw new Error('列号超出表格范围')
  if(operation==='row-delete') {if(table.row===0)throw new Error('表头不能删除，请选择内容行');rows.splice(table.row,1)}
  if(operation==='row-before'||operation==='row-after') rows.splice(Math.max(1,table.row+(operation==='row-after'?1:0)),0,Array(align.length).fill(''))
  if(operation==='column-delete'){if(align.length===1)throw new Error('不能删除最后一列');rows.forEach(r=>r.splice(col,1));align.splice(col,1)}
  if(operation==='column-before'||operation==='column-after'){const at=col+(operation==='column-after'?1:0);rows.forEach(r=>r.splice(at,0,''));align.splice(at,0,'---')}
  if(['left','center','right'].includes(operation))align[col]=operation==='left'?':---':operation==='center'?':---:':'---:'
  const format=(cells:string[])=>'| '+cells.map(c=>c.replace(/(?<!\\)\|/g,'\\|')).join(' | ')+' |'
  const body=[format(rows[0]),format(align),...rows.slice(1).map(format)].join(table.eol)
  return text.slice(0,table.from)+body+text.slice(table.to)
}

export interface MediaReference { from: number; to: number; image: boolean; label: string; url: string; title?: string; width?: number; height?: number }
const mediaParser=new MarkdownIt()
export function mediaAt(text:string,from:number,to=from,image?:boolean):MediaReference|null {
  const mask=proseMask(text,false,false)
  for(const match of text.matchAll(/!?\[/g)) {
    const start=match.index!, isImage=match[0][0]==='!'
    if(image!==undefined&&image!==isImage || start>0&&text[start-1]==='\\' || !mask.slice(start,start+match[0].length).trim())continue
    let close=start+match[0].length,depth=1
    for(;close<text.length;close++){if(text[close]==='\\'){close++;continue}if(text[close]==='[')depth++;if(text[close]===']'&&!--depth)break}
    if(text[close+1]!=='(')continue
    let pos=close+2;while(/[ \t]/.test(text[pos]??'')&&pos<text.length)pos++
    const destination=mediaParser.helpers.parseLinkDestination(text,pos,text.length)
    if(!destination.ok)continue
    pos=destination.pos;while(/[ \t]/.test(text[pos]??'')&&pos<text.length)pos++
    let title:string|undefined
    if(text[pos]!==')'){const parsed=mediaParser.helpers.parseLinkTitle(text,pos,text.length);if(!parsed.ok)continue;title=parsed.str;pos=parsed.pos;while(/[ \t]/.test(text[pos]??'')&&pos<text.length)pos++}
    if(text[pos]!==')')continue
    let end=pos+1;const attrs=isImage?/^\{((?:(?:width|height)=\d+\s*)+)\}/.exec(text.slice(end)):null
    const dimensions: {width?:number;height?:number}={}
    if(attrs){for(const m of attrs[1].matchAll(/(width|height)=(\d+)/g)) dimensions[m[1] as 'width'|'height']=Number(m[2]);end+=attrs[0].length}
    if(from>=start&&to<=end) return {from:start,to:end,image:isImage,label:mediaParser.utils.unescapeAll(text.slice(start+match[0].length,close)),url:destination.str,title,...dimensions}
  }
  return null
}
export function mediaMarkdown(media: Omit<MediaReference,'from'|'to'>):string {
  const url=media.url.trim()
  if(!url||/[\x00-\x1f<>]/.test(url))throw new Error('请输入有效链接或图片地址')
  const scheme=/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if(scheme && !(media.image?['http','https','file','mdasset','blob']:['http','https','mailto']).includes(scheme) && !(media.image&&/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(url)))throw new Error('不支持这个地址协议')
  const label=media.label.replace(/[\\[\]*_`<>]/g,'\\$&').replace(/[\r\n]+/g,' ')
  const title=media.title ? ' '+JSON.stringify(media.title.replace(/[\r\n]+/g,' ')) : ''
  let dimensions=''
  if(media.image)for(const key of ['width','height'] as const){const n=media[key];if(n!==undefined){if(!Number.isInteger(n)||n<1||n>10000)throw new Error('图片尺寸须为 1–10000 的整数像素');dimensions+=(dimensions?' ':'')+key+'='+n}}
  return `${media.image?'!':''}[${label}](<${url}>${title})${dimensions?'{'+dimensions+'}':''}`
}
