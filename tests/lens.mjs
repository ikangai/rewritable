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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
