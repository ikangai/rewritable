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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
