// Boot reconciliation test for seeds/rewritable.html.
// docs/plans/2026-08-04-boot-reconciliation-design.md
//
// THE BUG: getDoc() consults INLINE_DOC only when the IDB record is literally
// null. Any prior IDB record wins however stale, with no comparison of any
// kind — so an external edit (git pull, restored backup, another editor) to
// the file's own bytes is silently discarded on next open.
//
// THE FIX: rwa_state['doc_baseline'] = { baseHash, at } records sha256(canonLF
// (body)) at exactly two moments — hydration and a successful save (§3.2).
// reconcileBootDoc() compares a fresh hash of INLINE_DOC against that baseline
// at every boot, BEFORE block-id blessing runs (blessing rewrites rwa_doc on
// every fresh open and must never read as divergence — §2, the load-bearing
// hazard this design exists to avoid). The decision table (§3.3):
//   baseline absent          -> today's behaviour (IDB wins); record a baseline
//   baseline present, same   -> IDB wins (unchanged)
//   baseline present, changed, dirty_count===0 -> adopt the file
//   baseline present, changed, dirty_count>0   -> ask (persistent bar, block ⌘S)
//
// Written test-first against the design doc's own §5 table (scenarios A1-D2).
//
// Run:  (cd tests && node boot-reconcile.mjs)

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto, { webcrypto } from 'node:crypto';
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

const canonLF = (s) => (s == null ? '' : String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Boot a document container with a custom body. `uuid` lets a caller reopen the
// SAME container across two boots (two separate JSDOM windows sharing the one
// fake-indexeddb module instance — exactly how a real browser reopening a file
// reuses its rwa_<uuid> database). `suppress` mirrors the hosted shim
// (window.__rwaSuppressBlockIds, set before the bootstrap IIFE runs). `withCrypto`
// toggles the crypto.subtle/TextEncoder shim jsdom otherwise lacks entirely — off
// for C2, which tests the no-crypto degrade path.
async function boot(body, { uuid = crypto.randomUUID(), suppress = false, withCrypto = true } = {}) {
  const ov = kindOverrides('document');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'BR', fileMeta: 'br.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  // The download-commit path clicks a real <a>; jsdom doesn't implement navigation
  // and complains — benign (tests/agents.mjs:40 filters the same way).
  virtualConsole.on('jsdomError', e => {
    const s = e?.detail?.message || e?.detail?.stack || String(e?.detail || e);
    if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s);
  });
  const dom = new JSDOM(html, {
    url: 'https://rwa-br.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
      if (withCrypto) {
        // jsdom has NO crypto.subtle and NO TextEncoder — inject Node's (tests/agents.mjs:42-47).
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
        window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      }
      if (suppress) window.__rwaSuppressBlockIds = true;
    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (window.runtime && typeof window.getDoc === 'function') break;
    await tick();
  }
  await tick();
  return { window, uuid };
}

// Raw IDB reads/writes bypassing the runtime — the runtime's own db.* rejects
// rwa_* as reserved (by design), so a test simulating a PRIOR runtime's state
// (a pre-upgrade baseline, a bumped dirty_count) must go around it, exactly like
// tests/write-path.mjs's readStore.
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
function deleteKey(uuid, store, key = 'self') {
  return new Promise((res, rej) => {
    const req = indexedDB.open('rwa_' + uuid);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      } catch (e) { db.close(); rej(e); }
    };
    req.onerror = () => rej(req.error);
  });
}

// commit() needs URL.createObjectURL/revokeObjectURL, which jsdom doesn't
// implement — same stub tests/lens.mjs uses around runtime.commit().
function stubDownloadUrls(window) {
  window.URL.createObjectURL = () => 'blob:rwa-test/0';
  window.URL.revokeObjectURL = () => {};
}

(async () => {
  console.log('== boot reconciliation: file vs. IndexedDB (docs/plans/2026-08-04-boot-reconciliation-design.md) ==');

  // ── A1: fresh container, no IDB — hydrates, records a baseline ─────────────
  console.log('\n-- A1: fresh container, no prior IDB --');
  {
    const BODY = '<article><h1>A1</h1><p>fresh container.</p></article>';
    const { window, uuid } = await boot(BODY);
    const baseline = await readStore(uuid, 'rwa_state', 'doc_baseline');
    check('A1: baseline recorded on hydration', !!baseline && typeof baseline.baseHash === 'string');
    check('A1: baseHash === H(canonLF(INLINE_DOC))', !!baseline && baseline.baseHash === sha256hex(canonLF(BODY)));
    check('A1: no reconcile bar (nothing to reconcile against yet)',
      !window.document.getElementById('rwa-reconcile-bar'));
  }

  // ── A2: second open, nothing changed — IDB wins, no bar, baseline unchanged ─
  console.log('\n-- A2: second open, file unchanged --');
  {
    const BODY = '<article><h1>A2</h1><p>unchanged across opens.</p></article>';
    const uuid = crypto.randomUUID();
    const first = await boot(BODY, { uuid });
    const baselineAfterFirst = await readStore(uuid, 'rwa_state', 'doc_baseline');

    const second = await boot(BODY, { uuid });
    const baselineAfterSecond = await readStore(uuid, 'rwa_state', 'doc_baseline');
    check('A2: no reconcile bar on the unchanged second open',
      !second.window.document.getElementById('rwa-reconcile-bar'));
    check('A2: baseline record untouched (same "at" timestamp, no rewrite)',
      baselineAfterFirst.at === baselineAfterSecond.at);
    check('A2: rendered content still reflects the doc (IDB won, uneventfully)',
      /unchanged across opens/.test(second.window.document.getElementById('rwa-doc-mount').innerHTML));
  }

  // ── A3: THE §2 HAZARD — blessing rewrote rwa_doc; must NOT read as divergence ─
  console.log('\n-- A3: never-edited container, blessing rewrote rwa_doc --');
  {
    // An anchorable block (<p>) so the boot IIFE's block-id blessing actually
    // has something to bless — this is what makes the test meaningful.
    const BODY = '<article><h1>A3</h1><p>this paragraph gets a data-rwa-id.</p></article>';
    const uuid = crypto.randomUUID();
    const first = await boot(BODY, { uuid });
    const blessedDoc = await first.window.getDoc();
    check('A3 setup: blessing actually rewrote rwa_doc (carries data-rwa-id)',
      /\sdata-rwa-id\s*=/.test(blessedDoc));
    check('A3 setup: the blessed rwa_doc differs from the raw file body (the exact §2 hazard shape)',
      blessedDoc !== BODY);

    // Reopen the SAME unchanged file. If reconciliation compared rwa_doc against
    // INLINE_DOC (instead of baseline-vs-filehash), this would false-positive.
    const second = await boot(BODY, { uuid });
    check('A3: no reconcile bar despite rwa_doc !== INLINE_DOC (blessing is not divergence)',
      !second.window.document.getElementById('rwa-reconcile-bar'));
    const stillBlessed = await second.window.getDoc();
    check('A3: the blessed doc is still what renders (IDB won)', /data-rwa-id/.test(stillBlessed));
  }

  // ── B1: file changed, dirty_count === 0 — adopts the file ───────────────────
  console.log('\n-- B1: file body changed, no unsaved edits --');
  {
    const BODY_1 = '<article><h1>B1</h1><p>original from disk.</p></article>';
    const BODY_2 = '<article><h1>B1</h1><p>edited outside the browser.</p></article>';
    const uuid = crypto.randomUUID();
    await boot(BODY_1, { uuid }); // establishes baseline = H(BODY_1)

    const reopened = await boot(BODY_2, { uuid }); // "the file changed on disk"
    check('B1: no reconcile bar (nothing unsaved — no need to ask)',
      !reopened.window.document.getElementById('rwa-reconcile-bar'));
    const adopted = await reopened.window.getDoc();
    check('B1: rwa_doc adopts the new file body', /edited outside the browser/.test(adopted));
    check('B1: the stale original is gone', !/original from disk/.test(adopted));
    const baseline = await readStore(uuid, 'rwa_state', 'doc_baseline');
    check('B1: baseline advances to the new file hash', baseline.baseHash === sha256hex(canonLF(BODY_2)));
  }

  // ── B2: file changed, dirty_count > 0 — asks, keeps IDB, blocks commit ─────
  console.log('\n-- B2: file body changed, unsaved local edits --');
  {
    const BODY_1 = '<article><h1>B2</h1><p>local unsaved work.</p></article>';
    const BODY_2 = '<article><h1>B2</h1><p>changed outside the browser.</p></article>';
    const uuid = crypto.randomUUID();
    const first = await boot(BODY_1, { uuid }); // establishes baseline = H(BODY_1)
    await first.window.rwaBumpDirtyCount();     // simulate an unsaved local edit before closing

    const divergent = await boot(BODY_2, { uuid }); // reopen against a changed file
    const bar = divergent.window.document.getElementById('rwa-reconcile-bar');
    check('B2: persistent reconcile bar is shown', !!bar && bar.hidden === false);
    const rendered = divergent.window.document.getElementById('rwa-doc-mount').innerHTML;
    check('B2: IDB doc still rendered (the changed file is NOT silently adopted)',
      /local unsaved work/.test(rendered) && !/changed outside the browser/.test(rendered));
    check('B2: divergence state is set', divergent.window.rwaGetDivergence() !== null);

    stubDownloadUrls(divergent.window);
    const dirtyBefore = await divergent.window.rwaGetDirtyCount();
    await divergent.window.runtime.commit();
    const status = divergent.window.document.getElementById('rwa-st-status').textContent;
    check('B2: ⌘S is blocked — status explains why', /conflict/i.test(status));
    check('B2: dirty_count unchanged by the blocked commit (nothing was actually saved)',
      (await divergent.window.rwaGetDirtyCount()) === dirtyBefore && dirtyBefore > 0);
  }

  // ── B3: B2 then "Use the file version" ──────────────────────────────────────
  console.log('\n-- B3: "Use the file version" resolves B2 --');
  {
    const BODY_1 = '<article><h1>B3</h1><p>local unsaved work B3.</p></article>';
    const BODY_2 = '<article><h1>B3</h1><p>changed outside the browser B3.</p></article>';
    const uuid = crypto.randomUUID();
    const first = await boot(BODY_1, { uuid });
    await first.window.rwaBumpDirtyCount();
    const divergent = await boot(BODY_2, { uuid });
    check('B3 setup: divergence bar is up', !!divergent.window.document.getElementById('rwa-reconcile-bar'));
    const supersededDoc = await divergent.window.getDoc();

    await divergent.window.rwaReconcileUseFile();

    check('B3: dirty_count === 0 after adopting the file',
      (await divergent.window.rwaGetDirtyCount()) === 0);
    const undoArr = (await readStore(uuid, 'rwa_undo')) || [];
    check('B3: the prior (superseded) document is recoverable from rwa_undo',
      undoArr.length > 0 && undoArr[undoArr.length - 1] === supersededDoc);
    const adopted = await divergent.window.getDoc();
    check('B3: rwa_doc now carries the file version', /changed outside the browser B3/.test(adopted));
    check('B3: the bar is dismissed', divergent.window.document.getElementById('rwa-reconcile-bar').hidden === true);
    check('B3: commit is unblocked', divergent.window.rwaGetDivergence() === null);
  }

  // ── B4: B2 then "Keep my edits" ─────────────────────────────────────────────
  console.log('\n-- B4: "Keep my edits" resolves B2 --');
  {
    const BODY_1 = '<article><h1>B4</h1><p>local unsaved work B4.</p></article>';
    const BODY_2 = '<article><h1>B4</h1><p>changed outside the browser B4.</p></article>';
    const uuid = crypto.randomUUID();
    const first = await boot(BODY_1, { uuid });
    await first.window.rwaBumpDirtyCount();
    const divergent = await boot(BODY_2, { uuid });
    const dirtyBefore = await divergent.window.rwaGetDirtyCount();
    check('B4 setup: dirty_count > 0 before resolving', dirtyBefore > 0);

    await divergent.window.rwaReconcileKeepMine();

    check('B4: dirty_count is UNCHANGED (edits are still live and unsaved)',
      (await divergent.window.rwaGetDirtyCount()) === dirtyBefore);
    const baseline = await readStore(uuid, 'rwa_state', 'doc_baseline');
    check('B4: baseline advances to the new file hash', baseline.baseHash === sha256hex(canonLF(BODY_2)));
    check('B4: commit is unblocked', divergent.window.rwaGetDivergence() === null);

    // Prove "unblocked" concretely: commit() now proceeds and resets dirty_count.
    stubDownloadUrls(divergent.window);
    await divergent.window.runtime.commit();
    check('B4: a subsequent ⌘S actually proceeds (dirty_count resets to 0)',
      (await divergent.window.rwaGetDirtyCount()) === 0);
  }

  // ── C1: no baseline (pre-upgrade container) + changed file ──────────────────
  console.log('\n-- C1: pre-existing container with no baseline yet --');
  {
    const BODY_1 = '<article><h1>C1</h1><p>pre-upgrade content.</p></article>';
    const BODY_2 = '<article><h1>C1</h1><p>changed after the upgrade.</p></article>';
    const uuid = crypto.randomUUID();
    await boot(BODY_1, { uuid }); // real first open: DOES write a baseline...
    await deleteKey(uuid, 'rwa_state', 'doc_baseline'); // ...simulate a pre-upgrade container that never had one

    const reopened = await boot(BODY_2, { uuid });
    check('C1: no reconcile bar (today\'s behaviour on the migration path)',
      !reopened.window.document.getElementById('rwa-reconcile-bar'));
    const rendered = await reopened.window.getDoc();
    check('C1: IDB wins — the pre-upgrade content is what renders, not the new file',
      /pre-upgrade content/.test(rendered) && !/changed after the upgrade/.test(rendered));
    const baseline = await readStore(uuid, 'rwa_state', 'doc_baseline');
    check('C1: a baseline is recorded for next time, from the CURRENT file',
      !!baseline && baseline.baseHash === sha256hex(canonLF(BODY_2)));
  }

  // ── C2: crypto.subtle absent — boots, today's behaviour, no throw ──────────
  console.log('\n-- C2: crypto.subtle unavailable --');
  {
    const BODY = '<article><h1>C2</h1><p>no crypto available.</p></article>';
    const { window, uuid } = await boot(BODY, { withCrypto: false });
    check('C2: boot completed without throwing (runtime is exposed)', typeof window.runtime === 'object');
    check('C2: no reconcile bar', !window.document.getElementById('rwa-reconcile-bar'));
    const baseline = await readStore(uuid, 'rwa_state', 'doc_baseline');
    check('C2: nothing recorded — hashing was unavailable (§3.6 degrade-safe)', baseline == null);
    const rendered = await window.getDoc();
    check('C2: today\'s behaviour — the doc still hydrated and rendered normally',
      /no crypto available/.test(rendered));
  }

  // ── D1: save writes the baseline ────────────────────────────────────────────
  console.log('\n-- D1: a successful ⌘S writes the baseline --');
  {
    const BODY = '<article><h1>D1</h1><p>before save.</p></article>';
    const { window } = await boot(BODY);
    const edited = '<article><h1>D1</h1><p>edited before commit.</p></article>';
    await window.__setDocForTest(edited);
    stubDownloadUrls(window);
    await window.runtime.commit();
    const docAtCommit = await window.getDoc();
    const baseline = await readStore(window.runtime.id, 'rwa_state', 'doc_baseline');
    check('D1: baseline === H(canonLF(rwa_doc)) after a successful save',
      !!baseline && baseline.baseHash === sha256hex(canonLF(docAtCommit)));
  }

  // ── D2: __rwaSuppressBlockIds — reconciliation stays inert ──────────────────
  console.log('\n-- D2: hosted shim (window.__rwaSuppressBlockIds) --');
  {
    const BODY_1 = '<article><h1>D2</h1><p>hosted body one.</p></article>';
    const BODY_2 = '<article><h1>D2</h1><p>hosted body two.</p></article>';
    const uuid = crypto.randomUUID();
    const first = await boot(BODY_1, { uuid, suppress: true });
    const persisted1 = await first.window.getDoc();
    check('D2: blessing suppressed (no data-rwa-id — unchanged hosted-bless-parity behaviour)',
      !/\sdata-rwa-id\s*=/.test(persisted1));
    const baselineAfterFirst = await readStore(uuid, 'rwa_state', 'doc_baseline');
    check('D2: reconciliation recorded NO baseline under suppression (fully inert, not just "no bar")',
      baselineAfterFirst == null);

    // Reopen against a DIFFERENT body under the same suppression — reconciliation
    // must not reintroduce divergence handling the hosted shim exists to avoid.
    const second = await boot(BODY_2, { uuid, suppress: true });
    check('D2: still no reconcile bar with the file "changed" under suppression',
      !second.window.document.getElementById('rwa-reconcile-bar'));
    const persisted2 = await second.window.getDoc();
    check('D2: IDB wins as before suppression existed — hosted parity untouched',
      /hosted body one/.test(persisted2) && !/hosted body two/.test(persisted2));
    const baselineAfterSecond = await readStore(uuid, 'rwa_state', 'doc_baseline');
    check('D2: still no baseline recorded (reconciliation never ran)', baselineAfterSecond == null);
  }

  console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
