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

// ─── Block B: apply core expands tokens (caps on virtual form) ──────
// WHY: the agent edits the VIRTUAL doc, but commits must persist real bytes,
// undo must restore real bytes, and hist must stay compact (virtual). If any
// of these flip, either pixels leak into prompts/caps or undo corrupts images.

async function readStoreSelf(name) {
  const db = await window.openDB();
  return new Promise(res => {
    const r = db.transaction(name).objectStore(name).get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(undefined);
  });
}

const FIG_A = '<figure><img src="' + URI_A + '" alt="photo"></figure>';

{
  console.log('-- B1: agent move on the virtual form commits real bytes --');
  const real = '<article>\n<h1>Title</h1>\n<p>intro paragraph</p>\n'
    + FIG_A + '\n<p>tail paragraph</p>\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  const vfig = window.__virtualizeWithMap(FIG_A, v.assets);
  const envelope = { version: 'rwa-edit/1', edits: [{
    find: vfig + '\n<p>tail paragraph</p>',
    replace: '<p>tail paragraph</p>\n' + vfig,
  }] };
  const out = await window.__applyEdits(envelope, v.doc, { surface: 'test', actor: 'test' },
    { assets: v.assets, orphans: v.orphans });
  const expected = '<article>\n<h1>Title</h1>\n<p>intro paragraph</p>\n'
    + '<p>tail paragraph</p>\n' + FIG_A + '\n</article>';
  check('B1a returned doc is the REAL doc, image moved', out === expected);
  check('B1b rwa_doc store holds the real doc', (await readStoreSelf('rwa_doc')) === expected);
  const undoArr = await readStoreSelf('rwa_undo');
  check('B1c undo frame is the REAL pre-edit doc (⌘Z restores pixels)', undoArr[undoArr.length - 1] === real);
  const hist = (await readStoreSelf('rwa_hist'))[0];
  const histStr = JSON.stringify(hist.envelope);
  check('B1d hist stores the VIRTUAL envelope (compact)', histStr.includes('rwa-asset:') && !histStr.includes('data:image/'));
}

{
  console.log('-- B2/B3: duplicate and delete --');
  const real = '<article>\n<p>intro</p>\n' + FIG_A + '\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  const vfig = window.__virtualizeWithMap(FIG_A, v.assets);
  const dup = await window.__applyEdits(
    { version: 'rwa-edit/1', edits: [{ find: vfig, replace: vfig + '\n' + vfig }] },
    v.doc, null, { assets: v.assets, orphans: v.orphans });
  check('B2a duplicated token expands twice', dup.split(URI_A).length - 1 === 2);
  await window.__setDocForTest(real);
  const del = await window.__applyEdits(
    { version: 'rwa-edit/1', edits: [{ find: '\n' + vfig, replace: '' }] },
    v.doc, null, { assets: v.assets, orphans: v.orphans });
  check('B3a deleted token leaves no URI behind', !del.includes(URI_A) && !del.includes('rwa-asset:'));
}

{
  console.log('-- B4: invented token rejects, doc untouched --');
  const real = '<article>\n<p>solo</p>\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  let code = null;
  try {
    await window.__applyEdits(
      { version: 'rwa-edit/1', edits: [{ find: '<p>solo</p>', replace: '<p>solo</p>\n<img src="rwa-asset:0badf00d" alt="ghost">' }] },
      v.doc, null, { assets: v.assets, orphans: v.orphans });
  } catch (e) { code = e.code; }
  check('B4a unknown_asset_reference surfaces', code === 'unknown_asset_reference');
  check('B4b doc store unchanged after the reject', (await readStoreSelf('rwa_doc')) === real);
}

{
  console.log('-- B5: caps are measured on the VIRTUAL form --');
  const URI_BIG = 'data:image/png;base64,' + 'QUJD'.repeat(370000); // ~1.48 MB > MAX_DOC
  const real = '<article>\n<p>intro</p>\n<figure><img src="' + URI_BIG + '" alt="big"></figure>\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  check('B5a fixture: REAL form exceeds MAX_DOC', real.length > 1024 * 1024);
  const out = await window.__applyEdits(
    { version: 'rwa-edit/1', edits: [{ find: '<p>intro</p>', replace: '<p>intro!</p>' }] },
    v.doc, null, { assets: v.assets, orphans: v.orphans });
  check('B5b edit on an over-1MB-real doc succeeds (text budget is virtual)', out.includes('<p>intro!</p>') && out.includes(URI_BIG));
  // No-assets path: today's caps still bite raw URIs (no regression).
  await window.__setDocForTest(real);
  let code = null;
  try {
    await window.__applyEdits(
      { version: 'rwa-edit/1', edits: [{ find: '<p>intro</p>', replace: '<p>intro</p><img src="' + URI_BIG + '">' }] },
      real, null, null);
  } catch (e) { code = e.code; }
  check('B5c raw-URI replace without assets still trips replace_too_large', code === 'replace_too_large');
}

{
  console.log('-- B6: frozen image survives byte-identical; touching it rejects --');
  const real = '<article>\n<p>open text</p>\n'
    + '<div data-rwa-frozen="brand"><img src="' + URI_A + '" alt="logo"></div>\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  const ok = await window.__applyEdits(
    { version: 'rwa-edit/1', edits: [{ find: '<p>open text</p>', replace: '<p>open text edited</p>' }] },
    v.doc, null, { assets: v.assets, orphans: v.orphans });
  check('B6a unrelated edit: frozen image bytes are byte-identical',
    ok.includes('<div data-rwa-frozen="brand"><img src="' + URI_A + '" alt="logo"></div>'));
  await window.__setDocForTest(real);
  const v2 = window.__virtualizeImages(real);
  const vimg = window.__virtualizeWithMap('<img src="' + URI_A + '" alt="logo">', v2.assets);
  let code = null;
  try {
    await window.__applyEdits(
      { version: 'rwa-edit/1', edits: [{ find: vimg, replace: '' }] },
      v2.doc, null, { assets: v2.assets, orphans: v2.orphans });
  } catch (e) { code = e.code; }
  check('B6b deleting the frozen img rejects (frozen wall holds on virtual form)',
    code === 'frozen_zone_corrupted' || code === 'frozen_zone_violation');
}

{
  console.log('-- B8: replace_document with assets expands too --');
  const real = '<article>\n<p>doc</p>\n' + FIG_A + '\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  const vfig = window.__virtualizeWithMap(FIG_A, v.assets);
  const out = await window.__replaceDocument(
    { version: 'rwa-edit/1', doc: '<article>\n' + vfig + '\n<p>rewritten</p>\n</article>', reason: 'test rewrite' },
    v.doc, null, null, { assets: v.assets, orphans: v.orphans });
  check('B8a replace_document output expands the token', out.includes(URI_A) && !out.includes('rwa-asset:'));
  check('B8b store matches', (await readStoreSelf('rwa_doc')) === out);
}

// ─── tail ───────────────────────────────────────────────────────────
await settle();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
