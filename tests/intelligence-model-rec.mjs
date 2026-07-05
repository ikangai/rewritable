// TDD — intelligence/0.2 I-A: a carrier can apply its RECOMMENDED MODEL on activation.
// The recommendation rides as an UNSIGNED envelope field (recommended_model /
// recommended_backend), OUTSIDE the signed `agent` — so canonicalAgent is unchanged,
// the signature still verifies, and this stays seed-only. It is non-secret, applied
// only behind explicit consent, only to sessionStorage rwa_model/rwa_backend (enum),
// and NEVER to a base-URL or the API key.
//
// New seed surface (test hooks):
//   window.__rwaGetRecommendation(envelope)   -> {model?, backend?} | null  (validated)
//   window.__rwaApplyRecommendation(rec)      -> sets sessionStorage; returns what it set
//   window.__rwaOfferRecommendedModel(role)   -> async; consent dialog -> apply on consent
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

const article = '<article><h1>Target</h1></article>\n';

async function makeSignedAgent(role, extra) {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const author_pubkey = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  const agent = { author_pubkey, description: 'test role', role, system_prompt: 'Be concise.', vault_namespace_set: [], version: 'rwa-agent/1' };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, agentSigningMessage(agent)));
  return { agent, signature: Buffer.from(sig).toString('base64'), ...(extra || {}) };
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

console.log('== intelligence/0.2 I-A: recommended model on activation ==');

// A — getRecommendation: validate the non-secret recommendation
{
  const w = await boot(article);
  const g = w.__rwaGetRecommendation;
  check('A1: a clean model + enum backend is accepted', (() => { const r = g({ recommended_model: 'anthropic/claude-sonnet-4-6', recommended_backend: 'openrouter' }); return r && r.model === 'anthropic/claude-sonnet-4-6' && r.backend === 'openrouter'; })());
  check('A2: an unknown backend is rejected (not enum) — backend dropped', (() => { const r = g({ recommended_model: 'x/y', recommended_backend: 'http://evil.test' }); return r && r.model === 'x/y' && !r.backend; })());
  check('A3: a model with whitespace / injection chars is rejected', (() => { const r = g({ recommended_model: 'oops <script> x' }); return r === null || !r.model; })());
  check('A4: no recommendation fields → null', g({}) === null && g({ agent: {}, signature: 'z' }) === null);
  check('A5: ollama-style model id (colon) accepted', (() => { const r = g({ recommended_model: 'llama3.1:8b', recommended_backend: 'ollama' }); return r && r.model === 'llama3.1:8b' && r.backend === 'ollama'; })());
}

// B — applyRecommendation: writes ONLY rwa_model/rwa_backend; never base-URL or key
{
  const w = await boot(article);
  w.sessionStorage.setItem('rwa_apikey', 'SECRET');
  w.sessionStorage.setItem('rwa_base_url_ollama', 'http://localhost:11434');
  w.__rwaApplyRecommendation({ model: 'anthropic/claude-sonnet-4-6', backend: 'openrouter' });
  check('B1: rwa_model is set', w.sessionStorage.getItem('rwa_model') === 'anthropic/claude-sonnet-4-6');
  check('B2: rwa_backend is set', w.sessionStorage.getItem('rwa_backend') === 'openrouter');
  check('B3: the API key is untouched', w.sessionStorage.getItem('rwa_apikey') === 'SECRET');
  check('B4: base-URL overrides are untouched', w.sessionStorage.getItem('rwa_base_url_ollama') === 'http://localhost:11434');
}

// C — offer on activation: consent dialog -> apply
{
  const w = await boot(article);
  w.sessionStorage.setItem('rwa_model', 'google/gemini-3.5-flash'); // current, differs from the rec
  const env = await makeSignedAgent('tightener', { recommended_model: 'anthropic/claude-sonnet-4-6', recommended_backend: 'openrouter' });
  const r = await w.runtime.agents.install(env);
  check('C0: the agent (with a recommendation) installs verified', r && r.ok && r.verified);
  const offerP = w.__rwaOfferRecommendedModel('tightener'); // do NOT await — the promise resolves only on the consent click
  await new Promise(r => setTimeout(r, 60));
  const dlg = w.document.getElementById('rwa-model-offer');
  check('C1: activating offers the recommended model (consent dialog)', !!dlg);
  check('C2: the dialog names the recommended model', !!dlg && /claude-sonnet-4-6/.test(dlg.textContent));
  check('C3: nothing applied before consent (current model unchanged)', w.sessionStorage.getItem('rwa_model') === 'google/gemini-3.5-flash');
  const apply = dlg && dlg.querySelector('[data-act=apply]');
  check('C4: an apply (consent) button is present', !!apply);
  apply.click();
  await offerP;
  await new Promise(r => setTimeout(r, 30));
  check('C5: consenting applies the recommended model', w.sessionStorage.getItem('rwa_model') === 'anthropic/claude-sonnet-4-6');
  check('C6: and the recommended backend', w.sessionStorage.getItem('rwa_backend') === 'openrouter');
}

// C-neg — no offer when there is nothing to offer
{
  const w = await boot(article);
  await w.runtime.agents.install(await makeSignedAgent('plain', {})); // no recommendation
  await w.__rwaOfferRecommendedModel('plain');
  await new Promise(r => setTimeout(r, 40));
  check('N1: a role with no recommendation opens no offer dialog', !w.document.getElementById('rwa-model-offer'));

  const w2 = await boot(article);
  w2.sessionStorage.setItem('rwa_model', 'anthropic/claude-sonnet-4-6'); // already the recommended one
  await w2.runtime.agents.install(await makeSignedAgent('same', { recommended_model: 'anthropic/claude-sonnet-4-6' }));
  await w2.__rwaOfferRecommendedModel('same');
  await new Promise(r => setTimeout(r, 40));
  check('N2: no offer when the recommendation already equals the current model', !w2.document.getElementById('rwa-model-offer'));
}

// D — the AI panel (status-bar ◇ AI chip) lists installed intelligences; activating one offers its model
{
  const w = await boot(article);
  w.sessionStorage.setItem('rwa_model', 'google/gemini-3.5-flash');
  await w.runtime.agents.install(await makeSignedAgent('tightener', { recommended_model: 'anthropic/claude-sonnet-4-6' }));
  w.document.getElementById('rwa-st-ai').click();
  await new Promise(r => setTimeout(r, 150));
  const panel = w.document.getElementById('rwa-ai-panel');
  check('D1: the AI panel lists the intelligence (tightener)', !!panel && panel.classList.contains('open') && /tightener/.test(panel.textContent));
  const onBtn = panel && panel.querySelector('[data-agent-on]');
  check('D2: a verified role offers an Activate button', !!onBtn);
  onBtn.click();
  await new Promise(r => setTimeout(r, 120));
  check('D3: activating sets the role active', (w.runtime.agents.active() || {}).role === 'tightener');
  check('D4: activating offers the recommended model (dialog)', !!w.document.getElementById('rwa-model-offer'));
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
