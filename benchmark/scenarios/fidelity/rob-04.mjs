// ROB-04 — JS code in the doc uses template literals with ${variable};
// round-trip through save (which wraps the doc in a parent template
// literal); content survives.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

// Use single quotes around the source so the template-literal example is
// literal in this string.
const FIXTURE = `<article>
<p>EDIT_PROSE Initial prose.</p>
<pre><code>const greet = (n) => \\\`Hello, \${n}!\\\`;
const x = \\\`\${1 + 1}\\\`;</code></pre>
</article>`;

export default {
  id: 'ROB-04',
  category: 'ROB',
  description: 'edit prose; template-literal code survives runtime escape round-trip',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the prose paragraph. Don\'t touch the code block.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial prose.', replace: 'Tightened prose.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => (d.querySelector('pre code')?.textContent || '').includes('Hello, ${n}!'), label: 'template literal preserved' },
    { fn: (d) => (d.querySelector('pre code')?.textContent || '').includes('${1 + 1}'), label: '${expr} preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_PROSE Initial prose.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
