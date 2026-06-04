// TDD — increment 9: the install dialog's LOGIC (v0.8 §1). runtime.reviewSkill (the structured
// trust info the dialog renders) + runtime.installSkill (validate-gates + Ed25519 verify + register
// in-memory). The dialog DOM + the visual layout are browser-verified separately (jsdom has no
// layout). Signs with the CLI signingMessage so seed-live verify == CLI-static.
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
const unsigned = (name, kind, permissions, code) => ({ format: 'rwa-skill/1', skill: { name, version: '1.0.0', kind, permissions, author_pubkey: 'AAAA', code } });

async function boot() {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'H', fileMeta: 'h.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, ov.body);
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
  while (Date.now() - t0 < 4000) { if (w.runtime && w.runtime.installSkill) break; await new Promise(r => setTimeout(r, 5)); }
  return w;
}

console.log('== increment 9: install dialog logic ==');
const w = await boot();
check('runtime exposes reviewSkill + installSkill', typeof w.runtime?.reviewSkill === 'function' && typeof w.runtime?.installSkill === 'function');

// reviewSkill: a signed tool with vault + network → prose, compound-risk, signed/verified, gates ok
{
  const env = await makeSigned('gh-sync', 'tool', ['vault:github', 'network:api.github.com'], 'async function run(i,r){return 1}');
  const rv = await w.runtime.reviewSkill(env);
  check('review: permissions rendered as prose', rv.permissions.length === 2 && /credentials stored under/i.test(rv.permissions.find(p => p.perm.startsWith('vault')).prose));
  check('review: compound-risk fires on vault+network', typeof rv.compoundRisk === 'string' && /credential/i.test(rv.compoundRisk));
  check('review: signed tool verifies', rv.signed === true && rv.verified === true);
  check('review: a signed tool with valid perms passes the gates', rv.gates.ok === true);
}
// reviewSkill: an unsigned compute with permissions → both gate failures
{
  const rv = await w.runtime.reviewSkill(unsigned('bad', 'compute', ['network:x.com'], 'async function run(){}'));
  check('review: unsigned+compute+perms fails gates with the right codes', rv.gates.ok === false && rv.gates.errors.includes('unsigned_with_permissions') && rv.gates.errors.includes('compute_with_permissions'));
  check('review: unsigned → verified false', rv.verified === false);
}
// installSkill: a valid signed no-perm compute → registered in-memory (describe/listSkills see it)
{
  const env = await makeSigned('counter', 'compute', [], 'async function run(i){return i.length}');
  const res = await w.runtime.installSkill(env);
  check('install: valid skill returns ok + skillId', res.ok === true && typeof res.skillId === 'string');
  check('install: the skill is now in listSkills()', w.runtime.listSkills().some(s => s.name === 'counter'));
  check('install: describe() unions the just-installed skill', w.runtime.describe().affordances.some(a => a.name === 'counter' && a.provenance === 'installed'));
}
// installSkill: a gate-failing skill is refused (no register)
{
  const res = await w.runtime.installSkill(unsigned('nope', 'tool', ['network:x.com'], 'async function run(){}'));
  check('install: gate-failing skill refused with errors', res.ok === false && Array.isArray(res.errors) && res.errors.length > 0);
  check('install: refused skill is NOT registered', !w.runtime.listSkills().some(s => s.name === 'nope'));
}
// lookalike: install A (key1); review A' (distance 1, key2) → lookalike warning naming A
{
  const a = await makeSigned('github-helper', 'compute', [], 'async function run(){}');
  await w.runtime.installSkill(a);
  const aprime = await makeSigned('github-helpr', 'compute', [], 'async function run(){}'); // distance 1, different key
  const rv = await w.runtime.reviewSkill(aprime);
  check('review: a lookalike name from a different key is flagged', rv.lookalike === 'github-helper');
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
