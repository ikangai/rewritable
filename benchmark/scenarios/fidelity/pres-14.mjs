// PRES-14 — surgical CSS declaration swap inside @page. Only the `size`
// property changes (A4 → Letter); margin, body, and the rest of the
// stylesheet are byte-identical. Models that rewrite the whole @page block
// when asked to "change the page size" lose unrelated declarations.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page {
  size: A4 portrait;
  margin: 24mm 18mm 28mm 18mm;
  @top-left { content: "Internal — Confidential"; font-family: var(--font-ui); font-size: 9pt; color: #666; }
  @bottom-right { content: counter(page) " / " counter(pages); font-family: var(--font-mono); font-size: 9pt; color: #666; }
}
@page :first { margin-top: 48mm; }
body { font-family: var(--font-ui); }
</style>
<article>
<h1>Confidential brief</h1>
<p>Body content that is incidental to the page-size swap.</p>
</article>`;

export default {
  id: 'PRES-14',
  category: 'PRES',
  tag: 'content',
  description: 'change @page size A4 → Letter; margin + margin-box + @page :first all byte-identical',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Switch the paper size from "A4 portrait" to "Letter portrait" inside the @page rule. Do not touch the margins, the @top-left / @bottom-right margin-box content, the @page :first override, or the body font-family.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'size: A4 portrait;', replace: 'size: Letter portrait;' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('size: Letter portrait'), label: 'page size updated' },
    { fn: (d) => !d.querySelector('style')?.textContent.includes('size: A4'), label: 'old A4 declaration gone' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('margin: 24mm 18mm 28mm 18mm'), label: 'margin shorthand preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-left { content: "Internal — Confidential"'), label: '@top-left margin-box preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@bottom-right { content: counter(page) " / " counter(pages)'), label: '@bottom-right counter preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page :first { margin-top: 48mm; }'), label: '@page :first override preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('body { font-family: var(--font-ui); }'), label: 'body rule preserved' },
    { fn: (d) => d.querySelector('article h1')?.textContent === 'Confidential brief', label: 'article body unchanged' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'size: A4 portrait;');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
