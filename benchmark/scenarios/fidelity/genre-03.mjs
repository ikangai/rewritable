// GENRE-03 — slide deck; user edits one slide's content; other slides
// unchanged; slide counter "4 of 12" still reads correctly.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

function buildFixture() {
  const slides = [];
  for (let i = 1; i <= 12; i++) {
    const body = i === 4 ? 'EDIT_SLIDE_4 Slide 4 body to update.' : `Slide ${i} content.`;
    slides.push(`<section class="slide" data-slide="${i}"><h2>Slide ${i}</h2><p>${body}</p></section>`);
  }
  return `<div class="deck">
${slides.join('\n')}
<footer class="counter">1 of 12</footer>
</div>`;
}

export default {
  id: 'GENRE-03',
  category: 'GENRE',
  tag: 'content',
  description: 'edit slide 4 content; other 11 slides + counter byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: buildFixture(),
  prompt: 'Update slide 4\'s body content to "Updated slide 4". Don\'t touch other slides or the counter.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_SLIDE_4 Slide 4 body to update.', replace: 'Updated slide 4.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('.slide').length === 12, label: '12 slides preserved' },
    { selector: '.slide[data-slide="4"] p', textEquals: 'Updated slide 4.', label: 'slide 4 edited' },
    { selector: '.counter', textEquals: '1 of 12', label: 'counter byte-identical' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_SLIDE_4 Slide 4 body to update.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
