// Tests for image-asset virtualization (images-v1) in seeds/rewritable.html.
//
// Run from this directory:  node image-assets.mjs
//
// The contract under test (docs/plans/2026-06-10-images-in-rewritables-design.md):
// image bytes live in the doc as data:image URIs, but the agent and the
// rwa-edit/1 caps only ever see compact `rwa-asset:<hash8>` tokens. The
// virtualize/expand pair is the seam everything else stands on, so block A
// pins its round-trip identity byte-for-byte (Rule 9: if round-trip breaks,
// commits would corrupt pixels or undo frames silently).
//
// The test exits non-zero if any assertion fails.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const html = fs.readFileSync(SEED, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: 'https://rwa-test.local/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.sessionStorage.setItem('rwa_apikey', 'test-key');
    window.sessionStorage.setItem('rwa_model', 'test-model');
    window.fetch = async () => { throw new Error('image-assets tests must not call the network'); };
    window.BroadcastChannel = globalThis.BroadcastChannel;
    Object.defineProperty(window.navigator, 'storage', {
      value: { persist: () => Promise.resolve(false) }, configurable: true,
    });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  },
});

const window = dom.window;
const { document } = window;
await new Promise(r => setTimeout(r, 200));
const settle = () => new Promise(r => setTimeout(r, 50));

console.log('== Image-assets harness loaded ==');

// ─── Block A: virtualize/expand core ────────────────────────────────

const URI_A = 'data:image/png;base64,' + 'QUJD'.repeat(120);   // ~480 chars, quote-free like real base64
const URI_B = 'data:image/webp;base64,' + 'ZGVm'.repeat(90);

{
  console.log('-- A1: round-trip identity + dedupe --');
  const doc = '<article>\n<h1>T</h1>\n'
    + '<figure><img src="' + URI_A + '" alt="one"></figure>\n'
    + '<p>between</p>\n'
    + '<figure><img src="' + URI_A + '" alt="dup"></figure>\n'
    + '<figure><img src="' + URI_B + '" alt="two"></figure>\n'
    + '</article>';
  const v = window.__virtualizeImages(doc);
  check('A1a vdoc carries rwa-asset tokens', /src="rwa-asset:[0-9a-f]{8,}"/.test(v.doc));
  check('A1b vdoc carries NO data:image bytes', !v.doc.includes('data:image/'));
  check('A1c identical images dedupe to one token (2 entries for 3 imgs)', v.assets.size === 2);
  check('A1d vdoc is small (tokens, not pixels)', v.doc.length < 400);
  const back = window.__expandImages(v.doc, v.assets, v.orphans);
  check('A1e expand(virtualize(doc)) === doc byte-for-byte', back === doc);
}

{
  console.log('-- A2: substring coherence (anchored finds are doc slices) --');
  const doc = '<p>before</p>\n<figure><img src="' + URI_A + '" alt="x"></figure>\n<p>after</p>';
  const v = window.__virtualizeImages(doc);
  const sliceStart = doc.indexOf('<figure>');
  const sliceEnd = doc.indexOf('</figure>') + '</figure>'.length;
  const realSlice = doc.slice(sliceStart, sliceEnd);
  const vSlice = window.__virtualizeWithMap(realSlice, v.assets);
  check('A2a virtualized slice appears verbatim in vdoc', v.doc.includes(vSlice));
  check('A2b virtualized slice has the token', /rwa-asset:/.test(vSlice) && !vSlice.includes('data:image/'));
}

{
  console.log('-- A3: unknown token fails loud --');
  let code = null;
  try {
    window.__expandImages('<p><img src="rwa-asset:deadbeef" alt="ghost"></p>', new Map(), new Set());
  } catch (e) { code = e.code; }
  check('A3a expansion of an unmapped token throws unknown_asset_reference', code === 'unknown_asset_reference');
}

{
  console.log('-- A4: pre-existing orphan tokens pass through --');
  const doc = '<p>x</p>\n<p><img src="rwa-asset:cafebabe" alt="pre-broken"></p>\n'
    + '<figure><img src="' + URI_B + '" alt="real"></figure>';
  const v = window.__virtualizeImages(doc);
  check('A4a orphan token is recorded', v.orphans.has('rwa-asset:cafebabe'));
  const back = window.__expandImages(v.doc, v.assets, v.orphans);
  check('A4b round-trip preserves the orphan verbatim (doc stays editable)', back === doc);
  let threw = false;
  try { window.__expandImages(v.doc, v.assets, new Set()); } catch (e) { threw = e.code === 'unknown_asset_reference'; }
  check('A4c without the orphan set the same token fails loud', threw);
}

{
  console.log("-- A5: single-quote src='data:image/…' form --");
  const doc = "<p><img src='" + URI_A + "' alt='q'></p>";
  const v = window.__virtualizeImages(doc);
  check('A5a single-quote form is virtualized', !v.doc.includes('data:image/'));
  check('A5b single-quote form round-trips', window.__expandImages(v.doc, v.assets, v.orphans) === doc);
}

// ─── tail ───────────────────────────────────────────────────────────
await settle();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
