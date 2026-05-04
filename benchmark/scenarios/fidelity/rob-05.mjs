// ROB-05 — doc near size cap; edit slightly increases size; commit succeeds.
// Same edit pushing past cap returns target_size_exceeded cleanly. We test
// the "succeeds at high size" case here; the cap behavior is covered in
// CONFORM-13.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

// Build a doc near 90% of MAX_DOC (1 MB). Plus an edit anchor.
const PADDING = 'x'.repeat(900 * 1024);
const FIXTURE = `<article><p class="pad">${PADDING}</p><p>ANCHOR_EDIT_ROB05 Initial.</p></article>`;

export default {
  id: 'ROB-05',
  category: 'ROB',
  description: 'doc at 90% of MAX_DOC; small edit succeeds within cap',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Replace ANCHOR_EDIT_ROB05 with "Updated."',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'ANCHOR_EDIT_ROB05 Initial.', replace: 'Updated.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.body.textContent.includes('Updated.'), label: 'edit applied' },
    { fn: (d) => (d.querySelector('p.pad')?.textContent || '').length > 800 * 1024, label: 'large pad preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'ANCHOR_EDIT_ROB05 Initial.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
