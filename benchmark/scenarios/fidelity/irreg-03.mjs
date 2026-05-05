// IRREG-03 — move three specific kanban cards from one column to another.
// "Move A, C, E from todo to doing." Requires identifying three independent
// targets, removing each, and inserting all three into the destination in
// order. Multi-step structural surgery the DSL doesn't compress.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const CARD_A = '<div class="card" id="card-A">Card A: write spec</div>';
const CARD_B = '<div class="card" id="card-B">Card B: review PR</div>';
const CARD_C = '<div class="card" id="card-C">Card C: update docs</div>';
const CARD_D = '<div class="card" id="card-D">Card D: deploy patch</div>';
const CARD_E = '<div class="card" id="card-E">Card E: triage bugs</div>';

const FIXTURE = `<article>
<h1>Sprint board</h1>
<div class="col" id="todo">
<h2>To do</h2>
${CARD_A}
${CARD_B}
${CARD_C}
${CARD_D}
${CARD_E}
</div>
<div class="col" id="doing">
<h2>Doing</h2>
</div>
<div class="col" id="done">
<h2>Done</h2>
</div>
</article>`;

export default {
  id: 'IRREG-03',
  category: 'IRREG',
  tag: 'structural_irregular',
  description: 'move cards A, C, E from todo to doing; B, D stay in todo',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Move cards A, C, and E from the To do column into the Doing column. Cards B and D stay in To do. Preserve their existing relative order in the destination (A before C before E).',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [
        { find: `${CARD_A}\n`, replace: '' },
        { find: `${CARD_C}\n`, replace: '' },
        { find: `${CARD_E}\n`, replace: '' },
        { find: '<h2>Doing</h2>\n</div>', replace: `<h2>Doing</h2>\n${CARD_A}\n${CARD_C}\n${CARD_E}\n</div>` },
      ],
    } },
  ]),
  success: async (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('#todo .card').length === 2, label: 'todo column has 2 cards' },
    { fn: (d) => d.querySelectorAll('#doing .card').length === 3, label: 'doing column has 3 cards' },
    { fn: (d) => d.querySelectorAll('#done .card').length === 0, label: 'done column unchanged' },
    { fn: (d) => {
        const todoIds = [...d.querySelectorAll('#todo .card')].map(c => c.id);
        return todoIds.includes('card-B') && todoIds.includes('card-D');
      }, label: 'B and D remain in todo' },
    { fn: (d) => {
        const doingIds = [...d.querySelectorAll('#doing .card')].map(c => c.id);
        return JSON.stringify(doingIds) === JSON.stringify(['card-A', 'card-C', 'card-E']);
      }, label: 'doing has A, C, E in order' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const regions = [
      regionOfLiteral(fixture, `${CARD_A}\n`),
      regionOfLiteral(fixture, `${CARD_C}\n`),
      regionOfLiteral(fixture, `${CARD_E}\n`),
      regionOfLiteral(fixture, '<h2>Doing</h2>\n</div>'),
    ].filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
