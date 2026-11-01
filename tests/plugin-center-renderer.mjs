// Exercise production dialog/lifecycle in Chromium with controlled async host failures.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-plugin-center-'))
try {
  await build({ entryPoints: [path.join(root, 'tests/plugin-center-renderer-fixture.ts')], bundle: true, platform: 'browser', format: 'esm', outfile: path.join(temporary, 'renderer.js'), plugins: [{ name: 'controlled-plugin-sandbox', setup(builder) {
    builder.onResolve({ filter: /^\.\/externalPlugin$/ }, () => ({ path: 'sandbox', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const createPluginSandbox=(...args)=>window.__sandbox(...args);export const sanitizePluginHtml=x=>x;' }))
  } }] })
  await writeFile(path.join(temporary, 'index.html'), await readFile(path.join(root, 'src/renderer/index.html')))
  const worker = path.join(temporary, 'worker.cjs')
  await writeFile(worker, String.raw`
const {app,BrowserWindow}=require('electron')
const fs=require('node:fs/promises'), path=require('node:path')
app.setPath('userData',process.argv[3])
let code=0
app.on('will-quit',()=>{if(code)app.exit(code)})
function finish(value){code=value;for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit()}
app.whenReady().then(async()=>{
  const timer=setTimeout(()=>{console.error('PLUGIN_CENTER_UI timed out');finish(1)},45000)
  const win=new BrowserWindow({width:1080,height:820,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
  win.webContents.on('console-message',(_event,_level,message)=>console.log(message))
  const results=[]
  for(let phase=0;phase<2;phase++){
    await win.loadFile(process.argv[2])
    const result=await win.webContents.executeJavaScript('(async()=>{while(!window.pluginCenterTest)await new Promise(r=>setTimeout(r,10));return await window.pluginCenterTest})()')
    results.push(result)
    if(!result?.passed)throw Error(JSON.stringify(result))
  }
  for(const theme of ['light','dark']){
    await win.webContents.executeJavaScript('document.body.dataset.theme='+JSON.stringify(theme))
    await fs.writeFile(path.join(process.argv[4],'plugin-center-'+theme+'.png'),(await win.webContents.capturePage()).toPNG())
  }
  win.setSize(480,640)
  const fits=await win.webContents.executeJavaScript('(async()=>{await new Promise(r=>setTimeout(r,100));const d=document.querySelector(".pc-dialog");return d.scrollWidth<=d.clientWidth&&d.getBoundingClientRect().bottom<=innerHeight})()')
  if(!fits)throw Error('Narrow dialog overflows viewport')
  console.log('PLUGIN_CENTER_UI PASS '+JSON.stringify({checks:results.flatMap(r=>r.checks),narrow:true}))
  clearTimeout(timer);finish(0)
}).catch(error=>{console.error(error);finish(1)})
`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  await mkdir(path.join(root, 'verify'), { recursive: true })
  execFileSync(createRequire(import.meta.url)('electron'), [worker, path.join(temporary, 'index.html'), path.join(temporary, 'profile'), path.join(root, 'verify'), '--disable-gpu'], { cwd: root, env, stdio: 'inherit', timeout: 60000 })
} finally { await rm(temporary, { recursive: true, force: true }) }
