import {test} from 'node:test'
import assert from 'node:assert/strict'
import {validateReuse} from '../scripts/verify-release-source.mjs'
const source='a'.repeat(40), repository='Fovercon/Inkleaf'
const fixture=()=>({run:{repository:{full_name:repository},head_sha:source,status:'completed',path:'.github/workflows/release.yml'},jobs:[
  ...['linux (x64, ubuntu-22.04)','linux (arm64, ubuntu-24.04-arm)','Ubuntu 24.04 x64 compatibility'].map(name=>({name:'linux / '+name,status:'completed',conclusion:'success'})),
  {name:'validate',status:'completed',conclusion:'success'},{name:'mac',status:'completed',conclusion:'cancelled'},
]})
test('recovery accepts exact source with all three successful native Linux checks',()=>{const f=fixture();assert.doesNotThrow(()=>validateReuse(f.run,f.jobs,source,repository))})
test('recovery rejects mismatched source, repository, workflow or unfinished runs',()=>{
 for(const patch of [{head_sha:'b'.repeat(40)},{repository:{full_name:'Other/Repo'}},{path:'.github/workflows/untrusted.yml'},{status:'in_progress'}]){const f=fixture();assert.throws(()=>validateReuse({...f.run,...patch},f.jobs,source,repository))}
})
test('recovery never treats missing, duplicate, cancelled or failed Linux evidence as passing',()=>{
 for(const mutate of [jobs=>jobs.slice(1),jobs=>[...jobs,jobs[0]],jobs=>jobs.map((job,i)=>i===2?{...job,conclusion:'cancelled'}:job),jobs=>jobs.map((job,i)=>i===0?{...job,conclusion:'failure'}:job)]){const f=fixture();assert.throws(()=>validateReuse(f.run,mutate(f.jobs),source,repository))}
})
test('recovery rejects an actual macOS test failure and an invalid original release identity',()=>{
 for(const name of ['mac','validate']){const f=fixture();assert.throws(()=>validateReuse(f.run,f.jobs.map(job=>job.name===name?{...job,conclusion:'failure'}:job),source,repository))}
})
