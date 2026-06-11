// Connected-share chrome test for seeds/rewritable.html — the ↗ panel that
// connects a container to a stable share URL (service /share family).
// Design: docs/plans/2026-06-11-save-affordance-framings.md §7c.
//
// WHY these matter (Rule 9):
//   • the update token is a CAPABILITY — it must live only in rwa_state
//     (machine-local IDB) and never reach the DOM or the ⌘S file bytes; a
//     leaked token lets anyone rewrite the public share;
//   • the panel's language is the product decision: the link shows a published
//     VERSION, not live edits — if the copy stops saying so, the local-first
//     framing collapses back into the live-doc confusion it exists to fix;
//   • share gestures are the ONLY network the runtime does — create/update/
//     unshare each map to exactly one fetch, and a failed fetch must degrade
//     loudly (message) without corrupting the connection record;
//   • freshness ("behind your latest edits") is what tells the user the URL
//     lags their local state — it must flip when the doc changes.
//
// Run:  (cd tests && npm install && npm run test:share)
// Exits non-zero on any failure.

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

async function boot(body = '<article><h1>Share</h1><p>seed text here</p></article>', { sessionExtra = {} } = {}) {
  const ov = kindOverrides('document');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid: webcrypto.randomUUID(), title: 'Share', fileMeta: 'share.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);

  const calls = [];
  // Mutable per-boot fetch behavior; tests swap `handler` between steps.
  const net = {
    calls,
    handler: async () => { throw new Error('no fetch behavior set'); },
  };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-share.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      for (const [k, v] of Object.entries(sessionExtra)) window.sessionStorage.setItem(k, v);
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

const openPanel = async (document) => {
  const p = document.getElementById('rwa-share-panel');
  if (!p.classList.contains('open')) {
    document.getElementById('rwa-st-share').click();
    await waitFor(() => p.classList.contains('open'));
  }
  return p;
};
const closePanel = async (document) => {
  const p = document.getElementById('rwa-share-panel');
  if (p.classList.contains('open')) document.getElementById('rwa-st-share').click();
  await waitFor(() => !p.classList.contains('open'));
};

(async () => {
  console.log('== Connected share (↗ panel) ==');
  const { window, document, net } = await boot();

  // ── A. Disconnected state + the version language ──────────────────────────
  {
    // Open ⚙ first so we can assert the share panel closes it (mutual exclusion).
    document.getElementById('rwa-st-cog').click();
    const panel = await openPanel(document);
    check('A1 ↗ opens the share panel', panel.classList.contains('open'));
    check('A2 settings panel was closed (panels mutually exclusive)',
      !document.getElementById('rwa-set-panel').classList.contains('open'));
    check('A3 disconnected copy says VERSION, not live',
      /version you publish/i.test(panel.textContent));
    check('A4 create affordance present', !!document.getElementById('rwa-share-create'));
    check('A5 no update/stop affordances while disconnected',
      !document.getElementById('rwa-share-update') && !document.getElementById('rwa-share-stop'));
  }

  // ── B. Create: one POST /share with the FULL file bytes ───────────────────
  {
    net.handler = async () => jres(201, {
      short: 'abcd1234', url: 'https://abcd1234.rewritable.ikangai.com/', token: 'tok_test_secret', kind: 'connected',
    });
    document.getElementById('rwa-share-create').click();
    await waitFor(() => document.getElementById('rwa-share-update'));
    check('B1 exactly one fetch for create', net.calls.length === 1);
    const c = net.calls[0];
    check('B2 POST to <base>/share', c.url === 'https://rewritable.ikangai.com/share' && c.opts.method === 'POST');
    check('B3 body is the FULL container (buildFile output), not the bare doc',
      typeof c.opts.body === 'string' && c.opts.body.includes('const DOC_UUID') && c.opts.body.includes('seed text here'));
    const panel = document.getElementById('rwa-share-panel');
    check('B4 panel shows the share URL', panel.textContent.includes('abcd1234.rewritable.ikangai.com'));
    check('B5 connected copy still talks versions', /version/i.test(panel.textContent));
    check('B6 freshness says the published version is current',
      /shows this version/i.test(document.getElementById('rwa-share-fresh').textContent));
  }

  // ── H. Token is a capability: never in the DOM, never in the file ─────────
  {
    const panel = document.getElementById('rwa-share-panel');
    check('H1 token not rendered into the panel', !panel.innerHTML.includes('tok_test_secret'));
    const file = window.buildFile(await window.getDoc());
    check('H2 token not in the ⌘S file bytes (it lives in rwa_state only)', !file.includes('tok_test_secret'));
    check('H3 share URL also not baked into the file', !file.includes('abcd1234.rewritable.ikangai.com'));
  }

  // ── C. Connection persists across panel close/open (record in IDB) ────────
  {
    await closePanel(document);
    const panel = await openPanel(document);
    check('C1 reopened panel is still connected (record read back from rwa_state)',
      panel.textContent.includes('abcd1234.rewritable.ikangai.com') && !!document.getElementById('rwa-share-update'));
  }

  // ── D. Update: Bearer re-publish to the same short ─────────────────────────
  {
    net.calls.length = 0;
    net.handler = async () => jres(200, { short: 'abcd1234', url: 'https://abcd1234.rewritable.ikangai.com/', updatedAt: Date.now() });
    document.getElementById('rwa-share-update').click();
    await waitFor(() => net.calls.length === 1);
    await tick(); await tick();
    const c = net.calls[0];
    check('D1 POST to <base>/share/abcd1234', c.url === 'https://rewritable.ikangai.com/share/abcd1234' && c.opts.method === 'POST');
    check('D2 carries the Bearer capability', (c.opts.headers || {}).Authorization === 'Bearer tok_test_secret');
    check('D3 body is again the full current file', typeof c.opts.body === 'string' && c.opts.body.includes('const DOC_UUID'));
  }

  // ── E. Freshness flips when the doc moves past the published hash ─────────
  {
    await window.runtime.applyEnvelope(
      { version: 'rwa-edit/1', edits: [{ find: 'seed text here', replace: 'locally edited text' }] },
      { surface: 'test:share' });
    await tick();
    await closePanel(document);
    await openPanel(document);
    const freshText = () => (document.getElementById('rwa-share-fresh') || {}).textContent || '';
    check('E1 after a local edit the panel says the share is behind',
      /behind your latest edits/i.test(freshText()));
    // Publishing again returns to "shows this version".
    net.calls.length = 0;
    net.handler = async () => jres(200, { short: 'abcd1234', url: 'https://abcd1234.rewritable.ikangai.com/', updatedAt: Date.now() });
    document.getElementById('rwa-share-update').click();
    await waitFor(() => net.calls.length === 1 && /shows this version/i.test(freshText()));
    check('E2 re-publishing flips freshness back to current', /shows this version/i.test(freshText()));
    check('E3 the re-publish body carries the edited text', net.calls[0].opts.body.includes('locally edited text'));
  }

  // ── F. Failure modes: unreachable keeps the record; 404 clears it ──────────
  {
    net.calls.length = 0;
    net.handler = async () => { throw new TypeError('network down'); };
    document.getElementById('rwa-share-update').click();
    await waitFor(() => /unreachable/i.test(document.getElementById('rwa-share-panel').textContent));
    check('F1 network failure surfaces an unreachable message', true);
    check('F2 …and KEEPS the connection (update affordance still there)',
      !!document.getElementById('rwa-share-update'));

    net.handler = async () => jres(404, { error: 'not_found' });
    document.getElementById('rwa-share-update').click();
    await waitFor(() => !document.getElementById('rwa-share-update'));
    const panel = document.getElementById('rwa-share-panel');
    check('F3 a 404/410 update clears the record (link is dead)', !!document.getElementById('rwa-share-create'));
    check('F4 …with an honest message', /no longer be updated/i.test(panel.textContent));
    await closePanel(document);
    const re = await openPanel(document);
    check('F5 the cleared state persisted (reopen is disconnected)', !!document.getElementById('rwa-share-create'));
  }

  // ── G. Stop sharing: DELETE with the capability, record cleared ────────────
  {
    net.calls.length = 0;
    net.handler = async () => jres(201, { short: 'efgh5678', url: 'https://efgh5678.rewritable.ikangai.com/', token: 'tok_two', kind: 'connected' });
    document.getElementById('rwa-share-create').click();
    await waitFor(() => !!document.getElementById('rwa-share-stop'));

    net.calls.length = 0;
    net.handler = async () => jres(204, null);
    document.getElementById('rwa-share-stop').click();
    await waitFor(() => !!document.getElementById('rwa-share-create'));
    const c = net.calls[0];
    check('G1 DELETE to <base>/share/efgh5678', c.url === 'https://rewritable.ikangai.com/share/efgh5678' && c.opts.method === 'DELETE');
    check('G2 carries the Bearer capability', (c.opts.headers || {}).Authorization === 'Bearer tok_two');
    check('G3 panel returns to disconnected', !!document.getElementById('rwa-share-create'));
  }

  // ── J. Chrome polish: exclusion both ways, clipboard copy, busy state ─────
  {
    // J1/J2: the OTHER panel buttons must close an open share panel.
    let panel = await openPanel(document);
    document.getElementById('rwa-st-cog').click();
    check('J1 ⚙ closes the share panel (mutual exclusion, reverse direction)',
      !panel.classList.contains('open') && document.getElementById('rwa-set-panel').classList.contains('open'));
    await openPanel(document);
    document.getElementById('rwa-st-skin').click();
    await tick();
    check('J2 ✦ closes the share panel too', !panel.classList.contains('open'));
    document.getElementById('rwa-st-skin').click();   // close skins again

    // J3: copy link writes the URL to the clipboard and confirms in the panel.
    const copied = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async (s) => { copied.push(s); } }, configurable: true,
    });
    net.calls.length = 0;
    net.handler = async () => jres(201, { short: 'qqqq1111', url: 'https://qqqq1111.rewritable.ikangai.com/', token: 'tok_three', kind: 'connected' });
    await openPanel(document);
    document.getElementById('rwa-share-create').click();
    await waitFor(() => !!document.getElementById('rwa-share-copy'));
    document.getElementById('rwa-share-copy').click();
    await waitFor(() => copied.length === 1);
    check('J3 Copy link puts the share URL on the clipboard', copied[0] === 'https://qqqq1111.rewritable.ikangai.com/');
    await waitFor(() => /link copied/i.test(document.getElementById('rwa-share-panel').textContent));
    check('J4 …and the panel confirms it', /link copied/i.test(document.getElementById('rwa-share-panel').textContent));

    // J5: while a publish is in flight the action buttons are disabled.
    let release;
    net.handler = () => new Promise(r => { release = () => r(jres(200, { short: 'qqqq1111', url: 'https://qqqq1111.rewritable.ikangai.com/', updatedAt: Date.now() })); });
    document.getElementById('rwa-share-update').click();
    await waitFor(() => document.getElementById('rwa-share-update') && document.getElementById('rwa-share-update').disabled);
    check('J5 in-flight publish disables the action buttons',
      document.getElementById('rwa-share-update').disabled && document.getElementById('rwa-share-stop').disabled);
    await waitFor(() => typeof release === 'function');
    release();
    await waitFor(() => document.getElementById('rwa-share-update') && !document.getElementById('rwa-share-update').disabled);
    check('J6 buttons re-enable after the request settles', !document.getElementById('rwa-share-update').disabled);
  }

  // ── I. Base-URL override (dev/self-hosted service) ─────────────────────────
  {
    const b2 = await boot('<article><p>override</p></article>', { sessionExtra: { rwa_share_base: 'http://127.0.0.1:9999' } });
    b2.net.handler = async () => jres(201, { short: 'zzzz9999', url: 'http://127.0.0.1:9999/s/zzzz9999', token: 't', kind: 'connected' });
    b2.document.getElementById('rwa-st-share').click();
    await waitFor(() => b2.document.getElementById('rwa-share-panel').classList.contains('open'));
    b2.document.getElementById('rwa-share-create').click();
    await waitFor(() => b2.net.calls.length === 1);
    check('I1 sessionStorage rwa_share_base overrides the service base',
      b2.net.calls[0].url === 'http://127.0.0.1:9999/share');
  }

  console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
