// Cross-tab commit signal (#20).
//
// WHY: two tabs open on the same container is the concurrency case the substrate
// never noticed. Every commit path re-reads rwa_doc first, which makes the window
// look small — but modify() re-reads it BEFORE a model call that takes seconds,
// and a commit landing from the other tab inside that window is overwritten with
// no error, no history entry, and nothing on screen. rwa-edit-spec §5.6 recorded
// cross-tab modify as "not supported"; in practice that meant "silently picks one
// side", which is precisely what boot reconciliation exists to refuse for the
// file. This pins the sibling-tab half.
//
// Two JSDOM windows over ONE fake-indexeddb module instance is a faithful model:
// that is exactly how two real tabs share rwa_<DOC_UUID>. BroadcastChannel is
// injected from Node, whose implementation also delivers between instances in one
// process — so the whole signal path (post → receive → hash compare → bar) is
// assertable here. Per the browser-lane rule, anything jsdom can assert stays in
// jsdom; only the fact that delivery happens between two real file:// tabs (not
// obvious — file:// pages are opaque origins) belongs in tests/browser/.
//
// Run:  (cd tests && node cross-tab.mjs)

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto, { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await tick(); };

// `withChannel:false` boots a tab whose runtime finds no BroadcastChannel at all —
// the degrade path, which must still notice via the foreground re-check.
async function boot(body, { uuid = crypto.randomUUID(), withChannel = true } = {}) {
  const ov = kindOverrides('document');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'XT', fileMeta: 'xt.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => {
    const s = e?.detail?.message || e?.detail?.stack || String(e?.detail || e);
    if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s);
  });
  const dom = new JSDOM(html, {
    url: 'https://rwa-xt.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
      // jsdom ships neither crypto.subtle nor TextEncoder; the hash the signal
      // compares needs both (tests/boot-reconcile.mjs:80 does the same).
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      if (withChannel) window.BroadcastChannel = BroadcastChannel;
      else { try { delete window.BroadcastChannel; } catch (_) { /* absent already */ } }
    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (window.runtime && typeof window.runtime.applyEnvelope === 'function') break;
    await tick();
  }
  await settle(10);
  return { window, uuid };
}

const barShown = (w) => {
  const b = w.document.getElementById('rwa-foreign-bar');
  return !!b && b.hidden === false;
};
const env = (find, replace) => ({ version: 'rwa-edit/1', edits: [{ find, replace }] });

(async () => {
  console.log('== X1: a sibling tab\'s commit raises the bar — and only there ==');
  const uuid = crypto.randomUUID();
  const A = await boot('<article><p>alpha</p><p>bravo</p></article>', { uuid });
  const B = await boot('<article><p>alpha</p><p>bravo</p></article>', { uuid });
  check('both tabs booted on the same container', A.uuid === B.uuid);
  check('no bar before anything happens (A)', !barShown(A.window));
  check('no bar before anything happens (B)', !barShown(B.window));

  await A.window.runtime.applyEnvelope(env('alpha', 'ALPHA'), { surface: 'test:A' });
  await settle();

  check('the OTHER tab is told its copy is stale', barShown(B.window));
  // The committing tab must not warn itself: it would fire on every single edit,
  // and a warning that always shows is a warning nobody reads.
  check('the committing tab does NOT warn itself (self-echo filtered)', !barShown(A.window));

  console.log('\n== X2: the bar is dismissible, and re-arms on the next foreign commit ==');
  const dismiss = B.window.document.querySelector('#rwa-foreign-bar [data-act="dismiss"]');
  check('the bar offers a way to keep working here', !!dismiss);
  dismiss.click();
  await settle(5);
  check('dismiss hides it', !barShown(B.window));

  await A.window.runtime.applyEnvelope(env('bravo', 'BRAVO'), { surface: 'test:A2' });
  await settle();
  check('a LATER foreign commit raises it again (dismiss is not a permanent mute)', barShown(B.window));

  console.log('\n== X3: an undo in one tab is a change like any other ==');
  const uuid3 = crypto.randomUUID();
  const A3 = await boot('<article><p>one</p><p>two</p></article>', { uuid: uuid3 });
  const B3 = await boot('<article><p>one</p><p>two</p></article>', { uuid: uuid3 });
  // Two commits, so undoing the second lands on a state B3 has never seen. With a
  // single commit the undo would restore exactly the bytes B3 is still showing —
  // see the no-warn case asserted below, which is the reason this needs two.
  await A3.window.runtime.applyEnvelope(env('one', 'ONE'), { surface: 'test:A3a' });
  await A3.window.runtime.applyEnvelope(env('two', 'TWO'), { surface: 'test:A3b' });
  await settle();
  // B3 already knows it is stale from those commits; clear it so the undo is what
  // we are actually measuring rather than the commits that preceded it.
  const d3 = B3.window.document.querySelector('#rwa-foreign-bar [data-act="dismiss"]');
  if (d3) d3.click();
  await settle(5);
  check('bar cleared before the undo', !barShown(B3.window));

  await A3.window.runtime.undo();   // ONE/TWO → ONE/two, which B3 has never seen
  await settle();
  check('undo in tab A moves rwa_doc and warns tab B', barShown(B3.window));

  // The signal compares CONTENT, not event count — so an undo that happens to
  // restore exactly what the other tab is still showing must stay quiet. A
  // warning that fires when the two sides already agree trains the user to
  // ignore the one that matters.
  const uuid3b = crypto.randomUUID();
  const A3b = await boot('<article><p>keep</p></article>', { uuid: uuid3b });
  const B3b = await boot('<article><p>keep</p></article>', { uuid: uuid3b });
  await A3b.window.runtime.applyEnvelope(env('keep', 'KEEP'), { surface: 'test:A3c' });
  await settle();
  const d3b = B3b.window.document.querySelector('#rwa-foreign-bar [data-act="dismiss"]');
  if (d3b) d3b.click();
  await settle(5);
  await A3b.window.runtime.undo();  // back to exactly the bytes B3b still shows
  await settle();
  check('an undo restoring what the other tab already shows stays quiet', !barShown(B3b.window));

  console.log('\n== X4: no BroadcastChannel — the signal degrades, it does not vanish ==');
  const uuid4 = crypto.randomUUID();
  const A4 = await boot('<article><p>red</p><p>blue</p></article>', { uuid: uuid4 });
  const B4 = await boot('<article><p>red</p><p>blue</p></article>', { uuid: uuid4, withChannel: false });
  check('the degraded tab really has no BroadcastChannel', typeof B4.window.BroadcastChannel === 'undefined');

  await A4.window.runtime.applyEnvelope(env('red', 'RED'), { surface: 'test:A4' });
  await settle();
  check('with no channel it cannot know yet', !barShown(B4.window));

  // A frozen or throttled tab is never handed the message either. Coming back to
  // the foreground is the deterministic re-check, and the only path that works
  // with no channel at all.
  B4.window.document.dispatchEvent(new B4.window.Event('visibilitychange'));
  await settle();
  check('returning to the foreground re-checks IDB and notices', barShown(B4.window));

  console.log('\n== X5: the signal is scoped to ONE container ==');
  // The channel name is keyed by DOC_UUID; a different container must be silent,
  // or every open rewritable would warn about every other one.
  const C = await boot('<article><p>unrelated</p></article>'); // fresh uuid
  await settle(5);
  check('an unrelated container shows no bar at boot', !barShown(C.window));
  await A4.window.runtime.applyEnvelope(env('blue', 'BLUE'), { surface: 'test:A5' });
  await settle();
  check('a commit in another container does not reach it', !barShown(C.window));

  for (const t of [A, B, A3, B3, A3b, B3b, A4, B4, C]) { try { t.window.close(); } catch (_) { /* best effort */ } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
