// TDD — increment 5: the seed-side skill registry + describe union (v0.8 §5/§8).
// Boots a skill-host container with installed skills in the frozen #rwa-skills zone
// and asserts runtime.describe()/listSkills() report them live, verified via WebCrypto
// Ed25519. Signs with the CLI's signingMessage so this also pins seed-live == CLI-static
// (the seed must compute the same canonicalManifest/signingMessage/skillId).
import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { signingMessage, skillId as cliSkillId } from '../cli/src/skill-manifest.mjs';
import { validateSelfDescription } from '../tools/self-description.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (msg, cond) => { if (cond) { pass++; console.log('  OK  ' + msg); } else { fail++; console.log('  ✗   ' + msg); } };

async function makeSigned(name, kind, permissions, code) {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const author_pubkey = Buffer.from(rawPub).toString('base64');
  const manifest = { name, version: '1.0.0', kind, permissions, author_pubkey };
  const msg = signingMessage(manifest, code); // CLI logic — seed must match to verify
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, msg));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };
}
const scriptBlock = (env) => `<script type="application/rwa-skill+json">${Buffer.from(JSON.stringify(env)).toString('base64')}</script>`;
const hostBody = (blocks) => `<article><h1>Skill Host</h1></article>\n<div data-rwa-frozen id="rwa-skills">${blocks.join('')}</div>`;

async function boot(body) {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid: webcrypto.randomUUID(), title: 'Skill Host', fileMeta: 'host.html',
    productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', e?.detail?.stack || e?.detail || e); });
  const dom = new JSDOM(html, {
    url: 'https://rwa-test.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.fetch = async () => { throw new Error('no network'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      // Node WebCrypto (Ed25519 + digest + getRandomValues + randomUUID) — jsdom's subtle lacks Ed25519.
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder; // jsdom lacks these

    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) { if (window.runtime && typeof window.runtime.describe === 'function') break; await new Promise(r => setTimeout(r, 5)); }
  return window;
}

console.log('== increment 5: seed skill registry + describe union ==');

// 1. signed compute skill → reported verified, with the CLI-matching skillId
{
  const env = await makeSigned('word-count', 'compute', [], 'async function run(i){return i.length}');
  const w = await boot(hostBody([scriptBlock(env)]));
  check('runtime exposes listSkills()', typeof w.runtime?.listSkills === 'function');
  const skills = w.runtime.listSkills();
  check('listSkills() returns the one installed skill', Array.isArray(skills) && skills.length === 1 && skills[0].name === 'word-count');
  const d = w.runtime.describe();
  const inst = d.affordances.find(a => a.provenance === 'installed');
  check('describe() unions the installed compute skill', !!inst && inst.kind === 'compute' && inst.name === 'word-count');
  check('installed skill is verified:true (WebCrypto Ed25519 over the CLI signing message)', inst && inst.verified === true);
  const expectedId = cliSkillId('word-count', env.skill.author_pubkey);
  check('seed skillId == CLI skillId (4-site consistency)', inst && inst.skillId === expectedId);
  check('describe() still validates as source:live', validateSelfDescription(d).valid === true && d.source === 'live');
  check('kind is skill-host', d.kind === 'skill-host');
}

// 2. signed tool skill → kind tool, verified; provide('tool', ...) accepted
{
  const env = await makeSigned('gh-stars', 'tool', ['network:api.github.com'], 'async function run(i,r){return r.fetch("https://api.github.com")}');
  const w = await boot(hostBody([scriptBlock(env)]));
  const inst = w.runtime.describe().affordances.find(a => a.provenance === 'installed');
  check('installed tool reported kind:tool, verified', inst && inst.kind === 'tool' && inst.verified === true);
  let threw = false;
  try { w.runtime.provide('tool', { kind: 'tool', name: 'x', label: 'X' }); } catch (_) { threw = true; }
  check("runtime.provide('tool', …) is accepted (no throw)", threw === false);
}

// 3. unsigned compute → verified:false
{
  const env = { format: 'rwa-skill/1', skill: { name: 'wc2', version: '1.0.0', kind: 'compute', permissions: [], author_pubkey: 'AAAA', code: 'async function run(){}' } };
  const w = await boot(hostBody([scriptBlock(env)]));
  const inst = w.runtime.describe().affordances.find(a => a.provenance === 'installed');
  check('unsigned skill is reported verified:false', inst && inst.name === 'wc2' && inst.verified === false);
}

// 4. empty zone (default skill-host) → no installed affordances
{
  const w = await boot(kindOverrides('skill-host').body);
  const d = w.runtime.describe();
  check('empty #rwa-skills zone → no installed affordances', d.affordances.filter(a => a.provenance === 'installed').length === 0);
  check('listSkills() empty on a fresh skill-host', w.runtime.listSkills().length === 0);
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
