// Real Chromium DOM/CSS regressions for external post-processors; use Xvfb on Linux.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-plugin-dom-'))
const documentFixture = path.join(temporary, 'source.md')
const source = filename => JSON.stringify(path.join(root, 'src/renderer/src', filename))
const dangerousStyles = [
  'background-image:url(https://exfil.invalid/a)',
  String.raw`background-image:u\72l(https://exfil.invalid/a)`,
  'background-image:u/**/rl(https://exfil.invalid/a)',
  '@import url(https://exfil.invalid/a)',
  String.raw`\40import url(https://exfil.invalid/a)`,
  'width:expression(alert(1))',
  String.raw`width:e\78pression(alert(1))`,
  'width:e/**/xpression(alert(1))',
  'background-image:image-set(url(https://exfil.invalid/a) 1x)',
  'height:var(--resource);--resource:url(https://exfil.invalid/a)',
]
const renderer = String.raw`
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { sanitizePluginHtml } from ${source('externalPlugin.ts')}
import { renderPreview, setTaskToggleHandler } from ${source('preview.ts')}
import { registerPostProcessor, removePostProcessor } from ${source('pipeline.ts')}
import { setWikilinkNav } from ${source('wikilink.ts')}

const checks = []
function assert(value, message) { if (!value) throw new Error(message) }
async function check(name, fn) { await fn(); checks.push(name); console.log('PLUGIN_DOM_CASE PASS', name) }
function parse(html) { const el = document.createElement('div'); el.innerHTML = html; return el }
const delay = () => new Promise(resolve => setTimeout(resolve, 0))
window.pluginDomTest = (async () => {
  await check('real KaTeX styles survive a changed post-processor result', async () => {
    const container = document.getElementById('formula')
    container.innerHTML = katex.renderToString(${JSON.stringify(String.raw`\frac{a^2}{b}+\sqrt{x}+\overline{y}+\begin{array}{cc}a&b\\c&d\end{array}`)}, { throwOnError: true })
    await document.fonts.ready
    const protectedStyles = []
    for (const [index, el] of [...container.querySelectorAll('[style]')].entries()) {
      el.dataset.katexFixture = String(index)
      for (const property of ['height', 'top', 'width']) {
        const value = el.style.getPropertyValue(property)
        if (value) protectedStyles.push({ index, property, value, computed: getComputedStyle(el).getPropertyValue(property) })
      }
    }
    for (const property of ['height', 'top', 'width']) assert(protectedStyles.some(item => item.property === property), 'The actual KaTeX fixture must exercise ' + property)
    const before = container.innerHTML
    container.innerHTML = sanitizePluginHtml(before + '<span data-post-marker="true">post changed</span>', before)
    assert(container.querySelector('[data-post-marker="true"]'), 'The post-processor must actually change the DOM')
    for (const item of protectedStyles) {
      const el = container.querySelector('[data-katex-fixture="' + item.index + '"]')
      assert(el, 'A KaTeX styled element was removed')
      assert(el.style.getPropertyValue(item.property) === item.value, 'A legitimate KaTeX ' + item.property + ' inline value was lost')
      assert(getComputedStyle(el).getPropertyValue(item.property) === item.computed, 'Real KaTeX computed CSS changed for ' + item.property)
    }
  })
  await check('existing safe dimensions are retained and newly added styles are rejected', () => {
    const before = '<span data-case="safe" style="height:0.8em;top:-0.2em;width:1em">safe dimensions</span>'
    const clean = parse(sanitizePluginHtml(before + '<span data-case="new" style="height:999px;position:fixed">new style</span>', before))
    const safe = clean.querySelector('[data-case="safe"]')
    assert(safe.style.height === '0.8em' && safe.style.top === '-0.2em' && safe.style.width === '1em', 'Safe original dimensions must survive')
    assert(!clean.querySelector('[data-case="new"]').hasAttribute('style'), 'A plugin must not introduce new inline CSS')
  })
  await check('resource-bearing original CSS, including escapes and comments, is removed', () => {
    const styles = ${JSON.stringify(dangerousStyles)}
    const before = styles.map((style, index) => '<span data-danger="' + index + '" style="' + style + '">unsafe</span>').join('')
    const clean = parse(sanitizePluginHtml(before + '<span>different result</span>', before))
    for (const [index, style] of styles.entries()) {
      const el = clean.querySelector('[data-danger="' + index + '"]')
      assert(el && !el.hasAttribute('style'), 'Resource-bearing CSS survived: ' + style)
    }
  })
  await check('original asset images and HTTPS or relative links survive without new exfiltration URLs', () => {
    const before = '<img data-case="asset" src="mdasset://local/library/picture.png">'
      + '<a data-case="https" href="https://example.invalid/docs">web</a>'
      + '<a data-case="relative" href="./notes/doc.md">relative</a>'
      + '<a data-case="bare" href="notes/doc.md">bare relative</a>'
      + '<a data-case="parent" href="../notes/doc.md">parent relative</a>'
    const added = '<img data-case="evil-image" src="https://exfil.invalid/image">'
      + '<a data-case="evil-link" href="https://exfil.invalid/out">new URL</a>'
      + '<a data-case="script" href="javascript:alert(1)">script</a>'
      + '<template><span style="background:url(https://exfil.invalid/hidden)">hidden CSS</span><img src="https://exfil.invalid/hidden-image"></template>'
    const clean = parse(sanitizePluginHtml(before + added, before))
    for (const [name, attribute, expected] of [
      ['asset', 'src', 'mdasset://local/library/picture.png'],
      ['https', 'href', 'https://example.invalid/docs'],
      ['relative', 'href', './notes/doc.md'], ['bare', 'href', 'notes/doc.md'], ['parent', 'href', '../notes/doc.md'],
    ]) assert(clean.querySelector('[data-case="' + name + '"]').getAttribute(attribute) === expected, 'Original URL was lost: ' + name)
    assert(!clean.querySelector('[data-case="evil-image"]').hasAttribute('src'), 'A new image URL can leak data')
    assert(!clean.querySelector('[data-case="evil-link"]').hasAttribute('href'), 'A new link URL can leak data')
    assert(!clean.querySelector('[data-case="script"]').hasAttribute('href'), 'A JavaScript URL must remain forbidden')
    assert(!clean.querySelector('template'), 'Nested template contents must not bypass URL or style filtering')
  })
  await check('changed external HTML keeps real task checkbox and wikilink event handlers', async () => {
    const calls = [], navigations = [], resolutions = []
    let confirms = 0, postRuns = 0
    const transforms = []
    window.mdr = {
      resolveImage: async (source, documentPath) => {
        assert(source === 'picture.png' && documentPath === ${JSON.stringify(documentFixture)}, 'The image resolver must receive the actual source document')
        return __PRODUCTION_IMAGE_RESOLUTION__
      },
      indexResolve: async name => { resolutions.push(name); return name === 'Target' ? '/library/Target.md' : null },
      indexPeek: async () => null,
      confirm: async () => { confirms++; return false },
    }
    setTaskToggleHandler((line, checked) => calls.push({ line, checked }))
    setWikilinkNav((filename, anchor) => navigations.push({ filename, anchor }))
    const firstPost = container => {
      transforms.push('first')
      const before = container.innerHTML
      container.innerHTML = sanitizePluginHtml(before + '<span data-first-rewrite="yes">first transform</span>', before)
    }
    const post = container => {
      transforms.push('second')
      postRuns++
      assert(container.querySelector('[data-first-rewrite="yes"]'), 'External transformations must keep registration order')
      const before = container.innerHTML
      container.innerHTML = sanitizePluginHtml(before + '<p data-plugin-rewrite="yes">external rewrite</p>', before)
    }
    registerPostProcessor(firstPost, true)
    registerPostProcessor(post, true)
    try {
      const container = document.getElementById('preview'), scroller = document.getElementById('scroller')
      await renderPreview(scroller, container, '- [ ] a task\n\n[[Target#section]]\n\n![local](picture.png)', ${JSON.stringify(documentFixture)})
      await delay()
      assert(postRuns === 1 && container.querySelector('[data-plugin-rewrite="yes"]'), 'The external HTML replacement was not exercised')
      assert(transforms.join(',') === 'first,second', 'Early external transformations must remain FIFO')
      const checkbox = container.querySelector('input[type="checkbox"]')
      assert(checkbox && !checkbox.disabled, 'The rendered task must be an interactive real checkbox')
      checkbox.click()
      assert(calls.length === 1 && calls[0].line === 1 && calls[0].checked === true, 'A changed post result lost the task change listener')
      const link = container.querySelector('a[data-wikilink="Target"]')
      assert(link && link.dataset.wikilinkPath === '/library/Target.md' && resolutions.includes('Target'), 'The real wikilink resolver was not invoked')
      link.click()
      assert(navigations.length === 1 && navigations[0].filename === '/library/Target.md' && navigations[0].anchor === 'section' && confirms === 0, 'A changed post result lost the wikilink click listener')
      const image = container.querySelector('img')
      assert(image.getAttribute('src') === __PRODUCTION_IMAGE_RESOLUTION__.url, 'Local asset rewriting must run after the external replacement')
      await image.decode()
      assert(image.naturalWidth > 0 && image.naturalHeight > 0, 'The retained mdasset image must decode in the real browser')
    } finally { removePostProcessor(firstPost); removePostProcessor(post) }
  })
  return { passed: true, checks: checks.length, names: checks }
})().catch(error => ({ passed: false, checks: checks.length, error: String(error), stack: error.stack }))
`

try {
  const require = createRequire(import.meta.url)
  const assetModule = path.join(temporary, 'local-assets.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/local-assets.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: assetModule, logLevel: 'silent' })
  await cp(path.join(root, 'build', 'inkleaf-icon.png'), path.join(temporary, 'picture.png'))
  await writeFile(documentFixture, '# Real component image fixture')
  const { TrustedLocalAssets } = require(assetModule)
  const access = new TrustedLocalAssets()
  access.setLibraryRoot(temporary)
  await access.registerDocument(documentFixture)
  const imageResolution = await access.resolveImage('picture.png', documentFixture)
  if (!imageResolution.url) throw Error('The production local image resolver rejected the fixture')
  await build({
    stdin: { contents: renderer.replaceAll('__PRODUCTION_IMAGE_RESOLUTION__', '(' + JSON.stringify(imageResolution) + ')'), sourcefile: 'plugin-dom-fixture.ts', resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'browser', format: 'esm', outfile: path.join(temporary, 'fixture-renderer.js'),
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]',
    plugins: [{ name: 'controlled-theme-and-mermaid', setup(builder) {
      builder.onResolve({ filter: /^\.\/theme$/ }, args => args.importer.endsWith('/preview.ts') ? { path: 'theme', namespace: 'controlled' } : undefined)
      builder.onResolve({ filter: /^mermaid$/ }, () => ({ path: 'mermaid', namespace: 'controlled' }))
      builder.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({ contents: args.path === 'theme'
        ? "export const currentTheme=()=> 'light'; export const onThemeChange=()=>()=>{}"
        : "export default {initialize(){},async render(){return {svg:'<svg></svg>'}}}", loader: 'js' }))
    } }],
  })
  const html = path.join(temporary, 'index.html')
  await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' mdasset: data:;connect-src 'none'"><link rel="stylesheet" href="./fixture-renderer.css"></head><body><div id="formula"></div><div id="scroller"><div id="preview"></div></div><script type="module" src="./fixture-renderer.js"></script></body></html>`)
  const worker = path.join(temporary, 'worker.cjs')
  await writeFile(worker, String.raw`
const {app,BrowserWindow,protocol}=require('electron')
let resultCode=0
protocol.registerSchemesAsPrivileged([{scheme:'mdasset',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}])
app.setPath('userData',process.argv[3])
app.on('will-quit',()=>{if(resultCode!==0)app.exit(resultCode)})
const finish=code=>{resultCode=code;for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit()}
app.whenReady().then(async()=>{
  const timer=setTimeout(()=>{console.error('Plugin DOM tests timed out');finish(1)},30000)
  const {TrustedLocalAssets,handleLocalAsset}=require(process.argv[4])
  const access=new TrustedLocalAssets()
  access.setLibraryRoot(require('node:path').dirname(process.argv[5]))
  await access.registerDocument(process.argv[5])
  protocol.handle('mdasset',request=>handleLocalAsset(request.url,access))
  const win=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
  win.webContents.on('console-message',(_event,_level,message)=>console.log(message))
  await win.loadFile(process.argv[2])
  const result=await win.webContents.executeJavaScript('(async()=>{while(!window.pluginDomTest)await new Promise(resolve=>setTimeout(resolve,20));return await window.pluginDomTest})()')
  clearTimeout(timer)
  console.log('PLUGIN_DOM_UI '+(result?.passed?'PASS ':'FAIL ')+JSON.stringify(result))
  finish(result?.passed?0:1)
}).catch(error=>{console.error(error);finish(1)})
`)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [worker, html, path.join(temporary, 'profile'), assetModule, documentFixture, '--disable-gpu'], { cwd: root, env: environment, stdio: 'inherit', timeout: 45000 })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
