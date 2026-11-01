import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-tooltips-'))
try {
  await build({ stdin: { resolveDir: root, contents: `
import './src/renderer/styles/app.css'
import {setupTooltips} from './src/renderer/src/tooltips'
import {setupPlatformUi} from './src/renderer/src/platform'
window.mdr={platform:new URL(location.href).searchParams.get('platform')||'darwin'}
setupPlatformUi();setupTooltips();window.hintsReady=true
` }, bundle: true, platform: 'browser', format: 'esm', outfile: path.join(temporary, 'renderer.js') })
  await writeFile(path.join(temporary, 'index.html'), await readFile(path.join(root, 'src/renderer/index.html')))
  const worker = String.raw`
const {app,BrowserWindow}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path')
app.setPath('userData',process.argv[3])
let code=0
app.on('will-quit',()=>{if(code)app.exit(code)})
function finish(value){code=value;for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit()}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>{console.error('TOOLTIPS_UI timed out');finish(1)},30000)
 const win=new BrowserWindow({width:1180,height:820,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
 await win.loadFile(process.argv[2]);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
 const js=code=>win.webContents.executeJavaScript(code)
 await js('(async()=>{while(!window.hintsReady)await new Promise(r=>setTimeout(r,10))})()')
 const pause=ms=>new Promise(r=>setTimeout(r,ms))
 const assert=(v,m)=>{if(!v)throw Error(m)}
 const hover=async selector=>{
   const p=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
   win.webContents.sendInputEvent({type:'mouseMove',x:5,y:300});await pause(30)
   win.webContents.sendInputEvent({type:'mouseMove',...p})
   for(let i=0;i<80;i++) {
     const ready=await js('(()=>{const t=document.getElementById("ink-button-tooltip"),b=document.querySelector('+JSON.stringify(selector)+');return t?.matches(":popover-open")&&b?.getAttribute("aria-describedby")?.includes(t.id)})()')
     if(ready)return
     await pause(25)
   }
   throw Error('Tooltip did not appear for '+selector+'; text='+await hint())
 }
 const hint=()=>js('document.getElementById("ink-button-tooltip").matches(":popover-open")?document.getElementById("ink-button-tooltip").textContent:null')
 const checks=[]
 await hover('#btn-open-folder')
 assert((await hint())?.includes('作为书库浏览')&&(await hint()).includes('⇧⌘O'),'Mouse hover missed purpose or macOS shortcut')
 assert(await js('document.getElementById("btn-open-folder").getAttribute("aria-describedby").includes("ink-button-tooltip")&&!document.getElementById("btn-open-folder").hasAttribute("title")'),'Tooltip description missing or duplicate native title')
 await win.loadFile(process.argv[2],{query:{platform:'linux'}})
 await js('(async()=>{while(!window.hintsReady)await new Promise(r=>setTimeout(r,10))})()')
 await hover('#btn-open-file')
 assert((await hint())?.includes('Ctrl+O')&&!(await hint()).includes('⌘'),'Linux shortcut was displayed as macOS: '+await hint())
 await win.loadFile(process.argv[2])
 await js('(async()=>{while(!window.hintsReady)await new Promise(r=>setTimeout(r,10))})()')
 checks.push('real pointer hover explains icon actions and platform shortcuts')
 await js('document.getElementById("btn-toggle-editor").setAttribute("aria-pressed","true")')
 await hover('#btn-toggle-editor');assert((await hint()).startsWith('收起编辑面板'),'Visible pane hint inaccurate')
 await js('document.getElementById("btn-toggle-editor").setAttribute("aria-pressed","false")');await pause(50)
 assert((await hint()).startsWith('展开编辑面板'),'Hint did not update with state')
 checks.push('panel hints track live state')
 await js('document.getElementById("btn-updates").focus()');await pause(200)
 await js('document.getElementById("btn-updates").title="新版本已就绪，点击安装"');await pause(50)
 assert((await hint())==='新版本已就绪，点击安装','Live update title was stale: '+JSON.stringify(await js('({hint:document.getElementById(\"ink-button-tooltip\").textContent,open:document.getElementById(\"ink-button-tooltip\").matches(\":popover-open\"),active:document.activeElement.id,title:document.getElementById(\"btn-updates\").getAttribute(\"title\")})')))
 await js('document.getElementById("btn-updates").click()');assert((await hint())===null,'Click left a tooltip open')
 assert(await js('document.getElementById("btn-updates").title.includes("新版本已就绪")'),'Latest native title not restored')
 checks.push('update status and click dismissal preserve current titles')
 await js('document.getElementById("btn-tools").focus()');await pause(200)
 assert((await hint())?.includes('历史恢复'),'Keyboard focus has no hint')
 await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
 assert((await hint())===null,'Escape did not dismiss')
 checks.push('keyboard focus shows hints and Escape dismisses')
 await js('document.body.insertAdjacentHTML(\'beforeend\',\'<dialog id="hint-dialog"><button id="dynamic-action" title="动态按钮：复制写法" aria-describedby="existing-help">✕</button><p id="existing-help">保留说明</p></dialog>\');document.getElementById("hint-dialog").showModal();document.getElementById("dynamic-action").focus()')
 await pause(200)
 assert((await hint())==='动态按钮：复制写法','Dynamic dialog hint missing: '+JSON.stringify(await js('({text:document.getElementById(\"ink-button-tooltip\").textContent,active:document.activeElement.id,open:document.getElementById(\"ink-button-tooltip\").matches(\":popover-open\"),parent:document.getElementById(\"ink-button-tooltip\").parentElement.tagName,title:document.getElementById(\"dynamic-action\").getAttribute(\"title\")})')))
 assert(await js('document.getElementById("hint-dialog").contains(document.getElementById("ink-button-tooltip"))&&document.getElementById("dynamic-action").getAttribute("aria-describedby").includes("existing-help")'),'Modal top layer or existing ARIA description lost')
 await js('document.getElementById("hint-dialog").remove()');await pause(50)
 assert((await hint())===null,'Detached target left a stale tooltip')
 checks.push('dynamic modal buttons keep ARIA descriptions and clean up on removal')
 // Pointer must leave the prior toolbar control before returning.
 win.webContents.sendInputEvent({type:'mouseMove',x:5,y:300});await pause(30)
 await hover('#btn-tools')
 assert(await js('(()=>{const r=document.getElementById("ink-button-tooltip").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'),'Hint escapes viewport')
 await fs.writeFile(path.join(process.argv[4],'button-hints-light.png'),(await win.webContents.capturePage()).toPNG())
 await js('document.body.dataset.theme="dark"');await pause(60)
 await fs.writeFile(path.join(process.argv[4],'button-hints-dark.png'),(await win.webContents.capturePage()).toPNG())
 await js('document.dispatchEvent(new Event("scroll",{bubbles:true}))');assert((await hint())===null,'Scroll left a stale tooltip')
 checks.push('tooltips fit viewport, use both themes and dismiss on scroll')
 console.log('TOOLTIPS_UI PASS '+JSON.stringify({checks}));clearTimeout(timer);finish(0)
}).catch(e=>{console.error(e);finish(1)})
`
  await writeFile(path.join(temporary, 'worker.cjs'), worker)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  await mkdir(path.join(root, 'verify'), { recursive: true })
  execFileSync(createRequire(import.meta.url)('electron'), [path.join(temporary, 'worker.cjs'), path.join(temporary, 'index.html'), path.join(temporary, 'profile'), path.join(root, 'verify'), '--disable-gpu'], { cwd: root, env, stdio: 'inherit', timeout: 45000 })
} finally { await rm(temporary, { recursive: true, force: true }) }
