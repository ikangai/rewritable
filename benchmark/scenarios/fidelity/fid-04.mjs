// FID-04 — mid-document insertion. Add a new <tr> between the first two
// rows of the strategy table. Siblings and parent unchanged.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDrift, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const NEW_ROW = '<tr><td>Backpressure</td><td>Buffer overflow</td><td>Variable</td></tr>';

export default {
  id: 'FID-04',
  category: 'FID',
  description: 'mid-document insertion — new <tr> in strategy table, siblings preserved',
  weight: 2,
  N: 3,
  fixture: 'article-medium/clean',
  prompt: 'Add a new row to the strategy table between Bulkhead and Circuit breaker, with cells: "Backpressure", "Buffer overflow", "Variable". Don\'t touch other rows.',

  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: {
        version: 'rwa-edit/1',
        edits: [{
          find: '<tr><td>Bulkhead</td><td>Resource exhaustion</td><td>Seconds</td></tr>\n',
          replace: '<tr><td>Bulkhead</td><td>Resource exhaustion</td><td>Seconds</td></tr>\n' + NEW_ROW + '\n',
        }],
      },
    },
  ]),

  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('tbody tr').length === 4, label: '4 tbody rows' },
    { fn: (d) => Array.from(d.querySelectorAll('tbody tr td:first-child')).map(td => td.textContent).join(',') === 'Bulkhead,Backpressure,Circuit breaker,Retry with jitter', label: 'order: Bulkhead → Backpressure → Circuit breaker → Retry' },
  ]),

  stability: (fixture, doc) => {
    const region = regionOfLiteral(fixture, '<tr><td>Bulkhead</td><td>Resource exhaustion</td><td>Seconds</td></tr>');
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    // Allow region to extend through the inserted row.
    const expected = [region[0], region[1] + NEW_ROW.length + 1];
    const d = computeDrift(fixture, doc, [expected]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
