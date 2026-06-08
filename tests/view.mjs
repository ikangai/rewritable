// Presentation render-mode test for seeds/rewritable.html (spec §5.10).
//
// Conformance (benchmark/) exercises the view API against the DOCUMENT-kind seed
// with a test provider. This file loads a real PRESENTATION-kind container —
// built exactly the way `rwa new --kind presentation` builds it — and asserts the
// bootstrap-registered first-party provider behaves per the §5.10 contract.
//
// Run:  (cd tests && npm install && npm run test:view)
// Exits non-zero on any failure.

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

// Build a presentation container the same way the CLI does: seed-level subs
// first, then drop the starter deck into INLINE_DOC (CLAUDE.md ordering).
const ov = kindOverrides('presentation');
let html = fs.readFileSync(SEED, 'utf8');
html = applySeedSubs(html, {
  uuid: crypto.randomUUID(),
  title: 'Deck',
  fileMeta: 'deck.html',
  productKind: 'presentation',
  lensPlaceholder: ov.lensPlaceholder,
  palPlaceholder: ov.palPlaceholder,
  productHeader: ov.productHeader,
  lensClickToAnchor: ov.lensClickToAnchor,
});
html = replaceInlineDoc(html, ov.body);

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: 'https://rwa-deck.local/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.sessionStorage.setItem('rwa_apikey', 'test-key');
    window.sessionStorage.setItem('rwa_model', 'test-model');
    window.fetch = async () => { throw new Error('no network in this test'); };
    Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  },
});

const { window } = dom;
const { document } = window;

async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await tick(); }
  return pred();
}

(async () => {
  console.log('== Presentation render mode (spec §5.10) ==');

  const ready = await waitFor(() => window.runtime && typeof window.runtime.setView === 'function');
  check('bootstrap settled — runtime.setView exposed', ready);
  check('no bootstrap error', !document.body.textContent.startsWith('Bootstrap error'));

  const mount = document.getElementById('rwa-doc-mount');
  const toggle = document.getElementById('rwa-view-toggle');

  // Presentation kind builds the Present toggle; document/workflow never do.
  check('Present toggle built for presentation kind', !!toggle && toggle.textContent === 'Present');
  check('starts in prose mode (no view class, no slides)',
    !mount.classList.contains('viewmode-presentation') && mount.querySelectorAll('.rwa-slide').length === 0);

  // Activate the render mode.
  window.runtime.setView('presentation');
  await waitFor(() => mount.querySelectorAll('.rwa-slide').length > 0);
  const slides = mount.querySelectorAll('.rwa-slide');
  check('present mode renders 3 slides (h1 + 2×h2, no spurious leading slide)', slides.length === 3);
  check('exactly one slide is active', mount.querySelectorAll('.rwa-slide.active').length === 1);
  check('mount carries the viewmode-presentation class', mount.classList.contains('viewmode-presentation'));
  check('toggle label flips to Prose', toggle.textContent === 'Prose');
  check('slide counter reads 1 / 3', (document.getElementById('rwa-view-count') || {}).textContent === '1 / 3');

  // rwa inline-edit: the double-click-to-edit handler is NOT registered under an
  // active view (renderDoc gates it on !activeView, like click-to-anchor). A
  // double-click while presenting must not make a block contenteditable.
  {
    const block = mount.querySelector('.rwa-slide h1, .rwa-slide h2, .rwa-slide p, .rwa-slide li');
    check('a slide block exists to probe inline-edit inertness', !!block);
    if (block) block.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    check('inline edit inert under active view (block not contenteditable)',
      !block || block.getAttribute('contenteditable') !== 'true');
  }

  // Invariant 8: stored doc never carries slide wrappers, even while presenting.
  const stored = await window.getDoc();
  check('Invariant 8 — stored rwa_doc has NO slide wrappers while presenting', !/rwa-slide/.test(stored));
  check('stored doc still holds the prose (h1 title present)', /re-write-able/.test(stored));

  // Invariant 9: the agent-facing source cache equals the stored text.
  check('Invariant 9 — agent source cache == stored text (no wrappers)',
    window.getCurrentDocCache && window.getCurrentDocCache() === stored && !/rwa-slide/.test(window.getCurrentDocCache()));

  // Nav.
  document.getElementById('rwa-view-next').click();
  await tick();
  check('next advances to slide 2 / 3', (document.getElementById('rwa-view-count') || {}).textContent === '2 / 3');

  // Toggle back to prose — the click listener must be re-wired, view class gone.
  window.runtime.setView(null);
  await waitFor(() => !mount.classList.contains('viewmode-presentation'));
  check('toggle back to prose removes the view class', !mount.classList.contains('viewmode-presentation'));
  check('prose mode renders no slides', mount.querySelectorAll('.rwa-slide').length === 0);
  check('toggle label back to Present', toggle.textContent === 'Present');

  // setView refuses an unknown view name (defensive).
  let threw = null;
  try { window.runtime.setView('nope'); } catch (e) { threw = e; }
  check("setView('nope') throws 'no registered view'", !!threw && /no registered view/i.test(threw.message));

  console.log(`\n${pass} pass, ${fail} fail`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
