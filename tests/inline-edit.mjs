// Tests for inline manual edit — direct, no-LLM block editing in
// seeds/rewritable.html. Double-click a leaf block -> contenteditable;
// Enter/blur commits via the existing non-agent commit path (no model call).
//
// Run from this directory:  node inline-edit.mjs
//
// Each test encodes WHY the behavior matters (CLAUDE.md Rule 9). The two
// load-bearing ones are the corruption modes a naive implementation hits:
//   * id/attribute loss  -> breaks #id fragment links  (E1, E2)
//   * contenteditable HTML-soup -> reparse desyncs the sourceMap (E3)
//
// The test exits non-zero if any assertion fails.

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
    window.fetch = async () => { throw new Error('inline edit must not call the network'); };
    window.BroadcastChannel = globalThis.BroadcastChannel;
    Object.defineProperty(window.navigator, 'storage', {
      value: { persist: () => Promise.resolve(false) }, configurable: true,
    });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  },
});

const window = dom.window;
const { document } = window;
await new Promise(r => setTimeout(r, 200));
const settle = () => new Promise(r => setTimeout(r, 50));

console.log('== Inline-edit harness loaded ==');

const $id = id => document.querySelector(`[data-rwa-id="${id}"]`);
function dbl(el) { el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })); }
async function readHistTop() {
  const db = await window.openDB();
  return new Promise(res => {
    const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
    r.onsuccess = () => res((r.result || [])[0]);
  });
}
async function readUndoLen() {
  const db = await window.openDB();
  return new Promise(res => {
    const r = db.transaction('rwa_undo').objectStore('rwa_undo').get('self');
    r.onsuccess = () => res((r.result || []).length);
    r.onerror = () => res(0);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Group S — serializeLeafSafe: the controlled serializer that turns an
// edited contenteditable node into a clean replace string. It must emit
// ONLY escaped text and <br>, flattening any other node to plain text.
// This is the fix for the HTML-soup corruption mode.
console.log('\n== S1: escapes text content ==');
{
  const p = document.createElement('p');
  p.textContent = 'a & b < c >';
  check('text is HTML-escaped', window.serializeLeafSafe(p) === 'a &amp; b &lt; c &gt;');
}
console.log('\n== S2: preserves <br> soft break ==');
{
  const p = document.createElement('p');
  p.innerHTML = 'a<br>b';
  check('<br> survives (Shift+Enter soft break)', window.serializeLeafSafe(p) === 'a<br>b');
}
console.log('\n== S3: flattens <div> soup ==');
{
  const p = document.createElement('p');
  p.innerHTML = 'a<div>b</div>c';   // what a browser leaves after Enter in several engines
  check('<div> flattened to plain text (no tag)', window.serializeLeafSafe(p) === 'abc');
}
console.log('\n== S4: flattens styled span ==');
{
  const p = document.createElement('p');
  p.innerHTML = 'x<span style="color:red">y</span>z';
  check('styled span flattened to plain text', window.serializeLeafSafe(p) === 'xyz');
}

// ─────────────────────────────────────────────────────────────────────
// Group E — end-to-end: dblclick -> edit -> commit through the real path.
console.log('\n== E1: data-rwa-id preserved through an edit ==');
{
  await window.__setDocForTest('<p data-rwa-id="aaaa1111">Hello</p>');
  const el = $id('aaaa1111');
  dbl(el);
  check('block became contenteditable on double-click', el.getAttribute('contenteditable') === 'true');
  el.textContent = 'Hello world';
  await window.commitInlineEdit();
  await settle();
  const doc = await window.getDoc();
  // WHY: a re-assigned id silently breaks every #id fragment link to this block.
  check('original data-rwa-id is preserved (not re-assigned)', doc.includes('data-rwa-id="aaaa1111"'));
  check('new text committed', doc.includes('Hello world'));
  check('exactly one block id in doc (no duplicate/extra)',
    (doc.match(/data-rwa-id="aaaa1111"/g) || []).length === 1);
}

console.log('\n== E2: other attributes (class) preserved through an edit ==');
{
  await window.__setDocForTest('<p class="lead" data-rwa-id="bbbb2222">Hi</p>');
  const el = $id('bbbb2222');
  dbl(el);
  el.textContent = 'Hey there';
  await window.commitInlineEdit();
  await settle();
  const doc = await window.getDoc();
  // WHY: re-emitting <tag id> only would drop class/style/etc. — silent data loss.
  check('class attribute preserved', doc.includes('class="lead"'));
  check('id still preserved alongside class', doc.includes('data-rwa-id="bbbb2222"'));
  check('new text committed', doc.includes('Hey there'));
}

console.log('\n== E3: contenteditable soup flattened end-to-end, sourceMap stays in sync ==');
{
  await window.__setDocForTest('<p data-rwa-id="cccc3333">x</p>\n<p data-rwa-id="dddd4444">y</p>');
  const el = $id('cccc3333');
  dbl(el);
  el.innerHTML = 'a<div>b</div>c';   // simulate browser-left soup
  await window.commitInlineEdit();
  await settle();
  const doc = await window.getDoc();
  // WHY: a stored <div> inside a <p> hoists out on re-render, orphaning text and
  // desyncing buildSourcePositionMap (regex counts </p>) from the live DOM, so
  // every later click anchors the WRONG block.
  check('no <div> stored', !/<div>/.test(doc));
  check('first block content flattened to "abc"', doc.includes('<p data-rwa-id="cccc3333">abc</p>'));
  const map = window.buildSourcePositionMap(doc);
  check('sourceMap still has exactly 2 entries (no desync)', map.length === 2);
  check('second block untouched', doc.includes('<p data-rwa-id="dddd4444">y</p>'));
}

console.log('\n== E4: <br> soft break survives a commit ==');
{
  await window.__setDocForTest('<p data-rwa-id="eeee5555">x</p>');
  const el = $id('eeee5555');
  dbl(el);
  el.innerHTML = 'line one<br>line two';
  await window.commitInlineEdit();
  await settle();
  const doc = await window.getDoc();
  check('<br> present in committed block', /<p data-rwa-id="eeee5555">line one<br>line two<\/p>/.test(doc));
}

console.log('\n== E5: empty edit deletes the block ==');
{
  await window.__setDocForTest('<p data-rwa-id="f1aaaaaa">Alpha</p>\n<p data-rwa-id="f2bbbbbb">Beta</p>');
  const el = $id('f1aaaaaa');
  dbl(el);
  el.textContent = '';
  await window.commitInlineEdit();
  await settle();
  const doc = await window.getDoc();
  check('emptied block removed', !doc.includes('f1aaaaaa') && !doc.includes('Alpha'));
  check('sibling block intact', doc.includes('f2bbbbbb') && doc.includes('Beta'));
}

console.log('\n== E6: delete that would change structural shape is rejected (fail loud) ==');
{
  await window.__setDocForTest('<p data-rwa-id="g1aaaaaa">Keep</p>\n<blockquote data-rwa-id="g2bbbbbb">Quote</blockquote>');
  const el = $id('g2bbbbbb');
  dbl(el);
  el.textContent = '';
  let rejected = false;
  try { await window.commitInlineEdit(); } catch (e) { rejected = true; check('rejects with structural_shape_changed', e && e.code === 'structural_shape_changed'); }
  await settle();
  const doc = await window.getDoc();
  // WHY: removing the only <blockquote> at top level shrinks the type set; silently
  // deleting would corrupt; we must surface, not swallow (Rule 12).
  check('commit was rejected, not silent', rejected);
  check('blockquote NOT deleted', doc.includes('g2bbbbbb') && doc.includes('Quote'));
}

console.log('\n== E7: frozen block is not editable ==');
{
  await window.__setDocForTest('<p data-rwa-frozen data-rwa-id="h1aaaaaa">Locked</p>\n<p data-rwa-id="h2bbbbbb">Free</p>');
  const frozen = $id('h1aaaaaa');
  dbl(frozen);
  check('frozen (data-rwa-frozen) block did NOT become editable', frozen.getAttribute('contenteditable') !== 'true');
  const free = $id('h2bbbbbb');
  dbl(free);
  check('non-frozen sibling DID become editable', free.getAttribute('contenteditable') === 'true');
}

console.log('\n== E8: container (non-leaf) block is not editable ==');
{
  await window.__setDocForTest('<ul data-rwa-id="j1aaaaaa">\n  <li data-rwa-id="j2bbbbbb">Item</li>\n</ul>');
  const ul = $id('j1aaaaaa');
  dbl(ul);  // dblclick on the <ul> container itself
  check('container <ul> not editable', ul.getAttribute('contenteditable') !== 'true');
  const li = $id('j2bbbbbb');
  dbl(li);
  check('leaf <li> is editable', li.getAttribute('contenteditable') === 'true');
}

console.log('\n== E9: edit attributed to user:edit-surface in history ==');
{
  await window.__setDocForTest('<p data-rwa-id="k1aaaaaa">One</p>');
  const el = $id('k1aaaaaa');
  dbl(el);
  el.textContent = 'One edited';
  await window.commitInlineEdit();
  await settle();
  const top = await readHistTop();
  // WHY: non-agent edits must self-attribute so history distinguishes a human
  // hand-edit from a model edit.
  check('history actor is user:edit-surface', top && top.actor === 'user:edit-surface');
}

console.log('\n== E10: Enter commits, Esc reverts ==');
{
  await window.__setDocForTest('<p data-rwa-id="m1aaaaaa">Orig</p>');
  let el = $id('m1aaaaaa');
  dbl(el);
  el.textContent = 'Edited';
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  let doc = await window.getDoc();
  check('Enter committed the edit', doc.includes('Edited') && !doc.includes('Orig'));

  el = $id('m1aaaaaa');
  dbl(el);
  el.textContent = 'Should not stick';
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  doc = await window.getDoc();
  check('Esc reverted (no commit)', doc.includes('Edited') && !doc.includes('Should not stick'));
  check('Esc exited edit mode', $id('m1aaaaaa').getAttribute('contenteditable') !== 'true');
}

console.log('\n== E11: blur commits ==');
{
  await window.__setDocForTest('<p data-rwa-id="n1aaaaaa">Before</p>');
  const el = $id('n1aaaaaa');
  dbl(el);
  el.textContent = 'After blur';
  el.dispatchEvent(new window.FocusEvent('blur'));
  await settle();
  const doc = await window.getDoc();
  check('blur committed the edit', doc.includes('After blur') && !doc.includes('Before'));
}

console.log('\n== E12: Shift+Enter does not commit (inserts a break) ==');
{
  await window.__setDocForTest('<p data-rwa-id="o1aaaaaa">Stay</p>');
  const el = $id('o1aaaaaa');
  dbl(el);
  el.textContent = 'Stay';
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  await settle();
  check('still in edit mode after Shift+Enter', el.getAttribute('contenteditable') === 'true');
  const doc = await window.getDoc();
  check('no commit fired (doc unchanged)', doc.includes('Stay'));
}

console.log('\n== E13: a block emptied to a lone <br> is deleted (real-browser empty) ==');
{
  // Real browsers leave a bogus <br> when a contenteditable block is emptied
  // (Backspace), so serializeLeafSafe yields '<br>' — which is NOT ''.trim().
  // The empty check must treat <br>/whitespace-only as empty, else "empty
  // deletes" silently commits <p><br></p> instead of removing the block.
  await window.__setDocForTest('<p data-rwa-id="b1empty">Gone</p>\n<p data-rwa-id="b2keep">Stay</p>');
  const el = $id('b1empty');
  dbl(el);
  el.innerHTML = '<br>';
  await window.commitInlineEdit();
  await settle();
  const doc = await window.getDoc();
  check('emptied-to-<br> block is deleted', !doc.includes('b1empty') && !doc.includes('Gone'));
  check('no <p><br></p> committed', !/<p[^>]*><br><\/p>/.test(doc));
  check('sibling intact', doc.includes('b2keep'));
}

console.log('\n== E14: a no-change edit commits nothing (no undo frame burned) ==');
{
  // The lens-spec note promises "an edit that blurs with no change commits
  // nothing." commitDoc has no no-op guard, so without one an accidental
  // double-click + click-away burns a ⌘Z frame + a history record + dirty flag.
  await window.__setDocForTest('<p data-rwa-id="p1nochg">Unchanged</p>');
  const undoBefore = await readUndoLen();
  const el = $id('p1nochg');
  dbl(el); // enter edit, change nothing
  await window.commitInlineEdit();
  await settle();
  const undoAfter = await readUndoLen();
  check('no-op edit added no undo frame', undoAfter === undoBefore);
  check('block intact after no-op', (await window.getDoc()).includes('Unchanged'));
}

console.log('\n== E15: <td> cell is editable end-to-end (coverage) ==');
{
  await window.__setDocForTest('<table data-rwa-id="tbl1aaa"><tr><td data-rwa-id="td1aaaaa">Cell</td></tr></table>');
  const el = $id('td1aaaaa');
  dbl(el);
  check('td became editable', el.getAttribute('contenteditable') === 'true');
  el.textContent = 'Edited cell';
  await window.commitInlineEdit();
  await settle();
  const doc = await window.getDoc();
  check('td text edited', doc.includes('Edited cell'));
  check('td id preserved', doc.includes('data-rwa-id="td1aaaaa"'));
}

// NOTE: inert-under-active-view is tested in tests/view.mjs (which builds a real
// presentation-kind container with a registered view — this document-kind
// harness has none). Concurrency (serialize vs non-agent, reject vs agent loop)
// is inherited from runtimeApplyEnvelope/commitCore and covered by
// tests/r5-concurrent-commit.mjs + tests/write-path.mjs; not re-tested here.

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
