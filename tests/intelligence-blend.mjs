// TDD — intelligence/0.2 I-E: blended overlays (primary + advisory).
// Design: docs/plans/2026-06-27-intelligence-blended-overlays-design.md.
// The single activeAgentRole stays the PRIMARY (framing/actor/vault unchanged); a new in-memory
// advisorRoles set contributes advisory PROSE to resolveSystemPrompt() — never capabilities.
// Vault stays primary-only by construction (the vault gate reads the active record, never advisors).
//
// New seed surface:
//   runtime.agents.addAdvisor(role) / removeAdvisor(role) / advisors()
//   window.__rwaResolveSystemPrompt()  -> the assembled modify() system prompt
//   window.__rwaGetActiveActor()       -> the commit actor string
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
const threw = async (fn, code) => { try { await fn(); return false; } catch (e) { return !code || (e && (e.code === code || e.message === code)); } };

const article = '<article><h1>Target</h1></article>\n';

async function makeSignedAgent(role, opts) {
  const o = opts || {};
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const author_pubkey = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  const agent = { author_pubkey, description: role, role, system_prompt: o.prompt || ('Lens ' + role + '.'), vault_namespace_set: o.vault || [], version: 'rwa-agent/1' };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, agentSigningMessage(agent)));
  const env = { agent, signature: Buffer.from(sig).toString('base64') };
  if (o.tamper) env.signature = (env.signature[0] === 'A' ? 'B' : 'A') + env.signature.slice(1); // corrupt → verified:false
  return env;
}

async function boot(body) {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'T', fileMeta: 't.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, body);
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

console.log('== intelligence/0.2 I-E: blended overlays ==');

{
  const w = await boot(article);
  const ag = w.runtime.agents;
  check('API: addAdvisor/removeAdvisor/advisors exist', typeof ag.addAdvisor === 'function' && typeof ag.removeAdvisor === 'function' && typeof ag.advisors === 'function');
  for (const r of ['concise', 'legal', 'b', 'c', 'd']) await ag.install(await makeSignedAgent(r, { prompt: r + ' lens.', vault: r === 'legal' ? ['vault:secrets'] : [] }));
  await ag.install(await makeSignedAgent('bad', { tamper: true }));

  ag.setActive('concise');
  const baseline = w.__rwaResolveSystemPrompt(); // single-role prompt, before any advisor
  check('B0: single-role prompt has no advisory block', !/advisory lenses/i.test(baseline));

  ag.addAdvisor('legal');
  const sp = w.__rwaResolveSystemPrompt();
  check('A1: assembled prompt keeps the primary framing', /concise lens\./.test(sp));
  check('A2: it adds an advisory block labelled secondary', /advisory lenses \(secondary/i.test(sp));
  check('A3: the advisor prose is present, attributed to its role', /legal: legal lens\./.test(sp));
  check('A4: the shared tool RULES are still present', /apply_edits/.test(sp));

  // Security: the advisor declared a vault namespace; the vault-bearing identity stays the primary.
  check('S1: active role is still the primary (not the advisor)', (ag.active() || {}).role === 'concise');
  check('S2: actor attributes to the primary only', w.__rwaGetActiveActor() === 'agents:concise');
  check('S3: advisors() lists the advisor separately', JSON.stringify(ag.advisors()) === JSON.stringify(['legal']));

  // Cap (3) + verified-only + not-found + primary-xor-advisor (unverified/not-found beat the cap)
  ag.addAdvisor('b'); ag.addAdvisor('c');
  check('C1: three advisors accepted', ag.advisors().length === 3);
  check('C2: the 4th advisor is rejected (cap)', await threw(() => ag.addAdvisor('d'), 'advisor_cap_reached'));
  check('C3: an unverified role cannot be an advisor', await threw(() => ag.addAdvisor('bad'), 'unverified_agent'));
  check('C4: a non-installed role throws', await threw(() => ag.addAdvisor('ghost'), 'agent_not_found'));
  ag.addAdvisor('concise'); // the primary — no-op
  check('C5: the primary is never also an advisor', !ag.advisors().includes('concise'));

  // Empty advisors -> byte-identical single-role prompt
  ag.removeAdvisor('legal'); ag.removeAdvisor('b'); ag.removeAdvisor('c');
  check('E1: empty advisor set → prompt byte-identical to single-role baseline', w.__rwaResolveSystemPrompt() === baseline);

  // Deactivating the primary keeps advisors, layered on the default framing
  ag.addAdvisor('legal');
  ag.setActive(null);
  check('E2: with no primary, advisors still layer (block present, actor not an agent)', /advisory lenses/i.test(w.__rwaResolveSystemPrompt()) && w.__rwaGetActiveActor().indexOf('agents:') !== 0);
}

// Panel — Intelligences section shows primary/advisor controls
{
  const w = await boot(article);
  await w.runtime.agents.install(await makeSignedAgent('concise', { prompt: 'Be concise.' }));
  await w.runtime.agents.install(await makeSignedAgent('legal', { prompt: 'Legal tone.' }));
  w.runtime.agents.setActive('concise');
  w.runtime.agents.addAdvisor('legal');
  w.runtime.setMode('actions');
  await new Promise(r => setTimeout(r, 150));
  const panel = w.document.getElementById('rwa-mode-panel');
  check('P1: panel lists both roles under Intelligences', !!panel && /Intelligences/.test(panel.textContent) && /concise/.test(panel.textContent) && /legal/.test(panel.textContent));
  check('P2: a Deactivate (primary) and a remove-advisor control are present', !!panel && /Deactivate/.test(panel.textContent) && !!panel.querySelector('[data-agent-advoff]'));
  check('P3: a not-yet-used verified role would offer Add advisor', !!panel && /advisor/i.test(panel.textContent));
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
