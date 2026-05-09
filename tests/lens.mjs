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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
