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
// tests/intelligence-blend.mjs). No recommendation by default: activating it must not depend on
// the model-offer dialog (the test still cleans one up defensively). A recommended_model /
// recommended_backend in opts rides on the ENVELOPE (outside the signed `agent`, so the signature
// still verifies — intelligence/0.2 I-A), exercising the model-offer-open path in block G.
async function makeSignedAgent(role, opts) {
  const o = opts || {};
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const author_pubkey = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  const agent = { author_pubkey, description: o.description || (role + ' description'), role, system_prompt: o.prompt || ('Lens ' + role + '.'), vault_namespace_set: [], version: 'rwa-agent/1' };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, agentSigningMessage(agent)));
  const env = { agent, signature: Buffer.from(sig).toString('base64') };
  if (o.recommended_model) env.recommended_model = o.recommended_model;
  if (o.recommended_backend) env.recommended_backend = o.recommended_backend;
  return env;
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

// D6 — the REAL every-new-session case: a single verified role installed but NOT active in-session
// (activeAgentRole isn't persisted across sessions, so runtimeAgentActive() is null on a fresh open).
// WHY this test exists: D4 masked the bug by pre-calling setActive. Here Connect must ACTIVATE the
// named role, not just store the key — otherwise the card promises "'<role>' is ready" but ⌘K then
// runs the plain editor with an empty chip.
{
  const w = await boot({ kind: 'skill-host' });
  await w.runtime.agents.install(w.__rwaExtractAgentCarrier(carrierHtml)[0]);
  // deliberately NO setActive — this is the inactive branch
  w.sessionStorage.removeItem('rwa_apikey');
  check('D6: precondition — no active role in this session', w.runtime.agents.active() === null);
  try { await w.modify('x'); } catch (_) {}
  await tick();
  const invite = w.document.getElementById('rwa-ai-invite');
  check('D6: a single inactive verified role still yields the AI-aware invite', !!invite);
  check('D6: invite names the inactive role', !!invite && /concise-editor/.test(invite.textContent));
  const connect = invite && invite.querySelector('[data-ai-invite-connect]');
  check('D6: Connect is DISABLED before a key is typed', !!connect && connect.disabled === true);
  const field = invite && invite.querySelector('[data-ai-key]');
  if (field) { field.value = 'sk-or-live'; field.dispatchEvent(new w.Event('input')); }
  check('D6: Connect enables once a key is typed', !!connect && connect.disabled === false);
  if (connect) connect.click();
  await tick();
  check('D6: Connect ACTIVATES the named role (the branch D4 masked)', (w.runtime.agents.active() || {}).role === 'concise-editor');
  check('D6: Connect stores the key in sessionStorage', w.sessionStorage.getItem('rwa_apikey') === 'sk-or-live');
  check('D6: Connect removes the invite', !w.document.getElementById('rwa-ai-invite'));
}

// D6b — the AI-aware variant has a neutral dismiss (parity with the generic card): a Close button
// that just removes the invite without connecting or activating.
{
  const w = await boot({ kind: 'skill-host' });
  await w.runtime.agents.install(w.__rwaExtractAgentCarrier(carrierHtml)[0]);
  w.sessionStorage.removeItem('rwa_apikey');
  try { await w.modify('x'); } catch (_) {}
  await tick();
  const invite = w.document.getElementById('rwa-ai-invite');
  const closeBtn = invite && invite.querySelector('[data-act=cancel]');
  check('D6b: AI-aware invite offers a neutral Close button', !!closeBtn && /Close/i.test(closeBtn.textContent));
  if (closeBtn) closeBtn.click();
  await tick();
  check('D6b: Close removes the invite without connecting', !w.document.getElementById('rwa-ai-invite') && w.sessionStorage.getItem('rwa_apikey') == null);
  check('D6b: Close does not activate a role', w.runtime.agents.active() === null);
}

// D7 — ambiguity fallback: TWO verified inactive roles → GENERIC invite (no single role to name).
{
  const w = await boot({ kind: 'skill-host' });
  await w.runtime.agents.install(await makeSignedAgent('alpha', {}));
  await w.runtime.agents.install(await makeSignedAgent('beta', {}));
  w.sessionStorage.removeItem('rwa_apikey');
  try { await w.modify('x'); } catch (_) {}
  await tick();
  const invite = w.document.getElementById('rwa-ai-invite');
  check('D7: invite appears with two inactive verified roles', !!invite);
  check('D7: it falls back to the GENERIC variant (names no single role)', !!invite && /no AI connected/i.test(invite.textContent) && !/alpha|beta/.test(invite.textContent));
  check('D7: the generic invite still carries the gallery link', !!invite && !!invite.querySelector('a[href*="/ai"]'));
}

// D8 — a drop supersedes an open invite: showAgentInstallDialog removes any mounted #rwa-ai-invite so
// the consent card doesn't stack a second overlay behind it.
{
  const w = await boot({ kind: 'skill-host' });
  const env = w.__rwaExtractAgentCarrier(carrierHtml)[0];
  await w.runtime.agents.install(env);
  w.sessionStorage.removeItem('rwa_apikey');
  try { await w.modify('x'); } catch (_) {}
  await tick();
  check('D8: the invite is open (setup)', !!w.document.getElementById('rwa-ai-invite'));
  w.showAgentInstallDialog(env); // fire-and-forget: opens the consent dialog
  await tick(80);
  check('D8: the drop dialog removes the stale invite', !w.document.getElementById('rwa-ai-invite'));
  check('D8: the consent dialog is now mounted', !!w.document.getElementById('rwa-agent-install'));
}

// E — panel Activate runs a connect check. Flipping the chip to a role does NOT make ⌘K runnable:
// key/model are sessionStorage-only, so a fresh session (openrouter, no key) still can't run. WHY it
// matters: without this the chip says '◆ role' but the next ⌘K silently fails the guard; the user gets
// no signal that they still owe a connection. Activation now mirrors the ⌘K no-key path — it drops the
// AI panel and raises the (AI-aware) drop-invitation card naming the role just activated.
{
  const w = await boot({ kind: 'skill-host' }); // no session key
  await w.runtime.agents.install(await makeSignedAgent('connector', { description: 'Needs a key.' }));
  const chip = w.document.getElementById('rwa-st-ai');
  const panel = w.document.getElementById('rwa-ai-panel');
  if (chip) chip.click();
  await tick();
  const onBtn = panel && panel.querySelector('[data-agent-on="connector"]');
  check('E1: the inactive role lists an Activate button (setup)', !!onBtn);
  if (onBtn) onBtn.click();
  await tick(60);
  check('E1: Activate flips the active role', (w.runtime.agents.active() || {}).role === 'connector');
  const invite = w.document.getElementById('rwa-ai-invite');
  check('E1: with no key, activation raises the drop-invitation card', !!invite);
  check('E1: the invite is AI-aware — names the activated role', !!invite && /connector/.test(invite.textContent));
  check('E1: and the AI panel is closed (it made way for the invite)', !panel.classList.contains('open'));
}

// E2 — the negative control: a working session (key present) activates WITHOUT the invite. Proves the
// connect check fires only when the session genuinely can't run, not on every Activate.
{
  const w = await boot({ kind: 'skill-host', sessionKey: true }); // rwa_apikey + rwa_model set
  await w.runtime.agents.install(await makeSignedAgent('ready', {}));
  const chip = w.document.getElementById('rwa-st-ai');
  const panel = w.document.getElementById('rwa-ai-panel');
  if (chip) chip.click();
  await tick();
  const onBtn = panel && panel.querySelector('[data-agent-on="ready"]');
  if (onBtn) onBtn.click();
  await tick(60);
  check('E2: activation sets the role active', (w.runtime.agents.active() || {}).role === 'ready');
  check('E2: with a key, activation does NOT raise the invite', !w.document.getElementById('rwa-ai-invite'));
  check('E2: and the AI panel stays open', panel.classList.contains('open'));
}

// F — bridge-aware status line. The bridge backend shells to `claude -p`; the sessionStorage model is
// ignored, so 'using <model> via bridge' would be a lie. The active-role card names only the backend.
{
  const w = await boot({ kind: 'skill-host' });
  await w.runtime.agents.install(w.__rwaExtractAgentCarrier(carrierHtml)[0]);
  w.runtime.agents.setActive('concise-editor');
  w.sessionStorage.setItem('rwa_backend', 'bridge');
  w.sessionStorage.setItem('rwa_model', 'should-not-appear');
  const chip = w.document.getElementById('rwa-st-ai');
  const panel = w.document.getElementById('rwa-ai-panel');
  if (chip) chip.click();
  await tick();
  check('F1: bridge status names the backend (using bridge)', !!panel && /using bridge/.test(panel.textContent));
  check('F1: bridge status omits the model claim', !!panel && !/should-not-appear/.test(panel.textContent));
  check("F1: bridge status drops the 'via <backend>' model framing", !!panel && !/via bridge/.test(panel.textContent));
}

// G — the connect check DEFERS to an open model-offer. WHY it matters (both reviewers, real case): the
// shipped concise-editor carrier recommends a model, so activating it in a fresh unconnected session
// synchronously mounts #rwa-model-offer. Without the guard the connect check would ALSO stack
// #rwa-ai-invite on top (double modal); worse, if the offer switches to a keyless backend the invite is
// a false alarm. The offer is the user's next decision — if the session still can't run after they
// dismiss it, the next ⌘K's own no-key guard recovers the invite. Here: activate a rec-bearing role,
// unconnected → the model-offer is up AND the connect-check invite is suppressed.
{
  const w = await boot({ kind: 'skill-host' }); // no session key (openrouter requiresKey)
  await w.runtime.agents.install(await makeSignedAgent('recommender', {
    recommended_model: 'anthropic/claude-sonnet-4-6', recommended_backend: 'openrouter',
  }));
  const chip = w.document.getElementById('rwa-st-ai');
  const panel = w.document.getElementById('rwa-ai-panel');
  if (chip) chip.click();
  await tick();
  const onBtn = panel && panel.querySelector('[data-agent-on="recommender"]');
  check('G1: the rec-bearing role lists an Activate button (setup)', !!onBtn);
  if (onBtn) onBtn.click();
  await tick(60);
  check('G1: Activate flips the active role', (w.runtime.agents.active() || {}).role === 'recommender');
  check('G1: the recommended-model offer is open', !!w.document.getElementById('rwa-model-offer'));
  check('G1: the connect check defers — NO stacked drop-invitation card', !w.document.getElementById('rwa-ai-invite'));
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
