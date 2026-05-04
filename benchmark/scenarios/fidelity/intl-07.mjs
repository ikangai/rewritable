// INTL-07 — translate English doc to Japanese via apply_edits per text node;
// HTML structure byte-identical (BULK-01 shape with non-Latin target).
// lang="en" → lang="ja" if present.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article lang="en">
<h1 class="title">Greetings</h1>
<p class="lead">Hello, world.</p>
<p>This is a small test document.</p>
</article>`;

export default {
  id: 'INTL-07',
  category: 'INTL',
  description: 'translate to Japanese via apply_edits; structure preserved; lang attribute updated',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Translate to Japanese. Use apply_edits per text node, NOT replace_document. Update lang="en" to lang="ja".',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: 'lang="en"', replace: 'lang="ja"' },
        { find: 'Greetings', replace: 'ご挨拶' },
        { find: 'Hello, world.', replace: 'こんにちは、世界。' },
        { find: 'This is a small test document.', replace: 'これは小さなテスト文書です。' },
      ] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'article[lang="ja"]', label: 'lang updated to ja' },
    { selector: 'h1.title', textEquals: 'ご挨拶', label: 'h1 translated' },
    { selector: 'p.lead', textEquals: 'こんにちは、世界。', label: 'lead translated' },
    { fn: (d) => !d.body.textContent.includes('Hello, world.'), label: 'no English residue' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const regions = [
      regionOfLiteral(fixture, 'lang="en"'),
      regionOfLiteral(fixture, 'Greetings'),
      regionOfLiteral(fixture, 'Hello, world.'),
      regionOfLiteral(fixture, 'This is a small test document.'),
    ].filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
