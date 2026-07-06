// TDD — the typed artifact drop bus (docs/plans/2026-07-06-artifact-bus-design.md §1-§2,
// plan Task 1.1). Today the seed has TWO drop paths: a capture-phase window drop that claims
// AI/skill CARRIER .html files (classifyInstallText → routeInstallFromText → install dialogs)
// and a #rwa-doc-mount drop that ingests IMAGE files. We unify them behind ONE classifier.
//
// This block covers ONLY classifyArtifact — a pure, additive function returning
//   {class, source, payload}
// It has TWO lookup strategies: a DECLARED branch (a carrier .html / bare envelope JSON →
// install, delegating to the unchanged classifyInstallText) and a SNIFF branch (an image
// file by file.type → ingest). Declared beats sniff. An unclassifiable drop → the all-null
// "not a recognized artifact" shape. The dispatcher + accepts declaration are LATER tasks.
//
// Seed surface under test (test hook):
//   window.__rwaClassifyArtifact(file|text)  -> async {class, source, payload}
import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const CARRIER = path.join(__dirname, '..', 'examples', 'intelligence-carrier', 'concise-editor.html');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

const article = '<article><h1>Target</h1><p>An ordinary rewritable that can receive an artifact.</p></article>\n';

async function boot(body) {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'Target', fileMeta: 't.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s); });
  const dom = new JSDOM(html, { url: 'https://t.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    } });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 5000) { if (w.runtime && w.runtime.agents && w.runtime.agents.list) break; await new Promise(r => setTimeout(r, 5)); }
  await new Promise(r => setTimeout(r, 150));
  return w;
}

const carrierHtml = fs.readFileSync(CARRIER, 'utf8');

async function readStore(w, name) {
  const db = await w.openDB();
  return new Promise(res => {
    const r = db.transaction(name).objectStore(name).get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(undefined);
  });
}
const FAKE_URI = 'data:image/png;base64,QUJDREVG';

console.log('== artifact drop bus — classifier ==');

// A — classifyArtifact: the unified drop classifier. Every case asserts class/source (the type-system
// fields the dispatcher routes on), not mere presence. `class` IS the integration semantics (design §1
// is 1:1), so there is deliberately NO separate `semantics` field — A1b/A3b pin that collapse.
{
  const w = await boot(article);

  // A1 — a carrier .html TEXT → install, DECLARED. Payload carries the install classification
  // (the classifyInstallText result: kind + extracted envelopes) so the dispatcher can route it.
  const rCarrier = await w.__rwaClassifyArtifact(carrierHtml);
  check('A1: carrier .html → class=install', rCarrier.class === 'install');
  check('A1b: no separate semantics field (class IS the semantics)', rCarrier.semantics === undefined);
  check('A1c: carrier .html → source=declared', rCarrier.source === 'declared');
  check('A1d: payload IS the install classification (agent-carrier + 1 envelope)',
    !!rCarrier.payload && rCarrier.payload.kind === 'agent-carrier'
    && Array.isArray(rCarrier.payload.envelopes) && rCarrier.payload.envelopes.length === 1);

  // A2 — a bare rwa-agent/1 envelope string → install, DECLARED (json-agent).
  const env = w.__rwaExtractAgentCarrier(carrierHtml)[0];
  const rAgent = await w.__rwaClassifyArtifact(JSON.stringify(env));
  check('A2: bare json-agent → install/declared',
    rAgent.class === 'install' && rAgent.source === 'declared');
  check('A2b: payload is the json-agent classification', !!rAgent.payload && rAgent.payload.kind === 'json-agent');

  // A2c — a bare rwa-skill/1 envelope string → install, DECLARED (json-skill).
  const rSkill = await w.__rwaClassifyArtifact(JSON.stringify({ format: 'rwa-skill/1', skill: { name: 'x' } }));
  check('A2c: bare json-skill → install/declared',
    rSkill.class === 'install' && rSkill.source === 'declared');
  check('A2d: payload is the json-skill classification', !!rSkill.payload && rSkill.payload.kind === 'json-skill');

  // A3 — an image File-like → ingest, SNIFFED by file.type (no reading of image bytes).
  const img = { name: 'x.png', type: 'image/png', size: 1234 };
  const rImg = await w.__rwaClassifyArtifact(img);
  check('A3: image file → class=ingest', rImg.class === 'ingest');
  check('A3b: no separate semantics field (class IS the semantics)', rImg.semantics === undefined);
  check('A3c: image file → source=sniffed', rImg.source === 'sniffed');
  check('A3d: ingest payload carries the file(s) verbatim',
    !!rImg.payload && Array.isArray(rImg.payload.files) && rImg.payload.files[0] === img);

  // A4 — unknown text → the "not a recognized artifact" shape (today's kind:'none').
  const rNoneText = await w.__rwaClassifyArtifact('<html><body><p>just a page</p></body></html>');
  check('A4: unknown text → {class:null, source:null} (no semantics field)',
    rNoneText.class === null && rNoneText.source === null && rNoneText.semantics === undefined);

  // A4b — unknown file type (not image, not a carrier) → all-null.
  const rNoneFile = await w.__rwaClassifyArtifact({ name: 'data.bin', type: 'application/octet-stream', text: async () => 'not json, not a carrier' });
  check('A4b: unknown file type → {class:null, source:null}',
    rNoneFile.class === null && rNoneFile.source === null);

  // A5 — PRECEDENCE: a carrier delivered AS A FILE (type text/html, not image) classifies install
  // (declared) — declared beats sniff. WHY it matters: an artifact that self-declares must never be
  // silently re-typed by a sniff, or a dropped AI could be mis-ingested as document content.
  const carrierFile = new w.File([carrierHtml], 'concise-editor.html', { type: 'text/html' });
  const rPrec = await w.__rwaClassifyArtifact(carrierFile);
  check('A5: carrier File (text/html) → install/declared, NOT ingest (declared beats sniff)',
    rPrec.class === 'install' && rPrec.source === 'declared');
}

// B — dispatchArtifact: route a classified artifact to its class handler (plan Task 1.2). The bus
// COMPOSES the existing per-class machinery — routeInstallFromText (install) / insertImageFiles
// (ingest) — it never reimplements or weakens them. Each class keeps its DIFFERENT context, carried
// in ctx: install is any-mode + window-wide; ingest is Edit-mode + mount-target ONLY. The Edit-mode
// gate is the load-bearing invariant (Rule 9): a dispatch outside Edit mode must NOT mutate the doc,
// or an image drop could bypass the edit gate and rewrite a read-only view.
{
  console.log('-- B: dispatchArtifact routing --');

  // B0/B1 — install-class dispatch reaches the install path: the consent dialog opens
  // (routeInstallFromText → showAgentInstallDialog, exactly as a carrier drop does today).
  {
    const w = await boot(article);
    const dispatch = w.__rwaDispatchArtifact;
    check('B0: window.__rwaDispatchArtifact hook present', typeof dispatch === 'function');
    const cls = await w.__rwaClassifyArtifact(carrierHtml);
    if (typeof dispatch === 'function') {
      await dispatch(cls, { text: carrierHtml });
      await new Promise(r => setTimeout(r, 150)); // async file read + signature verify
    }
    check('B1: install-class dispatch opens the agent consent dialog',
      !!w.document.getElementById('rwa-agent-install'));
  }

  // B2 — ingest-class dispatch with ctx.mode='edit' inserts the image via insertImageFiles, and
  // attributes it user:image-drop / image:insert (the drop actor must survive the refactor).
  {
    const w = await boot(article);
    const dispatch = w.__rwaDispatchArtifact;
    w.__rwaIngestImage = async (f) => ({ dataUri: FAKE_URI, bytes: 6, name: (f && f.name) || 'x.png', resizedFrom: null });
    await w.__setDocForTest('<article>\n<p data-rwa-id="b2">hello</p>\n</article>');
    const cls = await w.__rwaClassifyArtifact({ name: 'shot.png', type: 'image/png', size: 6 });
    if (typeof dispatch === 'function') {
      await dispatch(cls, { mode: 'edit', target: null });
      await new Promise(r => setTimeout(r, 150));
    }
    const doc = await readStore(w, 'rwa_doc');
    check('B2: ingest dispatch (Edit mode) inserts the image figure',
      typeof doc === 'string' && new RegExp('hello</p>\\n<figure[^>]*><img src="' + FAKE_URI + '"').test(doc));
    const hist = (await readStore(w, 'rwa_hist') || [])[0];
    check('B2b: ingest dispatch attributes user:image-drop / image:insert',
      !!hist && hist.actor === 'user:image-drop' && hist.surface === 'image:insert');
  }

  // B3 — ingest-class dispatch with ctx.mode='document' is REFUSED by the Edit-mode gate: no insert,
  // returns false. This is the gate that keeps handleMountDrop's Edit-only contract after the rewire.
  {
    const w = await boot(article);
    const dispatch = w.__rwaDispatchArtifact;
    w.__rwaIngestImage = async (f) => ({ dataUri: FAKE_URI, bytes: 6, name: (f && f.name) || 'x.png', resizedFrom: null });
    const base = '<article>\n<p data-rwa-id="b3">unchanged</p>\n</article>';
    await w.__setDocForTest(base);
    const cls = await w.__rwaClassifyArtifact({ name: 'shot.png', type: 'image/png', size: 6 });
    let ret = 'unset';
    if (typeof dispatch === 'function') {
      ret = await dispatch(cls, { mode: 'document', target: null });
      await new Promise(r => setTimeout(r, 100));
    }
    check('B3: ingest dispatch in Document mode is a no-op (Edit-mode gate preserved)',
      (await readStore(w, 'rwa_doc')) === base);
    if (typeof dispatch === 'function') check('B3b: refused ingest returns false', ret === false);
  }

  // B4 — unknown class → the "not a recognized artifact" status, no side effect (today's kind:'none').
  {
    const w = await boot(article);
    const dispatch = w.__rwaDispatchArtifact;
    const base = '<article>\n<p data-rwa-id="b4">intact</p>\n</article>';
    await w.__setDocForTest(base);
    const cls = await w.__rwaClassifyArtifact('<html><body><p>just a page</p></body></html>'); // → all-null
    let ret = 'unset';
    if (typeof dispatch === 'function') { ret = await dispatch(cls, {}); await new Promise(r => setTimeout(r, 80)); }
    const st = w.document.getElementById('rwa-st-status');
    check('B4: unknown-class dispatch sets the "not a recognized artifact" status',
      !!st && /not a recognized artifact/.test(st.textContent));
    check('B4b: unknown-class dispatch has no side effect (doc intact, no install dialog)',
      (await readStore(w, 'rwa_doc')) === base && !w.document.getElementById('rwa-agent-install'));
    if (typeof dispatch === 'function') check('B4c: unknown-class dispatch returns false', ret === false);
  }

  // B5 — ingest gate: the OTHER arm. B3 exercises the mode arm (ctx.mode!=='edit' short-circuits the
  // OR before activeView/modifyMutex are read). Here ctx.mode='edit' PASSES the mode arm, but an ACTIVE
  // view is standing → the activeView arm must still refuse: no insert, returns false, doc byte-intact.
  // (A view is a read-only render projection; an ingest committing under it would corrupt that contract.)
  {
    const w = await boot(article);
    const dispatch = w.__rwaDispatchArtifact;
    w.__rwaIngestImage = async (f) => ({ dataUri: FAKE_URI, bytes: 6, name: (f && f.name) || 'x.png', resizedFrom: null });
    const base = '<article>\n<p data-rwa-id="b5">view-active</p>\n</article>';
    await w.__setDocForTest(base);
    // Register + activate a trivial view so activeView is truthy (the reachable gate arm in jsdom;
    // modifyMutex has no independent test seam and shares the identical OR, so pinning activeView
    // covers the arm's presence).
    w.runtime.provide('view', { kind: 'view', name: 'tv', label: 'TV', render: () => '<p>tv</p>' });
    w.runtime.setView('tv');
    await new Promise(r => setTimeout(r, 60));
    const viewActive = /tv/.test((w.document.getElementById('rwa-doc-mount') || {}).textContent || '');
    check('B5-precondition: a view is actually active (mount renders it)', viewActive);
    const cls = await w.__rwaClassifyArtifact({ name: 'shot.png', type: 'image/png', size: 6 });
    let ret = 'unset';
    if (typeof dispatch === 'function') { ret = await dispatch(cls, { mode: 'edit', target: null }); await new Promise(r => setTimeout(r, 100)); }
    check('B5: ingest dispatch with an ACTIVE view is refused (activeView gate arm)',
      (await readStore(w, 'rwa_doc')) === base);
    if (typeof dispatch === 'function') check('B5b: view-refused ingest returns false', ret === false);
  }
}

// C — the compose class: a droppable SKIN (docs/plans/2026-07-06-artifact-bus-plan.md Task 2.1). This is the
// EXTENSIBILITY test: adding a THIRD class must slot into the same classifier without disturbing install/ingest.
// A skin artifact is a .html (or bare JSON) carrying
//   <script type="application/rwa-artifact+json">{format:'rwa-artifact/1',class:'compose',artifact:'skin',skin:{name:<preset>}}</script>
// classifyArtifact recognizes it as class=compose BEFORE the agent-carrier sniff (a skin is not an agent), and
// FAILS LOUD (all-null) on an unknown preset / unknown artifact kind / malformed tag — never silently mis-routed
// to install or ingest. WHY (Rule 9): a mis-typed artifact runs the WRONG trust model — a skin swallowed as an
// install, or an unknown artifact silently ingested as document content.
{
  console.log('-- C: compose-class (skin) classification --');
  const w = await boot(article);
  const skinJson = (name) => JSON.stringify({ format: 'rwa-artifact/1', class: 'compose', artifact: 'skin', skin: { name } });
  // a skin artifact as a full carrier .html: the tag lives INSIDE INLINE_DOC, so its closing </script> is
  // backslash-escaped (exactly as buildFile emits) — classifyArtifact must un-escape via _carrierDoc, the same
  // path the agent-record extractor uses. This pins that a skin artifact is a real, droppable file, not just JSON.
  const skinHtml = (name) =>
    'const INLINE_DOC = `<article><h1>' + name + ' theme</h1></article>' +
    '<script type="application/rwa-artifact+json">' + skinJson(name) + '<\\/script>`;\n';

  // C1 — bare JSON skin artifact (valid preset) → compose/declared; payload is the normalized {artifact,skin}.
  const rJson = await w.__rwaClassifyArtifact(skinJson('linear-dark'));
  check('C1: bare skin JSON → class=compose', rJson.class === 'compose');
  check('C1b: skin artifact → source=declared', rJson.source === 'declared');
  check('C1c: compose payload is {artifact:skin, skin:{name}}',
    !!rJson.payload && rJson.payload.artifact === 'skin' && !!rJson.payload.skin && rJson.payload.skin.name === 'linear-dark');
  check('C1d: no separate semantics field (class IS the semantics)', rJson.semantics === undefined);

  // C1e — skin artifact as a full carrier .html (tag inside INLINE_DOC) → compose/declared.
  const rHtml = await w.__rwaClassifyArtifact(skinHtml('notion-clean'));
  check('C1e: skin-artifact .html → compose/declared',
    rHtml.class === 'compose' && rHtml.source === 'declared' && !!rHtml.payload && rHtml.payload.skin.name === 'notion-clean');

  // C2 — an UNKNOWN preset name → all-null (fail loud). A recognized rwa-artifact/1 envelope we cannot honor
  // must NOT fall through to install/ingest — it is a BROKEN artifact, not a different one.
  const rBadName = await w.__rwaClassifyArtifact(skinJson('no-such-skin'));
  check('C2: unknown preset → {class:null} (fail loud, not mis-routed)',
    rBadName.class === null && rBadName.source === null);

  // C3 — an UNKNOWN artifact kind (a recognized rwa-artifact/1 compose envelope, but not a skin) → all-null.
  const rBadKind = await w.__rwaClassifyArtifact(JSON.stringify({ format: 'rwa-artifact/1', class: 'compose', artifact: 'deck', deck: {} }));
  check('C3: unknown artifact kind → {class:null}', rBadKind.class === null);

  // C4 — a MALFORMED artifact tag (unparseable JSON in the tag) → all-null (not a crash, not a mis-route).
  const rMalformed = await w.__rwaClassifyArtifact('const INLINE_DOC = `<script type="application/rwa-artifact+json">{ not json <\\/script>`;');
  check('C4: malformed artifact tag → {class:null}', rMalformed.class === null);

  // C5 — PRECEDENCE: an AI carrier .html still classifies INSTALL (it carries no artifact tag); a skin artifact
  // classifies COMPOSE. The two are disjoint — adding compose did NOT steal the install path.
  const rCarrier = await w.__rwaClassifyArtifact(carrierHtml);
  const rSkin = await w.__rwaClassifyArtifact(skinJson('stripe-docs'));
  check('C5: AI carrier stays install; skin artifact is compose (disjoint)',
    rCarrier.class === 'install' && rSkin.class === 'compose');
}

// D — skin-drop END TO END (plan Task 2.2): dropping a skin artifact routes through the SAME capture-phase drop
// → classifyArtifact → dispatchArtifact bus and reaches applySkinL1's compose-then-commit — ONE commit, actor
// skin:NAME (the design's whole thesis: a new class rides the existing commit path + actor, unchanged). An
// invalid skin FAILS LOUD (status, no commit) — never a silent no-op. WHY (Rule 9): a skin that silently
// half-applied (a theme without the undo frame, or a commit without attribution) would corrupt ⌘Z / the audit.
{
  console.log('-- D: skin-drop end-to-end (compose) --');
  const skinJson = (name) => JSON.stringify({ format: 'rwa-artifact/1', class: 'compose', artifact: 'skin', skin: { name } });
  const skinHtml = (name) =>
    'const INLINE_DOC = `<article><h1>' + name + '</h1></article>' +
    '<script type="application/rwa-artifact+json">' + skinJson(name) + '<\\/script>`;\n';

  // D1 — drop a valid skin artifact .html → applySkinL1 lands the theme as exactly ONE commit / ONE ⌘Z,
  // attributed actor skin:NAME. A key is set so modify() runs the compose path (no key = early-return); the
  // agent is unreachable (fetch throws), so it degrades to a theme-only commit — still ONE, still attributed.
  {
    const w = await boot(article);
    w.sessionStorage.setItem('rwa_apikey', 'test-key');
    w.sessionStorage.setItem('rwa_model', 'test-model');
    await w.__setDocForTest('<article>\n<p data-rwa-id="d1">skin me</p>\n</article>');
    const hB = ((await readStore(w, 'rwa_hist')) || []).length;
    const uB = ((await readStore(w, 'rwa_undo')) || []).length;
    const file = new w.File([skinHtml('linear-dark')], 'linear-dark.html', { type: 'text/html' });
    const ev = { dataTransfer: { files: [file], items: [{ kind: 'file' }], types: ['Files'] }, preventDefault() {}, stopPropagation() {} };
    await w.__rwaHandleCarrierDrop(ev);
    await new Promise(r => setTimeout(r, 300)); // async read + classify + compose commit
    const doc = await readStore(w, 'rwa_doc');
    check('D1: skin-drop applied the linear-dark theme block', typeof doc === 'string' && /<style data-rwa-skin="linear-dark">/.test(doc));
    const hist = (await readStore(w, 'rwa_hist')) || [];
    check('D1b: skin-drop = exactly ONE commit', hist.length - hB === 1);
    check('D1c: skin-drop = exactly ONE undo frame (one ⌘Z)', (((await readStore(w, 'rwa_undo')) || []).length) - uB === 1);
    check('D1d: skin-drop commit attributed actor skin:linear-dark', !!hist[0] && hist[0].actor === 'skin:linear-dark');
  }

  // D2 — drop an INVALID-preset skin artifact → the "not a recognized artifact" status, NO commit, NO skin.
  // classifyArtifact rejected it to all-null (C2), so the bus never touches the doc — fail loud, not silent.
  {
    const w = await boot(article);
    w.sessionStorage.setItem('rwa_apikey', 'test-key');
    const base = '<article>\n<p data-rwa-id="d2">intact</p>\n</article>';
    await w.__setDocForTest(base);
    const badHtml = 'const INLINE_DOC = `<script type="application/rwa-artifact+json">' + skinJson('no-such-skin') + '<\\/script>`;\n';
    const hB = ((await readStore(w, 'rwa_hist')) || []).length;
    const file = new w.File([badHtml], 'bad.html', { type: 'text/html' });
    await w.__rwaHandleCarrierDrop({ dataTransfer: { files: [file], items: [{ kind: 'file' }], types: ['Files'] }, preventDefault() {}, stopPropagation() {} });
    await new Promise(r => setTimeout(r, 150));
    const st = w.document.getElementById('rwa-st-status');
    check('D2: invalid-preset skin-drop sets the "not a recognized artifact" status', !!st && /not a recognized artifact/.test(st.textContent));
    check('D2b: invalid-preset skin-drop makes NO commit (doc intact, no skin block)',
      (await readStore(w, 'rwa_doc')) === base && ((await readStore(w, 'rwa_hist')) || []).length - hB === 0);
  }

  // D3 — the compose handler's fail-loud GUARD (dispatched directly): classifyArtifact pre-validates the preset,
  // so this belt-and-suspenders guard pins that a hand-built/future compose cls with a bad name still fails loud
  // (clear status, returns false) rather than crashing or silently no-op'ing.
  {
    const w = await boot(article);
    const base = '<article>\n<p data-rwa-id="d3">intact</p>\n</article>';
    await w.__setDocForTest(base);
    const ret = await w.__rwaDispatchArtifact({ class: 'compose', source: 'declared', payload: { artifact: 'skin', skin: { name: 'no-such-skin' } } }, {});
    await new Promise(r => setTimeout(r, 80));
    check('D3: direct compose dispatch with an unknown preset returns false (fail loud)', ret === false);
    check('D3b: guard made no commit (doc intact)', (await readStore(w, 'rwa_doc')) === base);
  }
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
