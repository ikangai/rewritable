// CONT-01 — prose says "Five reasons" followed by a 5-item list. User asks
// to add a sixth item; prose updates to "Six reasons" alongside the list.
// This catches the common partial-success failure mode where the model
// adds the list item but forgets the prose count.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const NEW_LI = '<li>Reason six: virtualized cloud time</li>';

export default {
  id: 'CONT-01',
  category: 'CONT',
  tag: 'mixed',
  description: 'add 6th list item AND update "Five reasons" → "Six reasons" coupling',
  weight: 1,
  N: 3,
  fixture: 'article-medium/clean-rich',
  prompt: 'Add a sixth list item: "Reason six: virtualized cloud time". Also update the prose count from "Five reasons" to "Six reasons" so the prose matches the list.',

  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: {
        version: 'rwa-edit/1',
        edits: [
          { find: 'Five reasons', replace: 'Six reasons' },
          {
            find: '<li>Reason five: containers without RTC</li>\n',
            replace: '<li>Reason five: containers without RTC</li>\n' + NEW_LI + '\n',
          },
        ],
      },
    },
  ]),

  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('ul li').length === 6, label: '6 list items' },
    { fn: (d) => d.body.textContent.includes('Six reasons') && !d.body.textContent.includes('Five reasons'), label: 'prose count updated to Six' },
    { fn: (d) => d.body.textContent.includes('virtualized cloud time'), label: 'new li text present' },
  ]),

  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const r1 = regionOfLiteral(fixture, 'Five reasons');
    const r2 = regionOfLiteral(fixture, '<li>Reason five: containers without RTC</li>\n');
    if (!r1 || !r2) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [r1, r2]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
