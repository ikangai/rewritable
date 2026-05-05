// DEG-01 — twenty-edit sequence on a single document. Tests cumulative
// drift across a long session. Weight 3 — the most important fidelity
// claim ("drift across many edits") gets exercised here.
//
// Each edit targets a unique anchor; cumulative drift_bytes = 0 if every
// edit landed in its declared region, summed.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

function buildFixture() {
  const lines = Array.from({ length: 20 }, (_, i) => `<p data-i="${i}">SLOT_${String(i).padStart(2, '0')}: initial.</p>`);
  return `<article>${lines.join('\n')}</article>`;
}

function buildEdits() {
  return Array.from({ length: 20 }, (_, i) => ({
    find: `SLOT_${String(i).padStart(2, '0')}: initial.`,
    replace: `SLOT_${String(i).padStart(2, '0')}: edited (turn ${i + 1}/20).`,
  }));
}

export default {
  id: 'DEG-01',
  category: 'DEG',
  tag: 'drift',
  description: '20-edit sequence; cumulative drift contained within declared regions',
  weight: 3,
  N: 1,  // deterministic with stub; for real model bump to 10
  fixtureContent: buildFixture(),
  prompt: 'Apply 20 sequential edits, each updating one slot.',
  stub: () => {
    // Twenty separate single-edit envelopes (one per turn). The runtime's
    // multi-turn loop only triggers on failure; with all edits succeeding,
    // each modify() call uses turn 1. So we batch all 20 edits into one
    // envelope.
    return stubModel([
      { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: buildEdits() } },
    ]);
  },
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('p[data-i]').length === 20, label: '20 paragraphs preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('p[data-i]')).every(p => p.textContent.includes('edited (turn')), label: 'all 20 slots edited' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const regions = buildEdits().map(e => regionOfLiteral(fixture, e.find)).filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
