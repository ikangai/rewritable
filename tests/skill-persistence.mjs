// TDD — increment 7: skill persistence (v0.8 §7). runtimeInstallSkill / uninstallSkill
// write the frozen #rwa-skills zone via dirac's runtimeRegionCommit (reachability:'frozen')
// so an install lands in currentDoc/IDB immediately and SURVIVES RELOAD + travels in the
// exported file. The acceptance test boots a SECOND container from the committed doc and
// finds the skill — the real "durable across reload" contract, not just an in-memory set.
import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { signingMessage } from '../cli/src/skill-manifest.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

async function makeSigned(name, kind, permissions, code) {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const author_pubkey = Buffer.from(rawPub).toString('base64');
  const manifest = { name, version: '1.0.0', kind, permissions, author_pubkey };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, signingMessage(manifest, code)));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };
}

// Each boot is a SEPARATE container (own UUID/IDB) so "reload" = boot a new one from a doc.
async function boot(body) {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'H', fileMeta: 'h.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s); });
  const dom = new JSDOM(html, { url: 'https://h.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    } });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 4000) { if (w.runtime && w.runtime.installSkill && w.getDoc) break; await new Promise(r => setTimeout(r, 5)); }
  return w;
}
const HOST = kindOverrides('skill-host').body;
const zoneOf = (doc) => { const m = /<div\b[^>]*\bid="rwa-skills"[^>]*>([\s\S]*?)<\/div>/i.exec(doc); return m ? m[1] : null; };

console.log('== increment 7: skill persistence (durable across reload) ==');

// install → persisted to the committed doc's frozen zone
const w1 = await boot(HOST);
const env = await makeSigned('counter', 'compute', [], 'async function run(i){return i.length}');
const res = await w1.runtime.installSkill(env);
check('install returns ok + skillId', res.ok === true && typeof res.skillId === 'string');
const doc1 = await w1.getDoc();
check('committed doc now carries a rwa-skill+json block inside #rwa-skills', /id="rwa-skills"[\s\S]*?application\/rwa-skill\+json[\s\S]*?<\/script>[\s\S]*?<\/div>/.test(doc1));
check('the #rwa-skills zone is STILL data-rwa-frozen after the write', /<div\b[^>]*data-rwa-frozen[^>]*id="rwa-skills"|<div\b[^>]*id="rwa-skills"[^>]*data-rwa-frozen/.test(doc1));

// THE ACCEPTANCE: a fresh container booted from the committed doc finds the skill verified
const w2 = await boot(doc1);
check('skill SURVIVES RELOAD — present + verified after booting from the committed doc', w2.runtime.listSkills().some(s => s.name === 'counter' && s.verified === true));

// uninstall → gone, persisted, and gone after reload
const res2 = await w2.runtime.uninstallSkill(res.skillId);
check('uninstall returns ok', res2.ok === true);
check('uninstall of an unknown id → ok:false', (await w2.runtime.uninstallSkill('nope')).ok === false);
const doc2 = await w2.getDoc();
check('committed doc #rwa-skills zone has no skill block after uninstall', !/application\/rwa-skill\+json/.test(zoneOf(doc2) || ''));
check('emptied zone is STILL data-rwa-frozen', /<div\b[^>]*data-rwa-frozen[^>]*id="rwa-skills"|<div\b[^>]*id="rwa-skills"[^>]*data-rwa-frozen/.test(doc2));
const w3 = await boot(doc2);
check('skill GONE after uninstall + reload', !w3.runtime.listSkills().some(s => s.name === 'counter'));

// determinism: same skill SET installed in opposite orders → byte-identical zone (canonical sort)
const a = await makeSigned('alpha', 'compute', [], 'async function run(){return 1}');
const b = await makeSigned('bravo', 'compute', [], 'async function run(){return 2}');
const wa = await boot(HOST); await wa.runtime.installSkill(a); await wa.runtime.installSkill(b);
const wb = await boot(HOST); await wb.runtime.installSkill(b); await wb.runtime.installSkill(a);
check('zone bytes are install-order-independent (canonical by skillId)', zoneOf(await wa.getDoc()) === zoneOf(await wb.getDoc()) && /rwa-skill\+json/.test(zoneOf(await wa.getDoc())));

// one undo step: ⌘Z (popUndo) after install restores the prior (empty) zone
const w4 = await boot(HOST);
const before = zoneOf(await w4.getDoc());
await w4.runtime.installSkill(await makeSigned('undome', 'compute', [], 'async function run(){return 9}'));
check('install changed the zone', zoneOf(await w4.getDoc()) !== before);
await w4.undo();
check('a single ⌘Z restores the pre-install zone (one undo step)', zoneOf(await w4.getDoc()) === before);

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
