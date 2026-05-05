// BULK-01 — translate prose to French via apply_edits (NOT replace_document).
// Tests: bulk text changes don't require wholesale rewrites; HTML structure
// (tags, attributes, ids, classes) byte-identical, only text nodes changed.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article id="doc">
<h1 class="title">Spring Garden Notes</h1>
<p class="lead">The garden requires care every week.</p>
<p>Water the tomatoes early in the morning.</p>
<p>Prune the basil to encourage bushier growth.</p>
</article>`;

export default {
  id: 'BULK-01',
  category: 'BULK',
  tag: 'content',
  description: 'translate to French via apply_edits per text node; structure byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Translate all prose to French. Use apply_edits with one edit per text node — do NOT use replace_document.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: 'Spring Garden Notes', replace: 'Notes du jardin de printemps' },
        { find: 'The garden requires care every week.', replace: 'Le jardin nécessite des soins chaque semaine.' },
        { find: 'Water the tomatoes early in the morning.', replace: 'Arrosez les tomates tôt le matin.' },
        { find: 'Prune the basil to encourage bushier growth.', replace: 'Taillez le basilic pour encourager une croissance touffue.' },
      ] },
    },
  ]),
  success: async (doc, fixture) => {
    // Tool-trace check is implicit: if model emitted replace_document, the
    // hist record kind would be 'replace_document' instead of 'edit_batch'.
    // Our runner reads only edit_batch envelopes, so a successful run with
    // an envelope present already proves apply_edits was used.
    return runSelectorOracle(doc, [
      { selector: 'article#doc', label: 'article id preserved' },
      { selector: 'h1.title', label: 'h1 class preserved' },
      { selector: 'p.lead', label: 'p class preserved' },
      { fn: (d) => d.body.textContent.includes('Notes du jardin'), label: 'title translated' },
      { fn: (d) => d.body.textContent.includes('Arrosez les tomates'), label: 'body translated' },
      { fn: (d) => !d.body.textContent.includes('Spring Garden Notes'), label: 'no English title' },
    ]);
  },
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const regions = [
      regionOfLiteral(fixture, 'Spring Garden Notes'),
      regionOfLiteral(fixture, 'The garden requires care every week.'),
      regionOfLiteral(fixture, 'Water the tomatoes early in the morning.'),
      regionOfLiteral(fixture, 'Prune the basil to encourage bushier growth.'),
    ].filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
