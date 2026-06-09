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

// ─────────────────────────────────────────────────────────────────────
// Group C — prompt mode: a leading "/" in the editable block means the user
// is addressing the model, not writing content. The data-rwa-cmd attribute is
// the visual hook (chrome in a later task); without live detection the user
// has no signal that the block has flipped from text to command.

console.log('\n== C1: prompt mode toggles on leading slash ==');
{
  await window.__setDocForTest('<p data-rwa-id="c1aaaaaa">Original text</p>');
  const el = $id('c1aaaaaa');
  dbl(el);
  check('entered inline edit', el.getAttribute('contenteditable') === 'true');
  // not a command yet
  check('plain text → not command mode', el.dataset.rwaCmd !== 'on');
  // simulate clearing + typing a slash command
  el.textContent = '/make it bolder';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('leading slash → prompt mode on', el.dataset.rwaCmd === 'on');
  // remove the slash → back to text
  el.textContent = 'make it bolder';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('no leading slash → prompt mode off', el.dataset.rwaCmd !== 'on');
  // leading whitespace ignored — contenteditable serialization can lead with
  // whitespace, so the discriminator must look past it or commands go undetected
  el.textContent = '  /center this';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('whitespace then slash → prompt mode on', el.dataset.rwaCmd === 'on');
  // \/ escape — the user wants literal-slash content, not a command
  el.textContent = '\\/etc/hosts';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('backslash-escaped slash → prompt mode off', el.dataset.rwaCmd !== 'on');
  // lone "/" already signals addressing the model
  el.textContent = '/';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('lone slash → prompt mode on', el.dataset.rwaCmd === 'on');
  window.revertInlineEdit();
}

// C2 — Esc demotion: a block legitimately starting with "/" (paths, dates)
// must be typeable — Esc is the escape-hatch that demotes command mode to
// literal text. Demotion is session-sticky: re-triggering command mode on
// every subsequent keystroke would fight the user. A second Esc reverts the
// edit entirely, as Esc always has.

console.log('\n== C2: Esc demotes command mode, second Esc reverts ==');
{
  await window.__setDocForTest('<p data-rwa-id="c2aaaaaa">Keep me</p>');
  const el = $id('c2aaaaaa');
  dbl(el);
  el.textContent = '/usr/local';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('prompt mode on before Esc', el.dataset.rwaCmd === 'on');
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('first Esc demotes (still editing)', el.getAttribute('contenteditable') === 'true');
  check('first Esc clears prompt mode', el.dataset.rwaCmd !== 'on');
  // typing more slashes must NOT re-enter command mode this session
  el.textContent = '/usr/local/bin';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('demoted: leading slash stays literal text', el.dataset.rwaCmd !== 'on');
  // second Esc reverts the edit entirely (existing behavior)
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  check('second Esc reverted edit (not editable)', el.getAttribute('contenteditable') !== 'true');
  const doc = await window.getDoc();
  check('revert kept original content', doc.includes('Keep me'));
}

// C2b — demotion must not leak across edit sessions: a module-scoped `demoted`
// flag would pass every other check while killing slash commands for the rest
// of the page lifetime. A fresh session on the same block must detect "/" again.
console.log('\n== C2b: demotion does not leak into a new edit session ==');
{
  const el = $id('c2aaaaaa'); // re-query: C2's revert renderDoc replaced the node
  dbl(el);
  el.textContent = '/x';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('new session: prompt mode works again', el.dataset.rwaCmd === 'on');
  window.revertInlineEdit();
}

// C3 — the whole point of the feature: Enter on a "/instruction" runs the
// agent ON THE BLOCK the user is standing in — no trip to the floating lens,
// no copy-paste of context. The typed "/…" text is an instruction to the
// model, NEVER content: it must not appear in the committed document.
console.log('\n== C3: Enter in prompt mode runs the agent on the block ==');
{
  await window.__setDocForTest('<p data-rwa-id="c3aaaaaa">plain sentence</p>');
  const el = $id('c3aaaaaa');
  dbl(el);
  el.textContent = '/make it bold';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  const realFetch = window.fetch;
  // canned agent reply: the response replaces the WHOLE block (open tag included),
  // so it must carry the data-rwa-id for the preservation assertion to be meaningful
  window.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '<p data-rwa-id="c3aaaaaa">plain <strong>sentence</strong></p>' } }] }),
  });
  try {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    let doc = '';
    for (let i = 0; i < 80; i++) { await settle(); doc = await window.getDoc(); if (doc.includes('<strong>')) break; }
    check('block edited by the agent', doc.includes('plain <strong>sentence</strong>'));
    check('the "/command" text was NOT committed as content', !doc.includes('/make it bold'));
    check('data-rwa-id preserved', doc.includes('data-rwa-id="c3aaaaaa"'));
    const top = await readHistTop();
    check('hist surface is anchored-command', top && top.surface === 'anchored-command');
  } finally {
    window.fetch = realFetch;
  }
}

// C3b — blur = click-away, not consent. A prompt half-typed when focus leaves
// must neither run a surprise model call nor be committed as prose ("the /…
// text is never committed as content" — design doc). Discard, restore, done.
console.log('\n== C3b: blur in prompt mode discards the prompt, commits nothing ==');
{
  await window.__setDocForTest('<p data-rwa-id="c3bbbbbb">stay put</p>');
  const el = $id('c3bbbbbb');
  dbl(el);
  const undoBefore = await readUndoLen();
  // undo is capped (UNDO_CAP=10) and this suite has long since filled it, so the
  // length check alone is vacuous here — the hist-top check below is the one
  // that can actually fail if blur-in-prompt-mode ever commits.
  const histBefore = JSON.stringify((await readHistTop()) || null);
  el.textContent = '/something';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  el.dispatchEvent(new window.FocusEvent('blur'));
  await settle();
  const doc = await window.getDoc();
  check('prompt text not committed on blur', !doc.includes('/something'));
  check('block restored to committed content', $id('c3bbbbbb') && $id('c3bbbbbb').textContent === 'stay put');
  check('no undo frame burned on blur-discard', (await readUndoLen()) === undoBefore);
  check('no history record written on blur-discard', JSON.stringify((await readHistTop()) || null) === histBefore);
}

// C3c — instruction fidelity: the prompt is captured via serializeLeafSafe,
// whose output is HTML-escaped with <br> soft-break tokens. Markup-referencing
// prompts ("/turn this into <h2>") are a primary use case — the model must see
// what the user TYPED (real '<', real newlines), not entity soup.
//
// The unescape ORDERING in runInlineCommand is load-bearing and pinned here:
// <br> → \n must run FIRST (so only real soft breaks become newlines), and
// &amp; → & must run LAST. If someone reorders &amp; first, a typed literal
// "&lt;" (serialized as "&amp;lt;") double-unescapes — &amp;lt; → &lt; → the
// &lt; pass turns it into "<" — silently corrupting the instruction.
console.log('\n== C3c: instruction reaches the agent unescaped ==');
{
  await window.__setDocForTest('<p data-rwa-id="c3cccccc">target</p>');
  const el = $id('c3cccccc');
  dbl(el);
  // innerHTML parses entities ONCE, so this leaves exactly what a user typing
  // the prompt with a Shift+Enter soft break leaves behind: text node
  // "/turn this into <h2>" + a real <br> + text node
  // "keep a & b and literal &lt; intact" (a typed '&' and the 5-char literal
  // "&lt;" — fixture '&amp;' → text '&', fixture '&amp;lt;' → text '&lt;').
  el.innerHTML = '/turn this into &lt;h2&gt;<br>keep a &amp; b and literal &amp;lt; intact';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  let askedPrompt = null;
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    askedPrompt = JSON.parse(opts.body).messages.map(m => m.content).join('\n');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '<p data-rwa-id="c3cccccc">target</p>' } }] }) };
  };
  try {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 80; i++) { await settle(); if (askedPrompt) break; }
    check('typed <h2> reaches the model unescaped', askedPrompt && askedPrompt.includes('turn this into <h2>'));
    check('soft break becomes a newline, not a <br> token', askedPrompt && askedPrompt.includes('<h2>\nkeep a'));
    // Regression: a stray extra unescape pass (or any entity mishandling) would
    // leave "a &amp; b" instead of the typed "a & b".
    check('typed & arrives verbatim (a & b)', askedPrompt && askedPrompt.includes('keep a & b'));
    // Regression: entity-reorder (&amp; unescaped before &lt;) double-unescapes
    // the typed 5-char literal "&lt;" into "<" — this substring proves it survived.
    check('typed literal &lt; survives (no double-unescape)', askedPrompt && askedPrompt.includes('literal &lt; intact'));
  } finally {
    window.fetch = realFetch;
  }
}

// C4 — failure path: the typed "/…" prompt is never content, so when the agent
// call fails the document must be exactly what it was — original bytes, no
// history record, live DOM restored. runInlineCommand restores FIRST (before
// the agent runs), so a failure has nothing to clean up.
console.log('\n== C4: agent failure restores the block, commits nothing ==');
{
  await window.__setDocForTest('<p data-rwa-id="c4aaaaaa">untouched</p>');
  const el = $id('c4aaaaaa');
  dbl(el);
  el.textContent = '/do something';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  const histBefore = JSON.stringify(await readHistTop());
  const realFetch = window.fetch;
  window.fetch = async () => { throw new Error('network down'); };
  try {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // Drain: a callAgentSingleShot throw is awaited OUTSIDE runAnchoredCommand's
    // inner try, so it escapes the 3-attempt retry loop to the outer catch after
    // ONE fetch call — no multi-attempt drain needed; a short settle loop suffices.
    for (let i = 0; i < 10; i++) { await settle(); }
    const doc = await window.getDoc();
    check('original content intact', doc.includes('untouched'));
    check('no "/command" leaked into the doc', !doc.includes('/do something'));
    check('hist unchanged on failure', JSON.stringify(await readHistTop()) === histBefore);
    const live = $id('c4aaaaaa');
    check('live DOM shows original, not the /command', live && live.textContent === 'untouched');
  } finally {
    window.fetch = realFetch;
  }
}

// C4b — concurrency: an in-flight modify re-renders on commit, which would wipe
// any edit session opened meanwhile — and worse, a session-triggered render
// would rebuild the sourceMap under the in-flight anchor. Double-click must be
// gated on modifyMutex: no new session while a modify runs, normal service after.
console.log('\n== C4b: no new edit session while a modify is in flight ==');
{
  await window.__setDocForTest('<p data-rwa-id="c4bbbbbb">first</p>\n<p data-rwa-id="c4cccccc">second</p>');
  const el = $id('c4bbbbbb');
  dbl(el);
  el.textContent = '/embolden';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  let releaseAgent;
  const gate = new Promise(r => { releaseAgent = r; });
  const realFetch = window.fetch;
  window.fetch = async () => { await gate; return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '<p data-rwa-id="c4bbbbbb"><strong>first</strong></p>' } }] }),
  }; };
  try {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(); // restore-render done, agent now parked on the gate
    const other = $id('c4cccccc');
    dbl(other);
    check('double-click during in-flight modify does not open an edit', other.getAttribute('contenteditable') !== 'true');
    releaseAgent();
    let doc = '';
    for (let i = 0; i < 80; i++) { await settle(); doc = await window.getDoc(); if (doc.includes('<strong>')) break; }
    check('in-flight command still landed after the gate released', doc.includes('<strong>first</strong>'));
    const after = $id('c4cccccc');
    dbl(after);
    check('double-click works again after the modify completes', after.getAttribute('contenteditable') === 'true');
    window.revertInlineEdit();
  } finally {
    window.fetch = realFetch;
  }
}

// C5 — frozen zones are author-declared invariants. If a frozen block could
// enter inline edit, the /-command layer would hand the agent an instruction
// scoped to a block it must never rewrite; pinning at the entry gate
// (handleMountDblClick's data-rwa-frozen/.rwa-locked closest checks + the
// marker-form isWithinLockedRange backstop) keeps the WHOLE layer — manual
// edit AND prompt mode — out of frozen territory.
console.log('\n== C5: frozen block cannot enter inline edit (so no /command) ==');
{
  await window.__setDocForTest('<p data-rwa-frozen data-rwa-id="c5aaaaaa">locked</p>');
  const el = $id('c5aaaaaa');
  dbl(el);
  check('frozen block did not become editable', el.getAttribute('contenteditable') !== 'true');
  check('no prompt mode on a frozen block', el.dataset.rwaCmd !== 'on');
}

// NOTE: inert-under-active-view is tested in tests/view.mjs (which builds a real
// presentation-kind container with a registered view — this document-kind
// harness has none). Concurrency (serialize vs non-agent, reject vs agent loop)
// is inherited from runtimeApplyEnvelope/commitCore and covered by
// tests/r5-concurrent-commit.mjs + tests/write-path.mjs; not re-tested here.

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
