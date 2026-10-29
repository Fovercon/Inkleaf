import test from 'node:test'
import assert from 'node:assert/strict'
import { readProperties, editProperties } from '../src/shared/markdown-tools'
test('property edits preserve unrelated YAML comments, complex values, CRLF and body bytes', () => {
  const source = '---\r\n# first\r\ntitle: Old # keep\r\ncomplex:\r\n  foo: [1, 2] # nested\r\ntags: [a, b]\r\n---\r\n\r\n# Body\r\n'
  const result = editProperties(source, [{ key: 'title', value: 'New: Title' }, { key: 'tags', value: ['one/two', 'three'] }])
  assert.equal(result, source.replace('Old', '"New: Title"').replace('[a, b]', '["one/two","three"]'))
  assert.equal(readProperties(result).find(p => p.key === 'complex')?.editable, false)
})
test('property insert/delete and malformed YAML have explicit, non-destructive behavior', () => {
  assert.match(editProperties('# Body\n', [{ key: 'title', value: 'Text' }]), /^---\ntitle: "Text"\n---\n# Body\n$/)
  assert.equal(editProperties('---\na: 1 # comment\nb: true\n---\nbody', [{ key: 'a', remove: true }]), '---\nb: true\n---\nbody')
  for (const text of ['---\na: [1\n---\nbody', '---\na: 1\na: 2\n---\nbody', '---json\n{}\n---\nbody']) assert.throws(() => editProperties(text, [{ key: 'title', value: 'no' }]))
})

import { documentTags, renameTag, proseMask } from '../src/shared/markdown-tools'
test('hierarchical tag renames deduplicate YAML and exclude code, links and URLs', () => {
  const text='---\ntags: [项目, 项目/墨页, 新/墨页]\nkeep: true\n---\n#项目/墨页 #项目2 项目\n`#项目` [项目](https://a/#项目) https://a/#项目\n> ```\n> #项目\n> ```\n'
  const next=renameTag(text,'项目','新')
  assert.match(next.content, /tags: \["新","新\/墨页"\]/)
  assert.match(next.content, /#新\/墨页 #项目2 项目/)
  assert.match(next.content, /`#项目`/); assert.match(next.content, /> #项目/)
  assert.deepEqual(documentTags(next.content).sort(),['新','新/墨页','项目2'].sort())
  assert.equal(proseMask('名字 [[名字]] [名字](url) `名字` https://a/名字').trim(), '名字')
  assert.equal(proseMask('[名字]\n\n[名字]: https://example.com').trim(), '')
})
test('deleting a block list keeps the next property and its comment', () => {
  const source='---\ntags:\n  - a\n  - b\n# keep\nstatus: draft\n---\nbody'
  assert.equal(editProperties(source,[{key:'tags',remove:true}]),'---\n# keep\nstatus: draft\n---\nbody')
})

import { localDate, applyTemplate, tableAt, editTable } from '../src/shared/markdown-tools'
test('daily dates use local time and known placeholders only',()=>{
  const date=new Date(2026,9,30,9,5)
  assert.equal(localDate(date,'YYYY/MM/DD'),'2026/10/30')
  assert.equal(applyTemplate('{{title}} {{date}} {{time}} {{unknown}}','墨页',date),'墨页 2026-10-30 09:05 {{unknown}}')
  assert.throws(()=>localDate(date,'MM-DD'))
})
test('table operations preserve escaped/code pipes, correct columns and CRLF; invalid positions do not mutate',()=>{
  const text='# Intro\r\n\r\n| A | B |\r\n| --- | :---: |\r\n| x\\|y | `a|b` |\r\n\r\nTail', cursor=text.indexOf('`a|b`')
  assert.equal(tableAt(text,cursor).column,1)
  const next=editTable(text,cursor,'column-before')
  assert.equal(tableAt(next,cursor).align.length,3)
  assert.match(next,/x\\\|y/);assert.match(next,/`a\\\|b`/);assert.ok(next.endsWith('\r\n\r\nTail'))
  assert.equal(tableAt(editTable(text,cursor,'row-after'),cursor).rows.length,3)
  assert.throws(()=>editTable('# no table',0,'row-after'),/有效/)
  assert.throws(()=>editTable('```\n| a |\n| --- |\n```',10,'row-after'),/代码块/)
})

import { mediaAt, mediaMarkdown } from '../src/shared/markdown-tools'
test('media attributes round-trip balanced URLs, alt text, titles and bounded dimensions',()=>{
  const src='Before ![a\\]b](<path/(photo 1).png> "title"){width=320 height=200} after'
  const media=mediaAt(src,src.indexOf('a\\]b')+1)!
  assert.equal(media.label,'a]b');assert.equal(media.url,'path/(photo 1).png');assert.equal(media.width,320)
  const rendered=mediaMarkdown(media),parsed=mediaAt(rendered,3)!
  assert.equal(parsed.label,media.label);assert.equal(parsed.title,'title');assert.equal(parsed.height,200)
  assert.throws(()=>mediaMarkdown({...media,url:'javascript:alert(1)'}),/协议/)
  assert.throws(()=>mediaMarkdown({...media,width:-1}),/整数/)
  assert.equal(mediaAt('`![alt](x)`',4),null)
})

test('YAML empty scalar and block text edits keep unrelated bytes',()=>{
  const source='---\nempty: # comment\ntext: |\n  hello\n  world\nnext: keep\n---\nbody'
  const result=editProperties(source,[{key:'empty',value:'filled'},{key:'text',value:'short'}])
  assert.match(result,/empty: "filled" # comment/)
  assert.match(result,/text: "short"\nnext: keep\n---\nbody$/)
})
