// TDD — intelligence chip, Inc 1: the advisory-only chip-edit contract
// (docs/plans/2026-07-06-intelligence-chip-datasheet-card-design.md §3).
//
// WHY this matters (not just what): a signed rwa-agent/1's personality (role, description,
// system_prompt, vault_namespace_set) is INSIDE the Ed25519 signature. Editing any of them
// invalidates the signature. So "edit the chip with a prompt" must be ADVISORY-ONLY: only the
// unsigned fields (recommended_model / recommended_backend — the fields I-A already applies to
// sessionStorage) may change from a prompt; every personality/role/vault ask is DECLINED and
// redirected to the Maker (re-author under your own key). The load-bearing invariant this test
// guards: NO prompt can make the chip write a signed field. If that ever regresses, an attacker
// could take a signed role that reaches no vault and "edit" it to reach one, then run it.
//
// Surface under test (seed): window.__rwaClassifyChipEdit / window.__rwaApplyChipEdit.
// Run: node tests/chip-edit.mjs
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
const seed = fs.readFileSync(path.join(__dirname, '..', 'seeds', 'rewritable.html'), 'utf8');

let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL', m); } };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

async function boot({ kind = 'document', body = '<article><h1>T</h1><p data-rwa-id="p1">Hello</p></article>\n' } = {}) {
  const ov = kindOverrides(kind);
  let html = applySeedSubs(seed, {
    uuid: webcrypto.randomUUID(), title: 'T', fileMeta: 't.html', productKind: kind,
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s); });
  const dom = new JSDOM(html, {
    url: 'https://rwa-chipedit-' + webcrypto.randomUUID() + '.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network in chip-edit test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    },
  });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 5000) { if (w.runtime && w.runtime.agents) break; await new Promise(r => setTimeout(r, 5)); }
  await tick(60);
  return w;
}

// A signed rwa-agent/1 envelope (same helper as tests/ai-chip.mjs) — so the edit UI can be tested
// against a real active, verified role.
async function makeSignedAgent(role, opts) {
  const o = opts || {};
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const author_pubkey = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  const agent = { author_pubkey, description: o.description || (role + ' description'), role, system_prompt: o.prompt || ('Lens ' + role + '.'), vault_namespace_set: [], version: 'rwa-agent/1' };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, agentSigningMessage(agent)));
  return { agent, signature: Buffer.from(sig).toString('base64') };
}

console.log('== chip advisory-only edit contract (Inc 1) ==');

const GEMINI = 'google/gemini-3.5-flash';
const SONNET = 'anthropic/claude-sonnet-4-6';

// E1 — advisory apply paths: model + backend ride OUTSIDE the signature, so they're editable.
{
  const w = await boot();
  const cls = w.__rwaClassifyChipEdit;
  check('E1: classifier hook is exposed', typeof cls === 'function');

  const c1 = cls && cls('use gemini');
  check("E1: 'use gemini' → apply model (alias resolves to a full id)", !!c1 && c1.action === 'apply' && c1.field === 'model' && c1.value === GEMINI);

  const c2 = cls && cls('use ' + SONNET);
  check("E1: a full model id applies verbatim", !!c2 && c2.action === 'apply' && c2.field === 'model' && c2.value === SONNET);

  const c3 = cls && cls('switch to ollama');
  check("E1: 'switch to ollama' → apply backend", !!c3 && c3.action === 'apply' && c3.field === 'backend' && c3.value === 'ollama');

  const c4 = cls && cls('run on openrouter');
  check("E1: 'run on openrouter' → apply backend", !!c4 && c4.action === 'apply' && c4.field === 'backend' && c4.value === 'openrouter');
}

// E2 — decline paths: personality/role/vault (signed) + gibberish (unknown) never apply; all
// redirect to the Maker.
{
  const w = await boot();
  const cls = w.__rwaClassifyChipEdit;

  const d1 = cls && cls('make it gentler');
  check("E2: 'make it gentler' → decline (not apply)", !!d1 && d1.action === 'decline');
  check("E2: a personality decline redirects to the Maker", !!d1 && d1.redirect === 'maker');

  const d2 = cls && cls('rename it to summarizer');
  check("E2: 'rename it…' → decline (role is signed)", !!d2 && d2.action === 'decline' && d2.field === 'role');

  const d3 = cls && cls('give it access to my notion vault');
  check("E2: a vault-reach ask → decline (vault is signed)", !!d3 && d3.action === 'decline' && d3.field === 'vault');

  const d4 = cls && cls('always answer in French');
  check("E2: a behavioural directive → decline (system_prompt)", !!d4 && d4.action === 'decline');

  const d5 = cls && cls('qwerty zxcv nonsense');
  check("E2: an unrecognized instruction → decline (unrecognized)", !!d5 && d5.action === 'decline' && d5.reason === 'unrecognized');
}

// E3 — SAFETY invariant: no personality/role/vault/description instruction may EVER classify as
// 'apply'. This is the whole point of advisory-only editing.
{
  const w = await boot();
  const cls = w.__rwaClassifyChipEdit;
  const signedAttempts = [
    'make it warmer', 'be more formal', 'rewrite your instructions', 'change its personality',
    'set the system prompt to hello', 'you are now a pirate', 'rename the role', 'call it bob',
    'change the description', 'give it my api key', 'let it read vault:notion', 'grant credential access',
    'never use hedging', 'tell it to translate to german', 'stop being concise',
  ];
  let leaks = 0;
  for (const a of signedAttempts) { const c = cls && cls(a); if (!c || c.action === 'apply') leaks++; }
  check('E3: NO signed-field instruction classifies as apply (0 leaks)', leaks === 0);
}

// E4 — apply side effects: advisory writes hit sessionStorage; a decline writes NOTHING and never
// touches the API key or the signed record.
{
  const w = await boot();
  const apply = w.__rwaApplyChipEdit;
  check('E4: apply hook is exposed', typeof apply === 'function');

  const r1 = apply && apply('use gemini');
  check("E4: applyChipEdit('use gemini') writes sessionStorage model", w.sessionStorage.getItem('rwa_model') === GEMINI);
  check('E4: apply returns the applied model', !!r1 && r1.action === 'apply' && r1.applied && r1.applied.model === GEMINI);

  apply && apply('switch to lmstudio');
  check("E4: applyChipEdit('switch to lmstudio') writes sessionStorage backend", w.sessionStorage.getItem('rwa_backend') === 'lmstudio');

  // a decline must not change model/backend and must never set the API key
  const modelBefore = w.sessionStorage.getItem('rwa_model');
  const backendBefore = w.sessionStorage.getItem('rwa_backend');
  const r2 = apply && apply('make it gentler and give it my notion key');
  check('E4: a declined edit does not change model', w.sessionStorage.getItem('rwa_model') === modelBefore);
  check('E4: a declined edit does not change backend', w.sessionStorage.getItem('rwa_backend') === backendBefore);
  check('E4: no chip edit ever sets the API key', w.sessionStorage.getItem('rwa_apikey') == null);
  check('E4: a declined edit reports action=decline', !!r2 && r2.action === 'decline');
}

// F — the inline edit input in the AI panel (Inc 2): only present under an ACTIVE AI; an advisory
// instruction applies + confirms; a personality instruction declines with a Maker link.
{
  const w = await boot({ kind: 'skill-host' });
  const chip = w.document.getElementById('rwa-st-ai');
  const panel = w.document.getElementById('rwa-ai-panel');

  // F1 — no active AI → no edit input (editing targets the active AI)
  if (chip) chip.click(); await tick();
  check('F1: with no active AI, the panel has no edit input', !!panel && !panel.querySelector('[data-ai-edit]'));
  if (chip) chip.click(); await tick();

  // install + activate a real signed role
  await w.runtime.agents.install(await makeSignedAgent('concise-editor', { description: 'Tightens prose.' }));
  w.runtime.agents.setActive('concise-editor');
  await tick();
  if (chip) chip.click(); await tick(); // open panel, now with an active AI

  const input = panel && panel.querySelector('[data-ai-edit]');
  const run = panel && panel.querySelector('[data-ai-edit-run]');
  check('F1: an active AI exposes an edit input + run button', !!input && !!run);

  // F2 — an advisory edit applies + confirms
  if (input && run) { input.value = 'use gemini'; run.click(); }
  await tick();
  check('F2: advisory edit writes sessionStorage model', w.sessionStorage.getItem('rwa_model') === GEMINI);
  check('F2: the panel confirms the applied model', !!panel && /gemini/.test(panel.textContent));

  // F3 — a personality edit declines with a Maker link, and changes nothing
  const modelBefore = w.sessionStorage.getItem('rwa_model');
  const input2 = panel && panel.querySelector('[data-ai-edit]');
  const run2 = panel && panel.querySelector('[data-ai-edit-run]');
  if (input2 && run2) { input2.value = 'make it much gentler'; run2.click(); }
  await tick();
  const makerLink = panel && panel.querySelector('[data-ai-edit-result] a[href*="/ai/maker"]');
  check('F3: a personality edit surfaces a "make your own in the Maker" link', !!makerLink);
  check('F3: a declined edit leaves the model unchanged', w.sessionStorage.getItem('rwa_model') === modelBefore);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
