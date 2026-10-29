import { applyTemplate, localDate } from '../../shared/markdown-tools'
import { element, input, toolDialog } from './toolDialog'
import type { DocumentToolsContext } from './documentTools'
interface Template { id: string; name: string; content: string }
interface WritingStore { templates: Template[]; daily: { directory: string; pattern: string; template: string } }
const KEY='inkleaf.writing.v1'
function read(): WritingStore {
  const raw=localStorage.getItem(KEY)
  if(raw) {
    const store=JSON.parse(raw) as WritingStore
    if(!Array.isArray(store.templates)||!store.daily||store.templates.some(t=>typeof t.name!=='string'||typeof t.content!=='string')) throw new Error('模板配置无法读取，请检查本机设置')
    return store
  }
  return {daily:{directory:'日记',pattern:'YYYY-MM-DD',template:'daily'},templates:[
    {id:'blank',name:'空白',content:'# {{title}}\n\n'},
    {id:'meeting',name:'会议记录',content:'# {{title}}\n\n日期：{{date}} {{time}}\n\n## 议题\n\n## 记录\n\n## 待办\n\n- [ ] \n'},
    {id:'daily',name:'日记',content:'---\ndate: {{date}}\ntags: [日记]\n---\n# {{title}}\n\n## 今天\n\n## 随想\n\n'},
  ]}
}
const write=(store:WritingStore)=>localStorage.setItem(KEY,JSON.stringify(store))
async function daily(ctx:DocumentToolsContext) {
  if(!ctx.root()) throw new Error('请先打开书库')
  const store=read(), name=localDate(new Date(),store.daily.pattern), relative=[store.daily.directory,name].filter(Boolean).join('/')
  const template=store.templates.find(t=>t.id===store.daily.template)?.content??'# {{title}}\n\n'
  const file=await ctx.mutate(()=>window.mdr.createDocument(relative,applyTemplate(template,name.split('/').pop()!),true),[])
  await ctx.open(file)
}
export function openDaily(ctx:DocumentToolsContext, settings=false) {
  const d=toolDialog(settings?'每日笔记设置':'每日笔记')
  void d.run(async()=>{
    if(!settings) { await daily(ctx); d.dialog.close(); return }
    const store=read(), directory=input('日记目录（相对书库）',store.daily.directory), pattern=input('日期格式',store.daily.pattern)
    const templates=element('select'); templates.setAttribute('aria-label','日记模板')
    for(const template of store.templates) { const o=element('option',template.name); o.value=template.id; templates.append(o) }; templates.value=store.daily.template
    d.body.append(directory.wrap,pattern.wrap,element('p','例如 YYYY-MM-DD 或 YYYY/MM/DD；文件名自动加 .md，已有当天笔记不会覆盖。','tool-hint'),templates)
    d.button('保存设置',()=>{ localDate(new Date(),pattern.field.value); const dir=directory.field.value.trim(); if(dir.startsWith('/')||dir.includes('..')||dir.includes('\\')) throw new Error('目录须为书库内相对路径'); store.daily={directory:dir,pattern:pattern.field.value,template:templates.value};write(store);d.status.textContent='每日笔记设置已保存' })
    d.button('打开今日笔记',async()=>{await daily(ctx);d.dialog.close()})
  })
}
export function openTemplates(ctx:DocumentToolsContext) {
  const expected=ctx.content(), file=ctx.path(), selection=ctx.selection(), d=toolDialog('文档模板',true)
  void d.run(()=>{
    let store=read(), selected=''
    const select=element('select'); select.setAttribute('aria-label','选择模板')
    const name=input('模板名称'), target=input('新文档路径（相对书库）','未命名.md'), text=element('textarea');text.rows=12;text.className='template-source';text.setAttribute('aria-label','模板内容')
    d.body.append(select,name.wrap,text,element('p','支持 {{title}}、{{date}}、{{time}}；未知占位符保留原样。','tool-hint'),target.wrap)
    const load=()=>{ selected=select.value; const template=store.templates.find(t=>t.id===selected);name.field.value=template?.name??'';text.value=template?.content??'' }
    const refresh=()=>{select.replaceChildren();for(const t of store.templates){const o=element('option',t.name);o.value=t.id;select.append(o)}select.value=selected||store.templates[0]?.id||'';load()}
    select.onchange=load;refresh()
    d.button('新模板',()=>{selected='';select.value='';name.field.value='';text.value='';name.field.focus()})
    d.button('保存模板',()=>{const n=name.field.value.trim();if(!n)throw new Error('请输入模板名称');if(store.templates.some(t=>t.name===n&&t.id!==selected))throw new Error('模板名已存在');const id=selected||crypto.randomUUID();const next={id,name:n,content:text.value};store={...store,templates:[...store.templates.filter(t=>t.id!==id),next]};write(store);selected=id;refresh();d.status.textContent='模板已保存'})
    d.button('删除模板',async()=>{if(!selected)return;if(!await window.mdr.confirm({title:'删除模板',message:'删除本机保存的这个模板？已创建的文档不会改变。',okLabel:'删除'}))return;store.templates=store.templates.filter(t=>t.id!==selected);write(store);selected='';refresh()})
    d.button('插入当前文档',async()=>{if(!file)throw new Error('请先打开文档');const title=file.split('/').pop()!.replace(/\.(md|markdown|mdx)$/i,'');const insert=applyTemplate(text.value,title);await ctx.edit(file,expected,expected.slice(0,selection.from)+insert+expected.slice(selection.to));d.dialog.close()}).disabled=!file
    d.button('据此新建文档',async()=>{const relative=target.field.value.trim(),title=relative.split('/').pop()!.replace(/\.(md|markdown|mdx)$/i,'');const created=await ctx.mutate(()=>window.mdr.createDocument(relative,applyTemplate(text.value,title)),[]);d.dialog.close();await ctx.open(created)}).disabled=!ctx.root()
  })
}
