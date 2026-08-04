// R5 write-path characterization test for seeds/rewritable.html.
//
// The non-agent commit path (runtime.applyEnvelope → synthesizeAndCommit) is how
// edit-surface / compute affordances write without an LLM in the loop. Today it
// holds modifyMutex through renderDoc and releases only in `finally`, so a rapid
// 2nd non-agent commit throws `concurrent_modify` — forcing every consumer (the
// datatable) to hand-roll a serialization chain (window.__dtBusy). R5 makes
// serialized commits first-class: rapid non-agent commits QUEUE and land in
// order; and applyEnvelope can pass an `actor` so an edit-surface self-attributes
// in rwa_hist instead of being hardcoded 'user:lens'.
//
// WHY these tests: a substrate that throws on its own non-agent write path under
// concurrency is one a consumer cannot trust without re-implementing the
// serialization the substrate should own (Rule 2). And a write path that can't
// attribute its writer lies about who edited the doc (Rule 12 — the actor is the
// audit record). These pin both.
//
// Written test-first (TDD): on the pre-R5 seed the burst test FAILS (2nd/3rd
// applyEnvelope reject with concurrent_modify) and the actor test FAILS (hist
// records 'user:lens'). R5 turns both green without a consumer hand-serializing.
//
// Run:  (cd tests && npm install && node write-path.mjs)

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

// Boot a document container with a custom body (CLAUDE.md ordering: seed subs
// first, then the body into INLINE_DOC). Returns { window, document, uuid }.
async function boot(body) {
  const ov = kindOverrides('document');
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'WP', fileMeta: 'wp.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-wp.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
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
    if (window.runtime && typeof window.runtime.applyEnvelope === 'function') break;
    await tick();
  }
  return { window, document: window.document, uuid };
}

// Read an internal rwa_* store straight from IDB (newest hist record at index 0).
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
const env = (find, replace) => ({ version: 'rwa-edit/1', edits: [{ find, replace }] });

(async () => {
  console.log('== R5 write-path: serialized non-agent commits + actor passthrough ==');

  // ── Burst: three rapid non-agent commits, fired WITHOUT serialization ──
  // This is the exact shape that throws concurrent_modify today (the datatable
  // only survives it by hand-rolling __dtBusy). R5 must serialize them so all
  // three land, in order, with no concurrent_modify and nothing lost.
  const b = await boot('<article><p>alpha</p><p>bravo</p><p>charlie</p></article>');
  check('runtime.applyEnvelope is exposed', typeof b.window.runtime?.applyEnvelope === 'function');
  const histBefore = ((await readStore(b.uuid, 'rwa_hist')) || []).length;

  // Fire all three with NO await between — no consumer-side serialization.
  const results = await Promise.allSettled([
    b.window.runtime.applyEnvelope(env('alpha', 'ALPHA'), { surface: 'burst:1' }),
    b.window.runtime.applyEnvelope(env('bravo', 'BRAVO'), { surface: 'burst:2' }),
    b.window.runtime.applyEnvelope(env('charlie', 'CHARLIE'), { surface: 'burst:3' }),
  ]);
  await tick(); await tick();

  const rejected = results.filter(r => r.status === 'rejected');
  const concurrentRejects = rejected.filter(r => (r.reason && (r.reason.code || r.reason.message) || '').toString().includes('concurrent_modify'));
  check('no commit rejected with concurrent_modify (the substrate serialized them)', concurrentRejects.length === 0);
  check('all three commits resolved (none lost)', results.every(r => r.status === 'fulfilled'));

  const doc = b.window.getCurrentDocCache();
  check('burst edit 1/3 landed (alpha→ALPHA)', /ALPHA/.test(doc));
  check('burst edit 2/3 landed (bravo→BRAVO)', /BRAVO/.test(doc));
  check('burst edit 3/3 landed (charlie→CHARLIE)', /CHARLIE/.test(doc));

  const histAfter = ((await readStore(b.uuid, 'rwa_hist')) || []).length;
  check('exactly 3 commits recorded — none doubled, none lost', histAfter - histBefore === 3);

  // ── Actor passthrough: an edit-surface self-attributes in rwa_hist ──
  const a = await boot('<article><p>seed text here</p></article>');
  await a.window.runtime.applyEnvelope(env('seed text here', 'edited by the surface'),
    { surface: 'datatable:cell-edit', actor: 'user:edit-surface' });
  await tick();
  const newest = ((await readStore(a.uuid, 'rwa_hist')) || [])[0];
  check('hist record exists for the applyEnvelope commit', !!newest);
  check("applyEnvelope({actor}) self-attributes — rwa_hist records 'user:edit-surface', not hardcoded 'user:lens'",
    !!newest && newest.actor === 'user:edit-surface');
  // Back-compat: a caller that passes no actor still records the lens default.
  const c = await boot('<article><p>default actor case</p></article>');
  await c.window.runtime.applyEnvelope(env('default actor case', 'changed'), { surface: 'visual:wf-drag' });
  await tick();
  const def = ((await readStore(c.uuid, 'rwa_hist')) || [])[0];
  check("no actor passed → defaults to 'user:lens' (back-compat)", !!def && def.actor === 'user:lens');

  console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
