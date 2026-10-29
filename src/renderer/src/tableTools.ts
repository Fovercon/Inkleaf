import { tableAt, editTable, type TableOperation } from '../../shared/markdown-tools'
import { element, input, toolDialog } from './toolDialog'
import type { DocumentToolsContext } from './documentTools'
export function openTable(ctx:DocumentToolsContext) {
  const path=ctx.path();if(!path)return
  const expected=ctx.content(),cursor=ctx.selection().from,d=toolDialog('编辑表格')
  void d.run(()=>{
    const table=tableAt(expected,cursor),column=input('操作列（从 1 开始）',String(table.column+1),'number');column.field.min='1';column.field.max=String(table.align.length)
    d.body.append(element('p',`${table.rows.length-1} 行内容 · ${table.align.length} 列。当前位于${table.row?'第 '+table.row+' 行内容':'表头'}。`,'tool-hint'),column.wrap)
    const actions=element('div','','tool-menu');d.body.append(actions)
    for(const [op,label] of [['row-before','插入上方行'],['row-after','插入下方行'],['row-delete','删除当前行'],['column-before','插入左侧列'],['column-after','插入右侧列'],['column-delete','删除当前列'],['left','列左对齐'],['center','列居中'],['right','列右对齐']] as [TableOperation,string][]) {
      d.button(label,async()=>{await ctx.edit(path,expected,editTable(expected,cursor,op,Number(column.field.value)-1));d.dialog.close()},actions)
    }
  })
}
