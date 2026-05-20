// PRES-08 — table with rowspan + colspan. Edit a regular cell's text; every
// rowspan/colspan attribute on neighboring cells must remain byte-identical.
// Models often "fix" the table shape by collapsing spans they don't
// understand; this scenario catches that.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<table class="grid">
<caption>Server reservation grid</caption>
<thead>
<tr><th colspan="2">Server</th><th colspan="3">Allocations</th></tr>
<tr><th>Hostname</th><th>Region</th><th>Mon-Wed</th><th>Thu-Fri</th><th>Weekend</th></tr>
</thead>
<tbody>
<tr><td rowspan="2">db-01</td><td rowspan="2">eu-west</td><td>Alice</td><td>Bob</td><td>—</td></tr>
<tr><td>OPS_CELL placeholder text</td><td colspan="2">Carol (oncall)</td></tr>
<tr><td>db-02</td><td>us-east</td><td colspan="3">Maintenance window</td></tr>
</tbody>
</table>`;

export default {
  id: 'PRES-08',
  category: 'PRES',
  tag: 'content',
  description: 'edit one regular cell; rowspan/colspan attributes on neighboring cells unchanged',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Replace the cell text "OPS_CELL placeholder text" with "Dave". Do not change any rowspan or colspan attributes — the row/column geometry stays exactly as it is.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'OPS_CELL placeholder text', replace: 'Dave' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('caption')?.textContent === 'Server reservation grid', label: 'caption preserved' },
    { fn: (d) => d.querySelectorAll('thead tr').length === 2, label: 'thead still 2 rows' },
    { fn: (d) => d.querySelectorAll('th[colspan="2"]').length === 1, label: 'th colspan=2 preserved' },
    { fn: (d) => d.querySelectorAll('th[colspan="3"]').length === 1, label: 'th colspan=3 preserved' },
    { fn: (d) => d.querySelectorAll('td[rowspan="2"]').length === 2, label: 'both td rowspan=2 preserved' },
    { fn: (d) => d.querySelectorAll('td[colspan="2"]').length === 1, label: 'td colspan=2 (Carol) preserved' },
    { fn: (d) => d.querySelectorAll('td[colspan="3"]').length === 1, label: 'td colspan=3 (Maintenance) preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('tbody td')).some(t => t.textContent === 'Dave'), label: 'edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('OPS_CELL'), label: 'old placeholder gone' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'OPS_CELL placeholder text');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
