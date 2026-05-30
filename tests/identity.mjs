// self-description/1 test for seeds/rewritable.html — "a rewritable knows what it is".
//
// Pins the LIVE self-description surface: runtime.describe() (the agent half) and
// the ⓘ "what is this?" chrome panel (the human half). The contract is
// docs/specs/rwa-self-description-spec.md; the referee oracle is
// tools/self-description.mjs; the static counterpart is cli/src/doc.mjs.
//
// These tests encode WHY, not just WHAT: a self-description that OVERCLAIMS (a
// phantom 'redo' the runtime can't do), that GUESSES affordances from the kind
// instead of reading the live provider registry, or whose human panel LIES, is
// worse than none — an agent or human would trust a false answer. The strongest
// check runs describe()'s output through the SAME validator the CLI consumer
// uses, so producer and contract cannot drift.
//
// Run:  (cd tests && npm install && npm run test:identity)
// Exits non-zero on any failure.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { validateSelfDescription, checkAffordanceAgreement, computeSelfDescription } from '../tools/self-description.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise(r => setTimeout(r, 0));

// Boot a container of `kind` with an optional custom INLINE_DOC body, the same
// way `rwa new [--kind k]` builds it: seed-level subs first, then the body
// (CLAUDE.md ordering). Returns the live { window, document, uuid }.
async function boot({ kind = 'document', title = 'Doc', body = null } = {}) {
  const ov = kindOverrides(kind);
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title, fileMeta: title.toLowerCase() + '.html',
    productKind: kind,
    lensPlaceholder: ov.lensPlaceholder,
    palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader,
    lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body != null ? body : ov.body);

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-identity.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (window.runtime && typeof window.runtime.describe === 'function') break;
    await tick();
  }
  return { window, document: window.document, uuid, html };
}

(async () => {
  console.log('== self-description/1: runtime.describe() — the agent surface ==');

  // A document with a real title, prose, and one author-declared frozen zone —
  // so title / blocks / frozenZones are all non-trivial.
  const docBody = [
    '<article>',
    '  <h1>Quarterly Plan</h1>',
    '  <p>First paragraph of the plan.</p>',
    '  <!-- rwa:frozen:begin signature -->',
    '  <p>Signed: the author. Do not edit.</p>',
    '  <!-- rwa:frozen:end signature -->',
    '</article>',
  ].join('\n');

  const doc = await boot({ kind: 'document', title: 'Quarterly Plan', body: docBody });
  check('runtime.describe is exposed on the public API', typeof doc.window.runtime?.describe === 'function');
  check('no bootstrap error', !doc.document.body.textContent.startsWith('Bootstrap error'));

  const d = doc.window.runtime.describe();

  // ── THE referee: describe() must satisfy the same oracle the CLI uses ──
  const v = validateSelfDescription(d);
  check('describe() validates against the self-description/1 oracle' + (v.valid ? '' : ' — ' + v.errors.join('; ')), v.valid);
  check('describe() affordances agree with the kind→providers table (SD-03)', checkAffordanceAgreement(d).ok);

  // ── Shape + provenance ────────────────────────────────────────────────
  check('rwa tag is self-description/1', d.rwa === 'self-description/1');
  check("source is 'live' (this is the runtime emitter; CLI emits 'static')", d.source === 'live');
  check('uuid is the container UUID (correlates edits/history/shares)', d.uuid === doc.uuid);
  check("kind is 'document'", d.kind === 'document');

  // ── Title + blocks read the LIVE doc, not a stale guess ───────────────
  check('title is extracted from the <h1>', d.title === 'Quarterly Plan');
  check('blocks is a number', typeof d.blocks === 'number');
  const liveIds = (doc.window.getCurrentDocCache().match(/\bdata-rwa-id\b/g) || []).length;
  check('blocks equals the live data-rwa-id count (reads real state)', d.blocks === liveIds && d.blocks > 0);

  // ── Affordances: HONEST, kernel-pure (provider kinds, not verbs) ──────
  // A base document registers NO providers → affordances is empty. This is the
  // live registry, not a kind-hardcoded guess.
  check('document has empty affordances (base kind, no registered providers)', Array.isArray(d.affordances) && d.affordances.length === 0);
  check('document has no active view', d.activeView === null);

  // ── Substrate-universals live in `baseline`, NOT `affordances` ────────
  check('baseline.edit is the lens', eq(d.baseline.edit, ['lens']));
  check('baseline.tools are the three rwa-edit/1 tools', eq(d.baseline.tools, ['apply_dsl_plan', 'apply_edits', 'replace_document']));
  check('baseline.export is html + print', eq(d.baseline.export, ['html', 'print']));
  // THE honesty pin: ⌘Z undo exists, redo does NOT. The oracle also rejects a
  // 'redo' here (validateSelfDescription), so this is double-guarded.
  check("baseline.history is ['undo'] only — no phantom redo", eq(d.baseline.history, ['undo']));

  // ── Invariants reflect the author-declared frozen zone ────────────────
  check('frozenZones lists the marker-form zone name', eq(d.frozenZones, ['signature']));

  // ── Title honesty: a doc with no <h1> reports null, not a fabrication ──
  const untitled = await boot({ kind: 'document', title: 'X', body: '<article><p>No heading here.</p></article>' });
  check('title is null when the doc has no <h1>', untitled.window.runtime.describe().title === null);

  console.log('\n== self-description/1: LIVE view-registry introspection ==');
  // Presentation registers a first-party view provider at boot. describe() must
  // report it from the ACTUAL registry (zero-drift), and reflect activation.
  const deck = await boot({ kind: 'presentation', title: 'Deck' });
  const p0 = deck.window.runtime.describe();
  check('presentation describe() validates against the oracle', validateSelfDescription(p0).valid);
  check('presentation affordances agree with the table (SD-03)', checkAffordanceAgreement(p0).ok);
  const viewAff = p0.affordances.find(a => a.kind === 'view');
  check('presentation reports a live-registered view provider', !!viewAff && viewAff.kind === 'view');
  check("view affordance carries the provider name ('presentation') as detail, kind as the token", viewAff && viewAff.name === 'presentation');
  check('view is not active until toggled', p0.activeView === null);
  deck.window.runtime.setView('presentation');
  await tick();
  const p1 = deck.window.runtime.describe();
  check('a fresh describe() reflects the now-active view (live, not cached)', p1.activeView === 'presentation');

  console.log('\n== self-description/1: producer ⇔ consumer agreement (no fork) ==');
  // The contract exists so the LIVE projection (runtime.describe(), this lane)
  // and the STATIC projection (computeSelfDescription on the bytes — the CLI
  // consumer's path) cannot disagree about what the file is. Assert they agree on
  // every shared contract field, for the same presentation container. (blocks is
  // intentionally excluded: static reads INLINE_DOC before the runtime backfills
  // data-rwa-id, so the live count is legitimately higher; source/activeView
  // differ by design — static omits the live-only ones.)
  const liveSD = deck.window.runtime.describe();
  const staticSD = computeSelfDescription(deck.html);
  check('both projections carry the same rwa tag', liveSD.rwa === staticSD.rwa);
  check('live and static agree on uuid', liveSD.uuid === staticSD.uuid);
  check('live and static agree on kind', liveSD.kind === staticSD.kind);
  check('live and static agree on affordance KINDS (SD-03 across surfaces)',
    eq(liveSD.affordances.map(a => a.kind).sort(), staticSD.affordances.map(a => a.kind).sort()));
  check('live and static agree on frozenZones (SD-04)', eq(liveSD.frozenZones, staticSD.frozenZones));
  check('static projection carries no live-only activeView (SD-05)', !('activeView' in staticSD));

  console.log('\n== self-description/1: the ⓘ "what is this?" human panel ==');
  const infoBtn = doc.document.getElementById('rwa-st-info');
  const panel = doc.document.getElementById('rwa-info-panel');
  check('the ⓘ button is present in the runtime chrome', !!infoBtn);
  check('the info panel element exists', !!panel);
  check('panel starts closed', !panel.classList.contains('open'));
  infoBtn.onclick();
  check('clicking ⓘ opens the panel', panel.classList.contains('open'));
  const prose = panel.textContent;
  check('panel names the kind (it tells the human what this is)', /document/.test(prose));
  check('panel shows the title', /Quarterly Plan/.test(prose));
  check('panel surfaces the locked region', /signature/.test(prose) && /locked region/.test(prose));
  check("panel carries the thesis line 'the file knows what it is'", /knows what it is/i.test(prose));
  // Mutually exclusive with settings: opening the cog closes info, and vice-versa.
  doc.document.getElementById('rwa-st-cog').onclick();
  check('opening settings closes the info panel (panels are mutually exclusive)', !panel.classList.contains('open'));

  // SD-06 — self-description writes nothing to the agent-facing source. describe()
  // is a pure read and the panel renders into chrome (outside #rwa-doc-mount), so
  // the document the agent edits must be byte-unchanged and carry no manifest.
  const before = doc.window.getCurrentDocCache();
  doc.window.runtime.describe();
  infoBtn.onclick(); // re-open, re-render the panel
  const after = doc.window.getCurrentDocCache();
  check('SD-06: agent-facing source unchanged by describe()/panel', before === after);
  check('SD-06: agent-facing source carries no self-description manifest', !/self-description\/1/.test(after) && !/rwa-info-panel/.test(after));

  console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
