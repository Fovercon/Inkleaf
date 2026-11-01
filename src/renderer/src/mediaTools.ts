import { mediaAt, mediaMarkdown } from '../../shared/markdown-tools'
import { element, input, toolDialog } from './toolDialog'
import type { DocumentToolsContext } from './documentTools'
export function openMedia(ctx:DocumentToolsContext,image:boolean) {
  const file=ctx.path();if(!file)return
  const expected=ctx.content(),selection=ctx.selection(),existing=mediaAt(expected,selection.from,selection.to,image)
  const d=toolDialog(image?'图片属性':'链接属性'),label=input(image?'替代文字':'链接文字',existing?.label??expected.slice(selection.from,selection.to)),url=input('地址',existing?.url??''),title=input('悬停标题（可选）',existing?.title??'')
  const width=input('宽度（像素，可留空）',String(existing?.width??''),'number'),height=input('高度（像素，可留空）',String(existing?.height??''),'number')
  d.body.append(element('p',existing?'正在编辑光标处的引用。':'将在当前选区插入引用；关闭不会修改文档。','tool-hint'),label.wrap,url.wrap,title.wrap)
  if(image){d.body.append(width.wrap,height.wrap);d.body.append(element('p','只填一项时保持原比例；宽高都填写时按指定尺寸显示。','tool-hint'))}
  d.button(existing?'保存修改':'插入',async()=>{
    const source=mediaMarkdown({image,label:label.field.value,url:url.field.value,title:title.field.value,width:width.field.value?Number(width.field.value):undefined,height:height.field.value?Number(height.field.value):undefined})
    await ctx.edit(file,expected,expected.slice(0,existing?.from??selection.from)+source+expected.slice(existing?.to??selection.to));d.dialog.close()
  })
}
