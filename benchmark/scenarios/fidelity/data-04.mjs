// DATA-04 — <pre><code> with Python; user asks to translate prose to
// French; code block byte-identical (including indentation).

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const CODE_BLOCK = `<pre><code class="language-python">def hello(name):
    print(f"Hello, {name}!")
    return None</code></pre>`;

const FIXTURE = `<article>
<p id="prose">English prose to translate to French.</p>
${CODE_BLOCK}
</article>`;

export default {
  id: 'DATA-04',
  category: 'DATA',
  description: 'translate prose to French; <pre><code> Python block byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Translate the prose to French: "Texte français à traduire". Don\'t touch the Python code block — code stays English.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{
      find: 'English prose to translate to French.',
      replace: 'Texte français à traduire.',
    }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: '#prose', textContains: 'français', label: 'prose translated' },
    { fn: (d) => d.querySelector('pre code')?.textContent.includes('def hello(name):'), label: 'code block byte-identical' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'English prose to translate to French.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
