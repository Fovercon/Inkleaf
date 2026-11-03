import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import path from 'node:path'
async function check(status: number, body: unknown, targetArch = 'arm64') {
  const root=process.cwd()
  const bundle=await build({entryPoints:['src/main/updater.ts'],write:false,bundle:true,platform:'node',format:'cjs',logLevel:'silent',define:{'process.platform':JSON.stringify('darwin'),'process.arch':JSON.stringify(targetArch)},plugins:[{name:'response-fixture',setup(builder){
    builder.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}))
    builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
      const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
      export const app={isPackaged:true,getVersion:()=> '0.4.5',getPath:()=> '/tmp',once:(_name,fn)=>globalThis.__quit=fn};
      export const BrowserWindow={getAllWindows:()=>[]};export const ipcMain={handle:()=>{}};
      export const net={request:()=>{const req=new EventEmitter();req.setHeader=()=>{};req.abort=()=>req.emit('abort');req.end=()=>queueMicrotask(()=>{const response=new PassThrough();response.statusCode=${status};response.headers={'content-type':'application/json'};req.emit('response',response);response.end(${JSON.stringify(JSON.stringify(body))})});return req}};
    `}))
  }}]})
  const mod={exports:{} as any}
  new Function('module','exports','require',bundle.outputFiles[0].text)(mod,mod.exports,createRequire(path.join(root,'package.json')))
  mod.exports.initializeUpdater()
  try{return await mod.exports.checkForUpdates()}
  finally{(globalThis as any).__quit?.()}
}
test('inaccessible or private release source is an error, never a latest-version claim',async()=>{
  const state=await check(404,{message:'Not Found'})
  assert.equal(state.status,'error');assert.match(state.message,/404.*私有/);assert.equal(state.version,undefined)
  const denied=await check(403,{message:'Forbidden'});assert.equal(denied.status,'error')
})
test('only a successful stable release comparison can report up-to-date',async()=>{
  const state=await check(200,{tag_name:'v0.4.5',draft:false,prerelease:false,assets:[]})
  assert.equal(state.status,'up-to-date')
  const invalid=await check(200,{message:'Not Found'});assert.equal(invalid.status,'error')
})
test('the same transport detects the real package shape from a newer public release',async()=>{
  const name='Inkleaf-0.5.2-mac-arm64.zip'
  const state=await check(200,{tag_name:'v0.5.2',draft:false,prerelease:false,assets:[{name,state:'uploaded',size:2048,digest:'sha256:'+'a'.repeat(64),browser_download_url:'https://github.com/Fovercon/Inkleaf/releases/download/v0.5.2/'+name}]})
  assert.equal(state.status,'available');assert.equal(state.version,'0.5.2')
})

test('Intel remains unsupported; transport fixtures target the shipped ARM64 application explicitly',async()=>{
  const state=await check(200,{tag_name:'v0.5.3',draft:false,prerelease:false,assets:[]},'x64')
  assert.equal(state.status,'unsupported')
})
