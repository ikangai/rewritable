// GENRE-04 — letter (wedding invitation) — recipient name in 3 places
// (envelope, salutation, sign-off); user changes one; model surfaces
// inconsistency or propagates to all three.
//
// We test the "propagate" path here. The "surface inconsistency" path is
// difficult to score mechanically — the spec calls for testing both
// phrasings as separate runs; this is the easier one.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article class="invitation">
<address class="envelope">For: <span class="name">Riya Kapoor</span></address>
<p class="salutation">Dear <span class="name">Riya Kapoor</span>,</p>
<p class="signoff">We hope to see you, <span class="name">Riya Kapoor</span>, at our celebration.</p>
</article>`;

export default {
  id: 'GENRE-04',
  category: 'GENRE',
  description: 'change recipient name in all three places consistently',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Update the recipient name from "Riya Kapoor" to "Priya Sharma" in all three places (envelope, salutation, sign-off).',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: 'For: <span class="name">Riya Kapoor</span>', replace: 'For: <span class="name">Priya Sharma</span>' },
        { find: 'Dear <span class="name">Riya Kapoor</span>,', replace: 'Dear <span class="name">Priya Sharma</span>,' },
        { find: 'We hope to see you, <span class="name">Riya Kapoor</span>,', replace: 'We hope to see you, <span class="name">Priya Sharma</span>,' },
      ] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => Array.from(d.querySelectorAll('span.name')).every(s => s.textContent === 'Priya Sharma'), label: 'all three names updated' },
    { fn: (d) => !d.body.textContent.includes('Riya Kapoor'), label: 'no leftover old name' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const regions = [
      regionOfLiteral(fixture, 'For: <span class="name">Riya Kapoor</span>'),
      regionOfLiteral(fixture, 'Dear <span class="name">Riya Kapoor</span>,'),
      regionOfLiteral(fixture, 'We hope to see you, <span class="name">Riya Kapoor</span>,'),
    ].filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
