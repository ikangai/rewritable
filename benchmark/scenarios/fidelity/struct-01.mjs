// STRUCT-01 — wrap_each: wrap every .card div in a <section>.
// Exercises the DSL `wrap` op pattern. A regular structural transform: same
// shape applied to N independent matches. The DSL would express this as
// one op with selector semantics; today the stub enumerates anchors.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const C1 = '<div class="card" id="c1">First card</div>';
const C2 = '<div class="card" id="c2">Second card</div>';
const C3 = '<div class="card" id="c3">Third card</div>';

const FIXTURE = `<article>
<h1>Cards</h1>
${C1}
${C2}
${C3}
</article>`;

export default {
  id: 'STRUCT-01',
  category: 'STRUCT',
  tag: 'structural_regular',
  description: 'wrap_each: wrap every .card in a <section>; ids and bodies preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Wrap each .card div in a <section> element. The <section> has no attributes. Preserve every card\'s id, class, and body text. Three cards exist (c1, c2, c3) — each becomes <section><div class="card" id="cN">...</div></section>.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [
        { find: C1, replace: `<section>${C1}</section>` },
        { find: C2, replace: `<section>${C2}</section>` },
        { find: C3, replace: `<section>${C3}</section>` },
      ],
    } },
  ]),
  expectedDslPlan: {
    version: 'rwa-edit-dsl/1',
    ops: [
      { op: 'replace', find: C1, replace: `<section>${C1}</section>` },
      { op: 'replace', find: C2, replace: `<section>${C2}</section>` },
      { op: 'replace', find: C3, replace: `<section>${C3}</section>` },
    ],
  },
  success: async (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('section > .card').length === 3, label: 'all 3 cards inside <section>' },
    { fn: (d) => d.querySelectorAll('article > section').length === 3, label: 'article has 3 direct <section> children' },
    { fn: (d) => d.querySelector('#c1')?.textContent === 'First card', label: 'c1 body preserved' },
    { fn: (d) => d.querySelector('#c2')?.textContent === 'Second card', label: 'c2 body preserved' },
    { fn: (d) => d.querySelector('#c3')?.textContent === 'Third card', label: 'c3 body preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const regions = [
      regionOfLiteral(fixture, C1),
      regionOfLiteral(fixture, C2),
      regionOfLiteral(fixture, C3),
    ].filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
