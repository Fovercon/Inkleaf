import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KnowledgeService, matchDocuments } from '../src/main/knowledge-service'
import { DocumentHistory } from '../src/main/document-history'
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-knowledge-'))
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const a = path.join(root, 'A.md'), b = path.join(root, 'B.md')
  await fs.writeFile(a, '---\ntags: [project/ink]\nstatus: draft\n---\nCat cat scatter cat_ 中文。\n')
  await fs.writeFile(b, '# B\ncat\n')
  let epoch = 'one'
  const history = new DocumentHistory(path.join(root, '.history'))
  const service = new KnowledgeService(() => root, () => epoch, async () => [a,b], history)
  return { root, a, b, service, history, switch: () => { epoch = 'two' } }
}
test('case, Unicode word, path, tag and property filters compose; regex captures and literal replacement differ', async t => {
  const { service, a } = await fixture(t)
  assert.equal((await service.search({ query: 'cat' })).total, 5)
  assert.equal((await service.search({ query: 'cat', caseSensitive: true, wholeWord: true })).total, 2)
  assert.equal((await service.search({ query: 'cat', tag:'project', propertyKey:'status', propertyValue:'draft', path:'A.md' })).files, 1)
  assert.equal((await service.preview({ query: '(c)(at)', regex:true, wholeWord:true }, '$2$1')).files.find(f=>f.path===a)?.after.includes('atC atc'), true)
  assert.equal((await service.preview({query:'cat'}, '$1')).files[0].after.includes('$1'), true)
  await assert.rejects(service.search({query:'[',regex:true}), /regular expression|Invalid/i)
  assert.equal((await service.preview({query:'(?=cat)',regex:true}, 'x')).files.length, 2)
})
test('literal punctuation and zero-width matches work; pathological regex terminates', async () => {
  const files = [{path:'a',content:'one [a]. two'}]
  assert.equal((await matchDocuments(files,{query:'[a].'})).report.total,1)
  await assert.rejects(matchDocuments([{path:'x',content:'a'.repeat(5000)+'!'}], {query:'^(a+)+$',regex:true}, undefined, 100), /超时/)
})
test('preview cancellation, selection, snapshots, all-file preflight and stale library guards', async t => {
  const { service, a, b, history, switch: switchRoot } = await fixture(t)
  const first = await service.preview({query:'cat'}, 'dog'), before = await fs.readFile(a,'utf8')
  assert.equal(await fs.readFile(a,'utf8'),before)
  await fs.writeFile(b,'external cat')
  await assert.rejects(service.apply(first.id,[a,b]), /整批尚未开始/)
  assert.equal(await fs.readFile(a,'utf8'),before)
  const second = await service.preview({query:'cat'},'dog')
  assert.deepEqual((await service.apply(second.id,[a])).completed,[a])
  assert.equal(await fs.readFile(b,'utf8'),'external cat')
  assert.ok((await history.list(a)).entries.length>=2)
  const third = await service.preview({query:'cat'}, 'dog'); switchRoot()
  await assert.rejects(service.apply(third.id,[b]), /书库已切换/)
})
test('runtime failure reports completed, failed and unprocessed files, and stops', async t => {
  const { root, a, b, history } = await fixture(t), c = path.join(root,'C.md'); await fs.writeFile(c,'cat')
  const write = history.write.bind(history)
  history.write = async (file,...args) => { if (file === b) throw Error('disk full'); return write(file,...args) }
  const service = new KnowledgeService(()=>root,()=>'1',async()=>[a,b,c],history)
  const preview = await service.preview({query:'cat'},'dog'), result = await service.apply(preview.id,[a,b,c])
  assert.deepEqual(result.completed,[a]); assert.equal(result.failed?.path,b); assert.deepEqual(result.pending,[c])
  assert.equal(await fs.readFile(c,'utf8'),'cat')
})

test('creation rejects traversal, symlink escape and overwrites, and daily-style existing open preserves content', async t => {
  const {root,service,a}=await fixture(t)
  const created=await service.create('notes/New','# New')
  assert.equal(await fs.readFile(created,'utf8'),'# New')
  await assert.rejects(service.create('notes/New','overwrite'), /存在/)
  assert.equal(await service.create('notes/New','overwrite',true),created)
  assert.equal(await fs.readFile(created,'utf8'),'# New')
  await assert.rejects(service.create('../Escape','x'), /书库/)
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'ink-outside-')); t.after(()=>fs.rm(outside,{recursive:true,force:true}))
  await fs.symlink(outside,path.join(root,'link'))
  await assert.rejects(service.create('link/Escape','x'), /越出/)
  assert.deepEqual(await fs.readdir(outside),[])
  assert.equal(await service.create('./Sibling','x',false,a),path.join(root,'Sibling.md'))
})
