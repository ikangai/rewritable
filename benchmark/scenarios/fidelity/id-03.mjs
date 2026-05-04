// ID-03 — internal <a href="#sec-clocks"> reference still resolves after
// the H2 heading text is changed. The heading element's id="sec-clocks"
// must survive an edit that retitles only its visible text.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

export default {
  id: 'ID-03',
  category: 'ID',
  description: 'rename H2 visible text, id="sec-clocks" preserved, anchor link still resolves',
  weight: 1,
  N: 3,
  fixture: 'article-medium/clean-rich',
  prompt: 'Rename the heading "Clocks and ordering" to "Logical clocks and event ordering". Keep id="sec-clocks" so the anchor link continues to work.',

  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: {
        version: 'rwa-edit/1',
        edits: [{
          find: '<h2 id="sec-clocks">Clocks and ordering</h2>',
          replace: '<h2 id="sec-clocks">Logical clocks and event ordering</h2>',
        }],
      },
    },
  ]),

  success: (doc) => runSelectorOracle(doc, [
    { selector: '#sec-clocks', textEquals: 'Logical clocks and event ordering', label: 'heading retitled with id intact' },
    { selector: 'a[href="#sec-clocks"]', label: 'href anchor unchanged' },
    { fn: (d) => {
      const target = d.querySelector('#sec-clocks');
      const link = d.querySelector('a[href="#sec-clocks"]');
      return !!(target && link);
    }, label: 'link target resolves' },
  ]),

  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, '<h2 id="sec-clocks">Clocks and ordering</h2>');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
