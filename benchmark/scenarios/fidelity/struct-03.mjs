// STRUCT-03 — nested DSL: insert a new row + set_attr on the new row's
// first cell. Tests an ordered chain of two DSL ops where the second
// operates on output of the first. The stub does both as one apply_edits
// (the runtime sees a composite envelope, the DSL would see two ops).

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const HEADER = '<tr><th>Strategy</th><th>Failure mode</th><th>Cost</th></tr>';
const ROW_BULKHEAD = '<tr><td>Bulkhead</td><td>Failure isolation</td><td>Low</td></tr>';
const ROW_CIRCUIT = '<tr><td>Circuit breaker</td><td>Cascading failure</td><td>Medium</td></tr>';

const NEW_ROW = '<tr><td class="highlight">Backpressure</td><td>Buffer overflow</td><td>Variable</td></tr>';

const FIXTURE = `<article>
<h1>Strategy table</h1>
<table id="strategies">
${HEADER}
${ROW_BULKHEAD}
${ROW_CIRCUIT}
</table>
</article>`;

export default {
  id: 'STRUCT-03',
  category: 'STRUCT',
  tag: 'structural_regular',
  description: 'insert new row after Bulkhead AND set class="highlight" on its first cell (chained DSL)',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Insert a new row after the Bulkhead row with cells "Backpressure / Buffer overflow / Variable". The new row\'s first cell should have class="highlight" to mark it as recently added. The Circuit breaker row stays unchanged.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [{
        find: ROW_BULKHEAD,
        replace: `${ROW_BULKHEAD}\n${NEW_ROW}`,
      }],
    } },
  ]),
  expectedDslPlan: {
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'insert', after: ROW_BULKHEAD, content: `\n${NEW_ROW}` }],
  },
  success: async (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('#strategies tr').length === 4, label: 'table has 4 rows (header + 3 data)' },
    { fn: (d) => d.querySelectorAll('#strategies td.highlight').length === 1, label: 'exactly one highlighted cell' },
    { fn: (d) => d.querySelector('#strategies td.highlight')?.textContent === 'Backpressure', label: 'highlight cell text is Backpressure' },
    { fn: (d) => {
        const rows = [...d.querySelectorAll('#strategies tr')];
        return rows[1]?.textContent.includes('Bulkhead')
          && rows[2]?.textContent.includes('Backpressure')
          && rows[3]?.textContent.includes('Circuit breaker');
      }, label: 'row order: Bulkhead, Backpressure, Circuit breaker' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, ROW_BULKHEAD);
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
