// NFC anchor normalization (rwa-edit v1.7, 2026-08-10).
//
// WHY this matters: apply_edits matches by exact splice, and Unicode has two
// byte forms for visually identical text (NFC "ü" U+00FC vs NFD "u"+U+0308).
// NFD enters real documents via paste (PDFs, some macOS pipelines); models
// return NFC. Before v1.7 that combination failed with find_not_found on text
// the user cannot visually distinguish — reproduced live 2026-08-08 — and the
// suite contained zero non-ASCII anchors, so nothing could catch it. The fix:
// canonLF canonicalizes to LF + NFC, so doc, find and replace meet in one
// canonical space. Design: docs/plans/2026-08-10-nfc-anchor-normalization-design.md
//
// All non-ASCII fixture bytes are built from \u escapes ON PURPOSE: literal
// NFD characters in this file would not survive an editor (or future repo
// tooling) normalizing the source to NFC, and the test would silently stop
// testing anything.
//
// Run:  (cd tests && npm install && node unicode-anchors.mjs)

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

const NFD_UMLAUT = 'Mu\u0308ller';   // Müller decomposed (u + combining diaeresis)
const NFC_UMLAUT = 'M\u00FCller';     // Müller precomposed
const NFD_ACCENT = 'cafe\u0301';      // café decomposed (e + combining acute)
const NFC_ACCENT = 'caf\u00E9';       // café precomposed
const COMBINING = /[\u0300-\u036F]/; // any surviving decomposed sequence

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
    uuid, title: 'NFC', fileMeta: 'nfc.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-nfc.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
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
  return { window, uuid };
}

const env = (find, replace) => ({ version: 'rwa-edit/1', edits: [{ find, replace }] });

(async () => {
  console.log('== NFC anchor normalization (rwa-edit v1.7) ==');

  // replaceInlineDoc embeds via escapeTL → canonLF, which is now NFC-izing.
  // To get genuinely NFD bytes IN FRONT of the runtime we must check what the
  // runtime actually hydrated; the load-bearing property is that an NFC find
  // matches regardless of which form the document arrived in.
  const b = await boot('<article><p>Herr ' + NFD_UMLAUT + ' war im ' + NFD_ACCENT + '.</p></article>');
  check('runtime.applyEnvelope is exposed', typeof b.window.runtime?.applyEnvelope === 'function');

  const hydrated = b.window.getCurrentDocCache();
  check('hydrated doc is already NFC-canonical (born-canonical embedding)',
    !COMBINING.test(hydrated) && hydrated.includes(NFC_UMLAUT));

  // The load-bearing case: NFC anchor applies cleanly.
  let ok1 = true;
  try { await b.window.runtime.applyEnvelope(env('Herr ' + NFC_UMLAUT, 'Frau ' + NFC_UMLAUT), { surface: 'test:nfc' }); }
  catch (e) { ok1 = false; console.log('       applyEnvelope rejected:', e && (e.code || e.message)); }
  await tick();
  check('NFC find applies against a document authored NFD', ok1);
  check('replacement landed', /Frau/.test(b.window.getCurrentDocCache()));

  // The mirror case: an NFD-authored find (e.g. pasted into a surface that
  // does not normalize) matches the NFC doc.
  let ok2 = true;
  try { await b.window.runtime.applyEnvelope(env(NFD_ACCENT, NFC_ACCENT + ' Central'), { surface: 'test:nfd-find' }); }
  catch (e) { ok2 = false; console.log('       applyEnvelope rejected:', e && (e.code || e.message)); }
  await tick();
  check('NFD find matches the NFC document', ok2);

  // NFD replace content must be stored NFC — the doc never re-accumulates
  // decomposed bytes through the edit path.
  let ok3 = true;
  try { await b.window.runtime.applyEnvelope(env('Central', 'Zentral bei ' + NFD_UMLAUT), { surface: 'test:nfd-replace' }); }
  catch (e) { ok3 = false; console.log('       applyEnvelope rejected:', e && (e.code || e.message)); }
  await tick();
  const finalDoc = b.window.getCurrentDocCache();
  check('NFD replace content applies', ok3);
  check('stored doc carries no decomposed sequences after an NFD replace', !COMBINING.test(finalDoc));
  check('replace content present in NFC form', finalDoc.includes('Zentral bei ' + NFC_UMLAUT));

  // NFC is canonicalization, not fuzziness: a transliterated anchor (ue for ü)
  // is DIFFERENT text and must still fail loud.
  let code4 = null;
  try { await b.window.runtime.applyEnvelope(env('Frau Mueller', 'x'), { surface: 'test:not-fuzzy' }); }
  catch (e) { code4 = String(e && (e.code || e.message) || e); }
  check('transliterated anchor still fails (find_not_found, not fuzzy-matched)',
    !!code4 && /find_not_found/.test(code4));

  console.log(`\n${pass} passed, ${fail} failed`);
  b.window.close();
  process.exit(fail ? 1 : 0);
})();
