// Production installer + preload IPC + opaque plugin iframe + preview pipeline, using an isolated profile.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-plugin-market-'))
const source = name => JSON.stringify(path.join(root, name))
try {
  await build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temporary, 'preload.cjs') })
  await build({ stdin: { resolveDir: root, contents: `
import '${root}/src/renderer/styles/app.css'
import '${root}/src/renderer/styles/preview.css'
import {bootPlugins,pluginSnapshot,uninstallPlugin} from ${source('src/renderer/src/pluginRuntime.ts')}
import {setupPluginCenter,openPluginCenter} from ${source('src/renderer/src/pluginCenter.ts')}
import {renderPreview} from ${source('src/renderer/src/preview.ts')}
import {registerCalloutPlugin} from ${source('src/renderer/src/bundled-callout.ts')}
const assert=(v,m)=>{if(!v)throw Error(m)}
const wait=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('UI timed out')}
const idle=()=>wait(()=>document.getElementById('pc-list').getAttribute('aria-busy')==='false')
const card=id=>document.querySelector('.pc-card[data-id="'+id+'"]')
const click=async(selector,parent=document)=>{const b=parent.querySelector(selector);assert(b&&!b.disabled,'Missing button '+selector);b.click();await idle()}
window.pluginMarketTest=(async()=>{
  const checks=[]
  registerCalloutPlugin();await bootPlugins();setupPluginCenter();openPluginCenter();await idle()
  await click('[data-view="discover"]')
  for(const id of ['inkleaf.reading-time','inkleaf.external-links']) {
    await click('[data-action="catalog"]',card(id))
    assert(pluginSnapshot().find(p=>p.id===id)?.state==='registered','Install auto-enabled '+id)
    await click('[data-action="toggle"]',card(id))
    assert(pluginSnapshot().find(p=>p.id===id)?.state==='active','Actual iframe activation failed '+id)
  }
  checks.push('both official plugins install via production IPC and activate in real opaque iframes')
  const preview=document.getElementById('preview')
  const markdown='# 标题\\n\\n中文内容 hello world\\n\\n[网站](https://example.invalid) [本地](notes.md) [目录](#标题)\\n\\n> [!warning] 注意\\n> 小心修改。'
  await renderPreview(preview,preview,markdown,null)
  assert(preview.querySelector('[data-ink-reading-time]')?.textContent.includes('分钟'),'Reading time output missing')
  assert(preview.querySelector('a[href="https://example.invalid"]')?.textContent.endsWith('↗'),'External link marker missing')
  assert(preview.querySelector('a[href="notes.md"]')?.textContent==='本地','Local link changed')
  assert(preview.querySelector('a[href^="#"]')?.textContent==='目录','Anchor changed')
  assert(getComputedStyle(preview.querySelector('.md-callout-warning')).borderLeftColor==='rgb(232, 160, 0)','Document callout warning color still overridden')
  checks.push('both real plugins transform preview, retain links and compose with colored callouts')
  window.ink.disable('inkleaf.reading-time');window.ink.disable('inkleaf.external-links')
  await renderPreview(preview,preview,markdown,null)
  assert(!preview.querySelector('[data-ink-reading-time]')&&!preview.querySelector('[data-ink-external-link]'),'Disable did not remove transforms')
  checks.push('disabling plugins removes preview contributions')
  await uninstallPlugin('inkleaf.external-links')
  assert(!(await window.mdr.pluginsList()).some(p=>p.id==='inkleaf.external-links'),'Uninstall left files')
  checks.push('uninstall removes runtime and installed package')
  return {passed:true,checks}
})().catch(error=>({passed:false,error:String(error),stack:error.stack}))
` }, bundle: true, platform: 'browser', format: 'esm', outfile: path.join(temporary, 'renderer.js'), loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  await writeFile(path.join(temporary, 'index.html'), await readFile(path.join(root, 'src/renderer/index.html')))
  for (const file of ['plugin-sandbox.html', 'plugin-sandbox.mjs']) await cp(path.join(root, 'src/renderer', file), path.join(temporary, file))
  await build({ stdin: { resolveDir: root, contents: `
import {app,BrowserWindow,dialog,protocol,shell} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {registerPluginIpc,resolvePluginFile} from ${source('src/main/plugins-host.ts')}
app.setPath('userData',path.join(${JSON.stringify(temporary)},'profile'))
app.getVersion=()=> '0.5.1'
dialog.showMessageBox=async()=>({response:1,checkboxChecked:false})
shell.trashItem=async target=>fs.rm(target,{recursive:true,force:true})
protocol.registerSchemesAsPrivileged([{scheme:'inkplug',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}])
let exitCode=0
app.on('will-quit',()=>{if(exitCode)app.exit(exitCode)})
function finish(code){exitCode=code;for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit()}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>{console.error('PLUGIN_MARKET_UI timed out');finish(1)},45000)
 protocol.handle('inkplug',async request=>{
   const u=new URL(request.url)
   const bootstrap=u.host==='sandbox'?{'/index.html':'plugin-sandbox.html','/bootstrap.mjs':'plugin-sandbox.mjs'}[u.pathname]:undefined
   const file=bootstrap?path.join(${JSON.stringify(temporary)},bootstrap):await resolvePluginFile(request.url)
   if(!file)return new Response('forbidden',{status:403})
   return new Response(new Uint8Array(await fs.readFile(file)),{headers:{'content-type':bootstrap==='plugin-sandbox.html'?'text/html':'text/javascript','access-control-allow-origin':'*','cross-origin-resource-policy':'cross-origin'}})
 })
 registerPluginIpc()
 const win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(${JSON.stringify(temporary)},'preload.cjs')}})
 win.webContents.on('console-message',(_e,_l,msg)=>console.log(msg))
 await win.loadFile(path.join(${JSON.stringify(temporary)},'index.html'))
 const result=await win.webContents.executeJavaScript('(async()=>{while(!window.pluginMarketTest)await new Promise(r=>setTimeout(r,10));return await window.pluginMarketTest})()')
 if(!result.passed)throw Error(JSON.stringify(result))
 await win.webContents.executeJavaScript("document.querySelector('[data-view=discover]').click();document.querySelector('.pc-card[data-id=\\"bundled.callout\\"] [data-action=details]').click();document.getElementById('pc-tab-examples').click()")
 for(const theme of ['light','dark']) {
   await win.webContents.executeJavaScript('document.body.dataset.theme='+JSON.stringify(theme))
   await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,150))')
   await fs.writeFile(path.join(${JSON.stringify(root)},'verify','plugin-workspace-real-'+theme+'.png'),(await win.webContents.capturePage()).toPNG())
 }
 win.setSize(480,640)
 const fits=await win.webContents.executeJavaScript('(async()=>{await new Promise(r=>setTimeout(r,100));const d=document.querySelector(".pc-dialog");return d.scrollWidth<=d.clientWidth&&d.getBoundingClientRect().bottom<=innerHeight})()')
 if(!fits)throw Error('Plugin workspace overflows at 480px')
 await fs.writeFile(path.join(${JSON.stringify(root)},'verify','plugin-workspace-real-narrow.png'),(await win.webContents.capturePage()).toPNG())
 console.log('PLUGIN_MARKET_UI PASS '+JSON.stringify({...result,narrow:true}));clearTimeout(timer);finish(0)
}).catch(err=>{console.error(err);finish(1)})
` }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temporary, 'worker.cjs') })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  execFileSync(createRequire(import.meta.url)('electron'), [path.join(temporary, 'worker.cjs'), '--disable-gpu'], { cwd: root, env, stdio: 'inherit', timeout: 60000 })
} finally { await rm(temporary, { recursive: true, force: true }) }
