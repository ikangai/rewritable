// MPAGE-01 — named pages: @page :first (cover) vs @page (body). Different
// margins and different margin-boxes per page type. Edit a body paragraph;
// BOTH @page rules (and all their nested margin-boxes) stay byte-identical.
// A model that "consolidates" the two @page rules into one loses the cover
// page; this scenario catches that.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page {
  size: A4;
  margin: 22mm 18mm;
  @top-center { content: "Annual Report 2026"; font-size: 9pt; }
  @bottom-center { content: counter(page); font-size: 9pt; }
}
@page :first {
  margin: 0;
  @top-center { content: none; }
  @bottom-center { content: none; }
}
.cover { page: auto; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; color: white; }
</style>
<section class="cover">
<h1>Annual Report 2026</h1>
</section>
<article>
<h1>Executive summary</h1>
<p>Q1_LEAD Revenue grew 18% year-over-year, driven by enterprise renewals and modest expansion in the EMEA region.</p>
<p>Operating margin held steady at 22% despite headcount additions.</p>
<h1>Outlook</h1>
<p>We expect mid-teens growth to continue through Q2 with new product introductions in late summer.</p>
</article>`;

export default {
  id: 'MPAGE-01',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit body prose; @page (body) and @page :first (cover) both byte-identical including nested margin-boxes',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'In the Executive summary, rewrite the paragraph starting with "Q1_LEAD" to read: "Revenue rose 18% year over year on strong enterprise renewals and EMEA expansion.". Leave both @page rules, the cover section, the Outlook section, and the second Executive-summary paragraph alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'Q1_LEAD Revenue grew 18% year-over-year, driven by enterprise renewals and modest expansion in the EMEA region.',
        replace: 'Revenue rose 18% year over year on strong enterprise renewals and EMEA expansion.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page {\n  size: A4;\n  margin: 22mm 18mm;'), label: 'default @page rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page :first {\n  margin: 0;'), label: '@page :first rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-center { content: "Annual Report 2026"'), label: 'body @top-center preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@bottom-center { content: counter(page)'), label: 'body @bottom-center counter preserved' },
    { fn: (d) => (d.querySelector('style')?.textContent.match(/@top-center \{ content: none/g) || []).length === 1, label: '@page :first @top-center: none preserved' },
    { fn: (d) => (d.querySelector('style')?.textContent.match(/@bottom-center \{ content: none/g) || []).length === 1, label: '@page :first @bottom-center: none preserved' },
    { fn: (d) => d.querySelector('section.cover h1')?.textContent === 'Annual Report 2026', label: 'cover heading preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article h1')).map(h => h.textContent).join('|') === 'Executive summary|Outlook', label: 'article section order preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('Revenue rose 18% year over year on strong enterprise renewals')), label: 'edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('Q1_LEAD'), label: 'anchor token removed' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.includes('Operating margin held steady at 22%')), label: 'sibling paragraph preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.includes('mid-teens growth to continue through Q2')), label: 'Outlook paragraph preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'Q1_LEAD Revenue grew 18% year-over-year, driven by enterprise renewals and modest expansion in the EMEA region.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
