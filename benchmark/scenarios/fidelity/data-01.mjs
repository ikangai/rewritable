// DATA-01 — <script type="application/json"> with tabular data; user asks
// "add a row for Q4"; JSON parses, has new row, schema unchanged.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<script type="application/json" id="quarters">{"rows":[{"q":"Q1","v":100},{"q":"Q2","v":200},{"q":"Q3","v":150}]}</script>
<div id="rendered"></div>`;

export default {
  id: 'DATA-01',
  category: 'DATA',
  tag: 'structural_regular',
  description: 'add Q4 row to embedded JSON; schema preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Add a Q4 row with value 250 to the JSON in #quarters. Keep the rest unchanged.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{
      find: '{"q":"Q3","v":150}]}',
      replace: '{"q":"Q3","v":150},{"q":"Q4","v":250}]}',
    }] } },
  ]),
  expectedDslPlan: {
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'insert', after: '{"q":"Q3","v":150}', content: ',{"q":"Q4","v":250}' }],
  },
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => {
      const txt = d.querySelector('#quarters')?.textContent;
      try {
        const j = JSON.parse(txt);
        return j.rows?.length === 4 && j.rows[3].q === 'Q4' && j.rows[3].v === 250;
      } catch { return false; }
    }, label: 'JSON parses with Q4 row' },
    { fn: (d) => {
      const txt = d.querySelector('#quarters')?.textContent;
      try {
        const j = JSON.parse(txt);
        return j.rows.every(r => 'q' in r && 'v' in r);
      } catch { return false; }
    }, label: 'schema preserved (q+v keys on every row)' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, '{"q":"Q3","v":150}]}');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
