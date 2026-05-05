// FID-01 — single-character edit (typo fix). Fixture has "thier"; the
// edit changes it to "their". Surrounding doc must be byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDrift, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

export default {
  id: 'FID-01',
  category: 'FID',
  tag: 'content',
  description: 'single-character typo fix — surrounding doc byte-identical',
  weight: 2,
  N: 3,
  fixture: 'article-medium/clean',
  prompt: 'Fix the typo "thier" → "their" in the second paragraph. Change nothing else.',

  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'thier', replace: 'their' }] } },
  ]),

  // v0.x baseline: wholesale rewrite that fixes the typo but reflows the
  // surrounding prose — the realistic v0.x failure mode where stability
  // collapses while success stays equivalent.
  baselineDoc: `<article>
<h1>How distributed systems handle partial failure</h1>
<p>The first paragraph establishes context. When a system spans many machines, any component can fail at any time, and the surrounding code must respond predictably.</p>
<p>The second paragraph: it now says "their" instead of the typo. A complete rewrite changes the prose around the fix as well.</p>
<p>The third paragraph closes the section with a summary. Distributed systems force engineers to reason about partial state, retries, and idempotence — none of which single-machine programs face.</p>
<h2>Strategies for failure handling</h2>
<table>
<thead><tr><th>Strategy</th><th>Failure mode</th><th>Recovery time</th></tr></thead>
<tbody>
<tr><td>Bulkhead</td><td>Resource exhaustion</td><td>Seconds</td></tr>
<tr><td>Circuit breaker</td><td>Cascading timeout</td><td>Milliseconds</td></tr>
<tr><td>Retry with jitter</td><td>Transient network</td><td>Variable</td></tr>
</tbody>
</table>
<h2>Implementation example</h2>
<pre><code class="language-python">def call_with_breaker(target, *args):
    if breaker.is_open():
        raise CircuitOpen()
    try:
        return target(*args)
    except TransientError as e:
        breaker.record_failure(e)
        raise</code></pre>
<details>
<summary>Why this matters in practice</summary>
<p>Real systems aggregate these patterns. A web service might wrap a downstream call in a circuit breaker, sit it inside a bulkhead with a bounded thread pool, and add retry-with-jitter on the calling side.</p>
</details>
<p class="callout">A subscribe form is included to test form-state preservation under unrelated edits.</p>
<form><label for="email-sub">Email</label><input id="email-sub" type="email" name="email"></form>
</article>`,

  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p:nth-of-type(2)', textContains: 'their', label: 'their is present in 2nd p' },
    { fn: (d) => !((d.querySelector('p:nth-of-type(2)')?.textContent || '').includes('thier')), label: 'thier removed' },
  ]),

  stability: (fixture, doc) => {
    const region = regionOfLiteral(fixture, 'thier');
    const d = computeDrift(fixture, doc, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
