// FAIL-01 — find_not_unique tool_result payload contains count + hints.
//
// Multi-turn: turn 1 emits an ambiguous edit; runtime returns
// find_not_unique tool_result; turn 2 inspects the payload and emits a
// disambiguated retry. Success oracle checks the captured payload shape.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<ul>
<li>Buy bread</li>
<li>Buy bread</li>
</ul>
</article>`;

let captured = null;

export default {
  id: 'FAIL-01',
  category: 'FAIL',
  description: 'find_not_unique tool_result payload includes count and hints',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Remove a "Buy bread" item.',

  // Each test run creates fresh state; reset before stub fires.
  stub: () => {
    captured = null;
    return stubModel([
      // Turn 1: ambiguous edit
      { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: '<li>Buy bread</li>', replace: '' }] } },
      // Turn 2: inspect tool_result
      (messages) => {
        const tr = [...messages].reverse().find(m => m.role === 'tool');
        if (tr) { try { captured = JSON.parse(tr.content); } catch { captured = { _raw: tr.content }; } }
        return { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: '<li>Buy bread</li>\n<li>Buy bread</li>', replace: '<li>Buy bread</li>' }] } };
      },
    ]);
  },

  success: () => runSelectorOracle('<div></div>', [
    { fn: () => captured?.code === 'find_not_unique', label: 'tool_result code = find_not_unique' },
    { fn: () => typeof captured?.count === 'number' && captured.count >= 2, label: 'count present' },
    { fn: () => Array.isArray(captured?.hints) && captured.hints.length > 0, label: 'hints array present' },
  ]),
  stability: () => ({ drift_bytes: 0, drift_ratio: 0, score: 2, reason: 'payload-shape check; stability not applicable' }),
};
