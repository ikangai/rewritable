// CONT-05 — TOC links via <a href="#sec-3">; rename section 3's heading
// text; TOC link still resolves and TOC text updates if the prompt asked.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<nav class="toc">
<ul>
<li><a href="#sec-1">Introduction</a></li>
<li><a href="#sec-3">Old Section 3</a></li>
</ul>
</nav>
<h2 id="sec-1">Introduction</h2>
<p>Intro body.</p>
<h2 id="sec-3">Old Section 3</h2>
<p>Section 3 body.</p>`;

export default {
  id: 'CONT-05',
  category: 'CONT',
  tag: 'content',
  description: 'rename section 3 heading + matching TOC entry; href unchanged',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rename section 3 heading and the matching TOC link text from "Old Section 3" to "New Section 3". Keep id="sec-3" and href="#sec-3".',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: '<a href="#sec-3">Old Section 3</a>', replace: '<a href="#sec-3">New Section 3</a>' },
        { find: '<h2 id="sec-3">Old Section 3</h2>', replace: '<h2 id="sec-3">New Section 3</h2>' },
      ] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'a[href="#sec-3"]', textContains: 'New Section 3', label: 'TOC text updated' },
    { selector: 'h2#sec-3', textContains: 'New Section 3', label: 'heading retitled with id' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const r1 = regionOfLiteral(fixture, '<a href="#sec-3">Old Section 3</a>');
    const r2 = regionOfLiteral(fixture, '<h2 id="sec-3">Old Section 3</h2>');
    if (!r1 || !r2) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [r1, r2]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
