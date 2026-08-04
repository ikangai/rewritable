// hosted-bless-parity test for seeds/rewritable.html.
//
// THE BUG (Option C target): in hosted/sink mode the server is the authoritative
// store and serves its un-blessed body verbatim as INLINE_DOC. The client's commit
// sink computes baseHash = sha256(canonLF(currentDoc)); the server computes
// baseBodyHash = sha256(canonLF(extractInlineDoc(stored bytes))). For a fresh edit
// to 200 (not false-409), these MUST be equal.
//
// But the seed's BOOT step blesses data-rwa-id (random ids) into the doc and writes
// it back to IDB rwa_doc (seeds/rewritable.html ~line 6140). So getDoc()→currentDoc
// carries data-rwa-id the server's stored body lacks → baseHash !== baseBodyHash →
// EVERY hosted edit false-409s. (Random ids also can't be reproduced server-side.)
//
// FIX (Option C): a second guarded seam — window.__rwaSuppressBlockIds. When the
// hosted shim sets it (it runs before the bootstrap IIFE), the boot blessing is
// skipped, the persisted rwa_doc stays un-blessed, and client/server hashes agree.
// The doc self-blesses on the first LOCAL (file://) open after export, where the
// flag is unset.
//
// WHY these tests (Rule 9 — test the invariant, not the mechanics):
//   (PARITY) With the flag SET before boot, the persisted rwa_doc must carry NO
//       data-rwa-id, and its sha256(canonLF(body)) must EQUAL the server's
//       baseBodyHash for the SAME stored bytes — the exact equality the commit sink
//       depends on. A meaningful test needs a body with ≥1 anchorable block (a <p>),
//       because that's what WOULD be blessed without suppression.
//   (DEFAULT PRESERVED) With the flag UNSET, the boot blessing still happens — the
//       persisted rwa_doc DOES carry data-rwa-id on the anchorable block. The guard
//       must be byte-identical-when-unset: every file:// / share / CLI container is
//       unchanged.
//
// Written test-first (TDD): RED on the pre-guard seed (the SET-flag case still
// blesses → hashes differ); GREEN once the boot guard lands.
//
// Run:  (cd tests && node hosted-bless-parity.mjs)

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
// The vendored seed extractor the SERVER uses for baseBodyHash. Replicating the
// server side here (rather than importing the CJS service/lib/hosted.js) keeps the
// test a pure ESM module while computing byte-identical bytes.
import { extractInlineDoc } from '../service/lib/seed.mjs';

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

// The SERVER's baseBodyHash, replicated: sha256 of the LF-canonical editable body,
// extracted from the stored container bytes the same way service/lib/hosted.js does
// (extractInlineDoc → canonLF → sha256). The stored bytes are the FROZEN seed with
// the un-blessed body spliced into INLINE_DOC (exactly what the service serves).
function serverBaseBodyHash(storedBytes) {
  return sha256hex(canonLF(extractInlineDoc(storedBytes)));
}

// Build a fresh container's bytes (the exact string the service stores + serves)
// and boot it in jsdom. `suppress` toggles window.__rwaSuppressBlockIds BEFORE the
// bootstrap IIFE parses — mirroring the hosted shim, which is prepended before
// <script id="rwa-bootstrap">. Each call gets its own DOC_UUID → its own IDB
// namespace, so two boots don't collide.
async function boot(body, { suppress } = {}) {
  const ov = kindOverrides('document');
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'HB', fileMeta: 'hb.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const storedBytes = html; // exactly what the service persists + re-serves
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-hb.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
      // The shim seam under test: set BEFORE the bootstrap IIFE runs, exactly as
      // service/public/hosted-shim.js does (prepended before #rwa-bootstrap).
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
  return { window, uuid, storedBytes };
}

(async () => {
  console.log('== hosted-bless-parity: boot data-rwa-id blessing suppressed in hosted/sink mode ==');

  // The body MUST contain an anchorable block (<p>) so that WITHOUT suppression it
  // WOULD be blessed — that's what makes the parity assertion meaningful.
  const BODY = '<article><h1>Parity</h1><p>hello world, this is an anchorable block.</p></article>';

  // ── (PARITY) flag SET → persisted rwa_doc un-blessed → hashes agree. ─────────
  {
    const b = await boot(BODY, { suppress: true });
    const persisted = await b.window.getDoc();
    check('(P0) suppress flag was observed at boot (window.__rwaSuppressBlockIds === true)',
      b.window.__rwaSuppressBlockIds === true);
    check('(P1) persisted rwa_doc carries NO data-rwa-id (boot blessing suppressed)',
      !/\sdata-rwa-id\s*=/.test(persisted));
    const clientBaseHash = sha256hex(canonLF(persisted));
    const serverHash = serverBaseBodyHash(b.storedBytes);
    check('(P2) sanity: the un-suppressed server body would also be un-blessed (no data-rwa-id in stored INLINE_DOC)',
      !/\sdata-rwa-id\s*=/.test(extractInlineDoc(b.storedBytes)));
    check('(P3) client baseHash === server baseBodyHash (a fresh hosted edit → 200, never a false 409)',
      clientBaseHash === serverHash);
  }

  // ── (DEFAULT PRESERVED) flag UNSET → boot blessing still happens. ───────────
  // Same container shape; the guard must be invisible when the flag is falsy.
  {
    const d = await boot(BODY, { suppress: false });
    const persisted = await d.window.getDoc();
    check('(D0) suppress flag is falsy by default', !d.window.__rwaSuppressBlockIds);
    check('(D1) persisted rwa_doc DOES carry data-rwa-id on the anchorable block (default blessing preserved)',
      /<p\s+data-rwa-id="[a-z0-9]+"/.test(persisted));
    // And the divergence the bug is about: WITHOUT suppression, client baseHash
    // (blessed) does NOT equal the server's un-blessed baseBodyHash — proving the
    // suppression in (P3) is load-bearing, not vacuous.
    const clientBaseHash = sha256hex(canonLF(persisted));
    const serverHash = serverBaseBodyHash(d.storedBytes);
    check('(D2) WITHOUT suppression client baseHash !== server baseBodyHash (this is the bug the flag fixes)',
      clientBaseHash !== serverHash);
  }

  console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
