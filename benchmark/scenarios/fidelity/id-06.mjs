// ID-06 — frozen-zone byte identity across an edit that anchors near
// (but not in) a frozen zone. Weight 2 — frozen-zone integrity is
// load-bearing.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
/* rwa:frozen:begin theme-tokens */
:root { --bg: #0e0e0f; --text: #ddd; --accent: #b8ff57; }
/* rwa:frozen:end theme-tokens */
.body { color: var(--text); }
</style>
<div class="body">
<p>NEAR_ZONE Adjacent prose paragraph that the model may edit.</p>
</div>`;

export default {
  id: 'ID-06',
  category: 'ID',
  description: 'edit near a frozen zone; zone bytes byte-identical (weight 2)',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the prose paragraph adjacent to the frozen zone. Don\'t touch the frozen zone\'s inner content.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'NEAR_ZONE Adjacent prose paragraph that the model may edit.', replace: 'Tightened adjacent prose.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('--accent: #b8ff57'), label: 'zone inner preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('rwa:frozen:begin theme-tokens'), label: 'zone marker preserved' },
    { selector: 'p', textContains: 'Tightened', label: 'edit landed' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'NEAR_ZONE Adjacent prose paragraph that the model may edit.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
