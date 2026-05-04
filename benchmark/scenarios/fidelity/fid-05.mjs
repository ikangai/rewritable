// FID-05 — mid-document deletion. Remove the middle row of the strategy
// table. Siblings and parent unchanged.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

export default {
  id: 'FID-05',
  category: 'FID',
  description: 'mid-document deletion — remove Circuit breaker row, siblings preserved',
  weight: 2,
  N: 3,
  fixture: 'article-medium/clean',
  prompt: 'Remove the "Circuit breaker" row from the strategy table. Keep the other two rows byte-identical.',

  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: {
        version: 'rwa-edit/1',
        edits: [{
          find: '<tr><td>Circuit breaker</td><td>Cascading timeout</td><td>Milliseconds</td></tr>\n',
          replace: '',
        }],
      },
    },
  ]),

  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('tbody tr').length === 2, label: '2 rows remaining' },
    { fn: (d) => !d.body.textContent.includes('Circuit breaker'), label: 'Circuit breaker absent' },
    { fn: (d) => d.body.textContent.includes('Bulkhead') && d.body.textContent.includes('Retry with jitter'), label: 'siblings present' },
  ]),

  stability: (fixture, doc, envelope) => {
    const region = regionOfLiteral(fixture, '<tr><td>Circuit breaker</td><td>Cascading timeout</td><td>Milliseconds</td></tr>\n');
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0, reason: 'no edit envelope' };
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
