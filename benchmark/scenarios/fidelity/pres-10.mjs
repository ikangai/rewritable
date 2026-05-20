// PRES-10 — table-within-table. Edit the outer cell's prose; the inner
// table's structure and contents must be byte-identical. Models that
// "tidy up" nested tables are a known failure mode.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const INNER = `<table class="sub-breakdown"><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>SKU-001</td><td>3</td></tr><tr><td>SKU-002</td><td>7</td></tr></tbody></table>`;

const FIXTURE = `<table class="orders">
<thead><tr><th>Order ID</th><th>Customer</th><th>Breakdown</th></tr></thead>
<tbody>
<tr>
<td>ORD-501</td>
<td>NOTE_ANCHOR Pending review by warehouse staff.</td>
<td>${INNER}</td>
</tr>
</tbody>
</table>`;

export default {
  id: 'PRES-10',
  category: 'PRES',
  tag: 'content',
  description: 'edit outer cell prose; nested table inside sibling cell byte-identical',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Update the second cell text from "Pending review by warehouse staff." to "Approved — ship Monday.". The nested breakdown table in the third cell is unrelated and must not be touched.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'NOTE_ANCHOR Pending review by warehouse staff.', replace: 'Approved — ship Monday.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('table.orders').length === 1, label: 'one outer table' },
    { fn: (d) => d.querySelectorAll('table.sub-breakdown').length === 1, label: 'one inner table preserved' },
    { fn: (d) => d.querySelectorAll('table.sub-breakdown thead th').length === 2, label: 'inner thead intact' },
    { fn: (d) => d.querySelectorAll('table.sub-breakdown tbody tr').length === 2, label: 'inner has 2 rows' },
    { fn: (d) => {
      const cells = Array.from(d.querySelectorAll('table.sub-breakdown tbody td')).map(t => t.textContent);
      return cells.join(',') === 'SKU-001,3,SKU-002,7';
    }, label: 'inner cell contents byte-identical' },
    { fn: (d) => Array.from(d.querySelectorAll('table.orders > tbody > tr > td'))
        .some(td => td.textContent.includes('Approved')), label: 'outer cell edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('NOTE_ANCHOR'), label: 'anchor token removed' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'NOTE_ANCHOR Pending review by warehouse staff.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
