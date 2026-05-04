// PRES-04 — inline formatting (bold, italic, links) inside an edited
// paragraph. The model edits the paragraph's prose without dropping
// <strong>, <em>, or <a> elements that should remain.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const NEW_P3 = 'This third paragraph has <strong>bold word</strong> in the middle and an <em>italic phrase</em> further along. Tightened: edits must preserve those inline elements.';

export default {
  id: 'PRES-04',
  category: 'PRES',
  description: 'paragraph edit preserves inline <strong>/<em> elements',
  weight: 1,
  N: 3,
  fixture: 'article-medium/clean-rich',
  prompt: 'Tighten the prose of the third paragraph. Keep the <strong>bold word</strong> and <em>italic phrase</em> inline elements exactly where they are. Change nothing outside this paragraph.',

  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: {
        version: 'rwa-edit/1',
        edits: [{
          find: 'This third paragraph has <strong>bold word</strong> in the middle and an <em>italic phrase</em> further along. Edits to this paragraph must preserve those inline elements.',
          replace: NEW_P3,
        }],
      },
    },
  ]),

  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('p > strong').length >= 1, label: 'strong present' },
    { fn: (d) => d.querySelectorAll('p > em').length >= 1, label: 'em present' },
    { fn: (d) => Array.from(d.querySelectorAll('p strong')).some(s => s.textContent === 'bold word'), label: 'strong text intact' },
    { fn: (d) => Array.from(d.querySelectorAll('p em')).some(e => e.textContent === 'italic phrase'), label: 'em text intact' },
  ]),

  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'This third paragraph has');
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    // Stretch to closing </p>.
    const closeIdx = fixture.indexOf('</p>', region[0]);
    const expanded = closeIdx > 0 ? [region[0], closeIdx + '</p>'.length] : region;
    const d = computeDriftFromEdits(fixture, envelope.edits, [expanded]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
