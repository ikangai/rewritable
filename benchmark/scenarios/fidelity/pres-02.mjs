// PRES-02 — @page margin-box headers/footers; edit body content; header/
// footer text byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page { @top-center { content: "Quarterly Report"; } @bottom-right { content: counter(page); } }
</style>
<article>
<h1>Quarterly Report</h1>
<p>BODY_ANCHOR Initial body content under the running header.</p>
</article>`;

export default {
  id: 'PRES-02',
  category: 'PRES',
  description: 'edit body content; @page margin-box header/footer text byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the body paragraph. Leave the @page margin boxes untouched.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'BODY_ANCHOR Initial body content under the running header.', replace: 'Updated body. The header/footer must not change.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-center'), label: '@top-center kept' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('Quarterly Report'), label: 'header text byte-identical' },
    { selector: 'article p', textContains: 'Updated body', label: 'edit applied' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'BODY_ANCHOR Initial body content under the running header.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
