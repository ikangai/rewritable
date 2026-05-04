// CONT-03 — table with line items + "Total: $X" row; add a new line item;
// total updates correctly.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<table>
<tbody>
<tr class="line"><td>A</td><td class="amt">10</td></tr>
<tr class="line"><td>B</td><td class="amt">20</td></tr>
<tr class="total"><td>Total</td><td class="amt">30</td></tr>
</tbody>
</table>`;

export default {
  id: 'CONT-03',
  category: 'CONT',
  description: 'add line item C=15; total updates 30 → 45',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Add a new line "C / 15" between B and Total. Update the Total cell from 30 to 45.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: '<tr class="line"><td>B</td><td class="amt">20</td></tr>\n', replace: '<tr class="line"><td>B</td><td class="amt">20</td></tr>\n<tr class="line"><td>C</td><td class="amt">15</td></tr>\n' },
        { find: '<tr class="total"><td>Total</td><td class="amt">30</td></tr>', replace: '<tr class="total"><td>Total</td><td class="amt">45</td></tr>' },
      ] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('tr.line').length === 3, label: '3 line items' },
    { fn: (d) => {
      const lineSum = Array.from(d.querySelectorAll('tr.line .amt')).reduce((acc, td) => acc + Number(td.textContent), 0);
      const total = Number(d.querySelector('tr.total .amt')?.textContent || 'NaN');
      return lineSum === total;
    }, label: 'total = sum of lines' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const r1 = regionOfLiteral(fixture, '<tr class="line"><td>B</td><td class="amt">20</td></tr>\n');
    const r2 = regionOfLiteral(fixture, '<tr class="total"><td>Total</td><td class="amt">30</td></tr>');
    if (!r1 || !r2) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [r1, r2]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
