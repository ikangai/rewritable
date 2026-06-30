// Mirror-parity: the structuralScore / structuralScoreByPage inlined into
// service/public/import.html (browser, no build step) must match cli/src/import-fidelity.mjs
// byte-for-output. Extract the inlined block from the HTML, run it in a node sandbox, and
// deep-equal its results against the CLI on the same inputs. Catches drift between the two sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cli from '../src/import-fidelity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(path.join(root, 'service', 'public', 'import.html'), 'utf8');
const startMarker = 'function _fidBadChars';
const endAnchor = 'window.__importFidelity = { structuralScore, structuralScoreByPage };';
const start = html.indexOf(startMarker);
const end = html.indexOf(endAnchor);
assert.ok(start >= 0 && end > start, 'could not locate the inlined fidelity block in import.html');
const block = html.slice(start, end + endAnchor.length);
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', block)(win);
const browser = win.__importFidelity;
assert.ok(browser && browser.structuralScore && browser.structuralScoreByPage, 'block did not expose the functions');

const cases = [
  { i: { sourceText: 'The quarterly report shows revenue up twelve percent across regions.', pages: 1 }, h: '<span>The quarterly report shows revenue up twelve percent across regions.</span>' },
  { i: { sourceText: 'aa bb cc ��� dd ee garble here', pages: 1 }, h: '<span>x</span>' },
  { i: { sourceText: 'alpha beta gamma delta epsilon', pages: 1 }, h: '<span>nothing matches</span>' },
  { i: { sourceText: '', pages: 1 }, h: '' },
];

test('import.html structuralScore matches the CLI (mirror parity)', () => {
  for (const c of cases) {
    assert.deepEqual(browser.structuralScore(c.i, c.h), cli.structuralScore(c.i, c.h), 'mismatch for ' + JSON.stringify(c.i));
  }
});

test('import.html structuralScoreByPage matches the CLI', () => {
  const perPage = [
    { sourceText: 'dense readable text with many words here today', html: '<span>dense readable text with many words here today</span>' },
    { sourceText: 'g��bled tex� here', html: '<span>g��bled tex� here</span>' },
  ];
  assert.deepEqual(browser.structuralScoreByPage(perPage), cli.structuralScoreByPage(perPage));
});
