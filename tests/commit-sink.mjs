// commit-sink characterization test for seeds/rewritable.html.
//
// The hosted live-editable projection (built in later tasks) must make a SERVER
// the authoritative apply path: the browser hands the rwa-edit/1 envelope to the
// server, the server applies + persists, and the browser mirrors the server's
// canonical doc locally. The seed's commit path is closure-private, so we add ONE
// additive, guarded hook at the single shared low-level write funnel — commitDoc.
// When the hook (window.__rwaCommitSink) is unset, commitDoc must be byte-identical
// to today.
//
// WHY these tests (Rule 9 — test the invariant, not the mechanics):
//   (A) UNSET → INVISIBLE. The seam must not change one byte of behavior when no
//       sink is installed: the normal three-store IDB transaction (rwa_doc + the
//       rwa_undo frame + the rwa_hist record) still runs for BOTH commit kinds.
//       A regression here breaks every non-hosted container.
//   (B) SET → SERVER IS AUTHORITY. With a sink, commitDoc must reconstruct the
//       rwa-edit/1 envelope (the agent's edits[] for edit_batch; a {doc,reason}
//       envelope for replace_document), hand it to the sink, and mirror ONLY the
//       server's returned doc into rwa_doc — writing NO local rwa_undo/rwa_hist
//       (history is server-side in hosted mode). Mirroring keeps getDoc()/reload
//       consistent with the server.
//   (C) THROWING SINK → NO LOCAL ADVANCE. If the server POST fails, the commit
//       must reject and leave rwa_doc unchanged — local stays == server, never
//       ahead of it.
//
// Written test-first (TDD): RED on the pre-seam seed (no window.__rwaCommitSink
// branch → sink ignored → (B)/(C) fail); GREEN once the seam lands.
//
// Run:  (cd tests && node commit-sink.mjs)

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

async function boot(body) {
  const ov = kindOverrides('document');
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'CS', fileMeta: 'cs.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-cs.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
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
    if (window.runtime && typeof window.runtime.applyEnvelope === 'function' && typeof window.getDoc === 'function') break;
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
const codeOf = (e) => (e && (e.code || e.message) || '').toString();
// apply_edits envelope (find/replace) and replace_document envelope ({doc,reason}).
const editEnv = (find, replace) => ({ version: 'rwa-edit/1', edits: [{ find, replace }] });
const replaceEnv = (doc, reason) => ({ version: 'rwa-edit/1', doc, reason });

(async () => {
  console.log('== commit-sink: additive guarded commitDoc hook (window.__rwaCommitSink) ==');

  // ── (A) UNSET → byte-identical: the seam is invisible. ──────────────────────
  // Both an apply_edits and a replace_document commit must run the normal
  // three-store transaction: rwa_doc gets the applied result, rwa_undo grows by a
  // frame, rwa_hist gets a record. If the seam leaked, one of these would change.
  {
    const a = await boot('<article><p>alpha unset</p></article>');
    check('(A0) sink is unset by default', typeof a.window.__rwaCommitSink !== 'function');

    const undoBefore = ((await readStore(a.uuid, 'rwa_undo')) || []).length;
    const histBefore = ((await readStore(a.uuid, 'rwa_hist')) || []).length;

    // apply_edits
    await a.window.runtime.applyEnvelope(editEnv('alpha unset', 'ALPHA EDITED'), { surface: 'unset:apply' });
    await tick();
    check('(A1) apply_edits committed the applied result to rwa_doc', /ALPHA EDITED/.test(await a.window.getDoc()));
    const undoAfter1 = ((await readStore(a.uuid, 'rwa_undo')) || []).length;
    const histAfter1 = ((await readStore(a.uuid, 'rwa_hist')) || []).length;
    check('(A2) apply_edits pushed exactly one rwa_undo frame', undoAfter1 - undoBefore === 1);
    check('(A3) apply_edits appended exactly one rwa_hist record (kind edit_batch)',
      histAfter1 - histBefore === 1 && ((await readStore(a.uuid, 'rwa_hist')) || [])[0].kind === 'edit_batch');

    // replace_document (envelope.doc → routed through replaceDocument)
    await a.window.runtime.applyEnvelope(
      replaceEnv('<article><p>WHOLE REPLACE</p></article>', 'unset replace test'), { surface: 'unset:replace' });
    await tick();
    check('(A4) replace_document committed the new doc to rwa_doc', /WHOLE REPLACE/.test(await a.window.getDoc()));
    const undoAfter2 = ((await readStore(a.uuid, 'rwa_undo')) || []).length;
    const histArr2 = (await readStore(a.uuid, 'rwa_hist')) || [];
    check('(A5) replace_document pushed exactly one more rwa_undo frame', undoAfter2 - undoAfter1 === 1);
    check('(A6) replace_document appended exactly one more rwa_hist record (kind replace_document)',
      histArr2.length - histAfter1 === 1 && histArr2[0].kind === 'replace_document');
  }

  // ── (B) SET → envelope reconstructed + local mirror + NO local history. ─────
  {
    const SERVER_DOC = '<article><p>SERVER CANONICAL DOC</p></article>';
    const captured = [];
    const b = await boot('<article><p>beta source</p></article>');
    const baseBefore = await b.window.getDoc();
    const undoBefore = ((await readStore(b.uuid, 'rwa_undo')) || []).length;
    const histBefore = ((await readStore(b.uuid, 'rwa_hist')) || []).length;

    b.window.__rwaCommitSink = async (envelope, histRecord, baseDoc) => {
      captured.push({ envelope, histRecord, baseDoc });
      return SERVER_DOC;
    };

    // apply_edits → the agent's edits[] envelope is handed over verbatim.
    await b.window.runtime.applyEnvelope(editEnv('beta source', 'beta changed'), { surface: 'set:apply' });
    await tick();
    const c1 = captured[0];
    check('(B1) apply_edits → sink received the agent envelope {version, edits:[...]}',
      !!c1 && JSON.stringify(c1.envelope) === JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'beta source', replace: 'beta changed' }] }));
    check('(B2) apply_edits → sink received the pre-edit base doc as baseDoc', !!c1 && c1.baseDoc === baseBefore);
    check('(B3) apply_edits → rwa_doc mirrors the SERVER doc (not the locally-applied result)',
      (await b.window.getDoc()) === SERVER_DOC);
    check('(B4) apply_edits → getDoc() returns the SERVER doc', (await b.window.getDoc()) === SERVER_DOC);

    // replace_document → reconstructed {version, doc:<newDoc>, reason:<reason>}.
    await b.window.runtime.applyEnvelope(
      replaceEnv('<article><p>local replace newdoc</p></article>', 'set replace reason'), { surface: 'set:replace' });
    await tick();
    const c2 = captured[1];
    check('(B5) replace_document → sink received reconstructed {version, doc:<newDoc>, reason:<reason>}',
      !!c2 && JSON.stringify(c2.envelope) === JSON.stringify({
        version: 'rwa-edit/1', doc: '<article><p>local replace newdoc</p></article>', reason: 'set replace reason' }));
    check('(B6) replace_document → rwa_doc still mirrors the SERVER doc', (await b.window.getDoc()) === SERVER_DOC);

    // The load-bearing invariant: in sink mode history lives server-side. No local
    // rwa_undo frame, no local rwa_hist record was written by either commit.
    const undoAfter = ((await readStore(b.uuid, 'rwa_undo')) || []).length;
    const histAfter = ((await readStore(b.uuid, 'rwa_hist')) || []).length;
    check('(B7) NO local rwa_undo frame written in sink mode (history is server-side)', undoAfter === undoBefore);
    check('(B8) NO local rwa_hist record written in sink mode (history is server-side)', histAfter === histBefore);
  }

  // ── (C) THROWING SINK → no local advance (local stays == server). ───────────
  {
    const c = await boot('<article><p>gamma stays put</p></article>');
    const baseBefore = await c.window.getDoc();
    c.window.__rwaCommitSink = async () => { throw new Error('server_post_failed'); };
    let err = null;
    await c.window.runtime.applyEnvelope(editEnv('gamma stays put', 'should not land'), { surface: 'throw:apply' })
      .catch(e => { err = e; });
    await tick();
    check('(C1) a throwing sink rejects the commit', err !== null && /server_post_failed/.test(codeOf(err)));
    check('(C2) rwa_doc is UNCHANGED (still the pre-edit base — local == server)',
      (await c.window.getDoc()) === baseBefore);
  }

  console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
