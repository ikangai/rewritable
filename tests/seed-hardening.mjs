// Low-severity seed hardening fixes (kanban TODO cards).
//
//   #6  tagBalance regex undercounts </script-*> / </style-*> custom-element
//       closes — opens use \b (matches <script-foo>), closes use \s*> (does
//       NOT match </script-foo>) → false structural_shape_changed on edits that
//       add a script-*/style-* custom element.
//   #8  parseBridgeEnvelope fence-strip regex is unanchored — strips the first
//       ``` anywhere (e.g. inside an envelope's string value), corrupting it.
//
// The seed's top-level `function` declarations are globals under jsdom
// runScripts:'dangerously', so we call them as window.* directly.
//
// Run:  node seed-hardening.mjs

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const html = fs.readFileSync(SEED, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: 'https://rwa-test.local/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.sessionStorage.setItem('rwa_apikey', 'test-key');
    window.sessionStorage.setItem('rwa_model', 'test-model');
    window.fetch = async () => { throw new Error('no network in this test'); };
    window.BroadcastChannel = globalThis.BroadcastChannel;
    Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  },
});

const window = dom.window;
await new Promise(r => setTimeout(r, 200));
console.log('== Seed-hardening harness loaded ==');

// ─── #6 tagBalance: custom elements must not skew the open/close balance ──────
console.log('\n== #6 tagBalance vs <script-*>/<style-*> custom elements ==');
// WHY: a <script-foo>…</script-foo> custom element is balanced; if opens count
// it (\b) but closes don't (\s*>), applyEdits falsely rejects the edit.
check('tagBalance ignores <script-foo> (balanced → null)', window.tagBalance('<script-foo>x</script-foo>') === null);
check('tagBalance ignores <style-bar>',                    window.tagBalance('<style-bar>y</style-bar>') === null);
check('tagBalance ignores self-terminated <script-foo/>',  window.tagBalance('<wrap><script-foo/></wrap>') === null);
// Sanity: a genuinely unbalanced real <script> is STILL caught.
{
  const r = window.tagBalance('<p>a</p><script>b');
  check('real unbalanced <script> still detected', !!r && r.tag === 'script' && r.opens === 1 && r.closes === 0);
}
check('balanced real <script> ok (null)', window.tagBalance('<script>b</script>') === null);

console.log('\n== #6 integration: edit adding a nested <script-foo> is not rejected ==');
{
  // The custom element is nested (top-level types unchanged) and is not an
  // executable <script>, so computeShape passes — only the buggy tagBalance
  // would reject. Before the fix: structural_shape_changed. After: accepted.
  const doc = '<div data-rwa-id="aaaa0001"><p data-rwa-id="aaaa0002">hi</p></div>';
  const env = { version: 'rwa-edit/1', edits: [{
    find: '<p data-rwa-id="aaaa0002">hi</p>',
    replace: '<p data-rwa-id="aaaa0002">hi</p><script-foo>x</script-foo>',
  }]};
  let threw = null;
  try { await window.applyEdits(env, doc); } catch (e) { threw = e; }
  check('edit adding nested <script-foo> not falsely rejected', !threw);
  if (threw) console.log('       (rejected with: ' + (threw.code || threw.message) + ')');
}

// ─── #8 parseBridgeEnvelope: fence-strip must only touch a LEADING fence ──────
console.log('\n== #8 parseBridgeEnvelope fence-strip anchoring ==');
// WHY: an unanchored strip removes a ```-fence from inside the envelope's own
// content (e.g. a doc/replace string with markdown), silently corrupting it.
{
  const text = '{"tool":"replace_document","envelope":{"version":"rwa-edit/1","doc":"see ```json docs","reason":"x"}}';
  const obj = window.parseBridgeEnvelope(text);
  check('in-content ```json fence preserved in value', !!obj && obj.envelope && obj.envelope.doc === 'see ```json docs');
}
// Sanity: a genuine LEADING fence is still stripped and the envelope parses.
{
  const t = '```json\n{"tool":"apply_edits","envelope":{"version":"rwa-edit/1","edits":[]}}\n```';
  const o = window.parseBridgeEnvelope(t);
  check('leading ```json fence still stripped → envelope parsed', !!o && o.tool === 'apply_edits');
}
// Sanity: a clean envelope (no fence) still parses.
{
  const o = window.parseBridgeEnvelope('{"tool":"apply_edits","envelope":{"version":"rwa-edit/1","edits":[]}}');
  check('clean envelope parses', !!o && o.tool === 'apply_edits');
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
