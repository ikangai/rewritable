// FID-06 — multiple non-overlapping edits in one batch. Per spec §4.1: rename
// heading + add table row + fix typo. Verify all three landed and nothing
// else changed.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const NEW_ROW = '<tr><td>Backpressure</td><td>Buffer overflow</td><td>Variable</td></tr>';

export default {
  id: 'FID-06',
  category: 'FID',
  description: 'multi-edit batch — rename heading, add row, fix typo (3 edits, all land)',
  weight: 2,
  N: 3,
  fixture: 'article-medium/clean',
  prompt: 'Apply three edits in one batch: (1) rename heading "Implementation example" to "Implementation". (2) Add a new strategy table row "Backpressure / Buffer overflow / Variable" after the Bulkhead row. (3) Fix the typo "thier" → "their".',

  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: {
        version: 'rwa-edit/1',
        edits: [
          { find: 'Implementation example', replace: 'Implementation' },
          {
            find: '<tr><td>Bulkhead</td><td>Resource exhaustion</td><td>Seconds</td></tr>\n',
            replace: '<tr><td>Bulkhead</td><td>Resource exhaustion</td><td>Seconds</td></tr>\n' + NEW_ROW + '\n',
          },
          { find: 'thier', replace: 'their' },
        ],
      },
    },
  ]),

  success: (doc) => runSelectorOracle(doc, [
    { selector: 'h2:nth-of-type(2)', textEquals: 'Implementation', label: 'heading renamed' },
    { fn: (d) => d.querySelectorAll('tbody tr').length === 4, label: '4 rows' },
    { fn: (d) => !d.body.textContent.includes('thier'), label: 'no typo' },
  ]),

  stability: (fixture, doc, envelope) => {
    // Three expected regions: heading text, the Bulkhead row (extended for
    // the inserted row), and the typo.
    const r1 = regionOfLiteral(fixture, 'Implementation example');
    const r2 = regionOfLiteral(fixture, '<tr><td>Bulkhead</td><td>Resource exhaustion</td><td>Seconds</td></tr>\n');
    const r3 = regionOfLiteral(fixture, 'thier');
    if (!r1 || !r2 || !r3 || !envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [r1, r2, r3]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
