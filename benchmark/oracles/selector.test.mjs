// Self-test for the selector oracle.

import { runSelectorOracle } from './selector.mjs';

let pass = 0, fail = 0;
const t = (label, ok, detail) => { if (ok) pass++; else { fail++; console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`); } };

const doc = '<div class="hello"><h1>Title</h1><p>their typo</p><a href="#sec-2">link</a></div>';

// 1. All pass → score 2
{
  const r = runSelectorOracle(doc, [
    { selector: 'h1', textEquals: 'Title' },
    { selector: 'p', textContains: 'their' },
    { selector: 'a', attrs: { href: '#sec-2' } },
  ]);
  t('all pass → score 2', r.score === 2 && r.passed === 3 && r.total === 3, JSON.stringify(r));
}

// 2. Partial pass → score 1
{
  const r = runSelectorOracle(doc, [
    { selector: 'h1', textEquals: 'Title' },
    { selector: 'p', textContains: 'thier' /* misspelled */ },
  ]);
  t('partial → score 1', r.score === 1 && r.passed === 1, JSON.stringify(r));
}

// 3. None pass → score 0
{
  const r = runSelectorOracle(doc, [
    { selector: 'section' },
    { selector: 'h1', textEquals: 'Different' },
  ]);
  t('none → score 0', r.score === 0 && r.passed === 0, JSON.stringify(r));
}

// 4. exists:false (negative assertion)
{
  const r = runSelectorOracle(doc, [
    { selector: 'script', exists: false },
  ]);
  t('exists:false on absent element passes', r.score === 2);
}

// 5. fn assertion
{
  const r = runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('p').length === 1, label: 'one p' },
  ]);
  t('fn predicate works', r.score === 2);
}

console.log(`oracles/selector.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
