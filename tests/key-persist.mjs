// API-key persistence — "Remember on this device", all documents (2026-08-12).
//
// WHY: the posture keeps the key in sessionStorage (per tab) because a hostile
// received document can read anything the page reaches. That cost re-entry in
// every tab of every document — the entire friction for the non-technical
// target audience. Operator decision 2026-08-12: default to remembering the key
// in localStorage, which at file:// is shared across all local rewritables
// (null origin) and per-origin when hosted, so one entry serves every document.
// These tests pin the mechanism AND the honest off-switch: turning Remember off
// clears the stored copy and restores the strict per-tab posture.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
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
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await tick(); }
  return false;
};

// A shared localStorage object simulates the file:// null origin: every
// container in a run reads and writes the same store, exactly as real file://
// documents do. sessionStorage is per-boot (per tab).
async function boot({ url = 'https://rwa-key.local/', shared, session = {} } = {}) {
  const ov = kindOverrides('document');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid: webcrypto.randomUUID(), title: 'K', fileMeta: 'k.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, '<article><p>seed text here</p></article>');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      if (shared) Object.defineProperty(window, 'localStorage', { value: shared, configurable: true });
      for (const [k, v] of Object.entries(session)) window.sessionStorage.setItem(k, v);
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  const ready = await waitFor(() => dom.window.runtime && dom.window.document.getElementById('rwa-st-commit'));
  if (!ready) throw new Error('bootstrap did not settle');
  return { window: dom.window, document: dom.window.document };
}

// Minimal Storage stand-in shared across boots (jsdom gives each window its own).
function makeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _map: m,
  };
}

(async () => {
  console.log('== API key persistence (remember on this device) ==');

  // A. Default ON: a key typed in one document is remembered and a SECOND
  //    document (new tab, same shared file:// store) boots already connected.
  {
    const shared = makeStorage();
    const a = await boot({ shared });
    const kf = a.document.getElementById('rwa-key');
    check('A1 Remember toggle exists and defaults ON', a.document.getElementById('rwa-remember-key')?.checked === true);
    kf.value = 'sk-or-typed-in-A';
    kf.dispatchEvent(new a.window.Event('input', { bubbles: true }));
    check('A2 the typed key is remembered (shared localStorage)', shared.getItem('rwa_apikey') === 'sk-or-typed-in-A');
    check('A3 it is also in this tab\'s sessionStorage', a.window.sessionStorage.getItem('rwa_apikey') === 'sk-or-typed-in-A');

    const b = await boot({ shared }); // a different document, same machine
    check('A4 a second document boots already holding the key', b.window.sessionStorage.getItem('rwa_apikey') === 'sk-or-typed-in-A');
  }

  // B. Turning Remember OFF clears the stored copy and stops persisting.
  {
    const shared = makeStorage({ rwa_apikey: 'sk-or-remembered', rwa_remember_key: 'on' });
    const w = await boot({ shared });
    check('B1 boot hydrated the per-tab key from the remembered one', w.window.sessionStorage.getItem('rwa_apikey') === 'sk-or-remembered');
    const toggle = w.document.getElementById('rwa-remember-key');
    check('B2 toggle reflects the stored ON preference', toggle.checked === true);
    toggle.checked = false;
    toggle.dispatchEvent(new w.window.Event('change', { bubbles: true }));
    check('B3 turning it off clears the remembered key', shared.getItem('rwa_apikey') === null);
    check('B4 the preference is recorded off', shared.getItem('rwa_remember_key') === 'off');
    // With remember off, a newly typed key must NOT persist.
    const kf = w.document.getElementById('rwa-key');
    kf.value = 'sk-or-should-not-persist';
    kf.dispatchEvent(new w.window.Event('input', { bubbles: true }));
    check('B5 with remember off, a new key stays per-tab only', shared.getItem('rwa_apikey') === null
      && w.window.sessionStorage.getItem('rwa_apikey') === 'sk-or-should-not-persist');
  }

  // C. With remember off, a fresh document does NOT inherit a key.
  {
    const shared = makeStorage({ rwa_remember_key: 'off' });
    const w = await boot({ shared });
    check('C1 remember-off container boots with no key', !w.window.sessionStorage.getItem('rwa_apikey'));
    check('C2 the toggle shows off', w.document.getElementById('rwa-remember-key').checked === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
