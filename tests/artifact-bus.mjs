// TDD — the typed artifact drop bus (docs/plans/2026-07-06-artifact-bus-design.md §1-§2,
// plan Task 1.1). Today the seed has TWO drop paths: a capture-phase window drop that claims
// AI/skill CARRIER .html files (classifyInstallText → routeInstallFromText → install dialogs)
// and a #rwa-doc-mount drop that ingests IMAGE files. We unify them behind ONE classifier.
//
// This block covers ONLY classifyArtifact — a pure, additive function returning
//   {class, semantics, source, payload}
// It has TWO lookup strategies: a DECLARED branch (a carrier .html / bare envelope JSON →
// install, delegating to the unchanged classifyInstallText) and a SNIFF branch (an image
// file by file.type → ingest). Declared beats sniff. An unclassifiable drop → the all-null
// "not a recognized artifact" shape. The dispatcher + accepts declaration are LATER tasks.
//
// Seed surface under test (test hook):
//   window.__rwaClassifyArtifact(file|text)  -> async {class, semantics, source, payload}
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

console.log('== artifact drop bus — classifier ==');

// A — classifyArtifact: the unified drop classifier. Every case asserts class/semantics/source
// (the type-system fields the dispatcher will route on), not mere presence.
{
  const w = await boot(article);

  // A1 — a carrier .html TEXT → install, DECLARED. Payload carries the install classification
  // (the classifyInstallText result: kind + extracted envelopes) so the dispatcher can route it.
  const rCarrier = await w.__rwaClassifyArtifact(carrierHtml);
  check('A1: carrier .html → class=install', rCarrier.class === 'install');
  check('A1b: carrier .html → semantics=install', rCarrier.semantics === 'install');
  check('A1c: carrier .html → source=declared', rCarrier.source === 'declared');
  check('A1d: payload IS the install classification (agent-carrier + 1 envelope)',
    !!rCarrier.payload && rCarrier.payload.kind === 'agent-carrier'
    && Array.isArray(rCarrier.payload.envelopes) && rCarrier.payload.envelopes.length === 1);

  // A2 — a bare rwa-agent/1 envelope string → install, DECLARED (json-agent).
  const env = w.__rwaExtractAgentCarrier(carrierHtml)[0];
  const rAgent = await w.__rwaClassifyArtifact(JSON.stringify(env));
  check('A2: bare json-agent → install/install/declared',
    rAgent.class === 'install' && rAgent.semantics === 'install' && rAgent.source === 'declared');
  check('A2b: payload is the json-agent classification', !!rAgent.payload && rAgent.payload.kind === 'json-agent');

  // A2c — a bare rwa-skill/1 envelope string → install, DECLARED (json-skill).
  const rSkill = await w.__rwaClassifyArtifact(JSON.stringify({ format: 'rwa-skill/1', skill: { name: 'x' } }));
  check('A2c: bare json-skill → install/install/declared',
    rSkill.class === 'install' && rSkill.semantics === 'install' && rSkill.source === 'declared');
  check('A2d: payload is the json-skill classification', !!rSkill.payload && rSkill.payload.kind === 'json-skill');

  // A3 — an image File-like → ingest, SNIFFED by file.type (no reading of image bytes).
  const img = { name: 'x.png', type: 'image/png', size: 1234 };
  const rImg = await w.__rwaClassifyArtifact(img);
  check('A3: image file → class=ingest', rImg.class === 'ingest');
  check('A3b: image file → semantics=ingest', rImg.semantics === 'ingest');
  check('A3c: image file → source=sniffed', rImg.source === 'sniffed');
  check('A3d: ingest payload carries the file(s) verbatim',
    !!rImg.payload && Array.isArray(rImg.payload.files) && rImg.payload.files[0] === img);

  // A4 — unknown text → the all-null "not a recognized artifact" shape (today's kind:'none').
  const rNoneText = await w.__rwaClassifyArtifact('<html><body><p>just a page</p></body></html>');
  check('A4: unknown text → {class:null, semantics:null, source:null}',
    rNoneText.class === null && rNoneText.semantics === null && rNoneText.source === null);

  // A4b — unknown file type (not image, not a carrier) → all-null.
  const rNoneFile = await w.__rwaClassifyArtifact({ name: 'data.bin', type: 'application/octet-stream', text: async () => 'not json, not a carrier' });
  check('A4b: unknown file type → all-null',
    rNoneFile.class === null && rNoneFile.semantics === null && rNoneFile.source === null);

  // A5 — PRECEDENCE: a carrier delivered AS A FILE (type text/html, not image) classifies install
  // (declared) — declared beats sniff. WHY it matters: an artifact that self-declares must never be
  // silently re-typed by a sniff, or a dropped AI could be mis-ingested as document content.
  const carrierFile = new w.File([carrierHtml], 'concise-editor.html', { type: 'text/html' });
  const rPrec = await w.__rwaClassifyArtifact(carrierFile);
  check('A5: carrier File (text/html) → install/declared, NOT ingest (declared beats sniff)',
    rPrec.class === 'install' && rPrec.semantics === 'install' && rPrec.source === 'declared');
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
