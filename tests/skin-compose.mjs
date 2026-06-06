// skinning-v2 compose-then-commit — characterization test.
//
// Plan: docs/plans/2026-06-06-skinning-v2-impl-plan.md. Pins the new runtime
// surface that lets a skin land theme + agent-restyle as ONE commit:
//   • applyEdits({noCommit}) — validate + splice, return the string, DON'T commit
//     (the accumulate-without-commit seam; default path still commits).
//   • modify(instr, lensMeta, {compose}) — run the agent loop no-commit, splice
//     the deterministic theme block onto its output, commit ONCE via
//     replace_document (one rwa_undo frame → one ⌘Z reverts theme+wrappers).
//     Graceful: if the agent declines, the theme still lands (theme-only, one commit).
//   • applySkinL1(name) — drives the above for a preset; bridge/single-shot → L0.
//
// The agent is stubbed at the fetch layer (a canned OpenAI tool_call), same as
// the benchmark conformance harness. RED until Tasks 1-3 land in the seed.
//
// Run directly:  (cd tests && node skin-compose.mjs)

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
const codeOf = (e) => (e && (e.code || e.message) || '').toString();

// Build a canned OpenAI-compatible chat response carrying ONE apply_edits tool
// call (the agent's L1 restyle). This is exactly what openAiCompatChat returns.
function stubToolCall(envelope) {
  return async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'apply_edits', arguments: JSON.stringify(envelope) } },
      ] } }],
    }),
  });
}
// A response with NO tool_calls — the model "declines".
const stubDecline = async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { role: 'assistant', content: 'I will not edit this.' } }] }),
});

async function boot(body, { backend } = {}) {
  const ov = kindOverrides('document');
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'SK', fileMeta: 'sk.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-sk.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      if (backend) window.sessionStorage.setItem('rwa_backend', backend);
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (window.runtime && typeof window.getDoc === 'function') break;
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
const histLen = async (uuid) => ((await readStore(uuid, 'rwa_hist')) || []).length;
const undoLen = async (uuid) => ((await readStore(uuid, 'rwa_undo')) || []).length;

(async () => {
  console.log('== skinning-v2: compose-then-commit ==');

  // ── Task 1: applyEdits({noCommit}) validates + returns the string, no commit ──
  {
    const BODY = '<article>\n<p>ANCHOR-ALPHA paragraph</p>\n<p>second paragraph</p>\n</article>';
    const w = await boot(BODY);
    const doc0 = await w.window.getDoc();
    const histBefore = await histLen(w.uuid);

    const out = await w.window.applyEdits(
      { version: 'rwa-edit/1', edits: [{ find: 'ANCHOR-ALPHA', replace: 'ANCHOR-BETA' }] },
      doc0, null, { noCommit: true });
    check('T1: noCommit returns the spliced string', typeof out === 'string' && out.includes('ANCHOR-BETA') && !out.includes('ANCHOR-ALPHA'));
    await tick();
    check('T1: noCommit did NOT write rwa_hist', (await histLen(w.uuid)) === histBefore);
    check('T1: noCommit did NOT change the stored doc', (await w.window.getDoc()) === doc0);

    // control: default (no opts) still commits exactly one entry.
    const committed = await w.window.applyEdits(
      { version: 'rwa-edit/1', edits: [{ find: 'ANCHOR-ALPHA', replace: 'ANCHOR-GAMMA' }] },
      doc0, null);
    await tick();
    check('T1: default (no opts) still commits one rwa_hist entry', (await histLen(w.uuid)) - histBefore === 1);
    check('T1: default returns committed doc with the edit', typeof committed === 'string' && committed.includes('ANCHOR-GAMMA'));
  }

  console.log(`\n${pass} / ${pass + fail} passing`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
