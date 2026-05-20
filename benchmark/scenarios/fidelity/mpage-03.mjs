// MPAGE-03 — running header via CSS `string-set` and `string()`. Each H1
// updates a named string (`chapter`); the @page @top-center pulls it via
// `string(chapter)`. Edit prose INSIDE a chapter (not the H1); the
// string-set declaration and the @top-center string() reference must
// remain byte-identical. Models that don't recognize `string-set` may
// "clean it up"; this catches that.

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
<p>FIRST_LEAD The simplest expression of a system is the one that names every variable it depends on and nothing else.</p>
<p>This is harder than it sounds because most variables are tacit.</p>
<h1 class="chapter">Chapter 2 — Composition</h1>
<p>Two systems compose cleanly when the output type of one is the input type of the other and neither smuggles state through a back channel.</p>
</article>`;

export default {
  id: 'MPAGE-03',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit body prose inside Chapter 1; `string-set: chapter content()` and `string(chapter)` reference byte-identical',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'In Chapter 1, rewrite the paragraph starting with "FIRST_LEAD" to read: "The clearest expression of a system names every variable it depends on, and nothing more.". Leave the chapter headings, the @page rules, the string-set rule, and all other paragraphs alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'FIRST_LEAD The simplest expression of a system is the one that names every variable it depends on and nothing else.',
        replace: 'The clearest expression of a system names every variable it depends on, and nothing more.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('h1.chapter { string-set: chapter content(); page-break-before: always; }'), label: 'string-set rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-center { content: string(chapter); font-size: 9pt; color: #555; font-style: italic; }'), label: '@top-center string() reference byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('h1.chapter:first-of-type { page-break-before: avoid; }'), label: 'first-chapter page-break-avoid preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@bottom-center { content: counter(page)'), label: '@bottom-center counter preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('h1.chapter')).map(h => h.textContent).join('|') === 'Chapter 1 — First Principles|Chapter 2 — Composition', label: 'chapter order + titles preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('The clearest expression of a system names every variable it depends on')), label: 'edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('FIRST_LEAD'), label: 'anchor token removed' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.includes('This is harder than it sounds')), label: 'sibling paragraph in Chapter 1 preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('Two systems compose cleanly')), label: 'Chapter 2 prose preserved' },
    { fn: (d) => d.querySelectorAll('article p').length === 3, label: '3 paragraphs preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'FIRST_LEAD The simplest expression of a system is the one that names every variable it depends on and nothing else.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
