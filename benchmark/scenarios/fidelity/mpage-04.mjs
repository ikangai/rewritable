// MPAGE-04 — same string-set fixture as MPAGE-03, but the EDIT is the H1
// that drives the string. In a real paged-media renderer, changing the
// H1 would naturally change the running header (that's the whole point of
// string-set). The fidelity test here: the H1 changes; the `string-set:
// chapter content();` declaration and the @top-center `string(chapter)`
// reference both stay BYTE-IDENTICAL — the runtime invariant is the rule,
// not the rendered output.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page {
  size: B5;
  margin: 20mm;
  @top-center { content: string(chapter); font-size: 9pt; color: #555; font-style: italic; }
  @bottom-center { content: counter(page); font-size: 9pt; }
}
h1.chapter { string-set: chapter content(); page-break-before: always; }
h1.chapter:first-of-type { page-break-before: avoid; }
</style>
<article>
<h1 class="chapter">Chapter 1 — First Principles</h1>
<p>The simplest expression of a system names the variables it depends on.</p>
<h1 class="chapter">Chapter 2 — Composition</h1>
<p>Two systems compose cleanly when the output type of one is the input type of the other.</p>
</article>`;

export default {
  id: 'MPAGE-04',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit Chapter 2 heading text; string-set rule + @top-center reference byte-identical (running header derives from new content)',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the Chapter 2 heading to "Chapter 2 — Composition and Glue". Leave Chapter 1, both paragraphs, the @page rules, and the string-set rule alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: '<h1 class="chapter">Chapter 2 — Composition</h1>',
        replace: '<h1 class="chapter">Chapter 2 — Composition and Glue</h1>' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('h1.chapter { string-set: chapter content(); page-break-before: always; }'), label: 'string-set rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-center { content: string(chapter)'), label: '@top-center string() reference byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('h1.chapter:first-of-type { page-break-before: avoid; }'), label: 'first-chapter page-break-avoid preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('h1.chapter')).map(h => h.textContent).join('|') === 'Chapter 1 — First Principles|Chapter 2 — Composition and Glue', label: 'Chapter 2 renamed; Chapter 1 unchanged' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('The simplest expression of a system names')), label: 'Chapter 1 paragraph preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('Two systems compose cleanly')), label: 'Chapter 2 paragraph preserved' },
    { fn: (d) => d.querySelectorAll('h1.chapter').length === 2, label: '2 chapter headings preserved' },
    { fn: (d) => d.querySelectorAll('article p').length === 2, label: '2 paragraphs preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, '<h1 class="chapter">Chapter 2 — Composition</h1>');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
