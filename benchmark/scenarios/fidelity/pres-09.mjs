// PRES-09 — add a new column to a table: thead, every tbody row, and tfoot
// must all receive the new cell consistently. A model that adds the th but
// forgets a single body row produces a malformed table; this scenario
// catches that asymmetry.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<table class="metrics">
<thead>
<tr><th>Region</th><th>Requests</th><th>p50 ms</th></tr>
</thead>
<tbody>
<tr><td>eu-west</td><td class="num">1,204,302</td><td class="num">42</td></tr>
<tr><td>us-east</td><td class="num">2,418,775</td><td class="num">38</td></tr>
<tr><td>ap-south</td><td class="num">419,008</td><td class="num">61</td></tr>
</tbody>
<tfoot>
<tr><td><strong>Total</strong></td><td class="num"><strong>4,042,085</strong></td><td class="num">—</td></tr>
</tfoot>
</table>`;

export default {
  id: 'PRES-09',
  category: 'PRES',
  tag: 'structural_regular',
  description: 'add p99 column: th + 3 tbody rows + tfoot cell all updated, column count consistent',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Add a new rightmost column "p99 ms" to the metrics table. Values per row: eu-west 180, us-east 145, ap-south 240. The tfoot Total row gets "—" in the new column. Update thead, all three tbody rows, and tfoot. Use class="num" on all body+foot cells in the new column for consistency.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: '<tr><th>Region</th><th>Requests</th><th>p50 ms</th></tr>',
        replace: '<tr><th>Region</th><th>Requests</th><th>p50 ms</th><th>p99 ms</th></tr>' },
      { find: '<tr><td>eu-west</td><td class="num">1,204,302</td><td class="num">42</td></tr>',
        replace: '<tr><td>eu-west</td><td class="num">1,204,302</td><td class="num">42</td><td class="num">180</td></tr>' },
      { find: '<tr><td>us-east</td><td class="num">2,418,775</td><td class="num">38</td></tr>',
        replace: '<tr><td>us-east</td><td class="num">2,418,775</td><td class="num">38</td><td class="num">145</td></tr>' },
      { find: '<tr><td>ap-south</td><td class="num">419,008</td><td class="num">61</td></tr>',
        replace: '<tr><td>ap-south</td><td class="num">419,008</td><td class="num">61</td><td class="num">240</td></tr>' },
      { find: '<tr><td><strong>Total</strong></td><td class="num"><strong>4,042,085</strong></td><td class="num">—</td></tr>',
        replace: '<tr><td><strong>Total</strong></td><td class="num"><strong>4,042,085</strong></td><td class="num">—</td><td class="num">—</td></tr>' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('thead th').length === 4, label: 'thead has 4 columns' },
    { fn: (d) => d.querySelector('thead tr')?.lastElementChild?.textContent === 'p99 ms', label: 'p99 ms header is rightmost' },
    { fn: (d) => Array.from(d.querySelectorAll('tbody tr')).every(tr => tr.children.length === 4), label: 'every tbody row has 4 cells' },
    { fn: (d) => Array.from(d.querySelectorAll('tfoot tr')).every(tr => tr.children.length === 4), label: 'tfoot row has 4 cells' },
    { fn: (d) => d.querySelectorAll('tbody tr').length === 3, label: 'still 3 body rows (no extras inserted)' },
    { fn: (d) => d.querySelectorAll('tfoot tr').length === 1, label: 'still 1 tfoot row' },
    { fn: (d) => {
      const p99s = Array.from(d.querySelectorAll('tbody tr')).map(tr => tr.children[3]?.textContent);
      return p99s.join(',') === '180,145,240';
    }, label: 'p99 values land in correct rows' },
    { fn: (d) => d.querySelector('tfoot tr')?.children[3]?.textContent === '—', label: 'tfoot new cell is em-dash' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const anchors = [
      '<tr><th>Region</th><th>Requests</th><th>p50 ms</th></tr>',
      '<tr><td>eu-west</td><td class="num">1,204,302</td><td class="num">42</td></tr>',
      '<tr><td>us-east</td><td class="num">2,418,775</td><td class="num">38</td></tr>',
      '<tr><td>ap-south</td><td class="num">419,008</td><td class="num">61</td></tr>',
      '<tr><td><strong>Total</strong></td><td class="num"><strong>4,042,085</strong></td><td class="num">—</td></tr>',
    ];
    const regions = anchors.map(a => regionOfLiteral(fixture, a)).filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
