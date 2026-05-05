// DATA-02 — <pre>-formatted CSV; add a row; CSV still parses, column count
// unchanged.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<pre id="csv">name,value,status
alpha,1,active
beta,2,active</pre>`;

export default {
  id: 'DATA-02',
  category: 'DATA',
  tag: 'structural_regular',
  description: 'append a CSV row; columns unchanged',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Append a row "gamma,3,inactive" to the CSV in #csv.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{
      find: 'beta,2,active</pre>',
      replace: 'beta,2,active\ngamma,3,inactive</pre>',
    }] } },
  ]),
  expectedDslPlan: {
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'insert', after: 'beta,2,active', content: '\ngamma,3,inactive' }],
  },
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => {
      const txt = d.querySelector('#csv')?.textContent || '';
      const lines = txt.trim().split('\n');
      const cols = lines.map(l => l.split(',').length);
      return lines.length === 4 && cols.every(c => c === 3);
    }, label: '4 lines all with 3 columns' },
    { fn: (d) => (d.querySelector('#csv')?.textContent || '').includes('gamma,3,inactive'), label: 'new row present' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'beta,2,active</pre>');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
