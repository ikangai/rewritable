// IRREG-02 — sort a list of meetings by date, ascending. The sort key lives
// in data-date attributes; correct ordering requires reading all items,
// sorting, and emitting a reordered list. No DSL primitive expresses "sort";
// the supervisor must self-execute or compute the order out-of-band.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const ITEMS_UNSORTED = `<li data-date="2026-06-15">Q3 planning kickoff (Jun 15)</li>
<li data-date="2026-05-20">Roadmap review (May 20)</li>
<li data-date="2026-08-03">Annual offsite (Aug 3)</li>
<li data-date="2026-05-10">Sprint retro (May 10)</li>
<li data-date="2026-07-12">Hiring sync (Jul 12)</li>`;

const ITEMS_SORTED = `<li data-date="2026-05-10">Sprint retro (May 10)</li>
<li data-date="2026-05-20">Roadmap review (May 20)</li>
<li data-date="2026-06-15">Q3 planning kickoff (Jun 15)</li>
<li data-date="2026-07-12">Hiring sync (Jul 12)</li>
<li data-date="2026-08-03">Annual offsite (Aug 3)</li>`;

const FIXTURE = `<article>
<h1>Upcoming meetings</h1>
<ul id="meetings">
${ITEMS_UNSORTED}
</ul>
</article>`;

export default {
  id: 'IRREG-02',
  category: 'IRREG',
  tag: 'structural_irregular',
  description: 'sort meeting list by data-date ascending; item bodies preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Sort the meetings list by date, ascending (earliest first). Use the data-date attribute as the sort key. Each <li> element moves as a whole — preserve every attribute and the body text byte-identical. The expected order: 2026-05-10, 2026-05-20, 2026-06-15, 2026-07-12, 2026-08-03.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [{ find: ITEMS_UNSORTED, replace: ITEMS_SORTED }],
    } },
  ]),
  success: async (doc) => runSelectorOracle(doc, [
    { fn: (d) => {
        const items = [...d.querySelectorAll('#meetings li')];
        const dates = items.map(li => li.getAttribute('data-date'));
        const sorted = [...dates].sort();
        return JSON.stringify(dates) === JSON.stringify(sorted);
      }, label: 'list sorted ascending by data-date' },
    { fn: (d) => d.querySelectorAll('#meetings li').length === 5, label: 'still 5 items' },
    { fn: (d) => {
        const items = [...d.querySelectorAll('#meetings li')];
        return items.every(li => li.textContent.match(/\(\w{3} \d+\)/));
      }, label: 'every item has its (Mon DD) suffix preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, ITEMS_UNSORTED);
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
