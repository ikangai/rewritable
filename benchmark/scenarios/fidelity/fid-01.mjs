// FID-01 — single-character edit (typo fix). Fixture has "thier"; the
// edit changes it to "their". Surrounding doc must be byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDrift, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

export default {
  id: 'FID-01',
  category: 'FID',
  description: 'single-character typo fix — surrounding doc byte-identical',
  weight: 2,
  N: 3,
  fixture: 'article-medium/clean',
  prompt: 'Fix the typo "thier" → "their" in the second paragraph. Change nothing else.',

  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'thier', replace: 'their' }] } },
  ]),

  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p:nth-of-type(2)', textContains: 'their', label: 'their is present in 2nd p' },
    { fn: (d) => !((d.querySelector('p:nth-of-type(2)')?.textContent || '').includes('thier')), label: 'thier removed' },
  ]),

  stability: (fixture, doc) => {
    const region = regionOfLiteral(fixture, 'thier');
    const d = computeDrift(fixture, doc, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
