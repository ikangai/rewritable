// DATA-06 — <textarea> with default content containing HTML-looking text
// "<not a real tag>"; edit unrelated prose; textarea content byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<p>EDIT_PROSE Outside the form.</p>
<form>
<textarea name="hint">&lt;not a real tag&gt; placeholder</textarea>
</form>
</article>`;

export default {
  id: 'DATA-06',
  category: 'DATA',
  tag: 'content',
  description: 'edit prose; <textarea> default content byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the prose paragraph. Don\'t touch the textarea default content.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Outside the form.', replace: 'Tightened prose.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('textarea')?.textContent.includes('<not a real tag>'), label: 'textarea default preserved (escapes decoded)' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_PROSE Outside the form.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
