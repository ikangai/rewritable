// Failure-hint coverage + the document size meter (#24).
//
// PART A is a cross-site gate, not a unit test. The retry loop feeds a failed
// edit back to the model as a structured tool_result, and FAILURE_HINTS is the
// only part of that payload written for a reader. Eight codes the battery could
// already throw had no entry, so the model got a bare code and burned its
// remaining attempts guessing — target_size_exceeded worst of all, since it
// retried three times at a size that could never succeed.
//
// Rather than pin the eight (which would go stale the moment a ninth appears),
// this derives the requirement FROM the seed: every RwaEditError code thrown by
// the validation battery must have a hint, and every code NOT in the battery
// must be listed below with a reason. A new code lands in neither list and fails
// here, forcing the author to decide which it is. Same discipline as
// cli/tests/workflow-prompt-parity.test.mjs.
//
// PART B pins the meter itself: the 1 MB text budget the edit contract enforces
// had no user-facing signal at all, unlike images (warn at 5 MB) and browser
// storage (warn at 80% of quota).
//
// Run:  (cd tests && node doc-budget.mjs)

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto, { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { FAILURE_HINTS as CLI_HINTS } from '../cli/src/apply-edits.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = fs.readFileSync(path.join(__dirname, '..', 'seeds', 'rewritable.html'), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

// ── Part A: which codes must carry a hint ───────────────────────────────────
// The validation battery: everything the model's output is checked against, plus
// the tool-dispatch guard. A failure from any of these is handed back to the
// model, so a failure from any of these needs words a model can act on.
const BATTERY_FNS = new Set([
  'applyEdits', 'replaceDocument', 'replaceDocumentStripped',
  'compileDslPlan', 'compileDslReplace', 'compileDslInsert', 'compileDslDelete',
  'compileDslSetAttr', 'contextualizeDslEdit',
  'assertNoNewAssetTokens', 'expandImages',
]);

// Codes that never reach the model. Each needs a reason, so that adding one is a
// decision someone made rather than a line someone copied.
const NOT_MODEL_FACING = {
  concurrent_modify: 'thrown before the loop starts — a second ⌘K, not a bad edit',
  advisor_cap_reached: 'runtime.agents API misuse, surfaced to the caller',
  agent_not_found: 'runtime.agents API misuse, surfaced to the caller',
  unverified_agent: 'runtime.agents API — a signature failure, not an edit failure',
  no_active_agent: 'runtime.agents API misuse, surfaced to the caller',
  invalid_agent_message: 'runtime.agents API misuse, surfaced to the caller',
  unknown_skin: 'the ✦ skin chip passed a name that is not in RWA_SKINS — UI path',
  anchor_unresolved: 'inline-edit surface: the user\'s own block vanished mid-edit',
  region_not_found: 'runtimeRegionCommit — runtime-owned primitive, never the agent',
  region_overlap: 'runtimeRegionCommit — runtime-owned primitive, never the agent',
  region_escaped: 'runtimeRegionCommit — runtime-owned primitive, never the agent',
  region_not_refrozen: 'runtimeRegionCommit — runtime-owned primitive, never the agent',
  compose_requires_apply_edits: 'skin compose path calling modify() wrongly — internal API misuse',
  model_declined: 'the model refused in prose; a hint cannot make it comply',
  empty_response: 'the backend returned nothing; retrying is the runtime\'s job, not the model\'s',
};

// Map each throw site to its enclosing function (parser-free, like the other
// seed pins — the rules live in the frozen head and need no boot).
const fnRe = /\n(?:async )?function ([a-zA-Z_][a-zA-Z0-9_]*)/g;
const fns = [];
for (let m; (m = fnRe.exec(seed));) fns.push({ i: m.index, name: m[1] });
const owners = new Map();
for (const t of seed.matchAll(/RwaEditError\(\s*.([a-z_]+)./g)) {
  let owner = '(top)';
  for (const f of fns) { if (f.i < t.index) owner = f.name; else break; }
  if (!owners.has(t[1])) owners.set(t[1], new Set());
  owners.get(t[1]).add(owner);
}

const hintsBlock = seed.slice(seed.indexOf('const FAILURE_HINTS = {'), seed.indexOf('function failureToToolResult'));
const hinted = new Set([...hintsBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map(m => m[1]));

console.log('== A: every code the model can be handed carries a hint ==');
check('the seed still has a FAILURE_HINTS block', hinted.size > 0);
check('throw sites were found to classify', owners.size > 10);

const mustHint = [...owners.keys()]
  .filter(code => [...owners.get(code)].some(fn => BATTERY_FNS.has(fn)))
  .sort();
// unknown_tool is thrown in modify() itself when the model names a tool that
// does not exist — dispatch, not validation, but it IS the model's mistake and
// it IS fed back, so it belongs on the hinted side.
mustHint.push('unknown_tool');

for (const code of mustHint) {
  check(`"${code}" (validation battery) has a hint`, hinted.has(code));
}

const unclassified = [...owners.keys()]
  .filter(c => !mustHint.includes(c) && !(c in NOT_MODEL_FACING))
  .sort();
check(`every failure code is classified — hinted or explicitly not model-facing${unclassified.length ? ' [' + unclassified.join(', ') + ']' : ''}`,
  unclassified.length === 0);

// The CLI mirrors the apply path by hand (no cmp gate), so a hint added to one
// side and not the other means the same failure explains itself in the browser
// and stays mute in `rwa edit`.
console.log('\n== A2: the CLI mirror carries the same hints ==');
for (const code of mustHint) {
  check(`cli/src/apply-edits.mjs mirrors the hint for "${code}"`,
    Object.prototype.hasOwnProperty.call(CLI_HINTS, code));
}

// ── Part B: the meter ───────────────────────────────────────────────────────
async function boot(body) {
  const ov = kindOverrides('document');
  const uuid = crypto.randomUUID();
  let html = applySeedSubs(seed, {
    uuid, title: 'DB', fileMeta: 'db.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => {
    const s = e?.detail?.message || String(e?.detail || e);
    if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s);
  });
  const dom = new JSDOM(html, {
    url: 'https://rwa-db.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (window.runtime && typeof window.runtime.applyEnvelope === 'function') break;
    await tick();
  }
  for (let i = 0; i < 30; i++) await tick();
  return { window, uuid };
}
const meter = (w) => {
  const t = w.document.querySelector('.rwa-lens-toast[data-kind="docsize-warn"]');
  return t ? t.textContent : null;
};

console.log('\n== B: the document size meter ==');
const small = await boot('<article><p>a short document</p></article>');
check('an ordinary document shows no size warning', meter(small.window) === null);

// ~88% of the 1 MB budget. Deliberately a FEW LONG paragraphs rather than many
// short ones: byte count is what the budget measures, but block count is what
// boot pays for (every anchorable block gets a data-rwa-id). The first draft of
// this test used 12k paragraphs and took minutes — same bytes, wrong shape.
const sentence = 'Quarterly figures are reconciled against the ledger before publication. ';
const longPara = '<p>' + sentence.repeat(Math.ceil((1024 * 90) / sentence.length)) + '</p>';
const big = await boot('<article>' + longPara.repeat(10) + '</article>');
const bigText = meter(big.window);
check('a document near its budget says so', typeof bigText === 'string' && /edit budget/.test(bigText));
check('the warning reports a percentage the user can act on', /\b8[0-9]%|\b9[0-9]%/.test(bigText || ''));
if (bigText) console.log('       ' + bigText);

// Images are the case a naive byte count gets wrong: the cap applies to the
// virtualized form, so a document that is mostly image data has plenty of edit
// budget left and must not be warned about.
const dataUri = 'data:image/png;base64,' + 'A'.repeat(900 * 1024);
const imgDoc = await boot('<article><p>one line of prose</p><img src="' + dataUri + '" alt="chart"></article>');
check('a document that is mostly image bytes is NOT warned (the cap is on the virtualized form)',
  meter(imgDoc.window) === null);

for (const t of [small, big, imgDoc]) { try { t.window.close(); } catch (_) { /* best effort */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
