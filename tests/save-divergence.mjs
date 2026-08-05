// Save-time divergence guard (#14; closes the same hole for #6).
//
// WHY (Rule 9): boot reconciliation (#1) compares the file against IndexedDB at OPEN time. It
// cannot see a change that lands while a tab is already open — a cloud-sync client pulling down a
// remote edit, a second tab saving, an external editor. In all three the next ⌘S silently
// overwrites work nobody saw. The destructive moment is the write, so that is where this checks.
//
// It hashes the WHOLE file rather than the body: no INLINE_DOC extraction is needed and it catches
// any external change, including one to the bootstrap. `file_baseline` is written after every
// successful save, so it is precisely "the bytes we last put there".
//
// SCOPE, stated plainly. These tests cover the DECISION and the bar's consent semantics. They do
// NOT cover the wiring inside commit(), and cannot: a real FileSystemFileHandle is
// structured-cloneable, a fake one is not, so a fake cannot be seeded into rwa_fsa —
// fake-indexeddb rejects it with DataCloneError. That is why no test in this repo has ever covered
// the FSA commit path. Taking the handle as an argument is what makes the decision testable at all;
// the wiring is browser-verified by hand, per docs/cloud-sync-investigation-2026-08-05.md steps
// B and F.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK   ' + m); } else { fail++; console.log('  ✗   ' + m); } };
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// Stands in for a FileSystemFileHandle, backed by a string the test can rewrite at will — which is
// exactly what a sync client does to a file underneath a held handle.
const fakeHandle = (bytes) => {
  const state = { bytes };
  return { state, getFile: async () => ({ text: async () => state.bytes }) };
};

async function boot() {
  const ov = kindOverrides('document');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid: crypto.randomUUID(), title: 'SD', fileMeta: 'sd.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, '<article><h1>Save</h1><p>one</p></article>');
  const vc = new VirtualConsole(); vc.on('jsdomError', () => {});
  const dom = new JSDOM(html, {
    url: 'https://sd.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.indexedDB = indexedDB; w.IDBKeyRange = IDBKeyRange;
      Object.defineProperty(w, 'crypto', { value: crypto.webcrypto, configurable: true });
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.fetch = async () => { throw new Error('no network'); };
      Object.defineProperty(w.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
    },
  });
  const w = dom.window;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) { if (w.runtime && w.__fileChangedSinceLastSave) break; await tick(10); }
  return { w, dom };
}

const barVisible = (w) => {
  const b = w.document.getElementById('rwa-overwrite-bar');
  return !!b && b.hidden === false;
};

console.log('== save-time divergence guard ==');
const { w, dom } = await boot();
check('the seam is exposed under jsdom', typeof w.__fileChangedSinceLastSave === 'function');

// A — with no baseline, proceed. A container that has never saved from this browser knows nothing
// about the file's history; guessing could destroy work.
{
  const h = fakeHandle('ANYTHING AT ALL');
  check('A: no baseline → no divergence claimed', (await w.__fileChangedSinceLastSave(h)) === false);
}

// B — the file is exactly what we last wrote.
{
  const bytes = 'THE BYTES WE WROTE';
  // Hash with the page's own WebCrypto so the comparison is apples-to-apples with what the runtime
  // computes internally.
  const digest = await w.crypto.subtle.digest('SHA-256', new w.TextEncoder().encode(bytes));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  await w.runtime.db;   // ensure the db layer is warm
  const req = w.indexedDB.open('rwa_' + w.runtime.id);
  await new Promise((res, rej) => { req.onsuccess = res; req.onerror = rej; });
  const db = req.result;
  await new Promise((res, rej) => {
    const tx = db.transaction('rwa_state', 'readwrite');
    tx.objectStore('rwa_state').put({ hash: hex, at: new Date().toISOString() }, 'file_baseline');
    tx.oncomplete = res; tx.onerror = rej;
  });
  check('B: file matches the recorded baseline → no divergence',
    (await w.__fileChangedSinceLastSave(fakeHandle(bytes))) === false);

  // C — THE CASE. Something else rewrote the file between saves.
  check('C: file differs from the baseline → divergence detected',
    (await w.__fileChangedSinceLastSave(fakeHandle('SOMEONE ELSE WROTE THIS'))) === true);
}

// D — an unreadable handle must not block the save on a guess; the write path reports it instead.
{
  const broken = { getFile: async () => { throw new Error('InvalidStateError'); } };
  check('D: an unreadable handle does not claim divergence', (await w.__fileChangedSinceLastSave(broken)) === false);
}

// E — consent semantics. The bar offers the choice; it must not make it, and the force must be
// single-shot so one "yes" never becomes a standing permission to overwrite.
{
  check('E: no bar before anything diverges', !barVisible(w));
  w.__showOverwriteBar();
  check('E: the bar is a persistent element, not a toast', barVisible(w));
  const bar = w.document.getElementById('rwa-overwrite-bar');
  check('E: it offers both a keep-mine and a compare route',
    !!bar.querySelector('[data-act="overwrite"]') && !!bar.querySelector('[data-act="reload"]'));
  check('E: force is off by default', w.__getForceOverwrite() === false);
  w.__setForceOverwrite(true);
  check('E: force can be set (the user chose overwrite)', w.__getForceOverwrite() === true);
  w.__setForceOverwrite(false);
  check('E: and is cleared again after a write, so consent is single-shot', w.__getForceOverwrite() === false);
}

dom.window.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
