// Isolated renderer tests; a graphical desktop or xvfb-run is required on Linux.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-platform-ui-'))
try {
  await build({ entryPoints: [path.join(root, 'tests/platform-ui.ts')], bundle: true, platform: 'browser', format: 'esm', outfile: path.join(temporary, 'fixture-renderer.js') })
  const html = (await readFile(path.join(root, 'src/renderer/index.html'), 'utf8'))
    .replace('./renderer.css', './fixture-renderer.css')
    .replace('./renderer.js', './fixture-renderer.js')
  const filename = path.join(temporary, 'index.html')
  await writeFile(filename, html)
  const worker = path.join(temporary, 'worker.cjs')
  await writeFile(worker, String.raw`
const {app,BrowserWindow}=require('electron')
let resultCode=0
app.on('will-quit',()=>{if(resultCode!==0)app.exit(resultCode)})
app.setPath('userData',process.argv[3])
app.whenReady().then(async()=>{
  const finish=(code)=>{resultCode=code;for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit()}
  const timer=setTimeout(()=>{console.error('Platform UI tests timed out');finish(1)},20000)
  const window=new BrowserWindow({width:1000,height:740,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
  await window.loadFile(process.argv[2])
  const result=await window.webContents.executeJavaScript('(async()=>{while(!window.platformUiTest)await new Promise(resolve=>setTimeout(resolve,20));return await window.platformUiTest})()')
  clearTimeout(timer)
  console.log(JSON.stringify(result))
  finish(result?.passed?0:1)
}).catch(error=>{console.error(error);resultCode=1;for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit()})
`)
  const require = createRequire(import.meta.url)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [worker, filename, path.join(temporary, 'profile')], { cwd: root, env: environment, stdio: 'inherit', timeout: 30000 })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
