// CONT-07 — templated {{name}} placeholders rendered by a script; edit
// elsewhere preserves placeholders byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<p>Welcome, {{name}}!</p>
<p>EDIT_ME Something to rewrite.</p>
<p>Your invoice id is {{invoice_id}}.</p>
</article>`;

export default {
  id: 'CONT-07',
  category: 'CONT',
  description: 'rewrite middle paragraph; {{name}} and {{invoice_id}} placeholders preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the middle paragraph. Don\'t touch the {{name}} or {{invoice_id}} placeholders elsewhere.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_ME Something to rewrite.', replace: 'Updated middle paragraph.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.body.textContent.includes('{{name}}'), label: 'name placeholder kept' },
    { fn: (d) => d.body.textContent.includes('{{invoice_id}}'), label: 'invoice_id placeholder kept' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_ME Something to rewrite.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
