// TDD — intelligence/0.2 I-D: advisory kind-affinity.
// A role may declare an UNSIGNED `affinity` (envelope field, like recommended_model) listing the
// document kinds it is tuned for. Activating / advising it on a mismatched PRODUCT_KIND WARNS but
// NEVER blocks (consistent with the spec §4 "affinity is a soft note"). Advisory only.
//
// New seed surface:
//   window.__rwaGetAffinity(envelope)  -> string[]   (normalized declared kinds)
//   window.__rwaAffinityWarning(role)  -> string|null (mismatch warning for the active doc kind)
import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { agentSigningMessage } from '../cli/src/skill-manifest.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

async function makeSignedAgent(role, opts) {
  const o = opts || {};
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const author_pubkey = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  const agent = { author_pubkey, description: role, role, system_prompt: 'Lens ' + role + '.', vault_namespace_set: [], version: 'rwa-agent/1' };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, agentSigningMessage(agent)));
  const env = { agent, signature: Buffer.from(sig).toString('base64') };
  if (o.affinity !== undefined) env.affinity = o.affinity; // unsigned advisory field
  return env;
}

// Boot a skill-host (PRODUCT_KIND === 'skill-host') so a role with affinity ['document'] mismatches.
async function boot() {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'T', fileMeta: 't.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, '<article><h1>Target</h1></article>\n');
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s); });
  const dom = new JSDOM(html, { url: 'https://t.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    } });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 5000) { if (w.runtime && w.runtime.agents && w.runtime.agents.install) break; await new Promise(r => setTimeout(r, 5)); }
  await new Promise(r => setTimeout(r, 150));
  return w;
}

console.log('== intelligence/0.2 I-D: advisory affinity ==');

{
  const w = await boot();
  const g = w.__rwaGetAffinity;
  check('A1: an array affinity is returned normalized', JSON.stringify(g({ affinity: ['document', 'presentation'] })) === JSON.stringify(['document', 'presentation']));
  check('A2: a string affinity is normalized to a single-element array', JSON.stringify(g({ affinity: 'document' })) === JSON.stringify(['document']));
  check('A3: no affinity → empty array', JSON.stringify(g({})) === JSON.stringify([]));
  check('A4: junk affinity → empty array', JSON.stringify(g({ affinity: 42 })) === JSON.stringify([]));

  await w.runtime.agents.install(await makeSignedAgent('proser', { affinity: ['document'] }));   // mismatch on skill-host
  await w.runtime.agents.install(await makeSignedAgent('hoster', { affinity: ['skill-host'] }));  // match
  await w.runtime.agents.install(await makeSignedAgent('anyrole', {}));                            // no affinity → no warning

  const wMis = w.__rwaAffinityWarning('proser');
  check('M1: a mismatched role yields a warning', typeof wMis === 'string' && wMis.length > 0);
  check('M2: the warning names the document kind and the role affinity', /skill-host/.test(wMis) && /document/.test(wMis));
  check('M3: a matching role yields no warning', w.__rwaAffinityWarning('hoster') === null);
  check('M4: a role with no affinity yields no warning', w.__rwaAffinityWarning('anyrole') === null);

  // Advisory ONLY — a mismatched role still activates (never blocked).
  let threw = false; try { w.runtime.agents.setActive('proser'); } catch (_) { threw = true; }
  check('B1: activating a mismatched role is NOT blocked', !threw && (w.runtime.agents.active() || {}).role === 'proser');
}

// Panel surfaces affinity in the role meta
{
  const w = await boot();
  await w.runtime.agents.install(await makeSignedAgent('proser', { affinity: ['document'] }));
  w.runtime.setMode('actions');
  await new Promise(r => setTimeout(r, 150));
  const panel = w.document.getElementById('rwa-mode-panel');
  check('P1: the panel shows the role’s affinity', !!panel && /document/.test(panel.textContent));
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
