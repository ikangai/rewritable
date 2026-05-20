// MPAGE-09 — multi-chapter doc with explicit `page-break-after: always` on
// each <section.chapter>'s closing boundary, expressed via a CSS rule on
// `section.chapter`. Edit prose deep inside one chapter; every other
// chapter, the page-break rule, and the section structure stay byte-
// identical. The "page" here is logical (CSS-driven), not enforced by a
// real paged renderer, but the invariant — page-break rules don't get
// "tidied" away — is what the runtime must protect.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page { size: A4; margin: 22mm 18mm; }
section.chapter { page-break-after: always; break-after: page; }
section.chapter:last-of-type { page-break-after: auto; break-after: auto; }
section.chapter h2 { page-break-before: avoid; break-before: avoid; margin-top: 0; }
</style>
<article>
<section class="chapter">
<h2>Chapter 1 — Background</h2>
<p>The project began in autumn 2024 with a survey of existing tooling.</p>
</section>
<section class="chapter">
<h2>Chapter 2 — Methods</h2>
<p>METHOD_LEAD We applied a two-pass coding scheme to the corpus, separating structural features from rhetorical features at the first pass and refining categories at the second.</p>
<p>Inter-coder agreement was 0.84 after the second pass.</p>
</section>
<section class="chapter">
<h2>Chapter 3 — Findings</h2>
<p>The headline finding is that structural features predict rhetorical choices more strongly than the reverse.</p>
</section>
</article>`;

export default {
  id: 'MPAGE-09',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit prose inside Chapter 2; page-break-after rule + section structure + other chapters byte-identical',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'In Chapter 2, rewrite the paragraph starting with "METHOD_LEAD" to read: "We coded the corpus in two passes — structural features first, rhetorical features second, with category refinement on the second pass.". Leave every section heading, the other paragraphs, the page-break CSS rules, and Chapters 1 and 3 alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'METHOD_LEAD We applied a two-pass coding scheme to the corpus, separating structural features from rhetorical features at the first pass and refining categories at the second.',
        replace: 'We coded the corpus in two passes — structural features first, rhetorical features second, with category refinement on the second pass.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('section.chapter { page-break-after: always; break-after: page; }'), label: 'chapter page-break-after rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('section.chapter:last-of-type { page-break-after: auto; break-after: auto; }'), label: 'last-chapter override rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('section.chapter h2 { page-break-before: avoid; break-before: avoid; margin-top: 0; }'), label: 'chapter h2 page-break-before:avoid rule preserved' },
    { fn: (d) => d.querySelectorAll('section.chapter').length === 3, label: '3 chapter sections preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('section.chapter h2')).map(h => h.textContent).join('|') === 'Chapter 1 — Background|Chapter 2 — Methods|Chapter 3 — Findings', label: 'chapter heading order preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('section.chapter p')).some(p => p.textContent.startsWith('We coded the corpus in two passes')), label: 'edit landed in Chapter 2' },
    { fn: (d) => !(d.body?.textContent || '').includes('METHOD_LEAD'), label: 'anchor token removed' },
    { fn: (d) => Array.from(d.querySelectorAll('section.chapter p')).some(p => p.textContent === 'Inter-coder agreement was 0.84 after the second pass.'), label: 'Chapter 2 second paragraph preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('section.chapter p')).some(p => p.textContent.startsWith('The project began in autumn 2024')), label: 'Chapter 1 paragraph preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('section.chapter p')).some(p => p.textContent.startsWith('The headline finding is that structural features')), label: 'Chapter 3 paragraph preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'METHOD_LEAD We applied a two-pass coding scheme to the corpus, separating structural features from rhetorical features at the first pass and refining categories at the second.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
