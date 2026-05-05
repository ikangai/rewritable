// GENRE-02 — spreadsheet-shaped doc (budget tracker); user edits cell B5;
// SUM row references still resolve; structural integrity preserved.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<table id="budget">
<thead><tr><th>Category</th><th>Budgeted</th><th>Spent</th></tr></thead>
<tbody>
<tr><td>Rent</td><td>1000</td><td class="cell-spent">900</td></tr>
<tr><td>Food</td><td>500</td><td class="cell-spent">CELL_B5_VALUE</td></tr>
<tr><td>Utilities</td><td>200</td><td class="cell-spent">180</td></tr>
</tbody>
<tfoot><tr><td>Total</td><td>1700</td><td id="total-spent">1530</td></tr></tfoot>
</table>`;

export default {
  id: 'GENRE-02',
  category: 'GENRE',
  tag: 'content',
  description: 'edit cell B5 from 450 to 600; total recomputes 1530 → 1680',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE.replace('CELL_B5_VALUE', '450'),
  prompt: 'Update the Food spent cell from 450 to 600. Recompute the Total cell from 1530 to 1680.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: '<td class="cell-spent">450</td>', replace: '<td class="cell-spent">600</td>' },
        { find: '<td id="total-spent">1530</td>', replace: '<td id="total-spent">1680</td>' },
      ] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: '#total-spent', textEquals: '1680', label: 'total updated' },
    { fn: (d) => {
      const cells = Array.from(d.querySelectorAll('.cell-spent')).map(c => Number(c.textContent));
      return cells.reduce((a, b) => a + b, 0) === 1680;
    }, label: 'sum of cells equals total' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const r1 = regionOfLiteral(fixture, '<td class="cell-spent">450</td>');
    const r2 = regionOfLiteral(fixture, '<td id="total-spent">1530</td>');
    if (!r1 || !r2) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [r1, r2]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
