// INTL-02 — Hebrew doc mixing prose and embedded English brand names;
// edit a sentence; English fragments preserved byte-identical, Hebrew
// word boundaries respected.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article dir="rtl" lang="he">
<p>EDIT_HE כתוב כאן עם שם המותג <span dir="ltr">Acme Corp</span> ועוד טקסט.</p>
<p>פסקה שנייה ללא עריכה.</p>
</article>`;

export default {
  id: 'INTL-02',
  category: 'INTL',
  tag: 'content',
  description: 'edit Hebrew sentence; English brand "Acme Corp" preserved; second paragraph byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the first Hebrew sentence. Keep the embedded "Acme Corp" English brand intact and the second paragraph unchanged.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_HE כתוב כאן עם שם המותג <span dir="ltr">Acme Corp</span> ועוד טקסט.', replace: 'משפט מעודכן עם <span dir="ltr">Acme Corp</span>.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'span[dir="ltr"]', textEquals: 'Acme Corp', label: 'English brand preserved' },
    { fn: (d) => d.body.textContent.includes('פסקה שנייה ללא עריכה.'), label: 'second paragraph unchanged' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_HE כתוב כאן עם שם המותג <span dir="ltr">Acme Corp</span> ועוד טקסט.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
