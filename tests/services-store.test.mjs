// Main-process settings and secret workflow with a controlled OS encryption adapter.
// This verifies adapter usage / restart semantics; native OS vault availability is separate.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
const require = createRequire(import.meta.url), temp = await mkdtemp(path.join(tmpdir(), 'inkleaf-service-store-'))
const encryptionKey = randomBytes(32), handlers = new Map(), chunks = []
const frame = { url: 'app://local/index.html' }, event = { senderFrame: frame, sender: { id: 1, mainFrame: frame, once() {}, removeListener() {}, isDestroyed: () => false, send: (_, value) => chunks.push(value) } }
let available = true, encrypted = 0, decrypted = 0, auth
const api = {
  app: { isPackaged: true, getPath: () => temp },
  ipcMain: { handle: (id, fn) => handlers.set(id, fn) },
  safeStorage: {
    isEncryptionAvailable: () => available, getSelectedStorageBackend: () => available ? 'gnome_libsecret' : 'basic_text',
    encryptString(value) { encrypted++; const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce); return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]) },
    decryptString(value) { decrypted++; const cipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0,12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]).toString() },
  },
}
globalThis.__serviceTestElectron = api
const target = path.join(temp, 'host.cjs')
await build({ entryPoints:['src/main/services-host.ts'], outfile:target, bundle:true, platform:'node',format:'cjs',logLevel:'silent', plugins:[{name:'os-vault-adapter',setup(build){build.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'vault'}));build.onLoad({filter:/.*/,namespace:'vault'},()=>({contents:'module.exports = globalThis.__serviceTestElectron',loader:'js'}))}}] })
const restart = () => { delete require.cache[require.resolve(target)]; handlers.clear(); require(target).registerServiceIpc() }
const invoke = (name, arg, source = event) => handlers.get('services:' + name)(source, arg)
const settings = { plantumlUrl:'',provider:'compatible',endpoint:'https://example.com/v1',model:'test' }
const oldFetch = globalThis.fetch
try {
  restart(); await invoke('save',{...settings,key:'synthetic-secret',rememberKey:true})
  assert.equal(encrypted,1); const disk = await readFile(path.join(temp,'services.json'),'utf8');assert.ok(!disk.includes('synthetic-secret'));assert.ok(JSON.parse(disk).encryptedKey)
  assert.equal((await stat(path.join(temp,'services.json'))).mode & 0o777,0o600)
  restart();const state = await invoke('get');assert.equal(decrypted,1);assert.equal(state.hasKey,true);assert.equal(state.keyStorage,'encrypted');assert.ok(!JSON.stringify(state).includes('synthetic-secret'))
  globalThis.fetch = async (_url, options) => { auth=options.headers.Authorization; return new Response(JSON.stringify({choices:[{message:{content:'test output'}}]}),{headers:{'Content-Type':'application/json'}}) }
  assert.equal(await invoke('model',{id:'request-123',action:'explain',text:'selection'}),'test output');assert.equal(auth,'Bearer synthetic-secret')
  console.log('PASS encrypted settings use the vault, remain private, and survive restart')
  await writeFile(path.join(temp,'services.json'),JSON.stringify({...JSON.parse(disk),endpoint:'https://another.example/v1'}));restart();assert.equal((await invoke('get')).hasKey,false)
  console.log('PASS encrypted key is bound to the original provider and endpoint')
  available=false;await invoke('save',{...settings,key:'session-secret',rememberKey:true});assert.equal((await invoke('get')).keyStorage,'session');assert.ok(!(await readFile(path.join(temp,'services.json'),'utf8')).includes('session-secret'));restart();assert.equal((await invoke('get')).hasKey,false)
  console.log('PASS an unavailable secure vault uses session memory without plaintext fallback')
  await assert.rejects(()=>invoke('get',undefined,{...event,senderFrame:{url:'app://local/index.html'}}),/仅主窗口/)
  await assert.rejects(()=>invoke('get',undefined,{...event,senderFrame:event.sender.mainFrame={url:'https://evil.example'}}),/不可信/)
  console.log('PASS child frames and untrusted origins cannot invoke secret services')
} finally { globalThis.fetch=oldFetch;delete globalThis.__serviceTestElectron;await rm(temp,{recursive:true,force:true}) }
