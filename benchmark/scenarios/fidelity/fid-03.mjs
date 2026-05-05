// FID-03 — attribute-only change. Fixture has class="callout"; change to
// class="callout important". Surrounding markup byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDrift, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

export default {
  id: 'FID-03',
  category: 'FID',
  tag: 'structural_regular',
  description: 'attribute-only change — class augmentation, surrounding markup byte-identical',
  weight: 2,
  N: 3,
  fixture: 'article-medium/clean',
  prompt: 'Add the class "important" to the .callout paragraph. Keep "callout" and add "important". Change nothing else.',

  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: {
        version: 'rwa-edit/1',
        edits: [{ find: 'class="callout"', replace: 'class="callout important"' }],
      },
    },
  ]),
  expectedDslPlan: {
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'set_attr', anchor: '<p class="callout"', attr: 'class', value: 'callout important' }],
  },

  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p.callout.important', label: 'p has both classes' },
    { selector: 'p.callout', textContains: 'subscribe form', label: 'callout content unchanged' },
  ]),

  stability: (fixture, doc) => {
    const region = regionOfLiteral(fixture, 'class="callout"');
    const d = computeDrift(fixture, doc, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
