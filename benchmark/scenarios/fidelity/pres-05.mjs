// PRES-05 — change one cell's content; row/column structure, <thead>/
// <tbody>, alignment classes unchanged.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<table>
<thead><tr><th class="text-center">Name</th><th class="text-right">Value</th></tr></thead>
<tbody>
<tr><td class="text-center">Alpha</td><td class="text-right">CELL_VAL_BEFORE</td></tr>
<tr><td class="text-center">Beta</td><td class="text-right">200</td></tr>
</tbody>
</table>`;

export default {
  id: 'PRES-05',
  category: 'PRES',
  tag: 'content',
  description: 'change one cell value; structure + alignment classes unchanged',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Change "CELL_VAL_BEFORE" to "100". Keep all alignment classes and the row/column structure.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'CELL_VAL_BEFORE', replace: '100' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('thead').length === 1, label: 'thead present' },
    { fn: (d) => d.querySelectorAll('tbody').length === 1, label: 'tbody present' },
    { fn: (d) => d.querySelectorAll('.text-center').length === 3, label: '3 text-center cells preserved' },
    { fn: (d) => d.querySelectorAll('.text-right').length === 3, label: '3 text-right cells preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('tbody td.text-right')).map(t => t.textContent).join(',') === '100,200', label: 'cell value updated' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'CELL_VAL_BEFORE');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
