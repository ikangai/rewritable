// CONT-04 — dual-unit text "weight: 2.4 kg (5.3 lbs)"; user edits kg
// value; lbs value updates consistently.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article><p class="weight">weight: 2.4 kg (5.3 lbs)</p></article>`;

export default {
  id: 'CONT-04',
  category: 'CONT',
  tag: 'content',
  description: 'edit kg to 5.0; lbs updates to 11.0 (2.205 lb/kg)',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Update the weight to 5.0 kg. Recompute the lbs value (2.205 lb per kg, so 5.0 kg = 11.0 lbs).',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'weight: 2.4 kg (5.3 lbs)', replace: 'weight: 5.0 kg (11.0 lbs)' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p.weight', textContains: '5.0 kg', label: 'kg updated' },
    { selector: 'p.weight', textContains: '11.0 lbs', label: 'lbs updated consistently' },
    { fn: (d) => {
      const t = d.querySelector('p.weight')?.textContent || '';
      const m = t.match(/([\d.]+)\s*kg\s*\(([\d.]+)\s*lbs\)/);
      if (!m) return false;
      const kg = Number(m[1]); const lbs = Number(m[2]);
      return Math.abs(lbs - kg * 2.205) / lbs < 0.05;
    }, label: 'kg/lbs ratio within 5%' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'weight: 2.4 kg (5.3 lbs)');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
