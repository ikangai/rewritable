// PRES-06 — spacing/alignment classes (mt-4, text-center) on unedited
// elements survive an edit to edited elements.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<div class="text-center mt-4">
<h2 class="mb-2">Title</h2>
<p class="mt-2">EDIT_ANCHOR Initial paragraph.</p>
<p class="text-muted mt-2">Footnote text untouched.</p>
</div>`;

export default {
  id: 'PRES-06',
  category: 'PRES',
  tag: 'content',
  description: 'edit one paragraph; spacing classes on siblings preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the first inner paragraph. Leave .text-muted and .mt-2 classes on the footnote intact.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_ANCHOR Initial paragraph.', replace: 'Updated paragraph.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p.text-muted.mt-2', textContains: 'Footnote', label: 'sibling classes preserved' },
    { selector: 'div.text-center.mt-4', label: 'wrapper classes intact' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_ANCHOR Initial paragraph.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
