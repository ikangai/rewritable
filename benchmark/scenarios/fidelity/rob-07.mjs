// ROB-07 — doc has same code in inline <code> and <pre><code>; user says
// "fix the bug in the code example"; model edits the right one.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<p>The function <code>fnBuggy()</code> has a bug.</p>
<pre><code>function fnBuggy() {
  return 1 + 1;  // BUG: should return 2 + 2
}</code></pre>
</article>`;

export default {
  id: 'ROB-07',
  category: 'ROB',
  description: 'edit <pre><code> example, not the inline <code> reference',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Fix the bug in the <pre><code> example so it returns 4. Don\'t touch the inline <code>fnBuggy()</code> reference in prose.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [{
        find: '  return 1 + 1;  // BUG: should return 2 + 2',
        replace: '  return 2 + 2;',
      }] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => (d.querySelector('pre code')?.textContent || '').includes('return 2 + 2'), label: 'pre block fixed' },
    { fn: (d) => (d.querySelector('p code')?.textContent || '') === 'fnBuggy()', label: 'inline code unchanged' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, '  return 1 + 1;  // BUG: should return 2 + 2');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
