// INTL-05 — locale-formatted numbers: German doc with "1.000,00 €" in
// three places; user changes one to "2.000,00 €"; prose explanation
// referring to "one thousand euros" updates consistently.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article lang="de">
<p>Der Betrag ist <span class="amt">1.000,00 €</span>, also ein tausend Euros.</p>
<p>Die Tabelle zeigt: <span class="amt">1.000,00 €</span> als Standard.</p>
<p>Beim Kassieren: <span class="amt">1.000,00 €</span> bestätigen.</p>
</article>`;

export default {
  id: 'INTL-05',
  category: 'INTL',
  tag: 'content',
  description: 'change first amount + matching prose count consistently',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Change the FIRST "1.000,00 €" to "2.000,00 €" and update the matching prose from "ein tausend" to "zwei tausend". Don\'t touch the other two amounts.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [{
        find: 'Der Betrag ist <span class="amt">1.000,00 €</span>, also ein tausend Euros.',
        replace: 'Der Betrag ist <span class="amt">2.000,00 €</span>, also zwei tausend Euros.',
      }] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => Array.from(d.querySelectorAll('span.amt')).filter(s => s.textContent === '2.000,00 €').length === 1, label: 'one amount changed to 2.000' },
    { fn: (d) => Array.from(d.querySelectorAll('span.amt')).filter(s => s.textContent === '1.000,00 €').length === 2, label: 'two amounts unchanged at 1.000' },
    { fn: (d) => d.body.textContent.includes('zwei tausend'), label: 'prose count consistent' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'Der Betrag ist <span class="amt">1.000,00 €</span>, also ein tausend Euros.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
