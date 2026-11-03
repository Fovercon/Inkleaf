// Issue #7: exercise the real renderer after delayed relation data arrives.
import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root=process.cwd(), temp=await mkdtemp(path.join(tmpdir(),'inkleaf-layout-'))
try {
 await symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir')
 const hooks=`\nimport {registerPostProcessor,removePostProcessor} from './pipeline';
 Object.assign(window,{__layout:{runtime,editor,getState,saveState,applyLayout,openFile,renderPreview,preview,previewScroll,outlineNav,setTheme,registerPostProcessor,removePostProcessor,onPreviewRendered}});`
 await build({stdin:{contents:await readFile('src/renderer/src/main.ts','utf8')+hooks,resolveDir:path.join(root,'src/renderer/src'),loader:'ts'},bundle:true,platform:'browser',format:'esm',splitting:true,outdir:temp,entryNames:'renderer',loader:{'.woff2':'file','.woff':'file','.ttf':'file'},logLevel:'silent'})
 await build({entryPoints:{host:'src/main/ipc.ts',preload:'src/preload/index.ts'},bundle:true,platform:'node',format:'cjs',outdir:temp,outExtension:{'.js':'.cjs'},external:['electron','chokidar'],logLevel:'silent'})
 await writeFile(path.join(temp,'index.html'),await readFile('src/renderer/index.html'))
 const worker=String.raw`
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const temp=process.argv[2],lib=path.join(temp,'library'),file=path.join(lib,'A.md'),other=path.join(lib,'B.md')
app.setPath('userData',path.join(temp,'profile'))
const {registerIpc,flushSessionWrites}=require(path.join(temp,'host.cjs'))
let win,release,mode='delayed',code=0;const checks=[]
app.on('window-all-closed',()=>{});app.on('will-quit',()=>{if(code)app.exit(code)})
const run=s=>win.webContents.executeJavaScript(s).catch(e=>{throw Error(e.message+'; expression='+s)})
const until=async(s)=>{for(let i=0;i<300;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,20))}throw Error('Timed out: '+s)}
const measure=()=>run('(()=>{const rect=id=>document.getElementById(id).getBoundingClientRect().width;return {right:rect("right-panes"),doc:rect("doc-wrap"),preview:rect("preview-pane"),height:__layout.previewScroll.scrollHeight,backlinks:document.querySelectorAll(".backlink-item").length}})()')
const launch=async()=>{const ready=new Promise(r=>ipcMain.once('app:renderer-ready',r));win=new BrowserWindow({width:1360,height:880,show:false,webPreferences:{preload:path.join(temp,'preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});win.webContents.on('console-message',(_e,_l,m)=>console.log('LAYOUT_RENDERER',m));await win.loadFile(path.join(temp,'index.html'));await ready}
const finish=c=>{code=c;for(const w of BrowserWindow.getAllWindows())w.destroy();app.quit()}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>{console.error('LAYOUT_UI timed out');finish(1)},60000)
 await fs.mkdir(lib,{recursive:true});await fs.mkdir(app.getPath('userData'),{recursive:true})
 await fs.writeFile(file,'# Current A\n\n'+('A paragraph with normal content.\n\n'.repeat(180)))
 await fs.writeFile(other,'# Current B\n\nB body\n')
 await fs.writeFile(path.join(app.getPath('userData'),'session.json'),JSON.stringify({libraryRoot:lib,lastFile:file}))
 registerIpc();ipcMain.handle('update:getState',()=>({status:'idle',currentVersion:'test'}));ipcMain.handle('plugins:list',()=>[])
 ipcMain.removeHandler('knowledge:relations')
 ipcMain.handle('knowledge:relations',async(_e,p)=>{
  if(mode==='delayed')await new Promise(r=>release=r)
  return {backlinks:[],mentions:Array.from({length:13},(_,i)=>({path:path.join(lib,'a-very-long-folder-name-'.repeat(14),'source-'+i+'.md'),line:1,context:'上下文'.repeat(160)+'<br>第二行\n第三行'}))}
 })
 await launch();const before=await measure();await run('__layout.previewScroll.scrollTop=500')
 mode='long';release();await until('document.querySelectorAll(".backlink-item").length===13')
 const after=await measure();assert.ok(Math.abs(after.preview-before.preview)<=1,JSON.stringify({before,after}));assert.ok(after.right<=420&&after.preview>=200);assert.ok(after.height<=before.height*1.05)
 assert.equal(await run('document.querySelector(".bl-context").textContent.includes("<br>")'),false)
 checks.push('13 delayed long mentions do not resize the document while scrolling; context is plain text')
 const handle=await run('(()=>{const r=document.getElementById("resizer-outline").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+60)}})()')
 await run('window.__drag=[];for(const type of ["pointerdown","pointermove","pointerup"])document.getElementById("resizer-outline").addEventListener(type,e=>__drag.push([type,e.clientX]))')
 win.webContents.debugger.attach('1.3')
 await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
 await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...handle})
 await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...handle})
 await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:handle.x-60,y:handle.y})
 await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:handle.x-60,y:handle.y})
 await until('__layout.getState().widths.outline>220').catch(async e=>{throw Error(e.message+'; drag='+JSON.stringify(await run('__drag'))+'; widths='+JSON.stringify(await measure()))});assert.ok((await measure()).right>after.right+40)
 checks.push('dragging the shared right resizer left widens the rail and preserves preview space')
 await run('__layout.getState().collapsed.outline=true;__layout.getState().collapsed.backlink=false;__layout.applyLayout()')
 assert.ok((await measure()).right>0,'Backlinks-only right rail disappeared')
 await run('__layout.getState().collapsed.outline=false;__layout.getState().widths.outline=999999;__layout.getState().widths.sidebar=999999;__layout.getState().widths.editor=999999;__layout.applyLayout();__layout.saveState()')
 win.setSize(780,540);await run('__layout.applyLayout()');const narrow=await measure();assert.ok(narrow.preview>=158&&narrow.doc>=240&&narrow.right<=420,JSON.stringify(narrow))
 checks.push('shared right rail stays bounded with outline hidden, narrow windows and invalid saved widths')
 await flushSessionWrites();win.destroy();await launch();await until('document.querySelectorAll(".backlink-item").length===13');assert.ok((await measure()).preview>=200)
 checks.push('session restoration cannot restore a zero-width preview')
 await run('window.__completed=[];__layout.onPreviewRendered((c,p)=>__completed.push(p));window.__gate=new Promise(r=>window.__release=r);window.__seen=false;window.__slow=async(c,ctx)=>{if(ctx.filePath.endsWith("B.md")&&!__seen){__seen=true;await __gate}};__layout.registerPostProcessor(__slow,true)')
 await run('window.__pending=__layout.openFile('+JSON.stringify(other)+');void 0')
 await until('__seen');await run('__layout.setTheme("dark")')
 await until('__completed.some(p=>p.endsWith("B.md"))')
 await run('__release();__pending');assert.match(await run('__layout.preview.querySelector("h1").textContent'),/Current B/);assert.match(await run('__layout.outlineNav.textContent'),/Current B/);assert.doesNotMatch(await run('__layout.outlineNav.textContent'),/Current A/)
 checks.push('theme render during a delayed document render retains the current document and outline')
 await fs.mkdir(path.join(process.cwd(),'verify'),{recursive:true});await fs.writeFile(path.join(process.cwd(),'verify','workspace-layout.png'),(await win.webContents.capturePage()).toPNG())
 console.log('LAYOUT_UI PASS '+JSON.stringify({checks}));clearTimeout(timer);finish(0)
}).catch(e=>{console.error(e);finish(1)})
`
 await writeFile(path.join(temp,'worker.cjs'),worker)
 const env={...process.env,NODE_PATH:path.join(root,'node_modules')};delete env.ELECTRON_RUN_AS_NODE
 await mkdir('verify',{recursive:true})
 execFileSync(createRequire(import.meta.url)('electron'),[path.join(temp,'worker.cjs'),temp,'--disable-gpu'],{env,cwd:root,stdio:'inherit',timeout:75000})
}finally{await rm(temp,{recursive:true,force:true})}
