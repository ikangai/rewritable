// ID-05 — class .task-card referenced from <style> block; edit modifies
// one card's content; the class attribute and the rule both survive.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
.task-card { padding: 1rem; border: 1px solid #ccc; }
.task-card h3 { margin: 0; }
</style>
<div class="task-card"><h3>Card 1</h3><p>CARD_1_BODY First card body.</p></div>
<div class="task-card"><h3>Card 2</h3><p>Second card body.</p></div>`;

export default {
  id: 'ID-05',
  category: 'ID',
  tag: 'content',
  description: 'edit one card body; .task-card class + style rule preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the first card\'s body. Don\'t touch class names or the <style> block.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'CARD_1_BODY First card body.', replace: 'Updated card 1.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('.task-card'), label: 'CSS rule kept' },
    { fn: (d) => d.querySelectorAll('.task-card').length === 2, label: 'both cards still have class' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'CARD_1_BODY First card body.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
