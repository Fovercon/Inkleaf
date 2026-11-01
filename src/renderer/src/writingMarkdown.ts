import type MarkdownIt from 'markdown-it'
import { frontmatter, readProperties } from '../../shared/markdown-tools'
/** Width/height are bounded numeric HTML attributes; no arbitrary CSS is accepted. */
export function writingMarkdown(md:MarkdownIt) {
  md.block.ruler.before('hr','inkleaf_frontmatter',(state,startLine,_endLine,silent)=>{
    if(startLine!==0)return false
    try {
      const fm=frontmatter(state.src);if(!fm.exists)return false
      readProperties(state.src) // Invalid metadata stays visible for correction.
      if(!silent) state.line=state.src.slice(0,fm.end).split('\n').length-(state.src[fm.end-1]==='\n'?1:0)
      return true
    }catch{return false}
  })
  md.inline.ruler.before('text','inkleaf_image_dimensions',(state,silent)=>{
    const previous=state.tokens[state.tokens.length-1]
    if(previous?.type!=='image')return false
    const match=/^\{((?:(?:width|height)=\d+\s*)+)\}/.exec(state.src.slice(state.pos))
    if(!match)return false
    const values=[...match[1].matchAll(/(width|height)=(\d+)/g)]
    if(values.some(m=>Number(m[2])<1||Number(m[2])>10000)||new Set(values.map(m=>m[1])).size!==values.length)return false
    if(!silent)for(const value of values)previous.attrSet(value[1],value[2])
    state.pos+=match[0].length;return true
  })
  // This core rule runs after the host's heading ID rule. It consumes only a standalone paragraph.
  md.core.ruler.push('inkleaf_toc',state=>{
    const headings=state.tokens.flatMap((token,i)=>token.type==='heading_open'?[{id:token.attrGet('id')??'',level:Number(token.tag.slice(1)),text:(state.tokens[i+1]?.children??[]).filter(t=>!['html_inline','link_open','link_close'].includes(t.type)).map(t=>t.content).join('')}]:[])
    const escape=md.utils.escapeHtml
    for(let i=1;i<state.tokens.length-1;i++){
      const token=state.tokens[i]
      if(token.type!=='inline'||token.content.trim()!=='[TOC]'||state.tokens[i-1].type!=='paragraph_open'||state.tokens[i+1].type!=='paragraph_close')continue
      if(token.map&&token.map[1]-token.map[0]!==1)continue
      const html='<nav class="document-toc" aria-label="文档目录"><strong>目录</strong><ul>'+headings.map(h=>`<li class="toc-level-${h.level}"><a href="#${escape(h.id)}">${escape(h.text)}</a></li>`).join('')+'</ul></nav>'
      const replacement=new state.Token('html_block','',0);replacement.content=html;replacement.map=state.tokens[i-1].map
      state.tokens.splice(i-1,3,replacement);i--
    }
  })
}
