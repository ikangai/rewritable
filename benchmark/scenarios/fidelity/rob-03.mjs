// ROB-03 — doc contains non-BMP unicode (emoji, mathematical symbols);
// edit nearby prose; unicode survives byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const UNICODE = '🜨 ∑ ∫ ∞ 𝕏 𝓆 𝔄';
const FIXTURE = `<article>
<h1>Notation</h1>
<p class="symbols">${UNICODE}</p>
<p class="prose">EDIT_PROSE Initial prose to edit.</p>
</article>`;

export default {
  id: 'ROB-03',
  category: 'ROB',
  description: 'non-BMP unicode survives a nearby prose edit byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Tighten the prose paragraph. Don\'t touch the symbols paragraph.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial prose to edit.', replace: 'Tightened prose.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p.symbols', textContains: UNICODE, label: 'unicode preserved' },
    { selector: 'p.prose', textContains: 'Tightened', label: 'edit landed' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_PROSE Initial prose to edit.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
