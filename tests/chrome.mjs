// Unobtrusive chrome: the secondary runtime buttons (info / settings / skins / share)
// collapse into a single ⋯ overflow menu, so the persistent top-right row stays quiet —
// the user's "several buttons next to each other" complaint. WHY (Rule 9): the actions
// must stay REACHABLE (same ids + handlers; other suites click them by id) yet not clutter
// the chrome; ⌘S (the primary save) stays visible.
import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = fs.readFileSync(path.join(__dirname, '..', 'seeds', 'rewritable.html'), 'utf8');
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('  OK  ', l); } else { fail++; console.log('  FAIL', l); } };
const tick = () => new Promise(r => setTimeout(r, 0));

async function boot(kind = 'document') {
  const ov = kindOverrides(kind);
  let html = applySeedSubs(seed, { uuid: crypto.randomUUID(), title: kind, fileMeta: kind + '.html', productKind: kind, lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, ov.body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, { url: 'https://rwa-chrome-' + crypto.randomUUID() + '.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.fetch = () => Promise.reject(new Error('no network'));
      window.BroadcastChannel = globalThis.BroadcastChannel;
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    } });
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) { if (dom.window.runtime && dom.window.document.getElementById('rwa-st-commit')) break; await tick(); }
  await new Promise(r => setTimeout(r, 40));
  return dom.window;
}

console.log('== Unobtrusive chrome menu ==');
const w = await boot();
const doc = w.document;

console.log('\n== M1: the persistent row collapses to a single ⋯ menu ==');
{
  check('a ⋯ menu button exists', !!doc.getElementById('rwa-st-menu'));
  const setRow = doc.getElementById('rwa-set');
  for (const id of ['rwa-st-info', 'rwa-st-cog', 'rwa-st-skin', 'rwa-st-share']) {
    const b = doc.getElementById(id);
    check(id + ' moved out of the persistent row', !!b && !setRow.contains(b));
  }
  check('⌘S commit stays in the persistent row', setRow.contains(doc.getElementById('rwa-st-commit')));
}

console.log('\n== M2: ⋯ toggles the menu; the items live inside it ==');
{
  const menuBtn = doc.getElementById('rwa-st-menu');
  const panel = doc.getElementById('rwa-st-menu-panel');
  check('the menu panel exists', !!panel);
  check('menu hidden by default', !!panel && panel.hidden === true);
  for (const id of ['rwa-st-info', 'rwa-st-cog', 'rwa-st-skin', 'rwa-st-share']) {
    check(id + ' is inside the menu', !!panel && panel.contains(doc.getElementById(id)));
  }
  menuBtn.click();
  check('⋯ click opens the menu', panel.hidden === false);
  menuBtn.click();
  check('⋯ click again closes the menu', panel.hidden === true);
}

console.log('\n== M3: a menu item still opens its panel and closes the menu ==');
{
  const menuBtn = doc.getElementById('rwa-st-menu');
  const panel = doc.getElementById('rwa-st-menu-panel');
  menuBtn.click();
  doc.getElementById('rwa-st-cog').click();
  await tick();
  check('settings panel opened from the menu', doc.getElementById('rwa-set-panel').classList.contains('open'));
  check('the menu closed after choosing an item', panel.hidden === true);
}

console.log('\n== ' + pass + ' pass, ' + fail + ' fail ==');
process.exit(fail ? 1 : 0);
