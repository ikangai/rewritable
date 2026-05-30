// R5 ACCEPTANCE GATE — concurrent non-agent commits must serialize, not throw.
//
// Authored by tesla (datatable consumer) as the acceptance fixture for bohr's R5
// write-path refactor (docs/plans/2026-05-30-r5-write-path-design.md). It is RED
// against the pre-R5 seed and GREEN once runtime.applyEnvelope serializes through
// a commit queue instead of throwing concurrent_modify on reentrant entry.
//
// NOT wired into package.json yet — it fails today by design. bohr (seed owner this
// iteration) adds it to the suite when R5 turns it green. Run directly:
//   (cd tests && node r5-concurrent-commit.mjs)
//
// WHY this matters: the datatable hand-serializes direct edits (window.__dtBusy)
// purely to dodge concurrent_modify, because synthesizeAndCommit frees modifyMutex
// only AFTER renderDoc — a fast second applyEnvelope lands in a held mutex. R5
// moves that serialization INTO the runtime so no edit-surface has to reinvent it.
// Two concurrent applyEnvelope calls (the simplest reproduction of fast typing /
// compute cascades) must BOTH commit, in order, with neither surfacing
// concurrent_modify to the caller.

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

// Minimal document container with two distinct, uniquely-anchorable edit sites.
const ov = kindOverrides('document');
let html = fs.readFileSync(SEED, 'utf8');
html = applySeedSubs(html, {
  uuid: crypto.randomUUID(), title: 'Concurrent commit fixture', fileMeta: 'fixture.html',
  productKind: 'document', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
  productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
});
html = replaceInlineDoc(html, '<article>\n<h1>Concurrent commit fixture</h1>\n<p>alpha-marker-one</p>\n<p>beta-marker-two</p>\n</article>');

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log('  OK  ', label); } else { fail++; console.log('  FAIL', label); } };
const tick = () => new Promise(r => setTimeout(r, 0));

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: 'https://rwa-fixture.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
  beforeParse(window) {
    window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
    window.sessionStorage.setItem('rwa_apikey', 'test-key'); window.sessionStorage.setItem('rwa_model', 'test-model');
    window.fetch = async () => { throw new Error('no network in this test'); };
    Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  },
});
const { window } = dom;
async function waitFor(p, ms = 2000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return true; await tick(); } return p(); }

(async () => {
  console.log('== R5 acceptance gate: concurrent non-agent commits ==');
  await waitFor(() => window.runtime && typeof window.runtime.applyEnvelope === 'function');
  const stored = async () => await window.getDoc();

  // Fire two non-overlapping edits WITHOUT awaiting between them. Pre-R5 the second
  // lands in a held modifyMutex and rejects concurrent_modify; post-R5 both queue.
  const p1 = window.runtime.applyEnvelope(
    { version: 'rwa-edit/1', edits: [{ find: 'alpha-marker-one', replace: 'ALPHA-DONE' }] }, { surface: 'test:edit-a' });
  const p2 = window.runtime.applyEnvelope(
    { version: 'rwa-edit/1', edits: [{ find: 'beta-marker-two', replace: 'BETA-DONE' }] }, { surface: 'test:edit-b' });
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  await tick(); await tick();

  const concMod = [r1, r2].filter(r => r.status === 'rejected' && /concurrent_modify/.test(String(r.reason && (r.reason.code || r.reason.message)))).length;
  check('neither concurrent applyEnvelope surfaced concurrent_modify', concMod === 0);

  const doc = await stored();
  check('first edit committed (ALPHA-DONE present)', /ALPHA-DONE/.test(doc) && !/alpha-marker-one/.test(doc));
  check('second edit committed (BETA-DONE present) — not lost to the race', /BETA-DONE/.test(doc) && !/beta-marker-two/.test(doc));

  console.log(`\n${pass} pass, ${fail} fail` + (fail ? '   ← RED until R5 lands (expected pre-R5)' : '   ← GREEN: R5 serializes commits'));
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
