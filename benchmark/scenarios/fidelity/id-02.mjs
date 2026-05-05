// ID-02 — aria-labelledby reference still resolves after the heading
// text is changed (heading element's id unchanged).

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<h2 id="heading-3">HEADING_TEXT Original title</h2>
<section aria-labelledby="heading-3"><p>Section content.</p></section>
</article>`;

export default {
  id: 'ID-02',
  category: 'ID',
  tag: 'content',
  description: 'rename heading; aria-labelledby reference still resolves',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Change the heading text to "Updated title". Keep id="heading-3" intact.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'HEADING_TEXT Original title', replace: 'Updated title' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: '#heading-3', textEquals: 'Updated title', label: 'heading retitled with id' },
    { selector: 'section[aria-labelledby="heading-3"]', label: 'aria-labelledby reference unchanged' },
    { fn: (d) => !!d.querySelector('#' + d.querySelector('section[aria-labelledby]')?.getAttribute('aria-labelledby')), label: 'aria reference resolves' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'HEADING_TEXT Original title');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
