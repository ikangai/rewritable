// Backend-routing test for seeds/rewritable.html — pins that a selected agent
// backend actually routes modify() to ITS endpoint.
//
// WHY this matters (Rule 9): resolveBackendConfig() falls back to openrouter
// for any unknown backend name. If a backend is offered in the ⚙ select (or
// lifted from ?backend=) but not wired in the resolver, every ⌘K would
// silently POST the user's document to openrouter.ai instead of their chosen
// (often deliberately LOCAL, private) server. Routing is the privacy boundary.
//
// Covers the atomic.chat backend (localhost OpenAI-compat MLX server,
// http://127.0.0.1:1337/v1) added 2026-06-11: URL-param lift, modify routing,
// no-auth-header, base-URL override, and the ⚙ panel wiring.
//
// Run:  (cd tests && npm install && node backends.mjs)

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

// One successful apply_edits tool-call response (the e2e.mjs mock shape).
const toolCallResponse = (find, replace) => ({
  status: 200, ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find, replace }] }),
          },
        }],
      },
    }],
  }),
});

async function boot({ url = 'https://rwa-backends.local/', session = {} } = {}) {
  const ov = kindOverrides('document');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid: webcrypto.randomUUID(), title: 'B', fileMeta: 'b.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, '<article><p>seed text here</p></article>');
  const calls = [];
  const net = { calls, handler: async () => { throw new Error('no fetch behavior set'); } };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_model', 'test-model');
      for (const [k, v] of Object.entries(session)) window.sessionStorage.setItem(k, v);
      window.fetch = (u, opts) => { calls.push({ url: String(u), opts: opts || {} }); return net.handler(u, opts); };
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

(async () => {
  console.log('== Backend routing (atomic.chat) ==');

  // ── A. ?backend=atomic lifts into sessionStorage and is scrubbed from the URL ──
  {
    const { window } = await boot({ url: 'https://rwa-backends.local/?backend=atomic' });
    check('A1 ?backend=atomic lands in sessionStorage', window.sessionStorage.getItem('rwa_backend') === 'atomic');
    check('A2 the param is scrubbed from the URL', !window.location.search.includes('backend'));
  }

  // ── B. modify() routes to the atomic endpoint, unauthenticated ─────────────
  {
    const { window, net } = await boot({ session: { rwa_backend: 'atomic' } });
    net.handler = async () => toolCallResponse('seed text here', 'edited via atomic');
    await window.modify('change the text');
    await tick();
    check('B1 exactly one chat call', net.calls.length === 1);
    check('B2 modify POSTs to the atomic default base',
      net.calls[0] && net.calls[0].url === 'http://127.0.0.1:1337/v1/chat/completions');
    check('B3 no Authorization header (local server, no key)',
      net.calls[0] && !('Authorization' in (net.calls[0].opts.headers || {})));
    const doc = await window.getDoc();
    check('B4 the edit committed through the normal loop', doc.includes('edited via atomic'));
    // atomic.chat 400s when prompt + max generation exceed MAX_KV_SIZE (16384
    // default) instead of clamping — the request must fit the window.
    const body = JSON.parse(net.calls[0].opts.body);
    check('B5 max_tokens respects the atomic KV budget (8192, not 32000)', body.max_tokens === 8192);
  }

  // ── C. base-URL override (sessionStorage rwa_base_url_atomic) ──────────────
  {
    const { window, net } = await boot({
      session: { rwa_backend: 'atomic', rwa_base_url_atomic: 'http://10.0.0.5:9999/v1/' },
    });
    net.handler = async () => toolCallResponse('seed text here', 'via override');
    await window.modify('change the text');
    check('C1 override base used (trailing slash normalized)',
      net.calls[0] && net.calls[0].url === 'http://10.0.0.5:9999/v1/chat/completions');
  }

  // ── D. ⚙ panel wiring: selecting atomic shows base URL + hint, hides key ───
  {
    const { window, document } = await boot();
    document.getElementById('rwa-st-cog').click();
    const sel = document.getElementById('rwa-backend');
    check('D1 the select offers atomic', [...sel.options].some(o => o.value === 'atomic'));
    sel.value = 'atomic';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    check('D2 base-URL row visible with the atomic default',
      document.getElementById('rwa-set-row-base-url').style.display !== 'none'
      && document.getElementById('rwa-base-url').placeholder === 'http://127.0.0.1:1337/v1');
    check('D3 key row hidden (no key needed)',
      document.getElementById('rwa-set-row-key').style.display === 'none');
    check('D4 hint mentions CORS reality', /CORS|origin/i.test(document.getElementById('rwa-backend-hint').textContent));
  }

  console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
