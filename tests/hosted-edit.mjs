// "Edit online" chrome test for seeds/rewritable.html — the ✎ panel that
// creates a LIVE editable hosted copy (service POST /r). Sibling of the ↗
// connected-share panel; design docs/plans/2026-08-13-hosted-regular-user-flow-design.md §4.3.
//
// WHY these matter (Rule 9):
//   • Edit-online is CANON-MOVING, unlike Share (read-only version). The copy
//     must SAY so — "edits happen on the hosted copy, not this file" — or a user
//     will think their local file is being edited and lose work;
//   • the returned url embeds the capability token in its #k= fragment, so the
//     WHOLE url is a secret: it lives in rwa_state only and must never reach the
//     ⌘S file bytes (buildFile), exactly like the share token;
//   • create is ONE POST to <base>/r with the full file bytes (buildFile) — the
//     hosted runtime ingests a real rewritable, not a bare doc;
//   • the two link panels are mutually exclusive (opening one closes the other),
//     so the canon-stays vs canon-moves framings never sit open together.
//
// Run:  (cd tests && node hosted-edit.mjs)

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

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await tick(); }
  return pred();
}
const jres = (status, obj) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => obj, text: async () => JSON.stringify(obj ?? ''),
});

const HOSTED_URL = 'https://8qqnq6xa28ly.rewritable.ikangai.com/#k=cap_secret_tok';

async function boot(body = '<article><h1>Edit online</h1><p>seed text here</p></article>') {
  const ov = kindOverrides('document');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid: webcrypto.randomUUID(), title: 'HE', fileMeta: 'he.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const calls = [];
  const net = { calls, handler: async () => { throw new Error('no fetch behavior set'); } };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-he.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      window.fetch = (url, opts) => { calls.push({ url: String(url), opts: opts || {} }); return net.handler(url, opts); };
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  const ready = await waitFor(() => dom.window.runtime && dom.window.document.getElementById('rwa-st-commit'));
  if (!ready) throw new Error('bootstrap did not settle');
  return { window: dom.window, document: dom.window.document, net };
}

const openHosted = async (document) => {
  const p = document.getElementById('rwa-hostedit-panel');
  if (!p.classList.contains('open')) {
    document.getElementById('rwa-st-hostedit').click();
    await waitFor(() => p.classList.contains('open'));
  }
  return p;
};

(async () => {
  console.log('== Edit online (✎ hosted panel) ==');
  const { window, document, net } = await boot();

  // ── A. Disconnected state + the canon-moving language ─────────────────────
  {
    document.getElementById('rwa-st-share').click(); // open Share first → assert mutual exclusion
    await waitFor(() => document.getElementById('rwa-share-panel').classList.contains('open'));
    const panel = await openHosted(document);
    check('A1 ✎ opens the Edit-online panel', panel.classList.contains('open'));
    check('A2 the Share panel was closed (mutually exclusive framings)',
      !document.getElementById('rwa-share-panel').classList.contains('open'));
    check('A3 copy states the canon MOVES (edits on the hosted copy, not this file)',
      /hosted copy/i.test(panel.textContent) && /this file stays|stays as it is/i.test(panel.textContent));
    check('A4 create affordance present', !!document.getElementById('rwa-hostedit-create'));
  }

  // ── B. Create: one POST /r with the FULL file bytes ───────────────────────
  {
    net.handler = async () => jres(200, { id: '8qqnq6xa28ly', token: 'cap_secret_tok', url: HOSTED_URL });
    document.getElementById('rwa-hostedit-create').click();
    await waitFor(() => document.getElementById('rwa-hostedit-open'));
    check('B1 exactly one fetch for create', net.calls.length === 1);
    const c = net.calls[0];
    check('B2 POST to <base>/r', c.url === 'https://rewritable.ikangai.com/r' && c.opts.method === 'POST');
    check('B3 body is the FULL container (buildFile output), not the bare doc',
      typeof c.opts.body === 'string' && c.opts.body.includes('const DOC_UUID') && c.opts.body.includes('seed text here'));
    const panel = document.getElementById('rwa-hostedit-panel');
    check('B4 panel shows the editable link', panel.textContent.includes('8qqnq6xa28ly.rewritable.ikangai.com'));
    check('B5 Open/Copy/Forget affordances present',
      !!document.getElementById('rwa-hostedit-open') && !!document.getElementById('rwa-hostedit-copy') && !!document.getElementById('rwa-hostedit-forget'));
  }

  // ── C. The url IS the capability (token in #k=) — never in the file ────────
  {
    const file = window.buildFile(await window.getDoc());
    check('C1 the capability url is NOT baked into the ⌘S file (rwa_state only)', !file.includes('8qqnq6xa28ly'));
    check('C2 the token is NOT in the file', !file.includes('cap_secret_tok'));
  }

  // ── D. Record persists across close/open (read back from rwa_state) ───────
  {
    document.getElementById('rwa-st-hostedit').click(); // toggle closed
    await waitFor(() => !document.getElementById('rwa-hostedit-panel').classList.contains('open'));
    const panel = await openHosted(document);
    check('D1 reopened panel is still connected (record from rwa_state)',
      panel.textContent.includes('8qqnq6xa28ly.rewritable.ikangai.com') && !!document.getElementById('rwa-hostedit-open'));
  }

  // ── E. Forget clears the machine-local record, back to create state ───────
  {
    document.getElementById('rwa-hostedit-forget').click();
    await waitFor(() => document.getElementById('rwa-hostedit-create'));
    check('E1 Forget returns the panel to the create state', !!document.getElementById('rwa-hostedit-create')
      && !document.getElementById('rwa-hostedit-open'));
    check('E2 no further fetch was made by Forget (server copy untouched)', net.calls.length === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  window.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
