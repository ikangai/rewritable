// First-class runtime mode tests for seeds/rewritable.html.
//
// Run: node tests/mode.mjs

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
const seed = fs.readFileSync(SEED, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await tick(); }
  return pred();
}

function buildKind(kind, body) {
  const ov = kindOverrides(kind);
  let html = applySeedSubs(seed, {
    uuid: crypto.randomUUID(),
    title: kind,
    fileMeta: kind + '.html',
    productKind: kind,
    lensPlaceholder: ov.lensPlaceholder,
    palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader,
    lensClickToAnchor: ov.lensClickToAnchor,
  });
  return replaceInlineDoc(html, body == null ? ov.body : body);
}

async function boot({ kind = 'document', body = '<p data-rwa-id="modep">Hello</p>', fetchHandler } = {}) {
  const html = buildKind(kind, body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-mode-' + crypto.randomUUID() + '.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      window.fetch = (...args) => fetchHandler ? fetchHandler(...args) : Promise.reject(new Error('no network in mode test'));
      window.BroadcastChannel = globalThis.BroadcastChannel;
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  await waitFor(() => dom.window.runtime && dom.window.getDoc);
  await new Promise(r => setTimeout(r, 50));
  return dom;
}

async function readHistLen(window) {
  const db = await window.openDB();
  return new Promise(res => {
    const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
    r.onsuccess = () => res((r.result || []).length);
    r.onerror = () => res(0);
  });
}

console.log('== Runtime modes ==');

{
  const dom = await boot();
  const { window } = dom;
  const { document } = window;
  check('fresh boot starts in Document mode', window.runtime.mode === 'document');
  check('body carries document mode marker', document.body.dataset.rwaMode === 'document');

  let p = document.querySelector('[data-rwa-id="modep"]');
  p.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  check('Document mode does not attach click-to-edit', p.getAttribute('contenteditable') !== 'true');

  let seen = 0;
  const off = window.runtime.on('mode', ev => { if (ev.mode === 'edit') seen++; });
  window.runtime.setMode('edit');
  await new Promise(r => setTimeout(r, 50));
  p = document.querySelector('[data-rwa-id="modep"]');
  check('setMode("edit") updates runtime.mode', window.runtime.mode === 'edit');
  check('runtime.on("mode") fires', seen === 1);
  check('Edit mode marks editable leaves', p.classList.contains('rwa-editable-leaf'));
  p.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  check('Edit mode attaches click-to-edit', p.getAttribute('contenteditable') === 'true');

  off();
  window.runtime.setMode('document');
  await new Promise(r => setTimeout(r, 50));
  p = document.querySelector('[data-rwa-id="modep"]');
  check('setMode("document") switches back', window.runtime.mode === 'document');
  check('switching away removes active inline edit', p.getAttribute('contenteditable') !== 'true');
  window.runtime.setMode('edit');
  check('unsubscribed mode listener no longer fires', seen === 1);

  let bad = null;
  try { window.runtime.setMode('bogus'); } catch (e) { bad = e; }
  check('invalid mode throws', !!bad && /unknown mode/i.test(bad.message));
  dom.window.close();
}

{
  let releaseFetch;
  const dom = await boot({
    fetchHandler: () => new Promise(res => {
      releaseFetch = () => res({
        ok: true,
        json: async () => ({ choices: [{ message: { role: 'assistant', content: '<p data-rwa-id="modep">Changed</p>' } }] }),
      });
    }),
  });
  const { window } = dom;
  window.runtime.setMode('edit');
  const pending = window.modify('change it').catch(() => {});
  await waitFor(() => /running|thinking|calling/i.test(window.document.getElementById('rwa-st-status')?.textContent || ''));
  let blocked = null;
  try { window.runtime.setMode('document'); } catch (e) { blocked = e; }
  check('mode switch during modify is rejected', !!blocked && /modify/i.test(blocked.message));
  check('mode remains edit after rejected switch', window.runtime.mode === 'edit');
  if (releaseFetch) releaseFetch();
  await Promise.race([pending, new Promise(r => setTimeout(r, 100))]);
  dom.window.close();
}

{
  const dom = await boot();
  const { window } = dom;
  window.runtime.setMode('skills');
  await waitFor(() => window.document.getElementById('rwa-mode-panel')?.classList.contains('open'));
  check('base document Skills mode is truthful disabled state',
    /does not include the skill runtime/i.test(window.document.getElementById('rwa-mode-panel')?.textContent || ''));
  dom.window.close();
}

{
  const dom = await boot({ kind: 'skill-host', body: kindOverrides('skill-host').body });
  const { window } = dom;
  window.runtime.setMode('skills');
  await waitFor(() => /Installed skills/i.test(window.document.getElementById('rwa-mode-panel')?.textContent || ''));
  const panel = window.document.getElementById('rwa-mode-panel');
  check('skill-host Skills mode renders install controls', !!panel.querySelector('#rwa-skills-install'));
  check('skill-host Skills mode shows current installed list', /No skills installed/i.test(panel.textContent || ''));
  dom.window.close();
}

{
  const dom = await boot();
  const { window } = dom;
  const before = await readHistLen(window);
  window.runtime.setMode('actions');
  await waitFor(() => /Action center/i.test(window.document.getElementById('rwa-mode-panel')?.textContent || ''));
  const after = await readHistLen(window);
  const panel = window.document.getElementById('rwa-mode-panel');
  check('Actions mode renders launcher panel', !!panel.querySelector('#rwa-actions-save') && !!panel.querySelector('#rwa-actions-undo'));
  check('Actions mode open does not mutate history', after === before);
  dom.window.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
