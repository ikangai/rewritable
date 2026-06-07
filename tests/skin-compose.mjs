// skinning-v2 compose-then-commit — characterization test.
//
// Plan: docs/plans/2026-06-06-skinning-v2-impl-plan.md. Pins the new runtime
// surface that lets a skin land theme + agent-restyle as ONE commit:
//   • applyEdits({noCommit}) — validate + splice, return the string, DON'T commit
//     (the accumulate-without-commit seam; default path still commits).
//   • modify(instr, lensMeta, {compose}) — run the agent loop no-commit, splice
//     the deterministic theme block onto its output, commit ONCE via
//     replace_document (one rwa_undo frame → one ⌘Z reverts theme+wrappers).
//     Graceful: if the agent declines, the theme still lands (theme-only, one commit).
//   • applySkinL1(name) — drives the above for a preset; bridge/single-shot → L0.
//
// The agent is stubbed at the fetch layer (a canned OpenAI tool_call), same as
// the benchmark conformance harness. RED until Tasks 1-3 land in the seed.
//
// Run directly:  (cd tests && node skin-compose.mjs)

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));
const codeOf = (e) => (e && (e.code || e.message) || '').toString();

// Build a canned OpenAI-compatible chat response carrying ONE apply_edits tool
// call (the agent's L1 restyle). This is exactly what openAiCompatChat returns.
function stubToolCall(envelope) {
  return async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'apply_edits', arguments: JSON.stringify(envelope) } },
      ] } }],
    }),
  });
}
// A response with NO tool_calls — the model "declines".
const stubDecline = async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { role: 'assistant', content: 'I will not edit this.' } }] }),
});

// skinning-v3: a chat completion whose message.content is the token JSON the
// /skin like extractor expects (no tool_calls — a single-shot text reply).
function stubExtraction(tokenObj, { fence = false } = {}) {
  let content = JSON.stringify(tokenObj);
  if (fence) content = '```json\n' + content + '\n```';
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
  });
}
// A stub that returns the EXTRACTION JSON on the first call (no tool_calls) and
// the agent's apply_edits tool_call on every subsequent call (the L1 restyle).
function stubLikeThenEdit(tokenObj, editEnvelope, { fence = false } = {}) {
  let n = 0;
  return async () => {
    n++;
    if (n === 1) {
      let content = JSON.stringify(tokenObj);
      if (fence) content = '```json\n' + content + '\n```';
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { id: 'call_e', type: 'function', function: { name: 'apply_edits', arguments: JSON.stringify(editEnvelope) } },
    ] } }] }) };
  };
}

async function boot(body, { backend } = {}) {
  const ov = kindOverrides('document');
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'SK', fileMeta: 'sk.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-sk.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      if (backend) window.sessionStorage.setItem('rwa_backend', backend);
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (window.runtime && typeof window.getDoc === 'function') break;
    await tick();
  }
  return { window, document: window.document, uuid };
}

function readStore(uuid, store, key = 'self') {
  return new Promise((res, rej) => {
    const req = indexedDB.open('rwa_' + uuid);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(store, 'readonly');
        const r = tx.objectStore(store).get(key);
        r.onsuccess = () => { res(r.result); db.close(); };
        r.onerror = () => { rej(r.error); db.close(); };
      } catch (e) { db.close(); rej(e); }
    };
    req.onerror = () => rej(req.error);
  });
}
const histLen = async (uuid) => ((await readStore(uuid, 'rwa_hist')) || []).length;
const undoLen = async (uuid) => ((await readStore(uuid, 'rwa_undo')) || []).length;

(async () => {
  console.log('== skinning-v2: compose-then-commit ==');

  // ── Task 1: applyEdits({noCommit}) validates + returns the string, no commit ──
  {
    const BODY = '<article>\n<p>ANCHOR-ALPHA paragraph</p>\n<p>second paragraph</p>\n</article>';
    const w = await boot(BODY);
    const doc0 = await w.window.getDoc();
    const histBefore = await histLen(w.uuid);

    const out = await w.window.applyEdits(
      { version: 'rwa-edit/1', edits: [{ find: 'ANCHOR-ALPHA', replace: 'ANCHOR-BETA' }] },
      doc0, null, { noCommit: true });
    check('T1: noCommit returns the spliced string', typeof out === 'string' && out.includes('ANCHOR-BETA') && !out.includes('ANCHOR-ALPHA'));
    await tick();
    check('T1: noCommit did NOT write rwa_hist', (await histLen(w.uuid)) === histBefore);
    check('T1: noCommit did NOT change the stored doc', (await w.window.getDoc()) === doc0);

    // control: default (no opts) still commits exactly one entry.
    const committed = await w.window.applyEdits(
      { version: 'rwa-edit/1', edits: [{ find: 'ANCHOR-ALPHA', replace: 'ANCHOR-GAMMA' }] },
      doc0, null);
    await tick();
    check('T1: default (no opts) still commits one rwa_hist entry', (await histLen(w.uuid)) - histBefore === 1);
    check('T1: default returns committed doc with the edit', typeof committed === 'string' && committed.includes('ANCHOR-GAMMA'));
  }

  // ── Task 2: modify({compose}) — agent no-commit + theme splice = ONE commit ──
  {
    const BODY = '<article>\n<h1>Quarterly</h1>\n<p>STATWIDGET line</p>\n<p>closing thoughts</p>\n</article>';
    const w = await boot(BODY);
    // Stub the agent: one apply_edits adding an sk-* wrapper to the unique anchor.
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1',
      edits: [{ find: 'STATWIDGET', replace: '<span class="sk-test">STATWIDGET</span>' }] });
    const hB = await histLen(w.uuid), uB = await undoLen(w.uuid);
    await w.window.modify('TEST RECIPE', { surface: 'skin:l1', actor: 'skin:notion-clean' }, {
      compose: {
        transform: (agentDoc) => '<style data-rwa-skin="notion-clean">/* t */</style>\n' + agentDoc,
        reason: 'skin:notion-clean (theme+L1)',
      },
    });
    await tick(); await tick();
    const doc = await w.window.getDoc();
    check('T2: agent L1 wrapper landed (sk-test present)', /class="sk-test"/.test(doc) && /STATWIDGET/.test(doc));
    check('T2: deterministic theme block landed', /<style data-rwa-skin="notion-clean">/.test(doc));
    check('T2: exactly ONE rwa_hist entry (one commit)', (await histLen(w.uuid)) - hB === 1);
    check('T2: exactly ONE rwa_undo frame (one ⌘Z)', (await undoLen(w.uuid)) - uB === 1);
    const hist = await readStore(w.uuid, 'rwa_hist');
    check('T2: commit attributed actor:skin:notion-clean', hist && hist[0] && hist[0].actor === 'skin:notion-clean');
    check('T2: commit kind replace_document', hist && hist[0] && hist[0].kind === 'replace_document');
    // one-⌘Z reverts BOTH the theme block and the agent wrapper atomically.
    await w.window.runtime.undo(); await tick();
    const undone = await w.window.getDoc();
    check('T2: one undo reverts theme + wrapper together', !/data-rwa-skin/.test(undone) && !/sk-test/.test(undone));
  }

  // ── Task 2b: graceful degradation — agent declines → theme-only, still ONE commit ──
  {
    const BODY = '<article>\n<h1>Doc</h1>\n<p>body text here</p>\n</article>';
    const w = await boot(BODY);
    w.window.fetch = stubDecline;
    const hB = await histLen(w.uuid), uB = await undoLen(w.uuid);
    await w.window.modify('TEST RECIPE', { surface: 'skin:l1', actor: 'skin:linear-dark' }, {
      compose: {
        transform: (agentDoc) => '<style data-rwa-skin="linear-dark">/* t */</style>\n' + agentDoc,
        reason: 'skin:linear-dark (theme+L1)',
      },
    });
    await tick(); await tick();
    const doc = await w.window.getDoc();
    check('T2b: agent declined → theme block STILL landed', /<style data-rwa-skin="linear-dark">/.test(doc));
    check('T2b: declined still exactly ONE commit (theme-only)', (await histLen(w.uuid)) - hB === 1);
    check('T2b: declined still ONE undo frame', (await undoLen(w.uuid)) - uB === 1);
  }

  // ── Task 2c: agent UNREACHABLE (fetch throws) → theme-only, still ONE commit ──
  //    (a skin must apply even with no backend — and the ✦ gallery relies on it).
  {
    const BODY = '<article>\n<h1>Doc</h1>\n<p>plain body</p>\n</article>';
    const w = await boot(BODY);
    w.window.fetch = async () => { throw new Error('network down'); };
    const hB = await histLen(w.uuid), uB = await undoLen(w.uuid);
    await w.window.applySkinL1('stripe-docs');
    await tick(); await tick();
    const doc = await w.window.getDoc();
    check('T2c: agent unreachable → theme block STILL landed', /<style data-rwa-skin="stripe-docs">/.test(doc));
    check('T2c: unreachable still exactly ONE commit (theme-only)', (await histLen(w.uuid)) - hB === 1);
    check('T2c: unreachable still ONE undo frame', (await undoLen(w.uuid)) - uB === 1);
  }

  // ── Task 3: applySkinL1 — real preset theme + stubbed agent wrapper, ONE commit ──
  {
    const BODY = '<article>\n<h1>Status</h1>\n<p>STATWIDGET row</p>\n</article>';
    const w = await boot(BODY);
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1',
      edits: [{ find: 'STATWIDGET', replace: '<span class="sk-eyebrow">STATWIDGET</span>' }] });
    check('T3: applySkinL1 exposed', typeof w.window.applySkinL1 === 'function');
    const hB = await histLen(w.uuid);
    await w.window.applySkinL1('linear-dark');
    await tick(); await tick();
    const doc = await w.window.getDoc();
    check('T3: real linear-dark theme block landed', /<style data-rwa-skin="linear-dark">/.test(doc));
    check('T3: agent sk-* wrapper landed', /class="sk-eyebrow"/.test(doc));
    check('T3: exactly one skin block', (doc.match(/data-rwa-skin=/g) || []).length === 1);
    check('T3: ONE commit', (await histLen(w.uuid)) - hB === 1);
    const hist = await readStore(w.uuid, 'rwa_hist');
    check('T3: actor skin:linear-dark', hist && hist[0] && hist[0].actor === 'skin:linear-dark');
    check('T3: unknown skin throws unknown_skin',
      await w.window.applySkinL1('no-such-skin').then(() => false).catch(e => codeOf(e).includes('unknown_skin')));
  }

  // ── Task 3b: bridge backend → theme-only L0 fallback (no agent, no wrapper) ──
  {
    const BODY = '<article>\n<h1>Status</h1>\n<p>plain body paragraph</p>\n</article>';
    const w = await boot(BODY, { backend: 'bridge' });
    const hB = await histLen(w.uuid);
    await w.window.applySkinL1('linear-dark');
    await tick(); await tick();
    const doc = await w.window.getDoc();
    check('T3b: bridge → theme block still landed (L0)', /<style data-rwa-skin="linear-dark">/.test(doc));
    check('T3b: bridge → NO agent sk-* wrapper added', !/class="sk-/.test(doc));
    check('T3b: bridge → ONE commit', (await histLen(w.uuid)) - hB === 1);
  }

  // ── Task 4: no dead wrappers — every sk-* class a recipe tells the agent to add
  //    MUST have a CSS rule in the seed RWA_SKINS themes. Static check over seed text. ──
  {
    const seed = fs.readFileSync(SEED, 'utf8');
    const region = (from, to) => { const a = seed.indexOf(from), b = seed.indexOf(to, a); return (a >= 0 && b > a) ? seed.slice(a, b) : ''; };
    const recipesRegion = region('const RWA_SKIN_RECIPES = {', 'async function applySkin(');
    const themesRegion = region('const RWA_SKINS = {', 'const RWA_SKIN_BLOCK_RE');
    const recipeClasses = [...new Set(recipesRegion.match(/sk-[a-z]+(?:-[a-z]+)*/g) || [])];
    const themeSelectors = new Set([...themesRegion.matchAll(/\.(sk-[a-z]+(?:-[a-z]+)*)/g)].map(m => m[1]));
    check('T4: recipe + theme regions found, recipe classes present', recipesRegion.length > 0 && themesRegion.length > 0 && recipeClasses.length >= 8);
    const missing = recipeClasses.filter(c => !themeSelectors.has(c));
    check('T4: every recipe sk-* class is styled by a theme (no dead wrappers) — missing=' + JSON.stringify(missing), missing.length === 0);
  }

  // ── Task 5: ✦ gallery swatch click drives applySkinL1 (L1), not just L0 theme ──
  {
    const BODY = '<article>\n<h1>Status</h1>\n<p>STATWIDGET row</p>\n</article>';
    const w = await boot(BODY);
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1',
      edits: [{ find: 'STATWIDGET', replace: '<span class="sk-eyebrow">STATWIDGET</span>' }] });
    w.window.openSkinPanel();
    await tick();
    const sw = w.document.querySelector('.rwa-skin-sw[data-skin="linear-dark"]');
    check('T5: gallery swatch for linear-dark present', !!sw);
    if (sw) sw.click();
    for (let k = 0; k < 60 && !/class="sk-eyebrow"/.test(await w.window.getDoc()); k++) await tick();
    const doc = await w.window.getDoc();
    check('T5: gallery click added an sk-* wrapper (→ applySkinL1, not L0)', /class="sk-eyebrow"/.test(doc));
    check('T5: gallery click also applied the theme block', /<style data-rwa-skin="linear-dark">/.test(doc));
  }

  // ── Task 5b: /skin NAME lens command drives applySkinL1 ──
  {
    const BODY = '<article>\n<h1>Status</h1>\n<p>STATWIDGET row</p>\n</article>';
    const w = await boot(BODY);
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1',
      edits: [{ find: 'STATWIDGET', replace: '<span class="sk-eyebrow">STATWIDGET</span>' }] });
    await w.window.submitLens('/skin linear-dark');
    for (let k = 0; k < 60 && !/class="sk-eyebrow"/.test(await w.window.getDoc()); k++) await tick();
    const doc = await w.window.getDoc();
    check('T5b: /skin NAME added an sk-* wrapper (→ applySkinL1)', /class="sk-eyebrow"/.test(doc));
    check('T5b: /skin NAME also applied the theme block', /<style data-rwa-skin="linear-dark">/.test(doc));
  }

  // ── Review HIGH fix: a GENUINE compose failure (the theme commit itself rejects)
  //    must PROPAGATE — so /skin preserves the typed text and the gallery .catch
  //    fires. Graceful degradation is ONLY for agent failure; a doc that cannot be
  //    skinned at all is a real error, not a silent no-op. Trigger: a bare uncovered
  //    .rwa-locked block → replaceDocument throws class_lock_uncovered on the doc. ──
  {
    const BODY = '<article>\n<h1>Doc</h1>\n<p>ANCHORZ here</p>\n<div class="rwa-locked">locked region</div>\n</article>';
    const w = await boot(BODY);
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1',
      edits: [{ find: 'ANCHORZ', replace: '<span class="sk-eyebrow">ANCHORZ</span>' }] });
    let rejected = false, code = '';
    await w.window.applySkinL1('linear-dark').then(() => {}, e => { rejected = true; code = codeOf(e); });
    check('T-HIGH: genuine compose failure REJECTS (not swallowed) — code=' + code, rejected);
    check('T-HIGH: failed skin did NOT half-apply (no theme block committed)', !/data-rwa-skin/.test(await w.window.getDoc()));
  }

  // ── D1: deterministic de-skin — deskinDoc unwraps prior sk-* cruft ──
  {
    const w = await boot('<article><h1>x</h1></article>');
    check('D1: deskinDoc exposed', typeof w.window.deskinDoc === 'function');
    if (typeof w.window.deskinDoc === 'function') {
      const dk = w.window.deskinDoc;
      check('D1: unwraps a pure sk-* wrapper', dk('<div class="sk-hero"><h1>T</h1></div>') === '<h1>T</h1>');
      check('D1: strips sk-* token from a mixed class', dk('<p class="foo sk-byline">b</p>') === '<p class="foo">b</p>');
      check('D1: nested unwrap', dk('<div class="sk-stat-row"><div class="sk-stat"><b>9</b></div></div>') === '<b>9</b>');
      check('D1: removes the theme block', !/data-rwa-skin/.test(dk('<style data-rwa-skin="x">.a{}</style>\n<p>k</p>')));
      check('D1: non-sk doc passthrough', dk('<div class="content"><p>plain</p></div>') === '<div class="content"><p>plain</p></div>');
    }
  }

  // ── D1b: re-skin starts from a deterministically clean base (orphans can't survive) ──
  {
    const w = await boot('<article>\n<h1>Q</h1>\n<p>ANCHX line</p>\n</article>');
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1', edits: [{ find: 'ANCHX', replace: '<span class="sk-eyebrow">ANCHX</span>' }] });
    await w.window.applySkinL1('linear-dark'); await tick(); await tick();
    check('D1b: skin A added sk-eyebrow', /class="sk-eyebrow"/.test(await w.window.getDoc()));
    // skin B: agent adds sk-callout but does NOT strip the prior sk-eyebrow (non-compliant model)
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1', edits: [{ find: 'ANCHX', replace: '<div class="sk-callout">ANCHX</div>' }] });
    await w.window.applySkinL1('notion-clean'); await tick(); await tick();
    const doc = await w.window.getDoc();
    check('D1b: re-skin to B applied (notion-clean theme + sk-callout)', /data-rwa-skin="notion-clean"/.test(doc) && /class="sk-callout"/.test(doc));
    check('D1b: prior skin-A sk-eyebrow wrapper deterministically GONE', !/class="sk-eyebrow"/.test(doc));
    check('D1b: still exactly one skin block', (doc.match(/data-rwa-skin=/g) || []).length === 1);
  }

  // ── D1c: reset clears the sk-* wrappers too (not just the theme block) ──
  {
    const w = await boot('<article>\n<h1>Q</h1>\n<p>ANCHY line</p>\n</article>');
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1', edits: [{ find: 'ANCHY', replace: '<span class="sk-eyebrow">ANCHY</span>' }] });
    await w.window.applySkinL1('linear-dark'); await tick(); await tick();
    const pre = await w.window.getDoc();
    check('D1c: pre-reset has theme + wrapper', /data-rwa-skin/.test(pre) && /sk-eyebrow/.test(pre));
    await w.window.resetSkin(); await tick(); await tick();
    const doc = await w.window.getDoc();
    check('D1c: reset removed the theme block', !/data-rwa-skin/.test(doc));
    check('D1c: reset ALSO removed the sk-* wrapper', !/sk-eyebrow/.test(doc));
  }

  // ── V3-e: validateSkinTokens / synthesizeSkinTheme exposed + unit assertions ──
  {
    const w = await boot('<article><h1>x</h1></article>');
    check('V3e: validateSkinTokens exposed', typeof w.window.validateSkinTokens === 'function');
    check('V3e: synthesizeSkinTheme exposed', typeof w.window.synthesizeSkinTheme === 'function');
    check('V3e: applySkinLike exposed', typeof w.window.applySkinLike === 'function');
    if (typeof w.window.validateSkinTokens === 'function') {
      const v = w.window.validateSkinTokens({ name: 'Ocean Breeze', confidence: 'high',
        tokens: { accent: '#0ea5e9', ink: '#0f172a', bg: '#ffffff', fontUi: 'serif', baseSize: 17 } });
      check('V3e: clean tokens → ok, slug name, kept fields', v.ok && v.name === 'ocean-breeze' && v.tokens.accent === '#0ea5e9' && v.tokens.fontUi === 'serif' && v.tokens.baseSize === 17);
      // adversarial: an injecting accent is dropped + defaulted
      const bad = w.window.validateSkinTokens({ name: 'x', tokens: { accent: 'red;}body{x' } });
      check('V3e: injecting accent dropped + defaulted', bad.dropped.includes('accent') && bad.tokens.accent === '#2563eb');
      const theme = w.window.synthesizeSkinTheme(v.tokens, v.name);
      check('V3e: synthesized theme is a scoped, named, single <style> block',
        theme.startsWith('<style data-rwa-skin="ocean-breeze">') && theme.endsWith('</style>') &&
        (theme.match(/<\/style>/g) || []).length === 1 && theme.includes('#rwa-doc-mount{') && !theme.includes(':root'));
      // number clamping (unit)
      const clamp = w.window.validateSkinTokens({ name: 'c', tokens: { baseSize: 999, radius: -5, typeScaleRatio: 9 } });
      check('V3e: number clamping (baseSize 999→20, radius -5→0, ratio 9→1.5)',
        clamp.tokens.baseSize === 20 && clamp.tokens.radius === 0 && clamp.tokens.typeScaleRatio === 1.5);
    }
  }

  // ── V3-a: applySkinLike('warm vintage print') → synthesized skin, ONE commit ──
  {
    const BODY = '<article>\n<h1>The Quarterly</h1>\n<p>KICKER opening line</p>\n<p>body paragraph two</p>\n</article>';
    const w = await boot(BODY);
    // First fetch = extraction JSON; subsequent = agent apply_edits adding an sk-* wrapper.
    w.window.fetch = stubLikeThenEdit(
      { name: 'warm-print', feel: 'warm vintage editorial', confidence: 'high', tokens: {
        accent: '#c0392b', ink: '#1a1a1a', bg: '#fdfaf5', fontUi: 'serif', fontMono: 'mono',
        typeScaleRatio: 1.25, baseSize: 17, radius: 4, shadow: 'subtle', density: 'normal',
        borderWeight: 1, motion: 'subtle', ramp: ['#fdfaf5', '#1a1a1a'], semantic: {} } },
      { version: 'rwa-edit/1', edits: [{ find: 'KICKER', replace: '<span class="sk-eyebrow">KICKER</span>' }] });
    const hB = await histLen(w.uuid), uB = await undoLen(w.uuid);
    await w.window.applySkinLike('warm vintage print');
    for (let k = 0; k < 60 && !/data-rwa-skin/.test(await w.window.getDoc()); k++) await tick();
    const doc = await w.window.getDoc();
    check('V3a: synthesized theme block landed (data-rwa-skin="warm-print")', /<style data-rwa-skin="warm-print">/.test(doc));
    check('V3a: theme carries synthesized accent', /--sk-accent:#c0392b/.test(doc));
    check('V3a: agent L1 wrapper landed (sk-eyebrow)', /class="sk-eyebrow"/.test(doc));
    check('V3a: exactly one skin block', (doc.match(/data-rwa-skin=/g) || []).length === 1);
    check('V3a: exactly ONE rwa_hist entry (one commit)', (await histLen(w.uuid)) - hB === 1);
    check('V3a: exactly ONE rwa_undo frame (one ⌘Z)', (await undoLen(w.uuid)) - uB === 1);
    const hist = await readStore(w.uuid, 'rwa_hist');
    check('V3a: commit attributed actor:skin:warm-print', hist && hist[0] && hist[0].actor === 'skin:warm-print');
    check('V3a: commit kind replace_document', hist && hist[0] && hist[0].kind === 'replace_document');
  }

  // ── V3-b: malicious extractor output → dropped/defaulted, skin still applies clean ──
  {
    const BODY = '<article>\n<h1>Doc</h1>\n<p>plain body line</p>\n</article>';
    const w = await boot(BODY);
    // The "model" tries to inject CSS via accent + a url() and a </style breakout.
    w.window.fetch = stubExtraction({ name: 'attack', feel: 'evil', confidence: 'high', tokens: {
      accent: 'red;}body{x', ink: 'url(http://evil)', bg: '@import "x"', fontUi: 'Comic Sans, url(//x)',
      ramp: ['<script>', 'javascript:alert(1)'], semantic: { green: 'http://evil' } } });
    await w.window.applySkinLike('a malicious look');
    for (let k = 0; k < 60 && !/data-rwa-skin/.test(await w.window.getDoc()); k++) await tick();
    const doc = await w.window.getDoc();
    // Isolate the synthesized block and assert it is injection-safe.
    const m = doc.match(/<style data-rwa-skin="[^"]*">[\s\S]*?<\/style>/);
    const block = m ? m[0] : '';
    const inner = block.replace(/^<style[^>]*>/, '').replace(/<\/style>$/, '');
    check('V3b: a skin block was applied despite hostile tokens', !!block && /data-rwa-skin="attack"/.test(block));
    check('V3b: no url( in synthesized block', !/url\(/i.test(inner));
    check('V3b: no @import in synthesized block', !/@import/i.test(inner));
    check('V3b: no http in synthesized block', !/http/i.test(inner));
    check('V3b: no </style breakout in body', !/<\/style/i.test(inner));
    check('V3b: no injected body{ rule', !/body\{x/.test(inner));
    check('V3b: no <script in block', !/<script/i.test(inner));
    check('V3b: exactly one skin block (no extra breakout style)', (doc.match(/data-rwa-skin=/g) || []).length === 1);
    check('V3b: hostile accent fell back to safe default', /--sk-accent:#2563eb/.test(inner));
  }

  // ── V3-c: /skin like <desc> via submitLens reaches applySkinLike (same one-commit) ──
  {
    const BODY = '<article>\n<h1>Status</h1>\n<p>KICKER row</p>\n</article>';
    const w = await boot(BODY);
    w.window.fetch = stubLikeThenEdit(
      { name: 'cool-mint', feel: 'cool minimal', confidence: 'high', tokens: { accent: '#10b981', ink: '#062925', bg: '#f0fdf9', fontUi: 'sans' } },
      { version: 'rwa-edit/1', edits: [{ find: 'KICKER', replace: '<span class="sk-eyebrow">KICKER</span>' }] });
    const hB = await histLen(w.uuid);
    await w.window.submitLens('/skin like cool calm minimal mint');
    for (let k = 0; k < 60 && !/class="sk-eyebrow"/.test(await w.window.getDoc()); k++) await tick();
    const doc = await w.window.getDoc();
    check('V3c: /skin like added the synthesized theme', /<style data-rwa-skin="cool-mint">/.test(doc));
    check('V3c: /skin like added an sk-* wrapper (→ applySkinLike)', /class="sk-eyebrow"/.test(doc));
    check('V3c: /skin like = exactly ONE commit', (await histLen(w.uuid)) - hB === 1);
    check('V3c: /skin like cleared the lens input on success', (w.document.getElementById('rwa-lens-input') || {}).value === '');
  }

  // ── V3-c2: empty description after "like" → usage hint, no commit ──
  {
    const w = await boot('<article>\n<h1>X</h1>\n<p>body</p>\n</article>');
    w.window.fetch = async () => { throw new Error('extractor must not be called'); };
    const hB = await histLen(w.uuid);
    await w.window.submitLens('/skin like   ');
    await tick(); await tick();
    check('V3c2: empty /skin like made NO commit', (await histLen(w.uuid)) - hB === 0);
    check('V3c2: empty /skin like did not skin the doc', !/data-rwa-skin/.test(await w.window.getDoc()));
  }

  // ── V3-d: re-skin from a PRESET to a LIKE skin deterministically de-skins prior wrappers ──
  {
    const BODY = '<article>\n<h1>Q</h1>\n<p>ANCHL line</p>\n</article>';
    const w = await boot(BODY);
    // Step 1: apply a preset (linear-dark) that lands a sk-eyebrow wrapper.
    w.window.fetch = stubToolCall({ version: 'rwa-edit/1', edits: [{ find: 'ANCHL', replace: '<span class="sk-eyebrow">ANCHL</span>' }] });
    await w.window.applySkinL1('linear-dark'); await tick(); await tick();
    const pre = await w.window.getDoc();
    check('V3d: preset skin applied (linear-dark theme + sk-eyebrow)', /data-rwa-skin="linear-dark"/.test(pre) && /class="sk-eyebrow"/.test(pre));
    // Step 2: /skin like — extraction then an agent that adds sk-callout but does NOT
    // strip the prior sk-eyebrow (non-compliant model). de-skin must remove it anyway.
    w.window.fetch = stubLikeThenEdit(
      { name: 'paper', feel: 'soft paper', confidence: 'medium', tokens: { accent: '#7c5cff', ink: '#222', bg: '#fbfbfd', fontUi: 'serif' } },
      { version: 'rwa-edit/1', edits: [{ find: 'ANCHL', replace: '<div class="sk-callout">ANCHL</div>' }] });
    await w.window.applySkinLike('soft paper note look');
    for (let k = 0; k < 60 && !/data-rwa-skin="paper"/.test(await w.window.getDoc()); k++) await tick();
    const doc = await w.window.getDoc();
    check('V3d: re-skin to LIKE applied (paper theme + sk-callout)', /data-rwa-skin="paper"/.test(doc) && /class="sk-callout"/.test(doc));
    check('V3d: prior preset sk-eyebrow wrapper deterministically GONE', !/class="sk-eyebrow"/.test(doc));
    check('V3d: still exactly one skin block', (doc.match(/data-rwa-skin=/g) || []).length === 1);
  }

  // ── V3-f: bridge backend → /skin like unsupported (no commit, clear notice path) ──
  {
    const w = await boot('<article>\n<h1>X</h1>\n<p>body</p>\n</article>', { backend: 'bridge' });
    w.window.fetch = async () => { throw new Error('extractor must not be called on bridge'); };
    const hB = await histLen(w.uuid);
    await w.window.applySkinLike('warm vintage print');
    await tick(); await tick();
    check('V3f: bridge /skin like made NO commit (unsupported, prose v1)', (await histLen(w.uuid)) - hB === 0);
    check('V3f: bridge /skin like did not skin the doc', !/data-rwa-skin/.test(await w.window.getDoc()));
  }

  // ── V3-g: fenced ```json extractor reply is parsed leniently ──
  {
    const BODY = '<article>\n<h1>X</h1>\n<p>KICKER body</p>\n</article>';
    const w = await boot(BODY);
    w.window.fetch = stubLikeThenEdit(
      { name: 'fenced', feel: 'f', confidence: 'high', tokens: { accent: '#3366ff', ink: '#111', bg: '#fff', fontUi: 'sans' } },
      { version: 'rwa-edit/1', edits: [{ find: 'KICKER', replace: '<span class="sk-eyebrow">KICKER</span>' }] },
      { fence: true });
    await w.window.applySkinLike('a fenced look');
    for (let k = 0; k < 60 && !/data-rwa-skin/.test(await w.window.getDoc()); k++) await tick();
    const doc = await w.window.getDoc();
    check('V3g: fenced ```json reply parsed → theme applied', /<style data-rwa-skin="fenced">/.test(doc) && /--sk-accent:#3366ff/.test(doc));
  }

  // ── V3-h: extractor returns no JSON → applySkinLike rejects (no half-skin) ──
  {
    const w = await boot('<article>\n<h1>X</h1>\n<p>body</p>\n</article>');
    w.window.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Sorry, I cannot.' } }] }) });
    const hB = await histLen(w.uuid);
    let rejected = false;
    await w.window.applySkinLike('something').then(() => {}, () => { rejected = true; });
    await tick(); await tick();
    check('V3h: no-JSON extractor reply → applySkinLike rejects', rejected);
    check('V3h: no-JSON reply made NO commit', (await histLen(w.uuid)) - hB === 0);
  }

  console.log(`\n${pass} / ${pass + fail} passing`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
