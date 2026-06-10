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

let fetchHandler = async () => { throw new Error('image-assets tests must not call the network'); };

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
    window.fetch = (...args) => fetchHandler(...args);   // per-test reassignable (lens.mjs pattern)
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

// ─── Block C: agent boundaries — modify()/bridge never see pixels ───
// WHY: this is the entire point of the feature. If a data URI leaks into the
// prompt, one photo costs ~170K tokens and blows weaker backends entirely.

function toolCallResponse(envelope, name = 'apply_edits') {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
      id: 'tc1', type: 'function', function: { name, arguments: JSON.stringify(envelope) },
    }] } }] }),
  };
}

{
  console.log('-- C1/C2: modify() prompt carries tokens, commit restores bytes --');
  const URI_BIGISH = 'data:image/jpeg;base64,' + 'QUJD'.repeat(50000); // ~200 KB
  const FIG = '<figure><img src="' + URI_BIGISH + '" alt="photo"></figure>';
  const real = '<article>\n<p>intro</p>\n' + FIG + '\n<p>tail</p>\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  const vfig = window.__virtualizeWithMap(FIG, v.assets);
  const bodies = [];
  fetchHandler = async (url, init) => {
    bodies.push(init.body);
    return toolCallResponse({ version: 'rwa-edit/1', edits: [{
      find: vfig + '\n<p>tail</p>', replace: '<p>tail</p>\n' + vfig,
    }] });
  };
  await window.modify('move the image below the tail');
  await settle();
  check('C1a prompt body carries the token', bodies.length === 1 && bodies[0].includes('rwa-asset:'));
  check('C1b prompt body carries NO image bytes', !bodies[0].includes('data:image/'));
  check('C1c prompt body is small (<20 KB for a 200 KB image doc)', bodies[0].length < 20 * 1024);
  const doc = await readStoreSelf('rwa_doc');
  check('C2a committed doc has the real URI at the new position',
    doc === '<article>\n<p>intro</p>\n<p>tail</p>\n' + FIG + '\n</article>');
}

{
  console.log('-- C3: invented token feeds back as a structured retry --');
  const FIG = '<figure><img src="' + URI_A + '" alt="p"></figure>';
  const real = '<article>\n<p>solo</p>\n' + FIG + '\n</article>';
  await window.__setDocForTest(real);
  const calls = [];
  fetchHandler = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return toolCallResponse({ version: 'rwa-edit/1', edits: [{
      find: '<p>solo</p>', replace: '<p>solo</p>\n<img src="rwa-asset:0badf00d" alt="ghost">',
    }] });
  };
  await window.modify('add a ghost image');
  await settle();
  check('C3a retried (3 attempts)', calls.length === 3);
  const retryMsg = calls[1].messages.find(m => m.role === 'tool');
  check('C3b retry tool_result names unknown_asset_reference',
    retryMsg && retryMsg.content.includes('unknown_asset_reference'));
  check('C3c doc unchanged after exhaustion', (await readStoreSelf('rwa_doc')) === real);
}

{
  console.log('-- C4: compose (skin) on an image doc — ONE commit, pixels intact --');
  const FIG = '<figure><img src="' + URI_B + '" alt="s"></figure>';
  const real = '<article>\n<h1>Skin me</h1>\n' + FIG + '\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  const vfig = window.__virtualizeWithMap(FIG, v.assets);
  fetchHandler = async () => toolCallResponse({ version: 'rwa-edit/1', edits: [{
    find: vfig, replace: '<div class="sk-card">' + vfig + '</div>',
  }] });
  const undoBefore = ((await readStoreSelf('rwa_undo')) || []).length;
  await window.applySkinL1('linear-dark');
  await settle();
  const doc = await readStoreSelf('rwa_doc');
  check('C4a theme block landed', /<style data-rwa-skin="linear-dark">/.test(doc));
  check('C4b agent sk-wrapper landed with the REAL URI inside', doc.includes('<div class="sk-card">' + FIG + '</div>'));
  check('C4c no tokens persisted', !doc.includes('rwa-asset:'));
  check('C4d compose stayed ONE commit (one undo frame)', (await readStoreSelf('rwa_undo')).length - undoBefore === 1);
}

{
  console.log('-- C5: bridge single-shot — prompt virtual, commit real --');
  const FIG = '<figure><img src="' + URI_A + '" alt="b"></figure>';
  const real = '<article>\n<p>bridge intro</p>\n' + FIG + '\n</article>';
  await window.__setDocForTest(real);
  const v = window.__virtualizeImages(real);
  const vfig = window.__virtualizeWithMap(FIG, v.assets);
  window.sessionStorage.setItem('rwa_backend', 'bridge');
  let decodedPrompt = null;
  fetchHandler = async (url, init) => {
    const cmd = JSON.parse(init.body).command;
    const b64 = /echo '([^']+)'/.exec(cmd)[1];
    decodedPrompt = Buffer.from(b64, 'base64').toString('utf8');
    return { ok: true, status: 200, json: async () => ({ exit_code: 0, stderr: '', stdout: JSON.stringify({
      tool: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [{ find: '<p>bridge intro</p>', replace: '<p>bridge intro!</p>' }] },
    }) }) };
  };
  await window.modify('punctuate the intro');
  await settle();
  window.sessionStorage.setItem('rwa_backend', 'openrouter');
  check('C5a bridge prompt carries the token, not the bytes',
    decodedPrompt && decodedPrompt.includes('rwa-asset:') && !decodedPrompt.includes('data:image/'));
  const doc = await readStoreSelf('rwa_doc');
  check('C5b bridge commit expands back to real bytes',
    doc.includes('<p>bridge intro!</p>') && doc.includes(URI_A) && !doc.includes('rwa-asset:'));
}

// ─── Block D: anchored /-commands on an image block ─────────────────
// WHY: clicking an image anchors the lens on its <figure>; "make this
// smaller" must ship a 60-byte token to the model, not 600 KB of base64 —
// and the single-shot response (token form) must expand on commit.

{
  console.log('-- D1/D2: anchored command — virtual prompt, real commit --');
  const URI_BIGISH = 'data:image/jpeg;base64,' + 'QUJD'.repeat(50000); // ~200 KB
  const real = '<article>\n<h1>Head</h1>\n<p>before</p>\n'
    + '<figure><img src="' + URI_BIGISH + '" alt="big"></figure>\n<p>after</p>\n</article>';
  await window.__setDocForTest(real);
  const map = window.getSourceMap();
  const figEntry = map.find(e => e.tag === 'FIGURE');
  check('D1a figure is anchorable (sourceMap entry exists)', !!figEntry);
  const v = window.__virtualizeImages(real);
  const token = [...v.assets.keys()][0];
  const bodies = [];
  fetchHandler = async (url, init) => {
    bodies.push(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant',
      content: '<figure class="small"><img src="' + token + '" alt="big"></figure>' } }] }) };
  };
  await window.runAnchoredCommand(figEntry, 'make this smaller');
  await settle();
  check('D1b anchored prompt carries the token', bodies.length >= 1 && bodies[0].includes('rwa-asset:'));
  check('D1c anchored prompt carries NO image bytes', !bodies[0].includes('data:image/'));
  const doc = await readStoreSelf('rwa_doc');
  check('D2a committed doc has the styled figure with REAL bytes',
    doc.includes('<figure class="small"><img src="' + URI_BIGISH + '" alt="big"></figure>') && !doc.includes('rwa-asset:'));
}

{
  console.log('-- D3: anchored response with an invented token fails clean --');
  const real = '<article>\n<h1>H</h1>\n<figure><img src="' + URI_A + '" alt="x"></figure>\n</article>';
  await window.__setDocForTest(real);
  const map = window.getSourceMap();
  const figEntry = map.find(e => e.tag === 'FIGURE');
  let calls = 0;
  fetchHandler = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant',
      content: '<figure><img src="rwa-asset:0badf00d" alt="ghost"></figure>' } }] }) };
  };
  await window.runAnchoredCommand(figEntry, 'swap the image');
  await settle();
  check('D3a retried to exhaustion (3 attempts)', calls === 3);
  check('D3b doc unchanged after exhaustion', (await readStoreSelf('rwa_doc')) === real);
}

// ─── Block E: non-agent insert path (GUI rides the R5 queue) ────────
// WHY: a 200 KB data URI in an envelope replace would trip MAX_REPLACE (8 KB).
// GUI inserts therefore travel in token form with an assets map, through the
// SAME runtimeApplyEnvelope/commitCore the other edit-surfaces use.

{
  console.log('-- E1: runtime.applyEnvelope({assets}) — token in, pixels out --');
  const URI_BIGISH = 'data:image/webp;base64,' + 'd2Vi'.repeat(50000); // ~200 KB
  const real = '<article>\n<p>insert after me</p>\n</article>';
  await window.__setDocForTest(real);
  const assets = new Map();
  const token = window.__registerImageAsset(assets, URI_BIGISH);
  const env = { version: 'rwa-edit/1', edits: [{
    find: '<p>insert after me</p>',
    replace: '<p>insert after me</p>\n<figure><img src="' + token + '" alt="pic"></figure>',
  }] };
  const out = await window.runtime.applyEnvelope(env, { surface: 'image:insert', actor: 'user:image-drop', assets });
  check('E1a committed doc carries the real 200 KB URI (token replace beat MAX_REPLACE)',
    out.includes(URI_BIGISH) && !out.includes('rwa-asset:'));
  check('E1b store matches', (await readStoreSelf('rwa_doc')) === out);
  const hist = (await readStoreSelf('rwa_hist'))[0];
  check('E1c hist self-attributes the surface actor', hist.actor === 'user:image-drop' && hist.surface === 'image:insert');
  check('E1d hist envelope stays virtual (compact)', !JSON.stringify(hist.envelope).includes('data:image/'));
  const undoArr = await readStoreSelf('rwa_undo');
  check('E1e undo frame is the real pre-insert doc', undoArr[undoArr.length - 1] === real);
}

{
  console.log('-- E2: token envelope WITHOUT assets fails loud --');
  const real = '<article>\n<p>plain</p>\n</article>';
  await window.__setDocForTest(real);
  let code = null;
  try {
    await window.runtime.applyEnvelope({ version: 'rwa-edit/1', edits: [{
      find: '<p>plain</p>',
      replace: '<p>plain</p>\n<img src="rwa-asset:0badf00d" alt="ghost">',
    }] }, { surface: 'test:broken' });
  } catch (e) { code = e.code; }
  check('E2a NEW token without bytes rejects (no silent broken image)', code === 'unknown_asset_reference');
  check('E2b doc unchanged', (await readStoreSelf('rwa_doc')) === real);
  // …but an envelope merely MOVING a pre-existing orphan token stays legal
  // (the doc was already broken that way; editing must not be bricked).
  const realOrphan = '<article>\n<p>a</p>\n<img src="rwa-asset:cafebabe" alt="pre">\n</article>';
  await window.__setDocForTest(realOrphan);
  const out = await window.runtime.applyEnvelope({ version: 'rwa-edit/1', edits: [{
    find: '<p>a</p>\n<img src="rwa-asset:cafebabe" alt="pre">',
    replace: '<img src="rwa-asset:cafebabe" alt="pre">\n<p>a</p>',
  }] }, { surface: 'test:orphan-move' });
  check('E2c moving a PRE-EXISTING orphan token is allowed', out.includes('rwa-asset:cafebabe'));
}

// ─── Block F: ingestion pipeline pure helpers ───────────────────────
// WHY: the canvas/bitmap parts only run in real browsers (Task 14 proves
// those); the budget/geometry/markup decisions are pure and pinned here.

{
  console.log('-- F1: target dimensions (downscale, never upscale) --');
  const d1 = window.__rwaImageTargetDims(4000, 3000);
  check('F1a 4000×3000 → 1600×1200', d1.w === 1600 && d1.h === 1200);
  const d2 = window.__rwaImageTargetDims(800, 600);
  check('F1b 800×600 unchanged (no upscale)', d2.w === 800 && d2.h === 600);
  const d3 = window.__rwaImageTargetDims(3000, 4000);
  check('F1c portrait 3000×4000 → 1200×1600', d3.w === 1200 && d3.h === 1600);
  const d4 = window.__rwaImageTargetDims(1, 100000);
  check('F1d extreme aspect never rounds to 0', d4.w >= 1 && d4.h === 1600);
  const d5 = window.__rwaImageTargetDims(5000, 5000, 1280);
  check('F1e retry pass honors the smaller edge', d5.w === 1280 && d5.h === 1280);
}

{
  console.log('-- F2: figure markup is attribute-safe --');
  const fig = window.__buildImageFigure('rwa-asset:00000001', 'she said "hi" & <waved>');
  check('F2a alt is quote-and-angle escaped',
    fig === '<figure><img src="rwa-asset:00000001" alt="she said &quot;hi&quot; &amp; &lt;waved&gt;"></figure>');
}

{
  console.log('-- F3: filename stem for default alt --');
  check('F3a photo.JPG → photo', window.__rwaFileStem('photo.JPG') === 'photo');
  check('F3b archive.tar.gz → archive.tar', window.__rwaFileStem('archive.tar.gz') === 'archive.tar');
  check('F3c extensionless name unchanged', window.__rwaFileStem('snapshot') === 'snapshot');
  check('F3d missing name → image', window.__rwaFileStem(undefined) === 'image');
}

{
  console.log('-- F4: ingest rejects non-images and oversized passthrough --');
  const notImage = { type: 'text/plain', name: 'notes.txt', size: 10 };
  let msg = null;
  try { await window.__ingestImageFile(notImage); } catch (e) { msg = e.message; }
  check('F4a non-image rejects with a clear error', /not an image/.test(msg));
  const hugeGif = { type: 'image/gif', name: 'party.gif', size: 600 * 1024 };
  msg = null;
  try { await window.__ingestImageFile(hugeGif); } catch (e) { msg = e.message; }
  check('F4b oversized GIF passthrough refuses loud', /too large/.test(msg));
}

// ─── Block G: insert surfaces — drop, paste, /image, hover ✕ ────────
// WHY: this is the "pleasure" contract: drop → figure lands at the block
// boundary as ONE undoable non-agent commit with honest attribution.

const FAKE_URI = 'data:image/png;base64,QUJDREVG';
window.__rwaIngestImage = async (f) => ({ dataUri: FAKE_URI, bytes: 6, name: (f && f.name) || 'x.png', resizedFrom: null });
const fakeFile = { type: 'image/png', name: 'team.png', size: 6 };
function dropEventOn(el, dt) {
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = dt || { files: [fakeFile], items: [{ kind: 'file', type: 'image/png' }], types: ['Files'] };
  el.dispatchEvent(ev);
}

{
  console.log('-- G1: drop on a block inserts a figure after it (one commit) --');
  const real = '<article>\n<p data-rwa-id="g1a">first</p>\n<p data-rwa-id="g1b">second</p>\n</article>';
  await window.__setDocForTest(real);
  const p2 = document.querySelector('[data-rwa-id="g1b"]');
  dropEventOn(p2);
  await settle(); await settle();
  const doc = await readStoreSelf('rwa_doc');
  check('G1a figure landed after the drop block, real URI',
    new RegExp('second</p>\\n<figure[^>]*><img src="' + FAKE_URI + '" alt="team"></figure>').test(doc));
  const hist = (await readStoreSelf('rwa_hist'))[0];
  check('G1b attributed user:image-drop / image:insert', hist.actor === 'user:image-drop' && hist.surface === 'image:insert');
  const undoArr = await readStoreSelf('rwa_undo');
  check('G1c one undoable frame restores the pre-drop doc', undoArr[undoArr.length - 1] === real);
}

{
  console.log('-- G2: before/after placement via insertImageAt --');
  const real = '<article>\n<p data-rwa-id="g2a">alpha</p>\n<p data-rwa-id="g2b">beta</p>\n</article>';
  await window.__setDocForTest(real);
  const map = window.getSourceMap();
  const entry = map.find(e => (e.tag === 'P') && /alpha/.test(real.slice(e.start, e.end)));
  await window.__insertImageAt({ dataUri: FAKE_URI, bytes: 6, name: 'logo.png', resizedFrom: null }, { entry, before: true }, 'user:image-drop');
  const doc = await readStoreSelf('rwa_doc');
  check('G2a before:true puts the figure ABOVE the block',
    new RegExp('<figure[^>]*><img src="' + FAKE_URI + '" alt="logo"></figure>\\n<p data-rwa-id="g2a">alpha</p>').test(doc));
}

{
  console.log('-- G3: paste with an image file appends (no anchor) --');
  const real = '<article>\n<p data-rwa-id="g3a">prose</p>\n</article>';
  await window.__setDocForTest(real);
  const ev = new window.Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { files: [{ type: 'image/png', name: 'shot.png', size: 6 }] };
  document.dispatchEvent(ev);
  await settle(); await settle();
  const doc = await readStoreSelf('rwa_doc');
  check('G3a pasted image appended after the last block',
    new RegExp('prose</p>\\n<figure[^>]*><img src="' + FAKE_URI + '" alt="shot"></figure>').test(doc));
  check('G3b attributed user:image-paste', (await readStoreSelf('rwa_hist'))[0].actor === 'user:image-paste');
}

{
  console.log('-- G4: /image routes to the picker --');
  let opened = 0;
  window.__rwaOpenImagePicker = () => { opened++; };
  await window.submitLens('/image');
  check('G4a submitLens(/image) opens the picker', opened === 1);
  delete window.__rwaOpenImagePicker;
}

{
  console.log('-- G5: hover ✕ chip deletes the figure --');
  const real = '<article>\n<p data-rwa-id="g5a">keep me</p>\n<figure data-rwa-id="g5f"><img src="' + URI_A + '" alt="bye"></figure>\n</article>';
  await window.__setDocForTest(real);
  const img = document.querySelector('[data-rwa-id="g5f"] img');
  img.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  const chip = document.getElementById('rwa-img-chip');
  check('G5a chip appears on image hover', !!chip && !chip.hidden);
  // The chip is a toolbar (S/M/L + ✕); click the remove button specifically.
  chip.querySelector('button[data-action="remove"]').click();
  await settle(); await settle();
  const doc = await readStoreSelf('rwa_doc');
  check('G5b figure removed, prose intact', !doc.includes('<figure') && doc.includes('keep me'));
  check('G5c attributed user:image-delete', (await readStoreSelf('rwa_hist'))[0].actor === 'user:image-delete');
  const undoArr = await readStoreSelf('rwa_undo');
  check('G5d undo frame restores the figure', undoArr[undoArr.length - 1] === real);
}

{
  console.log('-- G6: container budget stop refuses the insert --');
  const real = '<article>\n<p data-rwa-id="g6a">tiny</p>\n</article>';
  await window.__setDocForTest(real);
  const hugeUri = 'data:image/png;base64,' + 'Q'.repeat(11 * 1024 * 1024);
  const res = await window.__insertImageAt({ dataUri: hugeUri, bytes: hugeUri.length, name: 'huge.png', resizedFrom: null }, null, 'user:image-drop');
  check('G6a oversized insert refused (returns null)', res === null);
  check('G6b doc unchanged', (await readStoreSelf('rwa_doc')) === real);
}

{
  console.log('-- G7: drop targeting a frozen block falls back to EOF append --');
  const real = '<article>\n<div data-rwa-frozen="hdr"><p>frozen para</p></div>\n<p data-rwa-id="g7a">open</p>\n</article>';
  await window.__setDocForTest(real);
  const frozenP = document.querySelector('[data-rwa-frozen] p');
  dropEventOn(frozenP);
  await settle(); await settle();
  const doc = await readStoreSelf('rwa_doc');
  check('G7a frozen zone untouched', doc.includes('<div data-rwa-frozen="hdr"><p>frozen para</p></div>'));
  check('G7b figure appended at EOF instead',
    new RegExp('open</p>\\n<figure[^>]*><img src="' + FAKE_URI + '"').test(doc));
}

{
  console.log('-- G8: rapid double insert — R5 queue lands both --');
  const real = '<article>\n<p data-rwa-id="g8a">base</p>\n</article>';
  await window.__setDocForTest(real);
  const ing = (n) => ({ dataUri: FAKE_URI, bytes: 6, name: n, resizedFrom: null });
  await Promise.all([
    window.__insertImageAt(ing('one.png'), null, 'user:image-drop'),
    window.__insertImageAt(ing('two.png'), null, 'user:image-drop'),
  ]);
  const doc = await readStoreSelf('rwa_doc');
  check('G8a both inserts landed (serialized, none lost)',
    doc.includes('alt="one"') && doc.includes('alt="two"'));
}

// ─── Block H: deterministic resize presets (S/M/L width) ────────────
// WHY: a no-model, no-key width control. The width is a figure class in the
// doc (commits/exports/⌘Z like any edit); the swap targets only the open tag
// (unique via data-rwa-id, no data URI) so it never trips MAX_REPLACE.

{
  console.log('-- H1: swapFigureSizeClass — set / replace / preserve other classes --');
  const swap = window.__swapFigureSizeClass;
  check('H1a adds a size class when none present',
    swap('<figure data-rwa-id="b1">', 'md') === '<figure data-rwa-id="b1" class="rwa-img-md">');
  check('H1b replaces an existing size class',
    swap('<figure data-rwa-id="b1" class="rwa-img-sm">', 'lg') === '<figure data-rwa-id="b1" class="rwa-img-lg">');
  check('H1c preserves unrelated classes',
    swap('<figure class="hero rwa-img-sm pinned">', 'md') === '<figure class="hero pinned rwa-img-md">');
  check('H1d unknown size is a no-op', swap('<figure>', 'xl') === '<figure>');
}

{
  console.log('-- H2: setImageSize commits a width class on the figure (one edit, real bytes intact) --');
  const real = '<article>\n<p>intro</p>\n' + FIG_A + '\n</article>';
  await window.__setDocForTest(real);
  // The committed doc backfills data-rwa-id on the figure; grab the live node.
  const fig = document.querySelector('#rwa-doc-mount figure');
  await window.__setImageSize(fig, 'sm');
  await settle();
  const doc = await readStoreSelf('rwa_doc');
  check('H2a figure gained the rwa-img-sm class', /<figure[^>]*\brwa-img-sm\b[^>]*>/.test(doc));
  check('H2b the image data URI is untouched', doc.includes(URI_A));
  check('H2c attributed user:image-resize', (await readStoreSelf('rwa_hist'))[0].actor === 'user:image-resize');
  const undoArr = await readStoreSelf('rwa_undo');
  check('H2d one undoable frame restores the pre-resize doc', undoArr[undoArr.length - 1] === real);
  // Re-size to md: replaces, not stacks.
  const fig2 = document.querySelector('#rwa-doc-mount figure');
  await window.__setImageSize(fig2, 'md');
  await settle();
  const doc2 = await readStoreSelf('rwa_doc');
  check('H2e re-size replaces (md present, sm gone)',
    /\brwa-img-md\b/.test(doc2) && !/\brwa-img-sm\b/.test(doc2));
}

// ─── tail ───────────────────────────────────────────────────────────
await settle();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
