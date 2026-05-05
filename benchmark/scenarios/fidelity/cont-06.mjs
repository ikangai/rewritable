// CONT-06 — prose contains "as discussed in section 4 above"; insert a
// new H2 + paragraphs block between sections 3 and 4 (no new top-level
// element); cross-reference text updates from "section 4" to "section 5".

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<h2>Section 1</h2><p>S1 body.</p>
<h2>Section 2</h2><p>S2 body.</p>
<h2>Section 3</h2><p>S3 body.</p>
<h2>Section 4</h2><p>S4 body.</p>
<p>As discussed in section 4 above, the conclusion follows.</p>
</article>`;

export default {
  id: 'CONT-06',
  category: 'CONT',
  tag: 'mixed',
  description: 'insert new section between 3 and 4; cross-ref renumbers to "section 5"',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Insert a new H2 "Section 3.5" between Section 3 and Section 4 with a body paragraph. Update the cross-reference "section 4" to "section 5" since it slid down.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: '<h2>Section 3</h2><p>S3 body.</p>\n<h2>Section 4</h2>', replace: '<h2>Section 3</h2><p>S3 body.</p>\n<h2>Inserted</h2><p>Inserted body.</p>\n<h2>Section 4</h2>' },
        { find: 'As discussed in section 4 above', replace: 'As discussed in section 5 above' },
      ] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('h2').length === 5, label: '5 sections' },
    { fn: (d) => d.body.textContent.includes('section 5 above'), label: 'cross-ref updated' },
    { fn: (d) => !d.body.textContent.includes('section 4 above'), label: 'old cross-ref gone' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const r1 = regionOfLiteral(fixture, '<h2>Section 3</h2><p>S3 body.</p>\n<h2>Section 4</h2>');
    const r2 = regionOfLiteral(fixture, 'As discussed in section 4 above');
    if (!r1 || !r2) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [r1, r2]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
