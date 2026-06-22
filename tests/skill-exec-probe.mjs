// Browser-execution proof for the v0.8 skill layer — the §12 steps that jsdom
// CANNOT run because it has no Web Workers: §12.4 (compute runs in an isolated
// Worker, globals removed / Invariant 18), §12.3 (the main-thread fetch bridge
// gates by declared origin: permission_denied BEFORE any network on an
// undeclared origin), and §12.6/§12.7's vault path (set/get through the
// bridge in a real Worker, and locked → null with no session key).
//
// This is the GENERATOR, the durable in-repo artifact (it builds from the LIVE
// seed so it can never drift). It emits a real skill-host container with an
// appended driver <script> that runs the sequence and writes a verdict to
// window.__mvp + document.title. Open the emitted file in Chromium (or drive it
// with the chrome-devtools MCP) and read window.__mvp. Companion to
// tests/csp-7b-probe.html (the durable CSP-wall proof) and tests/skill-mvp.mjs
// (the jsdom half: install/persist/uninstall/reload).
//
//   node tests/skill-exec-probe.mjs            # → prints the file:// URL to open
//   node tests/skill-exec-probe.mjs --out p    # → write the container to path p
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { signingMessage } from '../cli/src/skill-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const b64 = (u8) => Buffer.from(u8).toString('base64');

// ── skill bodies (kept tiny + literal; they encode the property under test) ──
const COMPUTE_CODE =
  'async function run(input){' +
  'var caps={fetch:typeof fetch,eval:typeof eval,Function:typeof Function,' +
  'importScripts:typeof importScripts,WebAssembly:typeof WebAssembly,' +
  'indexedDB:typeof indexedDB,Worker:typeof Worker,XMLHttpRequest:typeof XMLHttpRequest};' +
  'var n=((input&&input.text)||"").split(/\\s+/).filter(Boolean).length;' +
  'return {words:n,caps:caps};}';

const NETPROBE_CODE =
  'async function run(input,r){var res={};' +
  'try{await r.fetch("https://evil.example/x");res.denied="REACHED";}catch(e){res.denied=String(e.message);}' +
  'try{var g=await r.fetch("https://api.github.com/");res.allowed="status:"+g.status;}catch(e){res.allowed=String(e.message);}' +
  'return res;}';

const VAULT_CODE =
  'async function run(input,r){' +
  'if(input&&input.op==="set"){await r.vault.set("secrets","token",input.val);return {set:true};}' +
  'if(input&&input.op==="get"){return {token:await r.vault.get("secrets","token")};}' +
  'return {noop:true};}';

async function newKey() {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = b64(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
  return { kp, pub };
}
async function signEnvelope(key, name, kind, permissions, code, version = '1.0.0') {
  const manifest = { name, version, kind, permissions, author_pubkey: key.pub };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, key.kp.privateKey, signingMessage(manifest, code)));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: b64(sig) };
}
const unsigned = (name, kind, permissions, code) =>
  ({ format: 'rwa-skill/1', skill: { name, version: '1.0.0', kind, permissions, author_pubkey: 'AAAA', code } });

const key = await newKey();
const COMPUTE_ENV = unsigned('word-count', 'compute', [], COMPUTE_CODE);
const NETPROBE_ENV = await signEnvelope(key, 'net-probe', 'tool', ['network:api.github.com'], NETPROBE_CODE);
const VAULT_ENV = await signEnvelope(key, 'vault-keeper', 'tool', ['vault:secrets'], VAULT_CODE);

// ── driver: runs after the runtime boots, writes a verdict to window.__mvp ──
const driver = `
<pre id="mvp" style="position:fixed;top:8px;right:8px;max-width:46ch;max-height:90vh;overflow:auto;background:#111;color:#0f0;font:11px/1.4 monospace;padding:10px;border-radius:8px;z-index:99999;white-space:pre-wrap;"></pre>
<script>
(async function(){
  var COMPUTE_ENV=${JSON.stringify(COMPUTE_ENV)};
  var NETPROBE_ENV=${JSON.stringify(NETPROBE_ENV)};
  var VAULT_ENV=${JSON.stringify(VAULT_ENV)};
  var el=document.getElementById('mvp');
  var log=function(m){ if(el) el.textContent+=m+'\\n'; };
  var checks=[]; var ck=function(name,cond,detail){ checks.push({name:name,pass:!!cond,detail:detail||''}); log((cond?'OK   ':'FAIL ')+name+(detail!==undefined?'  ['+detail+']':'')); };
  function ready(){ return window.runtime && window.runtime.installSkill && window.runtime.invokeSkill && window.runtime.listSkills && window.runtime.vault; }
  var t0=Date.now(); while(!ready()){ if(Date.now()-t0>8000){ window.__mvp={fatal:'runtime never ready'}; log('FATAL runtime never ready'); document.title='MVP FATAL'; return; } await new Promise(function(r){setTimeout(r,20);}); }
  var R=window.runtime, out={};
  function nameVerified(n){ var s=R.listSkills().find(function(s){return s.name===n;}); return s && s.verified; }
  try {
    var wc=await R.installSkill(COMPUTE_ENV);  ck('install word-count (compute, verified:false)', wc.ok && nameVerified('word-count')===false);
    var np=await R.installSkill(NETPROBE_ENV); ck('install net-probe (tool, signed → verified:true)', np.ok && nameVerified('net-probe')===true);
    var vk=await R.installSkill(VAULT_ENV);    ck('install vault-keeper (tool, signed → verified:true)', vk.ok && nameVerified('vault-keeper')===true);

    // §12.4 — compute executes in a real Worker, globals removed
    var c=await R.invokeSkill(wc.skillId,{text:'one two three four'}); out.compute=c;
    ck('§12.4 compute runs IN A WORKER → words:4', c && c.words===4, JSON.stringify(c&&c.words));
    var caps=(c&&c.caps)||{};
    var GONE=['fetch','eval','Function','importScripts','WebAssembly','indexedDB','Worker','XMLHttpRequest'];
    ck('§12.4 isolation (Inv 18): '+GONE.join('/')+' all undefined in-Worker', GONE.every(function(k){return caps[k]==='undefined';}), JSON.stringify(caps));

    // §12.3 — main-thread fetch bridge gates by declared origin
    var nr=await R.invokeSkill(np.skillId,{}); out.netprobe=nr;
    ck('§12.3 bridge DENIES undeclared origin (evil.example → permission_denied, no network)', nr && nr.denied==='permission_denied', JSON.stringify(nr&&nr.denied));
    ck('§12.3 bridge ALLOWS declared origin past the gate (api.github.com ≠ permission_denied)', nr && nr.allowed && nr.allowed!=='permission_denied', JSON.stringify(nr&&nr.allowed));

    // §6/§12.7 — vault set/get through the bridge in a real Worker, then locked→null
    await R.vault.unlock('probe-pass');
    var vs=await R.invokeSkill(vk.skillId,{op:'set',val:'sk-SECRET-123'}); ck('§6 vault SET via bridge (declared ns)', vs && vs.set===true, JSON.stringify(vs));
    var vg=await R.invokeSkill(vk.skillId,{op:'get'}); out.vaultGet=vg; ck('§6 vault GET via bridge returns the secret', vg && vg.token==='sk-SECRET-123', JSON.stringify(vg));
    R.vault.lock(); // simulate a 2nd machine: no session key
    var vg2=await R.invokeSkill(vk.skillId,{op:'get'}); out.vaultLocked=vg2;
    ck('§12.7 locked (no session key) → secret is null, never throws', vg2 && vg2.token===null, JSON.stringify(vg2));
  } catch(e){ ck('no uncaught error during the run', false, String((e&&e.message)||e)); out.error=String((e&&e.message)||e); }
  var passN=checks.filter(function(c){return c.pass;}).length, failN=checks.length-passN;
  window.__mvp={ pass:passN, fail:failN, checks:checks, out:out };
  log('\\n== '+passN+' pass, '+failN+' fail ==');
  document.title = failN ? ('MVP FAIL '+failN) : 'MVP GREEN '+passN;
})();
<\/script>
`;

const ov = kindOverrides('skill-host');
let html = fs.readFileSync(SEED, 'utf8');
html = applySeedSubs(html, {
  uuid: webcrypto.randomUUID(), title: 'skill-exec-probe', fileMeta: 'skill-exec-probe.html',
  productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
  productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
});
html = replaceInlineDoc(html, ov.body);
const i = html.lastIndexOf('</body>');
html = i === -1 ? html + driver : html.slice(0, i) + driver + html.slice(i);

const outArg = process.argv.indexOf('--out');
const outPath = outArg !== -1 ? process.argv[outArg + 1]
  : path.join(os.tmpdir(), 'rwa-skill-exec-probe.html');
fs.writeFileSync(outPath, html);
console.log('wrote ' + outPath + ' (' + html.length + ' bytes)');
console.log('open: file://' + outPath);
