// Affordance edit-surface test for examples/datatable/datatable.html.
//
// The datatable is the blog's flagship "a file knows what it is" artifact: a
// self-contained rewritable carrying a grid View, a model-free cell
// Edit-surface, deterministic Compute columns, and a self-description manifest.
// This test loads it in jsdom and drives a REAL cell edit through the runtime's
// model-free path (runtime.applyEnvelope → synthesizeAndCommit), asserting the
// edit lands in rwa_doc + rwa_hist (surface-labelled), the computed column
// stays consistent, undo reverts, and invalid input is vetoed.
//
// Run:  (cd tests && npm install && node datatable.mjs)
// Exits non-zero on any failure.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(__dirname, '..', 'examples', 'datatable', 'datatable.html');
const RWA_BIN = path.join(__dirname, '..', 'cli', 'bin', 'rwa.mjs');
const html = fs.readFileSync(ARTIFACT, 'utf8');
const UUID = (html.match(/const DOC_UUID = '([0-9a-f-]{36})';/) || [])[1];

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: 'https://rwa-datatable.local/',
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
const { document } = window;

async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await tick(); }
  return pred();
}
const storedRows = () => JSON.parse(document.getElementById('dt-data').textContent);
const grid = () => document.getElementById('dt-grid');
const cellDiv = (r, c) => grid().querySelector('.dt-cell[data-row="' + r + '"][data-col="' + c + '"]');
const totalCellText = (r) => grid().querySelectorAll('tbody tr')[r].querySelector('.dt-total').textContent;
const grandTotalText = () => grid().querySelector('tfoot td.num').textContent;
// Wait for the edit-surface's serialized commit chain to fully settle (the
// runtime frees its modify mutex only after re-render, so the DOM updates
// before the commit is truly done). Awaiting window.__dtBusy makes the next
// action deterministic rather than racing the mutex release.
const settle = async () => { await (window.__dtBusy || Promise.resolve()); await tick(); await tick(); };

// Read an internal rwa_* store straight from IDB (runtime owns these; not on
// the public runtime.db surface). Newest hist record is at index 0 (unshift).
function readStore(store, key = 'self') {
  return new Promise((res, rej) => {
    const req = indexedDB.open('rwa_' + UUID);
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

// Simulate a human editing a cell: click it (delegated handler swaps in an
// <input>), set the value, press Enter. Returns after the keydown dispatch;
// the caller waits for the async commit to settle.
function editCell(r, c, value) {
  const cell = cellDiv(r, c);
  cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const input = cell.querySelector('input.dt-edit');
  if (!input) throw new Error('no input appeared for cell ' + r + ',' + c);
  input.value = String(value);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

(async () => {
  console.log('== Datatable affordance edit-surface ==');

  const ready = await waitFor(() => window.runtime && typeof window.runtime.applyEnvelope === 'function' && grid() && grid().querySelector('table.dt'));
  check('bootstrap settled — runtime.applyEnvelope exposed + grid rendered', ready);
  check('no bootstrap error', !document.body.textContent.startsWith('Bootstrap error'));

  // ── Self-description: the file knows what it is (readable without running JS),
  // shaped to the ratified self-description/1 contract (bohr's RFC).
  const manifest = JSON.parse(document.getElementById('rwa-affordances').textContent);
  check('manifest is schema "self-description/1"', manifest.schema === 'self-description/1');
  check('declares kind "datatable"', manifest.kind === 'datatable');
  check('affordances are the type-added providers (2×view + edit-surface + compute; no substrate-universals)',
    manifest.affordances.map(a => a.kind).sort().join(',') === 'compute,edit-surface,view,view');
  check('every declared affordance carries kind + name + provenance (Provider shape)',
    manifest.affordances.every(a => a.kind && a.name && a.provenance === 'first-party'));

  // ── Initial render: View + Compute.
  check('grid renders 6 data rows', grid().querySelectorAll('tbody tr').length === 6);
  // Events: 1×12000 = 12000.
  check('row 0 computed total = $12,000', totalCellText(0) === '$12,000');
  // 12000+13500+6400+6800+870+1500 = 41070.
  check('grand total = $41,070', grandTotalText() === '$41,070');

  const histBefore = (await readStore('rwa_hist')) || [];

  // ── KEYSTONE: model-free Edit-surface. Change row 0 qty 1 → 2.
  editCell(0, 2, '2'); await settle();            // col 2 = qty
  check('cell edit persisted into stored rwa_doc (qty 1 → 2)', storedRows()[0].qty === 2);
  check('compute column recomputed: row 0 total = $24,000', totalCellText(0) === '$24,000');
  check('grand total recomputed = $53,070', grandTotalText() === '$53,070');

  const histAfter = (await readStore('rwa_hist')) || [];
  check('edit appended exactly one rwa_hist record', histAfter.length === histBefore.length + 1);
  check('hist record is an edit_batch', histAfter[0] && histAfter[0].kind === 'edit_batch');
  check('hist record is surface-labelled "datatable:cell-edit" (audited as client-driven, not agent)',
    histAfter[0] && histAfter[0].surface === 'datatable:cell-edit');

  // ── Undo reverts the cell AND the derived total (Compute can't drift).
  await window.runtime.undo(); await settle();
  check('undo reverts the cell (qty 2 → 1)', storedRows()[0].qty === 1);
  check('undo reverts the computed total back to $12,000', totalCellText(0) === '$12,000');

  // ── Invalid numeric input is vetoed — no commit, no history growth.
  const histPreInvalid = (await readStore('rwa_hist')) || [];
  editCell(0, 2, 'abc'); await settle();
  const histPostInvalid = (await readStore('rwa_hist')) || [];
  check('non-numeric qty rejected — stored data unchanged', storedRows()[0].qty === 1);
  check('rejected edit wrote nothing to history', histPostInvalid.length === histPreInvalid.length);
  check('stale editor input cleaned up after veto', !grid().querySelector('input.dt-edit'));

  // ── Edit-surface also adds rows (same model-free path).
  document.querySelector('.dt-add').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await settle();
  check('add-row appends a row through applyEnvelope', storedRows().length === 7);
  check('new row total computes to $0 (qty 1 × unit 0)', totalCellText(6) === '$0');

  // ── Text edit (Item column) — non-numeric path; rapid succession after a
  // commit (exercises the serialized commit chain, not just a lone edit).
  editCell(1, 1, 'Paid search & display'); await settle();
  check('text-column edit persists (serialized behind the add-row commit)',
    storedRows()[1].item === 'Paid search & display');
  check('special chars round-trip through stored JSON (no double-escape)',
    storedRows()[1].item === 'Paid search & display');

  // ── Burst: three edits fired back-to-back with NO await between them (fast
  // typing across cells). This is the exact scenario that throws concurrent_modify
  // without serialization — the consumer-side contract R5 must preserve. All three
  // must land, in order, with no lost edit and no error surfaced to the user.
  const histPreBurst = (await readStore('rwa_hist')) || [];
  editCell(2, 2, '5');     // Content     qty        → 5
  editCell(3, 2, '7');     // Design      qty        → 7
  editCell(4, 3, '300');   // Tools       unit_price → 300
  await settle();
  const r = storedRows();
  check('burst edit 1/3 landed (row2 qty=5)', r[2].qty === 5);
  check('burst edit 2/3 landed (row3 qty=7)', r[3].qty === 7);
  check('burst edit 3/3 landed (row4 unit_price=300)', r[4].unit_price === 300);
  const histPostBurst = (await readStore('rwa_hist')) || [];
  check('burst produced exactly 3 commits — none lost, none doubled, no concurrent_modify',
    histPostBurst.length === histPreBurst.length + 3);
  check('no error surfaced to the user during the burst', !document.getElementById('dt-status') || !document.getElementById('dt-status').textContent);

  // ── Tool affordance: an AGENT edits the same data via the rwa-edit/1 contract
  // on #dt-data — through the CLI, no browser. Run against a throwaway copy so
  // the committed artifact stays pristine.
  const tmp = path.join(__dirname, '.dt-tool-probe.html');
  fs.copyFileSync(ARTIFACT, tmp);
  let toolOk = false, toolBody = '';
  try {
    const before = execFileSync('node', [RWA_BIN, 'doc', tmp], { encoding: 'utf8' });
    const m = before.match(/("item":\s*"Brand contractor",\s*"qty":\s*)1/);
    if (m) {
      const env = JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: m[0], replace: m[0].replace(/1$/, '2') }] });
      execFileSync('node', [RWA_BIN, 'edit', tmp], { input: env, encoding: 'utf8' });
      toolBody = execFileSync('node', [RWA_BIN, 'doc', tmp], { encoding: 'utf8' });
      toolOk = /"item":\s*"Brand contractor",\s*"qty":\s*2/.test(toolBody);
    }
  } catch (e) { toolBody = 'ERR ' + (e.stderr || e.message); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  check('Tool affordance: agent edits #dt-data via `rwa edit` (CLI), change visible via `rwa doc`', toolOk);

  console.log(`\n${pass} pass, ${fail} fail`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
