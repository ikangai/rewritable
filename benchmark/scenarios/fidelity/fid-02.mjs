// FID-02 — paragraph-level edit. The model rewrites only the second
// paragraph's content; the first and third must be byte-identical.
// (Closer to the worked example in spec §3 — same fixture as FID-01,
// but the prompt invites a paragraph-scope rewrite, not just a typo fix.)

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDrift, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const NEW_P2 = 'The second paragraph has been rewritten cleanly: it now states "their" without typo and adds nothing else.';

export default {
  id: 'FID-02',
  category: 'FID',
  description: 'paragraph-level edit — surrounding paragraphs byte-identical',
  weight: 2,
  N: 3,
  fixture: 'article-medium/clean',
  prompt: 'Rewrite ONLY the second paragraph to fix the "thier" typo and tighten the prose. Leave paragraphs 1 and 3 byte-identical.',

  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: {
        version: 'rwa-edit/1',
        edits: [{
          find: 'The second paragraph contains a typo: it says "thier" instead of "their". A correct edit changes only this paragraph and leaves the surrounding ones byte-identical.',
          replace: NEW_P2,
        }],
      },
    },
  ]),

  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p:nth-of-type(2)', textContains: 'their', label: 'their present' },
    { selector: 'p:nth-of-type(2)', textContains: 'rewritten', label: 'paragraph touched' },
    { selector: 'p:nth-of-type(1)', textContains: 'establishes context', label: 'p1 unchanged' },
    { selector: 'p:nth-of-type(3)', textContains: 'concludes the section', label: 'p3 unchanged' },
  ]),

  stability: (fixture, doc) => {
    // Expected region = the entire second paragraph block.
    const region = regionOfLiteral(fixture, 'The second paragraph contains a typo');
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    // Stretch the region to the closing </p>.
    const closeIdx = fixture.indexOf('</p>', region[0]);
    const expected = closeIdx > 0 ? [region[0], closeIdx + '</p>'.length] : region;
    const d = computeDrift(fixture, doc, [expected]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
