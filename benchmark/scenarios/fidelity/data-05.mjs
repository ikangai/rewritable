// DATA-05 — regex example with backslashes + escaped quotes; edit
// unrelated prose; regex region byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<p>UNRELATED Prose to edit.</p>
<pre id="re"><code>const re = /\\b(\\w+)\\b/g;
const greeting = "Hello, \\"world\\"";</code></pre>
</article>`;

export default {
  id: 'DATA-05',
  category: 'DATA',
  tag: 'content',
  description: 'edit unrelated prose; regex/escape region byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the prose paragraph. Leave the regex code block byte-identical.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'UNRELATED Prose to edit.', replace: 'Updated prose.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => (d.querySelector('#re')?.textContent || '').includes('/\\b(\\w+)\\b/g'), label: 'regex backslashes intact' },
    { fn: (d) => (d.querySelector('#re')?.textContent || '').includes('\\"world\\"'), label: 'escaped quotes intact' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'UNRELATED Prose to edit.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
