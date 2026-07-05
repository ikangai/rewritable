// TDD — drop-in AI UX Task 2: the AI chip + AI panel (docs/plans/2026-07-05-drop-in-ai-ux-design.md §2).
// The document's AI becomes visible: a persistent status-bar chip (#rwa-st-ai) showing the active
// AI role, and a dedicated AI panel (#rwa-ai-panel) that absorbs the "Intelligences" section
// previously buried in the ⋯ → Activity panel.
//
// New seed surface under test:
//   #rwa-st-ai      — status-bar chip: '◇ AI' + class 'none' (no active AI) / '◆ <role>'
//   #rwa-ai-panel   — chip-click panel: active-AI card, Activate/advisor rows, drop/gallery footer
//   renderActionsModePanel no longer renders an 'Intelligences' section (C1)
//
// Run: node tests/ai-chip.mjs
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
const CARRIER = path.join(__dirname, '..', 'examples', 'intelligence-carrier', 'concise-editor.html');
const seed = fs.readFileSync(SEED, 'utf8');
const carrierHtml = fs.readFileSync(CARRIER, 'utf8');

let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL', m); } };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// Second installed role for B4 — a fresh signed rwa-agent/1 envelope (same helper pattern as
// tests/intelligence-blend.mjs). No recommendation on purpose: activating it must not depend on
// the model-offer dialog (the test still cleans one up defensively).
async function makeSignedAgent(role, opts) {
  const o = opts || {};
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const author_pubkey = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  const agent = { author_pubkey, description: o.description || (role + ' description'), role, system_prompt: o.prompt || ('Lens ' + role + '.'), vault_namespace_set: [], version: 'rwa-agent/1' };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, agentSigningMessage(agent)));
  return { agent, signature: Buffer.from(sig).toString('base64') };
}

async function boot({ kind = 'document', body = '<article><h1>Target</h1><p data-rwa-id="aichip">Hello</p></article>\n', sessionKey = false } = {}) {
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
    url: 'https://rwa-aichip-' + webcrypto.randomUUID() + '.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      if (sessionKey) { window.sessionStorage.setItem('rwa_apikey', 'test-key'); window.sessionStorage.setItem('rwa_model', 'test-model'); }
      window.fetch = async () => { throw new Error('no network in ai-chip test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    },
  });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 5000) { if (w.runtime && w.runtime.agents && w.runtime.agents.install) break; await new Promise(r => setTimeout(r, 5)); }
  await tick(150);
  return w;
}

console.log('== AI chip + AI panel ==');

// A — chip + panel scaffolding on a plain document (no AI anywhere)
{
  const w = await boot({ sessionKey: true });
  const chip = w.document.getElementById('rwa-st-ai');
  const bar = w.document.getElementById('rwa-set');

  // A1 — the chip lives in the status bar and starts in the no-AI state
  check('A1: chip #rwa-st-ai exists inside the status bar #rwa-set', !!chip && !!bar && bar.contains(chip));
  check('A1: initial chip text mentions AI', !!chip && /AI/.test(chip.textContent));
  check("A1: initial chip carries class 'none' (no active AI)", !!chip && chip.classList.contains('none'));

  // A2 — chip click toggles the AI panel
  const panel = w.document.getElementById('rwa-ai-panel');
  check('A2: #rwa-ai-panel exists', !!panel);
  if (chip) chip.click();
  await tick();
  check('A2: chip click opens the AI panel', !!panel && panel.classList.contains('open'));
  if (chip) chip.click();
  await tick();
  check('A2: second chip click closes the AI panel', !!panel && !panel.classList.contains('open'));

  // A3 — empty state: drop invitation + gallery link + manual escape hatch
  if (chip) chip.click();
  await tick();
  check('A3: empty state invites the drop gesture', !!panel && /Drop an AI file/.test(panel.textContent));
  const gal = panel && panel.querySelector('a[href*="/ai"]');
  check("A3: a gallery link href contains '/ai'", !!gal);
  const manual = panel && panel.querySelector('#rwa-ai-manual');
  check("A3: a 'set up manually' control is present", !!manual && /set up manually/i.test(manual.textContent));
  if (manual) manual.click();
  await tick();
  check('A3: set-up-manually opens #rwa-set-panel', w.document.getElementById('rwa-set-panel').classList.contains('open'));
  check('A3: and closes the AI panel', !!panel && !panel.classList.contains('open'));
}

// B — installed + active role (real carrier envelope through runtime.agents.install)
{
  const w = await boot({ kind: 'skill-host' });
  const env = w.__rwaExtractAgentCarrier(carrierHtml)[0];
  const res = await w.runtime.agents.install(env);
  check('B0: carrier role installs verified (setup)', !!res && res.ok === true && res.verified === true);
  w.runtime.agents.setActive('concise-editor');
  await tick();

  // B1 — chip reflects the active role
  const chip = w.document.getElementById('rwa-st-ai');
  check("B1: chip text contains 'concise-editor' after activation", !!chip && /concise-editor/.test(chip.textContent));
  check("B1: chip class 'none' removed", !!chip && !chip.classList.contains('none'));

  // B2 — active card: name, description, Deactivate, connection status.
  // No session key yet (openrouter requiresKey) → 'not connected' + Connect.
  const panel = w.document.getElementById('rwa-ai-panel');
  if (chip) chip.click();
  await tick();
  check('B2: panel names the active role', !!panel && /concise-editor/.test(panel.textContent));
  check('B2: panel shows the role description', !!panel && /Tightens prose/.test(panel.textContent));
  const deact = panel && panel.querySelector('[data-agent-off]');
  check("B2: a 'Deactivate' button is present", !!deact && /Deactivate/.test(deact.textContent));
  check("B2: without a key the status reads 'not connected'", !!panel && /not connected/.test(panel.textContent));
  const connect = panel && panel.querySelector('[data-ai-connect]');
  check('B2: a Connect button is offered when not connected', !!connect);
  if (connect) connect.click();
  await tick();
  check('B2: Connect opens #rwa-set-panel (v1 = manual setup)', w.document.getElementById('rwa-set-panel').classList.contains('open'));
  w.document.getElementById('rwa-set-panel').classList.remove('open');

  // …and with a key + model the status line names them.
  w.sessionStorage.setItem('rwa_apikey', 'sk-test');
  w.sessionStorage.setItem('rwa_model', 'm1');
  if (chip) chip.click();
  await tick();
  check("B2: with a key the status reads 'using m1 via openrouter'", !!panel && panel.classList.contains('open') && /using m1 via openrouter/.test(panel.textContent));

  // B3 — Deactivate returns the chip to the no-AI state
  const deact2 = panel && panel.querySelector('[data-agent-off]');
  if (deact2) deact2.click();
  await tick();
  check('B3: Deactivate clears the active role (runtime state)', w.runtime.agents.active() === null);
  check("B3: chip back to the no-AI state ('none' + no role name)", !!chip && chip.classList.contains('none') && !/concise-editor/.test(chip.textContent));

  // B4 — a second installed-but-inactive role gets an Activate row; clicking activates it
  await w.runtime.agents.install(await makeSignedAgent('tightener', { description: 'Second role.' }));
  if (chip) { chip.click(); chip.click(); } // close + reopen → re-render with both roles
  await tick();
  const onBtn = panel && panel.querySelector('[data-agent-on="tightener"]');
  check('B4: an inactive installed role lists with an Activate button', !!onBtn && /Activate/.test(onBtn.textContent));
  if (onBtn) onBtn.click();
  await tick(60);
  check('B4: clicking Activate flips runtime.agents.active().role', (w.runtime.agents.active() || {}).role === 'tightener');
  check('B4: chip follows the newly active role', !!chip && /tightener/.test(chip.textContent) && !chip.classList.contains('none'));
  const offer = w.document.getElementById('rwa-model-offer'); // defensive: model-offer may open on activate
  if (offer) { const keep = offer.querySelector('[data-act=keep]'); if (keep) keep.click(); await tick(); }
}

// C — the Activity panel sheds its Intelligences section
{
  const w = await boot({ kind: 'skill-host' });
  await w.runtime.agents.install(await makeSignedAgent('proser', {}));
  w.runtime.setMode('actions');
  await tick(150);
  const panel = w.document.getElementById('rwa-mode-panel');
  check('C1: the Activity panel renders (setup)', !!panel && panel.classList.contains('open') && /Activity/.test(panel.textContent));
  check("C1: it no longer contains an 'Intelligences' section", !!panel && !/Intelligences/.test(panel.textContent) && !panel.querySelector('[data-agent-on]'));
}

// D — the no-key ⌘K path invites an AI drop instead of auto-opening ⚙ settings (plan task 1.5).
// The first ⌘K on a fresh openrouter rewritable with no session key used to answer 'no API key —
// open ⚙ settings' and AUTO-OPEN the developer settings form. WHY it matters: the tangible
// alternative — drop an AI file — was undiscoverable; the guard shoved the user into a raw dev
// form instead of surfacing the drop gesture. It now shows #rwa-ai-invite (a drop-invitation card),
// with the settings form demoted to an explicit 'set up manually' escape hatch.
{
  // D1 — generic invite (no AI installed, no key): modify() must NOT auto-open settings; it invites.
  const w = await boot(); // document kind, openrouter default, no rwa_apikey
  try { await w.modify('x'); } catch (_) {}
  await tick();
  const setPanel = w.document.getElementById('rwa-set-panel');
  check('D1: no-key modify does NOT auto-open the developer settings form', !setPanel.classList.contains('open'));
  const invite = w.document.getElementById('rwa-ai-invite');
  check('D1: a drop-invitation card #rwa-ai-invite appears instead', !!invite);

  // D2 — invite copy: no AI connected, the drop gesture, a gallery link to /ai
  check('D2: invite says no AI is connected', !!invite && /no AI connected/i.test(invite.textContent));
  check('D2: invite invites the drop gesture', !!invite && /Drop an AI file/i.test(invite.textContent));
  const gal = invite && invite.querySelector('a[href*="/ai"]');
  check("D2: invite carries a gallery link whose href contains '/ai'", !!gal);

  // D3 — escape hatch: [data-ai-manual] removes the invite + opens settings (the OLD guard behavior,
  // now behind an explicit choice rather than forced).
  const manual = invite && invite.querySelector('[data-ai-manual]');
  check("D3: invite offers a 'set up manually' control", !!manual && /set up manually/i.test(manual.textContent));
  if (manual) manual.click();
  await tick();
  check('D3: set-up-manually removes the invite', !w.document.getElementById('rwa-ai-invite'));
  check('D3: and opens the developer settings form', setPanel.classList.contains('open'));
}

// D4 — AI-aware variant: an installed+active role but no session key (the every-new-session case,
// since key/model are sessionStorage-only). The invite names the role and offers the key inline.
{
  const w = await boot({ kind: 'skill-host' });
  const env = w.__rwaExtractAgentCarrier(carrierHtml)[0];
  await w.runtime.agents.install(env);
  w.runtime.agents.setActive('concise-editor');
  await tick();
  const offer0 = w.document.getElementById('rwa-model-offer'); // defensive: clear any model-offer overlay
  if (offer0) { const k = offer0.querySelector('[data-act=keep]'); if (k) k.click(); await tick(); }
  w.sessionStorage.removeItem('rwa_apikey');
  try { await w.modify('x'); } catch (_) {}
  await tick();
  const invite = w.document.getElementById('rwa-ai-invite');
  check('D4: AI-aware invite appears', !!invite);
  check('D4: invite names the installed role', !!invite && /concise-editor/.test(invite.textContent));
  check('D4: invite says to connect a model', !!invite && /connect a model/i.test(invite.textContent));
  const field = invite && invite.querySelector('[data-ai-key]');
  check('D4: invite has an inline key field', !!field);
  const connect = invite && invite.querySelector('[data-ai-invite-connect]');
  check('D4: invite has a connect button', !!connect);
  if (field) { field.value = 'sk-or-typed'; field.dispatchEvent(new w.Event('input')); }
  if (connect) connect.click();
  await tick();
  check("D4: connect stores the key in sessionStorage (rwa_apikey)", w.sessionStorage.getItem('rwa_apikey') === 'sk-or-typed');
  check('D4: connect removes the invite', !w.document.getElementById('rwa-ai-invite'));
}

// D5 — a working session (key present) proceeds PAST the guard: no invite. (modify then hits the
// fake-network path and rejects — that's expected; we assert only on the invite's absence.)
{
  const w = await boot();
  w.sessionStorage.setItem('rwa_apikey', 'sk-or-test');
  try { await w.modify('x'); } catch (_) {}
  await tick();
  check('D5: with a key, modify proceeds past the guard — no invite appears', !w.document.getElementById('rwa-ai-invite'));
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
