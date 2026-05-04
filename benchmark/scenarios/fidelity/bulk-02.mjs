// BULK-02 — translate prose to French via apply_edits; <pre><code> blocks
// remain English/code, only prose translated.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<p class="prose">Hello, world. This is a tutorial.</p>
<pre><code class="lang-py">def hello():
    print("Hello, world")</code></pre>
<p class="prose">Run the code above to see output.</p>
</article>`;

export default {
  id: 'BULK-02',
  category: 'BULK',
  description: 'translate prose to French; <pre><code> Python remains English byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Translate prose paragraphs to French. Don\'t touch the <pre><code> Python block.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: 'Hello, world. This is a tutorial.', replace: 'Bonjour, monde. Ceci est un tutoriel.' },
        { find: 'Run the code above to see output.', replace: 'Exécutez le code ci-dessus pour voir le résultat.' },
      ] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.body.textContent.includes('Bonjour, monde'), label: 'first prose translated' },
    { fn: (d) => d.body.textContent.includes('Exécutez le code'), label: 'second prose translated' },
    { fn: (d) => (d.querySelector('pre code')?.textContent || '').includes('print("Hello, world")'), label: 'code byte-identical' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const regions = [
      regionOfLiteral(fixture, 'Hello, world. This is a tutorial.'),
      regionOfLiteral(fixture, 'Run the code above to see output.'),
    ].filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
