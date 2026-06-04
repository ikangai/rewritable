// Increment 10 — v0.8 §12 MVP acceptance, the jsdom-runnable integration (the full trust
// model composing in ONE skill-host: a mixed signed/unsigned pair, update-with-perm-change,
// selective uninstall, reload round-trip). An acceptance/characterization test over behaviour
// already unit-TDD'd in skill-install/skill-persistence — it encodes the §12 SEQUENCE as intent.
//
// §12 steps 3 (Worker bridge allow/deny), 4 (bridgeless isolation / globals removed), and 7
// (vault null on a 2nd machine) require real Workers + a real reload and are BROWSER-PROVEN
// (chrome-devtools), not reproducible in jsdom (no Workers). The full 7-step run, recorded:
//   1 install word-count (unsigned compute) ✓   2 install gh-stars (signed tool) ✓
//   3 invoke gh-stars → api.github.com 200, evil.com permission_denied ✓ (browser)
//   4 invoke word-count bridgeless → {words:N} ✓ (browser; Invariant 18 isolation proven incr 6)
//   5 update gh-stars (+network:tracker.y) → same skillId, persisted new perms ✓
//   6 uninstall gh-stars → reload → gone, word-count survives ✓
//   7 2nd machine (no session key) → vault locked, secret null; signed skill re-verifies ✓ (browser)
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

async function newKey() {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  return { kp, pub };
}
async function sign(key, name, kind, permissions, code, version = '1.0.0') {
  const manifest = { name, version, kind, permissions, author_pubkey: key.pub };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, key.kp.privateKey, signingMessage(manifest, code)));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };
}
const unsigned = (name, kind, permissions, code) => ({ format: 'rwa-skill/1', skill: { name, version: '1.0.0', kind, permissions, author_pubkey: 'AAAA', code } });

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
const permsOf = (doc, name) => {
  for (const m of doc.matchAll(/application\/rwa-skill\+json">([^<]+)<\/script>/g)) {
    try { const e = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); if (e.skill.name === name) return e.skill.permissions; } catch (_) {}
  }
  return null;
};

console.log('== increment 10: §12 MVP acceptance (jsdom integration) ==');
const ghKey = await newKey();

// Steps 1-2: install an unsigned compute + a signed tool into one host
const w1 = await boot(HOST);
const r1 = await w1.runtime.installSkill(unsigned('word-count', 'compute', [], 'async function run(i){return {words:(i.text||"").split(/\\s+/).filter(Boolean).length}}'));
const r2 = await w1.runtime.installSkill(await sign(ghKey, 'gh-stars', 'tool', ['network:api.github.com'], 'async function run(i,r){return 1}'));
check('§12.1 unsigned compute installs (verified:false)', r1.ok && w1.runtime.listSkills().find(s => s.name === 'word-count').verified === false);
check('§12.2 signed tool installs (verified:true, signature verifies)', r2.ok && w1.runtime.listSkills().find(s => s.name === 'gh-stars').verified === true);

// Step 5: update gh-stars (+network:tracker.y) with the SAME key → same skillId, persisted new perms
const r5 = await w1.runtime.installSkill(await sign(ghKey, 'gh-stars', 'tool', ['network:api.github.com', 'network:tracker.y'], 'async function run(i,r){return 1}', '2.0.0'));
check('§12.5 update keeps the same skillId (a true update, not a 2nd skill)', r5.ok && r5.skillId === r2.skillId);
check('§12.5 the persisted envelope carries the updated permission set', JSON.stringify(permsOf(await w1.getDoc(), 'gh-stars')) === JSON.stringify(['network:api.github.com', 'network:tracker.y']));
check('§12.5 still exactly two installed skills after update', w1.runtime.listSkills().length === 2);

// Step 6: uninstall gh-stars → persisted → reload → gone, the compute survives + re-verifies
const r6 = await w1.runtime.uninstallSkill(r2.skillId);
check('§12.6 uninstall ok', r6.ok);
const w2 = await boot(await w1.getDoc());
const after = w2.runtime.listSkills().map(s => s.name);
check('§12.6 after uninstall + RELOAD: gh-stars gone, word-count survives', !after.includes('gh-stars') && after.includes('word-count'));

console.log(`\n== ${pass} pass, ${fail} fail ==`);
console.log('(§12.3 bridge allow/deny, §12.4 bridgeless isolation, §12.7 vault-null-on-2nd-machine: browser-proven — see commit)');
process.exit(fail ? 1 : 0);
