// End-to-end smoke test for rwa-edit/1 in seeds/rewritable.html.
//
// Loads the seed in jsdom, stubs window.fetch to simulate OpenRouter tool-call
// responses, drives modify() through each scenario in the spec, and asserts on
// IDB state and DOM after each.
//
// Run from this directory:
//   npm install
//   npm test
//
// Or from the repo root:
//   (cd tests && npm install && npm test)
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
  if (cond) { pass++; console.log('  OK ', label); }
  else      { fail++; console.log('  FAIL', label); }
}

// Stubbable fetch — set this before each scenario.
let fetchHandler = async () => { throw new Error('no fetchHandler set'); };

const virtualConsole = new VirtualConsole();
// Forward jsdomError; suppress runtime console.error noise (rwa-edit retry exhaustion logs).
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
    window.fetch = (...args) => fetchHandler(...args);
    // jsdom 25 doesn't expose BroadcastChannel on its window, but Node has it
    // globally. The seed's runtime.db.subscribe relies on it (spec §7), so
    // borrow Node's implementation. Same-name channels in the same agent
    // cluster see each other's messages here, matching real-browser semantics.
    window.BroadcastChannel = globalThis.BroadcastChannel;
    Object.defineProperty(window.navigator, 'storage', {
      value: { persist: () => Promise.resolve(false) }, configurable: true,
    });
    Object.defineProperty(window.navigator, 'platform', {
      value: 'MacIntel', configurable: true,
    });
  },
});

const window = dom.window;

// Wait for the bootstrap IIFE to settle.
await new Promise(r => setTimeout(r, 200));

console.log('== Lens harness loaded ==');
// Tests appended below per phase.

// === Phase 1: source-position map ===
console.log('\n== Test L1.1: anchorable-set membership ==');
check('ANCHORABLE_TAGS includes p, h1-h6, blockquote, li, figure, pre, aside',
  ['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','LI','FIGURE','PRE','ASIDE']
    .every(t => window.ANCHORABLE_TAGS.has(t)));
check('ANCHORABLE_TAGS excludes hr, ul, ol, dl, dt, dd',
  ['HR','UL','OL','DL','DT','DD'].every(t => !window.ANCHORABLE_TAGS.has(t)));

console.log('\n== Test L1.2: source-position map basic ==');
{
  const doc = '<p>Alpha</p>\n<p>Beta</p>\n<h2>Gamma</h2>';
  const map = window.buildSourcePositionMap(doc);
  check('map is an array of 3 entries', Array.isArray(map) && map.length === 3);
  check('first entry covers <p>Alpha</p>',
    doc.slice(map[0].start, map[0].end) === '<p>Alpha</p>');
  check('second entry covers <p>Beta</p>',
    doc.slice(map[1].start, map[1].end) === '<p>Beta</p>');
  check('third entry covers <h2>Gamma</h2>',
    doc.slice(map[2].start, map[2].end) === '<h2>Gamma</h2>');
  check('each entry has tag', map.every(e => typeof e.tag === 'string'));
  check('each entry has node reference', map.every(e => e.node && e.node.tagName));
}

console.log('\n== Test L1.2b: source-position map with nested li ==');
{
  const doc = '<p>Intro</p>\n<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>\n<p>Outro</p>';
  const map = window.buildSourcePositionMap(doc);
  const tags = map.map(e => e.tag);
  check('map contains P, LI, LI, P (in order, no UL)',
    JSON.stringify(tags) === JSON.stringify(['P','LI','LI','P']));
  check('first LI has correct source slice',
    doc.slice(map[1].start, map[1].end) === '<li>One</li>');
}

console.log('\n== Test L1.2c: script-internal markup is not anchored ==');
{
  const doc = '<p>Above</p>\n<script>const x = "<p>FAKE</p>";</script>\n<p>Below</p>';
  const map = window.buildSourcePositionMap(doc);
  check('map has exactly 2 entries (script body skipped)',
    map.length === 2);
  check('first entry is real Above', doc.slice(map[0].start, map[0].end) === '<p>Above</p>');
  check('second entry is real Below', doc.slice(map[1].start, map[1].end) === '<p>Below</p>');
  check('both entries have real DOM nodes (no desync)',
    map.every(e => e.node && e.node.tagName === 'P'));
}

console.log('\n== Test L1.2d: style-internal markup is not anchored ==');
{
  const doc = '<p>Above</p>\n<style>p::before { content: "<h2>X</h2>"; }</style>\n<p>Below</p>';
  const map = window.buildSourcePositionMap(doc);
  check('style body skipped — exactly 2 entries', map.length === 2);
}

console.log('\n== Test L1.2e: HTML comments do not span blocks ==');
{
  const doc = '<p>One <!-- </p> --> still in p</p>\n<p>Two</p>';
  const map = window.buildSourcePositionMap(doc);
  check('first p span is correct (comment </p> ignored)',
    doc.slice(map[0].start, map[0].end) === '<p>One <!-- </p> --> still in p</p>');
  check('two entries total', map.length === 2);
}

console.log('\n== Test L1.2f: auto-closed <p> desync clears all node refs ==');
{
  // <p>One<p>Two</p> — HTML parser auto-closes the first <p>, producing 2 DOM nodes.
  // Source scanner only finds 1 valid pair (<p>Two</p>) because findCloseTagEnd
  // gets confused by depth counting on the unclosed first <p>. This is a desync.
  const doc = '<p>One<p>Two</p>';
  // Capture the warning so the test doesn't pollute test output.
  // The bootstrap calls console.warn from within the jsdom window, so patch
  // window.console.warn (jsdom's console is a distinct object from Node's).
  const origWarn = window.console.warn;
  let warned = '';
  window.console.warn = (msg) => { warned = String(msg); };
  const map = window.buildSourcePositionMap(doc);
  window.console.warn = origWarn;
  check('desync detected and warned',
    /desync/i.test(warned));
  check('all entries have node=null on desync',
    map.every(e => e.node === null));
  check('slices remain valid against original doc',
    map.every(e => doc.slice(e.start, e.end).startsWith('<p>')));
}

console.log('\n== Test L1.3: source-position map invariant 11 ==');
{
  const doc = '<h1>Title</h1>\n<p>One.</p>\n<blockquote><p>Quoted.</p></blockquote>\n<aside>Side.</aside>';
  const map = window.buildSourcePositionMap(doc);
  for (const e of map) {
    const slice = doc.slice(e.start, e.end);
    check(`invariant 11 holds for ${e.tag}: slice equals expected source form`,
      slice.startsWith(`<${e.tag.toLowerCase()}`) && slice.endsWith(`</${e.tag.toLowerCase()}>`));
  }
}

console.log('\n== Test L1.4: source-position map lifetime ==');
{
  // Initial map (from current rwa_doc, which is the seed's hello.html-like default)
  const doc1 = await window.getDoc();
  const map1 = window.getSourceMap();
  check('map exists after bootstrap', Array.isArray(map1) && map1.length > 0);

  // Stub the agent to insert a new <p> at end via apply_edits.
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 'm1', type: 'function',
        function: { name: 'apply_edits', arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: 'Hello, world.', replace: 'Hello, world.</p>\n<p>Added.' }]
        })}
      }]}}]
    })
  });
  await window.modify('add a paragraph');
  await new Promise(r => setTimeout(r, 100));

  const map2 = window.getSourceMap();
  const doc2 = await window.getDoc();
  check('map rebuilt after commit', map2 !== map1);
  check('map reflects new content', map2.some(e => doc2.slice(e.start, e.end).includes('Added.')));
}

console.log('\n== Test L1.5a: anchor find — unique case ==');
{
  const doc = '<p>Unique paragraph.</p>\n<p>Another.</p>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  const find = window.resolveAnchorFind(map[0]);
  check('find equals entry source for unique case',
    find.find === '<p>Unique paragraph.</p>');
  check('replacePrefix is empty for unique case',
    find.replacePrefix === '');
  check('replaceSuffix is empty for unique case',
    find.replaceSuffix === '');
}

console.log('\n== Test L1.5b: anchor find — duplicate paragraph ==');
{
  const doc = '<p>Same.</p>\n<p>Other.</p>\n<p>Same.</p>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  // Anchor on the first <p>Same.</p>. Its outerHTML duplicates the third's.
  const find = window.resolveAnchorFind(map[0]);
  check('find for first duplicate is unique within doc',
    doc.indexOf(find.find) === doc.lastIndexOf(find.find));
  check('find still anchors at original position',
    doc.indexOf(find.find) <= map[0].start);
  check('reconstructed source matches: prefix + entry + suffix === find',
    find.replacePrefix + doc.slice(map[0].start, map[0].end) + find.replaceSuffix === find.find);
}

console.log('\n== Test L1.5c: anchor find — left-only expansion (anchor at last entry) ==');
{
  const doc = '<p>Same.</p>\n<p>Other.</p>\n<p>Same.</p>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  // Anchor on the LAST <p>Same.</p>. canGrowHi is false; only lo can grow.
  const last = map[map.length - 1];
  const find = window.resolveAnchorFind(last);
  check('left-expansion result is unique',
    doc.indexOf(find.find) === doc.lastIndexOf(find.find));
  check('left-expansion result anchors at the LAST occurrence',
    doc.indexOf(find.find) + find.find.length === last.end);
  check('left-expansion reconstruction holds',
    find.replacePrefix + doc.slice(last.start, last.end) + find.replaceSuffix === find.find);
}

console.log('\n== Test L1.5d: anchor find — alternating expansion ==');
{
  // Construct a doc where the immediate entry is duplicate AND expanding by
  // one sibling on EITHER side is still ambiguous, so the runtime must
  // alternate (lo--, hi++, hi++…) before finding a unique window.
  // Layout: A Mid B C A Mid B — both Mid blocks share the same one-sibling
  // context "A.\nMid.\nB." but the full left-and-right context only appears
  // once around the first Mid. Avoids the trailing-X overlap trap so that
  // countOccurrences (non-overlapping) and indexOf/lastIndexOf agree.
  const doc = '<p>A.</p>\n<p>Mid.</p>\n<p>B.</p>\n<p>C.</p>\n<p>A.</p>\n<p>Mid.</p>\n<p>B.</p>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  // Indices 0..6 = A, Mid, B, C, A, Mid, B. Anchor on map[1] (first Mid).
  // map[1] duplicates map[5]. Stepwise: <p>Mid.</p> alone → 2 occ.
  // lo--/hi++ alternation grows the window through neighbors until the
  // surrounding A/B/C pattern only matches once.
  const find = window.resolveAnchorFind(map[1]);
  check('alternating-expansion produced a non-null find', find !== null);
  check('alternating-expansion result is unique within doc',
    doc.indexOf(find.find) === doc.lastIndexOf(find.find));
  check('alternating-expansion reconstruction holds',
    find.replacePrefix + doc.slice(map[1].start, map[1].end) + find.replaceSuffix === find.find);
}

console.log('\n== Test L1.5e: anchor find — pathological null ==');
{
  // Same source bytes appear inside an HTML comment AND as a real anchorable.
  // The map only contains the real <p>X.</p> (one entry; comment-internal is masked
  // from the scanner per Task 1.2's mask). But countOccurrences operates on the
  // unmasked doc, so it sees TWO matches, and there's no surrounding context to
  // expand into — only one map entry exists. Must return null.
  const doc = '<!-- <p>X.</p> --><p>X.</p>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  check('only one anchorable entry', map.length === 1);
  const find = window.resolveAnchorFind(map[0]);
  check('pathological case returns null',
    find === null);
}

console.log('\n== Test L2.1: lens DOM is mounted ==');
check('lens input exists', !!window.document.getElementById('rwa-lens-input'));
check('lens is initially in default state',
  window.document.getElementById('rwa-lens')?.dataset.state === 'default');
check('lens placeholder mentions writing or describing',
  /write|describe/i.test(window.document.getElementById('rwa-lens-input')?.placeholder || ''));

console.log('\n== Test L2.2: ⌘Enter submits, Enter does not ==');
{
  let submittedWith = null;
  window.__lensSubmitHandler = (text) => { submittedWith = text; };
  const input = window.document.getElementById('rwa-lens-input');
  input.value = 'hello';
  // Plain Enter: should NOT submit.
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('plain Enter did not trigger submit', submittedWith === null);
  // ⌘Enter: should submit.
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  check('⌘Enter triggered submit with text', submittedWith === 'hello');
  // Cleanup
  delete window.__lensSubmitHandler;
}

console.log('\n== Test L2.3: live mode indication ==');
{
  const input = window.document.getElementById('rwa-lens-input');
  const lens = window.document.getElementById('rwa-lens');
  // Type a leading slash.
  input.value = '/dark mode';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('lens dataset.mode shifts to "command"', lens.dataset.mode === 'command');
  // Backspace away the slash.
  input.value = 'dark mode';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('lens dataset.mode reverts to "text"', lens.dataset.mode === 'text');
  // Escaped slash should NOT trigger command mode.
  input.value = '\\/dark mode';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('escaped \\\\/ keeps text mode', lens.dataset.mode === 'text');
}

console.log('\n== Test L2.4: submitLens routes by state and mode ==');
{
  const calls = [];
  window.__synthesizeAndCommit = (envelope, surface, instr) => calls.push({ envelope, surface, instr });
  // Reset state
  if (window.__lensState) window.__lensState.anchor = null;
  // Default + text: routes to direct-text envelope synthesis.
  await window.submitLens('hello world');
  check('default + text invokes synth with surface=default-text',
    calls.length === 1 && calls[0].surface === 'default-text');
  check('default + text passes raw text as instruction',
    calls[0].instr === 'hello world');
  // Default + command: routes through modify (we just check it does NOT call synth).
  calls.length = 0;
  let modifyCalled = false;
  let modifyArg = null;
  const realModify = window.modify;
  window.modify = async (instr) => { modifyCalled = true; modifyArg = instr; };
  await window.submitLens('/whatever');
  check('default + command routes to modify, not direct-text synth',
    modifyCalled === true && calls.length === 0);
  check('default + command strips leading slash before passing to modify',
    modifyArg === 'whatever');
  window.modify = realModify;
  // Escape: \/ should be treated as text, not command.
  calls.length = 0;
  await window.submitLens('\\/api/v1/users');
  check('\\\\/ escape treated as text (synth surface)',
    calls.length === 1 && calls[0].surface === 'default-text');
  check('\\\\/ escape strips leading backslash before passing as text',
    calls[0].instr === '/api/v1/users');
  // Cleanup
  delete window.__synthesizeAndCommit;
}

console.log('\n== Test L3.1: wrapDirectText ==');
check('single paragraph wraps in <p>',
  window.wrapDirectText('Hello world.', null) === '<p>Hello world.</p>');
check('multi-paragraph splits on blank lines',
  window.wrapDirectText('First.\n\nSecond.', null) === '<p>First.</p>\n<p>Second.</p>');
check('anchor on LI wraps in <li>',
  window.wrapDirectText('New item.', 'LI') === '<li>New item.</li>');
check('multi-paragraph in LI context produces multiple <li>',
  window.wrapDirectText('A.\n\nB.', 'LI') === '<li>A.</li>\n<li>B.</li>');
check('anchor on BLOCKQUOTE still wraps in <p>',
  window.wrapDirectText('After quote.', 'BLOCKQUOTE') === '<p>After quote.</p>');
check('HTML special chars are escaped',
  window.wrapDirectText('a < b & c > d', null) === '<p>a &lt; b &amp; c &gt; d</p>');

console.log('\n== Test L3.2: resolveEofAnchor ==');
{
  await window.__setDocForTest('<p>First.</p>\n<p>Last.</p>');
  const eof = window.resolveEofAnchor();
  check('EOF anchor finds last anchorable block',
    eof.find === '<p>Last.</p>');
  check('EOF replacePrefix is empty (unique)', eof.replacePrefix === '');
  check('EOF replaceSuffix is empty (unique)', eof.replaceSuffix === '');
}

console.log('\n== Test L3.3: synthesizeDefaultAppend ==');
{
  await window.__setDocForTest('<p>Existing.</p>');
  const env = window.__synthesizeDefaultAppend('New paragraph.');
  check('envelope is rwa-edit/1', env.version === 'rwa-edit/1');
  check('envelope has 1 edit', env.edits.length === 1);
  check('edit find is last anchorable',
    env.edits[0].find === '<p>Existing.</p>');
  check('edit replace appends new <p>',
    env.edits[0].replace === '<p>Existing.</p>\n<p>New paragraph.</p>');
}

console.log('\n== Test L3.4: e2e default + direct text ==');
{
  await window.__setDocForTest('<p>Existing.</p>');
  delete window.__synthesizeAndCommit; // unstub — use the real one
  await window.submitLens('Direct text appended.');
  await new Promise(r => setTimeout(r, 50));
  const doc = await window.getDoc();
  check('doc contains both old and new',
    doc.includes('<p>Existing.</p>') && doc.includes('Direct text appended.'));
  check('order: existing first, new last',
    doc.indexOf('Existing.') < doc.indexOf('Direct text appended.'));
}

console.log('\n== Test L3.5: first append into empty doc uses replace_document ==');
{
  await window.__setDocForTest(''); // genuinely empty
  delete window.__synthesizeAndCommit;
  await window.submitLens('First content.');
  await new Promise(r => setTimeout(r, 50));
  const doc = await window.getDoc();
  check('doc now contains first content', doc.includes('First content.'));
  // Inspect rwa_hist for kind:'replace_document'.
  const hist = await new Promise(res => {
    window.openDB().then(db => {
      const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
      r.onsuccess = () => res(r.result);
    });
  });
  const top = hist[0];
  check('most recent history record is replace_document', top.kind === 'replace_document');
  check('reason matches "initial content into an empty document"',
    /initial content/.test(top.reason || top.envelope?.reason || ''));
}

console.log('\n== Test L3.5b: skeleton-only doc treated as empty ==');
{
  await window.__setDocForTest('<article></article>');
  await window.submitLens('Content into skeleton.');
  await new Promise(r => setTimeout(r, 50));
  const doc = await window.getDoc();
  check('skeleton replaced with content', doc.includes('Content into skeleton.'));
}

console.log('\n== Test L4.1: default + slash invokes modify ==');
{
  await window.__setDocForTest('<p>Original.</p>');
  delete window.__synthesizeAndCommit;
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 's1', type: 'function',
        function: { name: 'apply_edits', arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: 'Original.', replace: 'Tightened.' }]
        })}
      }]}}]
    })
  });
  await window.submitLens('/tighten throughout');
  await new Promise(r => setTimeout(r, 200));
  const doc = await window.getDoc();
  check('agent edit applied via default-slash path', doc.includes('Tightened.'));
  check('original removed', !doc.includes('Original.'));
}

console.log('\n== Test L5.1: click anchors lens ==');
{
  await window.__setDocForTest('<p id="x">First.</p>\n<p>Second.</p>');
  // Reset anchor first.
  window.__lensState.anchor = null;
  window.document.getElementById('rwa-lens').dataset.state = 'default';
  const target = window.document.querySelector('#x');
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('lens state is anchored', window.__lensState.anchor !== null);
  check('anchor entry matches first <p>',
    window.__lensState.anchor && window.__lensState.anchor.tag === 'P');
  check('lens dataset.state shifted to "anchored"',
    window.document.getElementById('rwa-lens').dataset.state === 'anchored');
}

console.log('\n== Test L5.1b: click on inline traverses to ancestor ==');
{
  await window.__setDocForTest('<p>Containing <strong id="s">strong</strong> here.</p>');
  window.__lensState.anchor = null;
  window.document.getElementById('rwa-lens').dataset.state = 'default';
  const target = window.document.querySelector('#s');
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('inline click anchors the containing P',
    window.__lensState.anchor && window.__lensState.anchor.tag === 'P');
}

console.log('\n== Test L5.1c: click on lens itself is not anchor ==');
{
  await window.__setDocForTest('<p>One.</p>');
  window.__lensState.anchor = null;
  window.document.getElementById('rwa-lens').dataset.state = 'default';
  const lensInput = window.document.getElementById('rwa-lens-input');
  lensInput.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking lens does not anchor', window.__lensState.anchor === null);
}

console.log('\n== Test L5.2: badge shown when anchored, hidden in default ==');
{
  await window.__setDocForTest('<p>One.</p>');
  // Initial state
  window.__lensState.anchor = null;
  window.document.getElementById('rwa-lens').dataset.state = 'default';
  window.document.getElementById('rwa-lens-badge').hidden = true;

  // Click to anchor.
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const badge = window.document.getElementById('rwa-lens-badge');
  check('badge shown when anchored', badge.hidden === false);
  check('badge contains text identifying tag', /p|paragraph/i.test(badge.textContent || ''));

  // Esc releases.
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('badge hidden after release', badge.hidden === true);
  check('lens state default after release',
    window.document.getElementById('rwa-lens').dataset.state === 'default');
  check('anchor cleared', window.__lensState.anchor === null);
}

console.log('\n== Test L6.1: synthesizeAnchoredInsert ==');
{
  await window.__setDocForTest('<p>First.</p>\n<p>Second.</p>');
  const map = window.getSourceMap();
  const env = window.__synthesizeAnchoredInsert(map[0], 'New between.');
  check('envelope is rwa-edit/1', env.version === 'rwa-edit/1');
  check('envelope has 1 edit', env.edits.length === 1);
  check('find equals first paragraph source',
    env.edits[0].find === '<p>First.</p>');
  check('replace inserts after first paragraph',
    env.edits[0].replace === '<p>First.</p>\n<p>New between.</p>');
}

console.log('\n== Test L6.2: e2e anchored direct text ==');
{
  await window.__setDocForTest('<p>First.</p>\n<p>Second.</p>');
  delete window.__synthesizeAndCommit;
  // Click to anchor on first <p>.
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('anchored on first p before submit', window.__lensState.anchor && window.__lensState.anchor.tag === 'P');
  // Submit direct text.
  await window.submitLens('Insert me.');
  await new Promise(r => setTimeout(r, 100));
  const doc = await window.getDoc();
  check('doc has three paragraphs', (doc.match(/<p>/g) || []).length === 3);
  check('inserted between first and second',
    doc.indexOf('Insert me.') > doc.indexOf('First.') &&
    doc.indexOf('Insert me.') < doc.indexOf('Second.'));
  check('lens stays anchored on first paragraph after insert',
    window.__lensState.anchor && window.__lensState.anchor.tag === 'P');
  check('anchor source range covers the original First paragraph',
    window.__lensState.anchor && doc.slice(window.__lensState.anchor.start, window.__lensState.anchor.end) === '<p>First.</p>');
}

console.log('\n== Test L6.3: anchored direct text on <li> wraps as <li> ==');
{
  await window.__setDocForTest('<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>');
  delete window.__synthesizeAndCommit;
  // Click on the first <li>.
  window.document.querySelectorAll('li')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await window.submitLens('Three');
  await new Promise(r => setTimeout(r, 100));
  const doc = await window.getDoc();
  check('new content wrapped as <li>, not <p>',
    doc.includes('<li>Three</li>') && !doc.includes('<p>Three</p>'));
  check('list now has three items',
    (doc.match(/<li>/g) || []).length === 3);
}

console.log('\n== Test L7.1: bounded context window — heading-relative ==');
{
  const doc = '<h1>Title</h1>\n<p>Intro.</p>\n<h2>Section A</h2>\n<p>A1.</p>\n<p>A2.</p>\n<h2>Section B</h2>\n<p>B1.</p>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  // Find the entry containing "A1."
  const a1 = map.find(e => doc.slice(e.start, e.end).includes('A1.'));
  const ctx = window.buildAnchoredContextWindow(a1);
  check('context includes section A blocks (A2)',
    ctx.context.includes('A2.'));
  check('context includes the preceding heading (Section A)',
    ctx.context.includes('Section A'));
  check('context does NOT include section B (B1)',
    !ctx.context.includes('B1.'));
  check('context does NOT include the target itself (A1)',
    !ctx.context.includes('A1.'));
  check('target equals A1 source', ctx.target === '<p>A1.</p>');
}

console.log('\n== Test L7.2: anchored prompt structure ==');
{
  const p = window.buildAnchoredPrompt('<p>Target.</p>', '<h2>Section</h2>', 'tighten this');
  check('prompt names target', p.includes('<TARGET>') && p.includes('<p>Target.</p>'));
  check('prompt names context', p.includes('<CONTEXT>') && p.includes('<h2>Section</h2>'));
  check('prompt includes instruction', p.includes('tighten this'));
  check('prompt forbids markdown fences (naked HTML directive)',
    /naked HTML|no markdown fences|no commentary/i.test(p));

  // LI parent-type constraint
  const pLi = window.buildAnchoredPrompt('<li>Item.</li>', '', 'make formal');
  check('LI prompt mentions LI constraint',
    /\<li\>|list item/.test(pLi));
}

console.log('\n== Test L7.3: response validation against parent context ==');
{
  // <li> target → response must be all <li>.
  await window.__setDocForTest('<ul><li>Item.</li></ul>');
  const liEntry = window.getSourceMap().find(e => e.tag === 'LI');
  // Need the live-DOM parent — use liveNodeForEntry to get the live node.
  const ok = window.validateAnchoredResponse('<li>New item.</li>', liEntry);
  check('all-<li> response accepted', ok.ok === true);
  const bad = window.validateAnchoredResponse('<p>Wrong.</p>', liEntry);
  check('<p> response rejected for <li> parent',
    bad.ok === false && /li|list/i.test(bad.reason));
  const mixed = window.validateAnchoredResponse('<li>Good.</li><p>Bad.</p>', liEntry);
  check('mixed <li> + <p> response rejected (multi-element check)',
    mixed.ok === false);
  const empty = window.validateAnchoredResponse('', liEntry);
  check('empty response accepted (deletion path)', empty.ok === true);

  // <p> target → flow content accepted (no parent constraint).
  await window.__setDocForTest('<p>Para.</p>');
  const pEntry = window.getSourceMap().find(e => e.tag === 'P');
  const okP = window.validateAnchoredResponse('<blockquote>Q</blockquote>', pEntry);
  check('flow content accepted for <p> parent', okP.ok === true);
}

console.log('\n== Test L7.4: e2e anchored slash command ==');
{
  await window.__setDocForTest('<p>Original.</p>');
  delete window.__synthesizeAndCommit;
  // Click to anchor.
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  // Stub fetch to return a single-shot completion (no tool_use — the lens runtime constructs the envelope).
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '<p>Tightened.</p>' }}]
    })
  });
  await window.submitLens('/tighten');
  await new Promise(r => setTimeout(r, 200));
  const doc = await window.getDoc();
  check('anchored block was rewritten', doc.includes('<p>Tightened.</p>'));
  check('original removed', !doc.includes('<p>Original.</p>'));
}

console.log('\n== Test L7.5: post-commit anchor branches ==');

// Branch 1: Single block → re-anchor on the new block.
{
  await window.__setDocForTest('<p>Original.</p>');
  delete window.__synthesizeAndCommit;
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  fetchHandler = async () => ({ ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '<p>Tightened.</p>' }}]
  })});
  await window.submitLens('/tighten');
  await new Promise(r => setTimeout(r, 200));
  check('still anchored after single-block reply',
    window.__lensState.anchor !== null);
  const doc1 = await window.getDoc();
  check('anchor points to new <p> with new content',
    window.__lensState.anchor && doc1.slice(window.__lensState.anchor.start, window.__lensState.anchor.end).includes('Tightened.'));
}

// Branch 2: Multi-block → release.
{
  await window.__setDocForTest('<p>Solo.</p>');
  delete window.__synthesizeAndCommit;
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  fetchHandler = async () => ({ ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '<p>One.</p>\n<p>Two.</p>' }}]
  })});
  await window.submitLens('/expand');
  await new Promise(r => setTimeout(r, 200));
  check('anchor released on multi-block reply',
    window.__lensState.anchor === null);
  check('lens state default after multi-block release',
    window.document.getElementById('rwa-lens').dataset.state === 'default');
}

// Branch 3: Empty response → release without affordance.
{
  await window.__setDocForTest('<p>To delete.</p>\n<p>Keep.</p>');
  delete window.__synthesizeAndCommit;
  window.document.querySelectorAll('p')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  fetchHandler = async () => ({ ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '' }}]
  })});
  await window.submitLens('/delete this');
  await new Promise(r => setTimeout(r, 200));
  check('anchor released on empty reply',
    window.__lensState.anchor === null);
  const doc3 = await window.getDoc();
  check('first paragraph removed', !doc3.includes('To delete.'));
  check('second paragraph preserved', doc3.includes('Keep.'));
}

console.log('\n== Test L8.1: source-position map flags locked entries ==');
{
  const doc = '<p>Free.</p>\n<section class="rwa-locked"><p>Locked.</p></section>';
  await window.__setDocForTest(doc);
  const lockedRanges = window.getLockedRanges();
  check('one locked range identified', lockedRanges.length === 1);
  check('locked range covers the section',
    doc.slice(lockedRanges[0][0], lockedRanges[0][1]).includes('class="rwa-locked"'));
  check('locked range covers the inner p too',
    doc.slice(lockedRanges[0][0], lockedRanges[0][1]).includes('Locked.'));
}

console.log('\n== Test L8.2: clicking a locked block does not anchor ==');
{
  await window.__setDocForTest('<section class="rwa-locked"><p>Legal.</p></section>\n<p>Free.</p>');
  window.__lensState.anchor = null;
  window.document.getElementById('rwa-lens').dataset.state = 'default';
  // Click on locked content.
  window.document.querySelector('section.rwa-locked p').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('click on locked content does not anchor', window.__lensState.anchor === null);
  check('lens stays in default state', window.document.getElementById('rwa-lens').dataset.state === 'default');
  // Click on free block still anchors.
  window.document.querySelectorAll('p')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('click on free block still anchors', window.__lensState.anchor !== null);
}

console.log('\n== Test L8.3: EOF resolution skips locked footer ==');
{
  const doc = '<p>Body.</p>\n<section class="rwa-locked"><p>Footer.</p></section>';
  await window.__setDocForTest(doc);
  const eof = window.resolveEofAnchor();
  check('EOF anchor is the body <p>, not the locked footer',
    eof.find === '<p>Body.</p>');
}

console.log('\n== Test L8.4: apply_edits rejects edits overlapping a .rwa-locked range ==');
{
  await window.__setDocForTest('<section class="rwa-locked"><p>Locked.</p></section>\n<p>Free.</p>');
  const env = {
    version: 'rwa-edit/1',
    edits: [{ find: '<p>Locked.</p>', replace: '<p>Hacked.</p>' }],
    reason: 'attempt to edit locked content',
  };
  let threw = false;
  let code = '';
  try {
    await window.applyEdits(env, await window.getDoc());
  } catch (e) {
    threw = true;
    code = e?.code || '';
  }
  check('apply_edits threw on class-lock overlap', threw === true);
  check('error code mentions lock or frozen',
    /lock|frozen/i.test(code));
}

console.log('\n== Test L8.4b: adjacent insertion (find ends where lock begins) is accepted ==');
{
  await window.__setDocForTest('<p>Before.</p>\n<section class="rwa-locked"><p>Locked.</p></section>');
  const env = {
    version: 'rwa-edit/1',
    edits: [{ find: '<p>Before.</p>', replace: '<p>Before.</p>\n<p>Inserted.</p>' }],
    reason: 'adjacent insertion',
  };
  let threw = false;
  try {
    await window.applyEdits(env, await window.getDoc());
  } catch (e) { threw = true; }
  check('adjacent insertion accepted', threw === false);
}

console.log('\n== Test L8.5a: replace_document rejected on bare class-locked doc ==');
{
  await window.__setDocForTest('<section class="rwa-locked"><p>Legal.</p></section>\n<p>Free.</p>');
  const env = { version: 'rwa-edit/1', doc: '<p>Wholesale rewrite.</p>', reason: 'test' };
  let threw = false;
  let code = '';
  try {
    await window.replaceDocument(env, await window.getDoc());
  } catch (e) { threw = true; code = e?.code || ''; }
  check('replace_document threw for bare class-locked doc', threw === true);
  check('error code mentions class lock or coverage',
    /class.lock|coverage|class_lock|frozen/i.test(code));
}

console.log('\n== Test L8.5b: marker-wrapping coexistence allows replace_document ==');
{
  // .rwa-locked range entirely contained within a marker-form frozen zone.
  const doc = '<!-- rwa:frozen:begin legal -->\n<section class="rwa-locked"><p>Legal.</p></section>\n<!-- rwa:frozen:end legal -->\n<p>Free.</p>';
  await window.__setDocForTest(doc);
  // The new doc must include the locked content byte-identically (rwa-edit/1 §6 rule 3).
  const newDoc = '<!-- rwa:frozen:begin legal -->\n<section class="rwa-locked"><p>Legal.</p></section>\n<!-- rwa:frozen:end legal -->\n<p>Rewritten.</p>';
  const env = { version: 'rwa-edit/1', doc: newDoc, reason: 'test' };
  let threw = false;
  try {
    await window.replaceDocument(env, await window.getDoc());
  } catch (e) { threw = true; }
  check('replace_document accepted with marker coexistence', threw === false);
}

console.log('\n== Test L8.5c: marker nested INSIDE class wrapper does NOT satisfy coverage ==');
{
  const doc = '<section class="rwa-locked"><!-- rwa:frozen:begin inner -->\n<p>Inner.</p>\n<!-- rwa:frozen:end inner --></section>';
  await window.__setDocForTest(doc);
  // Even with a wholesale rewrite that preserves the inner markers byte-identically:
  const newDoc = doc; // identical, but rule should still trigger
  const env = { version: 'rwa-edit/1', doc: newDoc, reason: 'test' };
  let threw = false;
  let code = '';
  try {
    await window.replaceDocument(env, await window.getDoc());
  } catch (e) { threw = true; code = e?.code || ''; }
  check('inverse-nesting pattern still rejects replace_document', threw === true);
  check('error mentions class lock', /class.lock|class_lock/i.test(code));
}

console.log('\n== Test L8.7: prompt names .rwa-locked blocks ==');
{
  const doc = '<!-- rwa:frozen:begin x -->...<!-- rwa:frozen:end x -->\n<section class="rwa-locked"><p>Locked.</p></section>';
  const frozen = window.extractFrozenZones ? window.extractFrozenZones(doc) : [];
  const prompt = window.buildUserPrompt('any', doc, frozen);
  check('prompt mentions .rwa-locked or class-declared in some form',
    /rwa-locked|class.declared|class-declared/i.test(prompt));
  // Stronger check: a dedicated mention must appear OUTSIDE the embedded <DOC>
  // body, otherwise the agent only "sees" the lock as a side-effect of the
  // class attribute being copied into the doc verbatim.
  const docIdx = prompt.indexOf('<DOC>');
  const head = docIdx >= 0 ? prompt.slice(0, docIdx) : prompt;
  check('lock annotation appears in prompt header (before <DOC>)',
    /rwa-locked|class.declared|class-declared/i.test(head));
}

console.log('\n== Test L9.1: rwa_hist records carry surface, instruction, scope ==');
{
  await window.__setDocForTest('<p>X.</p>');
  delete window.__synthesizeAndCommit;
  await window.submitLens('Direct text added.');
  await new Promise(r => setTimeout(r, 100));
  const hist = await new Promise(res => {
    window.openDB().then(db => {
      const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
      r.onsuccess = () => res(r.result);
    });
  });
  const top = hist[0];
  check('record has surface field', top.surface === 'default-text');
  check('record has instruction field', typeof top.instruction === 'string');
  check('record has scope field', top.scope && top.scope.type === 'eof');
}

console.log('\n== Test L9.2: default-state slash command records surface=default-command ==');
{
  // Reviewer's Issue 3: when /slash routes through modify() in the default
  // (unanchored) state, the resulting rwa_hist entry must still name a lens
  // surface — Invariant 6. Stub a tool-call response so modify() commits via
  // applyEdits and the new lensMeta thread reaches the hist record.
  await window.__setDocForTest('<p>Original prose.</p>');
  delete window.__synthesizeAndCommit;
  // Ensure we're in default state (no anchor).
  window.__lensState.anchor = null;
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 'd1', type: 'function',
        function: { name: 'apply_edits', arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: 'Original prose.', replace: 'Tightened prose.' }]
        })}
      }]}}]
    })
  });
  await window.submitLens('/tighten this');
  await new Promise(r => setTimeout(r, 200));
  const hist = await new Promise(res => {
    window.openDB().then(db => {
      const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
      r.onsuccess = () => res(r.result);
    });
  });
  const top = hist[0];
  check('default-slash commit produced a hist record', !!top);
  check('record has surface=default-command', top && top.surface === 'default-command');
  check('record has instruction matching the typed command body',
    top && top.instruction === 'tighten this');
  check('record has scope.type=document',
    top && top.scope && top.scope.type === 'document');
}

console.log('\n== Test L10.1: paste-detection hint shown for slash-leading code paste ==');
{
  // Reset hint shown state if exposed.
  if (typeof window.__resetPasteHint === 'function') window.__resetPasteHint();
  const input = window.document.getElementById('rwa-lens-input');
  // Simulate paste event with multi-line content containing additional slashes.
  const e = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: { getData: () => '/path/to/file\n/another/path' }
  });
  input.dispatchEvent(e);
  await new Promise(r => setTimeout(r, 50));
  const hint = window.document.getElementById('rwa-lens-paste-hint');
  check('paste hint visible', hint && !hint.hidden);
  check('hint mentions \\\\/ escape', /\\\\\//.test(hint?.textContent || ''));
}

// === Phase: commit-count nudge (spec §5.6) ===
console.log('\n== Test M1.1: dirtyCount increments on each successful modify ==');
{
  // Reset to a known state.
  await window.rwaResetDirtyCount?.();
  check('rwaGetDirtyCount exists', typeof window.rwaGetDirtyCount === 'function');
  check('starts at 0', (await window.rwaGetDirtyCount()) === 0);

  // Simulate three successful modifies by calling the internal hook.
  await window.rwaBumpDirtyCount(); // 1
  await window.rwaBumpDirtyCount(); // 2
  await window.rwaBumpDirtyCount(); // 3
  check('count is 3 after three bumps', (await window.rwaGetDirtyCount()) === 3);
}

console.log('\n== Test M1.2: nudge toast appears at threshold (5) ==');
{
  await window.rwaResetDirtyCount();
  for (let i = 0; i < 4; i++) await window.rwaBumpDirtyCount();
  check('no toast at count=4',
    !window.document.querySelector('.rwa-lens-toast[data-kind="commit-nudge"]'));
  await window.rwaBumpDirtyCount(); // crosses 5
  const toast = window.document.querySelector('.rwa-lens-toast[data-kind="commit-nudge"]');
  check('toast appears at count=5', !!toast);
  check('toast mentions 5 uncommitted changes',
    /5 uncommitted/i.test(toast?.textContent || ''));
  check('toast mentions ⌘S', /⌘S|cmd.?s/i.test(toast?.textContent || ''));
}

console.log('\n== Test M1.3: commit resets the counter and clears toast ==');
{
  // Counter still at >=5 from previous test.
  await window.rwaResetOnCommit();
  check('count is 0 after reset', (await window.rwaGetDirtyCount()) === 0);
  check('toast removed',
    !window.document.querySelector('.rwa-lens-toast[data-kind="commit-nudge"]'));
}

console.log('\n== Test M1.4: counter round-trips through IDB ==');
{
  await window.rwaResetDirtyCount();
  await window.rwaBumpDirtyCount();
  await window.rwaBumpDirtyCount();
  const stored = await window.rwaGetDirtyCount();
  check('count round-trips through IDB at 2', stored === 2);
}

console.log('\n== Test M1.5: lens direct text and anchored slash bump the counter ==');
{
  // Drive a direct-text append through the lens (default state → EOF append
  // via synthesizeAndCommit). Mirrors L3.4's setup.
  await window.__setDocForTest('<p>Existing.</p>');
  // Ensure default state (no anchor) so submitLens routes through
  // synthesizeAndCommit, not runAnchoredCommand.
  window.__lensState.anchor = null;
  window.document.getElementById('rwa-lens').dataset.state = 'default';
  delete window.__synthesizeAndCommit; // unstub — use the real synthesizeAndCommit
  await window.rwaResetDirtyCount();
  const beforeDirect = await window.rwaGetDirtyCount();
  await window.submitLens('Direct text appended via lens.');
  await new Promise(r => setTimeout(r, 100));
  const afterDirect = await window.rwaGetDirtyCount();
  check('direct text via lens increments counter (synthesizeAndCommit)',
    afterDirect === beforeDirect + 1);

  // Drive an anchored slash command via runAnchoredCommand. Mirrors L7.4.
  await window.__setDocForTest('<p>Original.</p>');
  await window.rwaResetDirtyCount();
  // Click to anchor.
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  // Single-shot completion response (no tool_use — runAnchoredCommand wraps
  // the model's content into the apply_edits envelope itself).
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '<p>Tightened.</p>' }}]
    })
  });
  await window.submitLens('/tighten');
  await new Promise(r => setTimeout(r, 200));
  const afterAnchored = await window.rwaGetDirtyCount();
  check('anchored slash command increments counter (runAnchoredCommand)',
    afterAnchored === 1);
}

// === Phase: quota warning (spec §5.3) ===
console.log('\n== Test M2.1: warning fires when usage > 80% ==');
const _origEstimate = window.navigator.storage.estimate?.bind(window.navigator.storage);
try {
  window.navigator.storage.estimate = async () => ({ usage: 81 * 1024 * 1024, quota: 100 * 1024 * 1024 });
  await window.rwaCheckQuota();
  const toast = window.document.querySelector('.rwa-lens-toast[data-kind="quota-warn"]');
  check('toast appears for >80% usage', !!toast);
  check('toast text mentions storage and 80%',
    /storage/i.test(toast?.textContent || '') && /80%/.test(toast?.textContent || ''));
  check('toast text includes used/quota MB',
    /\d+\/\d+ MB/.test(toast?.textContent || ''));
} finally {
  // Clean up toast + restore estimate for downstream tests.
  window.document.querySelector('.rwa-lens-toast[data-kind="quota-warn"]')?.remove();
  if (_origEstimate) window.navigator.storage.estimate = _origEstimate;
}

console.log('\n== Test M2.2: no warning when usage < 80% (and pre-existing warning clears) ==');
{
  // Pre-populate a warning toast so we can verify clearing.
  window.navigator.storage.estimate = async () => ({ usage: 81 * 1024 * 1024, quota: 100 * 1024 * 1024 });
  await window.rwaCheckQuota();
  check('pre-condition: warning toast present',
    !!window.document.querySelector('.rwa-lens-toast[data-kind="quota-warn"]'));

  // Now low usage: expect the toast to clear.
  window.navigator.storage.estimate = async () => ({ usage: 10 * 1024 * 1024, quota: 100 * 1024 * 1024 });
  await window.rwaCheckQuota();
  check('warning toast cleared at low usage',
    !window.document.querySelector('.rwa-lens-toast[data-kind="quota-warn"]'));
}

console.log('\n== Test M2.3: estimate() unsupported is a no-op ==');
{
  window.navigator.storage.estimate = undefined;
  // No pre-existing toast.
  window.document.querySelector('.rwa-lens-toast[data-kind="quota-warn"]')?.remove();
  let threw = false;
  try { await window.rwaCheckQuota(); } catch (_) { threw = true; }
  check('no exception on missing estimate()', !threw);
  check('no toast surfaced',
    !window.document.querySelector('.rwa-lens-toast[data-kind="quota-warn"]'));
}

// === Phase: private-mode detection (spec §9.1) ===
console.log('\n== Test M3.1: detectPrivateMode returns true on tiny quota ==');
{
  window.navigator.storage.estimate = async () => ({ usage: 0, quota: 1 * 1024 * 1024 });
  const verdict = await window.rwaDetectPrivateMode();
  check('verdict is true for 1 MB quota', verdict === true);
}

console.log('\n== Test M3.2: detectPrivateMode returns false on normal quota ==');
{
  window.navigator.storage.estimate = async () => ({ usage: 100, quota: 5 * 1024 * 1024 * 1024 });
  const verdict = await window.rwaDetectPrivateMode();
  check('verdict is false for 5 GB quota', verdict === false);
}

console.log('\n== Test M3.3: showPrivateModeBanner renders blocking overlay ==');
{
  window.document.getElementById('rwa-private-mode-banner')?.remove();
  window.rwaShowPrivateModeBanner();
  const banner = window.document.getElementById('rwa-private-mode-banner');
  check('banner exists', !!banner);
  check('banner contains spec wording',
    /requires normal browsing mode/i.test(banner?.textContent || ''));
  check('banner has role=alert', banner?.getAttribute('role') === 'alert');
}

console.log('\n== Test M3.4: estimate() unsupported defaults to safe (false) ==');
{
  const orig = window.navigator.storage.estimate;
  window.navigator.storage.estimate = undefined;
  const verdict = await window.rwaDetectPrivateMode();
  check('verdict is false when estimate() unsupported', verdict === false);
  window.navigator.storage.estimate = orig;
}

// === Phase: runtime.db basics (spec §7) ===
console.log('\n== Test R1.1: window.runtime exists with id + db ==');
{
  check('window.runtime is an object', typeof window.runtime === 'object' && window.runtime !== null);
  check('runtime.id is a UUID string',
    typeof window.runtime.id === 'string' && /^[0-9a-f-]{36}$/.test(window.runtime.id));
  check('runtime.db has get/put/del/all', ['get','put','del','all'].every(k => typeof window.runtime.db[k] === 'function'));
}

console.log('\n== Test R1.2: db.put on reserved store rejects ==');
{
  let threw = null;
  try { await window.runtime.db.put('rwa_doc', 'test-key', { foo: 1 }); }
  catch (e) { threw = e; }
  check('writing to reserved rwa_* store rejects',
    threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R1.3: db.get on reserved store rejects ==');
{
  let threw = null;
  try { await window.runtime.db.get('rwa_undo', 'no-such-key'); }
  catch (e) { threw = e; }
  check('reading from reserved store rejects',
    threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R1.4: db.del on reserved store rejects ==');
{
  let threw = null;
  try { await window.runtime.db.del('rwa_state', 'dirty_count'); }
  catch (e) { threw = e; }
  check('del on reserved rejects',
    threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R1.5: db.all on reserved store rejects ==');
{
  let threw = null;
  try { await window.runtime.db.all('rwa_hist'); }
  catch (e) { threw = e; }
  check('all on reserved rejects',
    threw !== null && /reserved/i.test(threw.message || ''));
}

// === Phase: runtime.db.open (spec §7) ===
console.log('\n== Test R2.1: open a new store, round-trip put/get ==');
{
  await window.runtime.db.open('tracker_tasks');
  await window.runtime.db.put('tracker_tasks', 'task-1', { title: 'first' });
  const got = await window.runtime.db.get('tracker_tasks', 'task-1');
  check('round-trip via runtime.db', got && got.title === 'first');
}

console.log('\n== Test R2.2: db.all iterates declared store ==');
{
  await window.runtime.db.put('tracker_tasks', 'task-2', { title: 'second' });
  const all = await window.runtime.db.all('tracker_tasks');
  check('db.all returns array', Array.isArray(all));
  check('contains both entries', all.length === 2 && all.every(e => e.key && e.value));
}

console.log('\n== Test R2.3: db.del removes a record ==');
{
  await window.runtime.db.del('tracker_tasks', 'task-1');
  const all = await window.runtime.db.all('tracker_tasks');
  check('only one entry remains', all.length === 1 && all[0].key === 'task-2');
}

console.log('\n== Test R2.4: db.open on reserved name rejects ==');
{
  let threw = null;
  try { await window.runtime.db.open('rwa_evil'); }
  catch (e) { threw = e; }
  check('reserved name rejects', threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R2.5: db.open is idempotent ==');
{
  await window.runtime.db.open('tracker_tasks');  // second open
  const got = await window.runtime.db.get('tracker_tasks', 'task-2');
  check('existing data preserved across re-open', got && got.title === 'second');
}

console.log('\n== Test R2.6: db.open with autoIncrement ==');
{
  await window.runtime.db.open('events', { autoIncrement: true });
  // autoIncrement stores accept put without explicit key.
  await window.runtime.db.put('events', null, { type: 'click' });
  await window.runtime.db.put('events', null, { type: 'scroll' });
  const all = await window.runtime.db.all('events');
  check('autoIncrement assigned keys', all.length === 2 && typeof all[0].key === 'number');
}

console.log('\n== Test R2.7: db.put with null key on non-autoIncrement store throws clearly ==');
{
  await window.runtime.db.open('plain_store');  // non-autoIncrement
  let threw = null;
  try { await window.runtime.db.put('plain_store', null, { foo: 1 }); }
  catch (e) { threw = e; }
  check('throws on null key',
    threw !== null && /key is required/i.test(threw.message || ''));
  check('error mentions the store name',
    threw !== null && /plain_store/.test(threw.message || ''));
  check('error mentions autoIncrement hint',
    threw !== null && /autoIncrement/i.test(threw.message || ''));
}

console.log('\n== Test R2.8: db.open with mismatched autoIncrement throws ==');
{
  await window.runtime.db.open('plain_store');  // existing as non-autoIncrement
  let threw = null;
  try { await window.runtime.db.open('plain_store', { autoIncrement: true }); }
  catch (e) { threw = e; }
  check('mismatched autoIncrement throws',
    threw !== null && /autoIncrement/i.test(threw.message || ''));
  check('error names the store',
    threw !== null && /plain_store/.test(threw.message || ''));
}

console.log('\n== Test R2.9: declared store survives a simulated reload ==');
{
  // The seed's _db handle is module-scoped inside the bootstrap IIFE, so we
  // can't close it from out here. Instead we open a brand-new IDB connection
  // directly against the per-container database and verify both that the
  // schema (object stores) and the registry (rwa_state['user_stores'])
  // survived — i.e. that a fresh page load would re-instantiate them.
  const dbName = 'rwa_' + window.runtime.id;
  const raw = await new Promise((res, rej) => {
    const r = window.indexedDB.open(dbName);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
  check('previously declared tracker_tasks store survives in IDB',
    raw.objectStoreNames.contains('tracker_tasks'));
  check('previously declared events store survives in IDB',
    raw.objectStoreNames.contains('events'));
  check('previously declared plain_store store survives in IDB',
    raw.objectStoreNames.contains('plain_store'));
  raw.close();

  // The user_stores entry in rwa_state is what openDB()'s upgrade handler
  // consults on a fresh load to re-create the user's stores. Verify it's
  // persisted with the right shape.
  const stateRaw = await new Promise((res, rej) => {
    const r = window.indexedDB.open(dbName);
    r.onsuccess = () => {
      const tx  = r.result.transaction('rwa_state', 'readonly');
      const req = tx.objectStore('rwa_state').get('user_stores');
      req.onsuccess = () => { r.result.close(); res(req.result); };
      req.onerror   = () => rej(req.error);
    };
    r.onerror = () => rej(r.error);
  });
  check('user_stores entry exists in rwa_state',
    stateRaw && typeof stateRaw === 'object');
  check('user_stores includes tracker_tasks',
    stateRaw && stateRaw.tracker_tasks !== undefined);
  check('user_stores includes events with autoIncrement',
    stateRaw && stateRaw.events && stateRaw.events.autoIncrement === true);
}

// === Phase: runtime.db.subscribe (spec §7) ===
console.log('\n== Test R3.1: subscribe fires on local put ==');
{
  await window.runtime.db.open('subscribe_test');
  let called = 0; let lastKey = null;
  const unsub = window.runtime.db.subscribe('subscribe_test', evt => {
    called++; lastKey = evt.key;
  });
  await window.runtime.db.put('subscribe_test', 'k1', { hi: 1 });
  // BroadcastChannel is async; allow a tick.
  await new Promise(r => setTimeout(r, 10));
  check('subscribe fired once', called === 1);
  check('event has key', lastKey === 'k1');
  unsub();
}

console.log('\n== Test R3.2: unsub stops the callback ==');
{
  let called = 0;
  const unsub = window.runtime.db.subscribe('subscribe_test', () => { called++; });
  unsub();
  await window.runtime.db.put('subscribe_test', 'k2', { hi: 2 });
  await new Promise(r => setTimeout(r, 10));
  check('callback not called after unsub', called === 0);
}

console.log('\n== Test R3.3: subscribe on reserved store rejects ==');
{
  let threw = null;
  try { window.runtime.db.subscribe('rwa_hist', () => {}); }
  catch (e) { threw = e; }
  check('reserved name rejects', threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R3.4: subscribe fires on del ==');
{
  let lastKind = null; let lastKey = null;
  const unsub = window.runtime.db.subscribe('subscribe_test', evt => {
    lastKind = evt.kind; lastKey = evt.key;
  });
  await window.runtime.db.del('subscribe_test', 'k1');
  await new Promise(r => setTimeout(r, 10));
  check('del fires subscribe with kind=del', lastKind === 'del');
  check('del event carries key', lastKey === 'k1');
  unsub();
}

console.log('\n== Test R3.5: throwing callback does not break put ==');
{
  const unsub = window.runtime.db.subscribe('subscribe_test', () => { throw new Error('boom'); });
  let putError = null;
  try { await window.runtime.db.put('subscribe_test', 'k3', { hi: 3 }); }
  catch (e) { putError = e; }
  await new Promise(r => setTimeout(r, 10));
  check('put completes despite callback throwing', putError === null);
  const got = await window.runtime.db.get('subscribe_test', 'k3');
  check('value stored despite callback throw', got && got.hi === 3);
  unsub();
}

console.log('\n== Test R3.6: subscribe rejects non-function callback ==');
{
  let threw = null;
  try { window.runtime.db.subscribe('subscribe_test', 'not a function'); }
  catch (e) { threw = e; }
  check('non-function callback throws TypeError',
    threw !== null && threw.name === 'TypeError');  // .name is realm-safe; jsdom's TypeError ≠ Node's
}

console.log('\n== Test R3.7: autoIncrement put carries resolved key in event ==');
{
  await window.runtime.db.open('subscribe_auto', { autoIncrement: true });
  let lastKey = null; let lastKind = null;
  const unsub = window.runtime.db.subscribe('subscribe_auto', evt => {
    lastKey = evt.key; lastKind = evt.kind;
  });
  const resolved = await window.runtime.db.put('subscribe_auto', null, { type: 'click' });
  await new Promise(r => setTimeout(r, 10));
  check('autoIncrement put returns resolved key', typeof resolved === 'number');
  check('event carries the resolved key, not null', lastKey === resolved);
  check('event has kind=put', lastKind === 'put');
  unsub();
}

// === Phase: runtime.modify/commit/undo + status + on (spec §7) ===
console.log('\n== Test R4.1: runtime.status reads dirty/fsa/storage ==');
{
  const s = window.runtime.status;
  check('status is an object', typeof s === 'object' && s !== null);
  check('status.dirty is boolean', typeof s.dirty === 'boolean');
  check('status.fsa is enum',
    ['granted','prompt','denied','unsupported','lost'].includes(s.fsa));
  // storage is either a {usage, quota} record or null when estimate() returned
  // an unusable result. Either is acceptable here.
  check('status.storage shape',
    (s.storage && typeof s.storage.usage === 'number' && typeof s.storage.quota === 'number')
    || s.storage === null);
}

console.log('\n== Test R4.2: runtime.on("modify", cb) fires ==');
{
  // Reset the doc so submitLens's direct-text path runs cleanly.
  await window.__setDocForTest('<p>Existing for runtime.modify.</p>');
  delete window.__synthesizeAndCommit;
  let n = 0;
  const off = window.runtime.on('modify', () => n++);
  // Trigger via the existing test seam.
  await window.submitLens('Direct prose for runtime.modify test.');
  await new Promise(r => setTimeout(r, 50));
  check('modify event fired', n === 1);
  off();
}

console.log('\n== Test R4.3: runtime.on("commit", cb) fires on commit ==');
{
  // jsdom lacks URL.createObjectURL and showSaveFilePicker; stub the download
  // path so commit() reaches its success branch (where the emit lives).
  const origCreateURL = window.URL.createObjectURL;
  const origRevokeURL = window.URL.revokeObjectURL;
  window.URL.createObjectURL = () => 'blob:rwa-test/0';
  window.URL.revokeObjectURL = () => {};
  let n = 0;
  const off = window.runtime.on('commit', () => n++);
  await window.runtime.commit();
  await new Promise(r => setTimeout(r, 20));
  check('commit event fired', n === 1);
  off();
  window.URL.createObjectURL = origCreateURL;
  window.URL.revokeObjectURL = origRevokeURL;
}

console.log('\n== Test R4.4: runtime.undo wraps internal undo ==');
{
  await window.__setDocForTest('<p>Baseline.</p>');
  delete window.__synthesizeAndCommit;
  const before = (await window.getDoc()) || '';
  await window.submitLens('Reversible append.');
  await new Promise(r => setTimeout(r, 50));
  const after = (await window.getDoc()) || '';
  check('doc changed', after.length > before.length);
  await window.runtime.undo();
  const restored = (await window.getDoc()) || '';
  check('undo restored prior doc', restored === before);
}

console.log('\n== Test R4.5: runtime.on("status", cb) fires on dirty change ==');
{
  await window.__setDocForTest('<p>Status fire base.</p>');
  delete window.__synthesizeAndCommit;
  let n = 0;
  const off = window.runtime.on('status', () => n++);
  await window.submitLens('Trigger dirty.');
  await new Promise(r => setTimeout(r, 50));
  check('status fired', n >= 1);
  off();
}

console.log('\n== Test R4.6: unknown event name throws ==');
{
  let threw = null;
  try { window.runtime.on('not-an-event', () => {}); }
  catch (e) { threw = e; }
  check('unknown event rejects', threw !== null);
}

console.log('\n== Test R4.7: runtime.on returns a working unsub function ==');
{
  let n = 0;
  const off = window.runtime.on('modify', () => n++);
  check('on returns a function', typeof off === 'function');
  off();
  await window.__setDocForTest('<p>After-unsub.</p>');
  delete window.__synthesizeAndCommit;
  await window.submitLens('Should not increment.');
  await new Promise(r => setTimeout(r, 50));
  check('callback not called after off()', n === 0);
}

console.log('\n== Test R4.8: runtime.on rejects non-function callback ==');
{
  let threw = null;
  try { window.runtime.on('commit', 'not a function'); }
  catch (e) { threw = e; }
  check('non-function callback throws TypeError',
    threw !== null && threw.name === 'TypeError');  // .name is realm-safe
}

console.log('\n== Test R4.9: runtime.status getter returns a fresh snapshot ==');
{
  const a = window.runtime.status;
  const b = window.runtime.status;
  check('two reads return distinct objects', a !== b);
  // Touching a property on one mustn't be visible on a later read.
  a.dirty = 'tampered';
  const c = window.runtime.status;
  check('snapshot is independent (mutation not retained)', c.dirty !== 'tampered');
}

console.log('\n== Test R4.10: throwing callback does not block other listeners ==');
{
  await window.__setDocForTest('<p>Throw-safety base.</p>');
  delete window.__synthesizeAndCommit;
  let goodCount = 0;
  const offBad  = window.runtime.on('modify', () => { throw new Error('boom'); });
  const offGood = window.runtime.on('modify', () => { goodCount++; });
  await window.submitLens('After-throwing-cb.');
  await new Promise(r => setTimeout(r, 50));
  check('non-throwing callback still received the event', goodCount === 1);
  offBad(); offGood();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
