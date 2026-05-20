// MPAGE-08 — frontmatter with lower-roman page numbers, main body with
// arabic numbers, by named-page selectors. The page counter resets at the
// frontmatter/body boundary. Edit body prose; @page frontmatter, @page
// body, the counter-reset on body, and the named-page assignment via
// the `page:` property must all stay byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page frontmatter {
  size: A4;
  margin: 22mm 18mm;
  @bottom-center { content: counter(page, lower-roman); font-size: 9pt; color: #555; }
}
@page body {
  size: A4;
  margin: 22mm 18mm;
  @bottom-center { content: counter(page); font-size: 9pt; }
}
section.frontmatter { page: frontmatter; }
section.body { page: body; counter-reset: page 0; }
</style>
<section class="frontmatter">
<h1>Acknowledgements</h1>
<p>The author thanks the workshop participants for their patience and feedback.</p>
</section>
<section class="body">
<h1>Introduction</h1>
<p>INTRO_LEAD The subject of this manual is the recovery of historical land-use patterns from incomplete cadastral records.</p>
<p>Three case studies follow.</p>
</section>`;

export default {
  id: 'MPAGE-08',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit body prose; @page frontmatter (lower-roman) + @page body (arabic) + page:assignment + counter-reset byte-identical',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'In the body section, rewrite the paragraph starting with "INTRO_LEAD" to read: "This manual addresses the recovery of historical land-use patterns from fragmentary cadastral records.". Leave the frontmatter section, the body heading, the second body paragraph, and the @page rules alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'INTRO_LEAD The subject of this manual is the recovery of historical land-use patterns from incomplete cadastral records.',
        replace: 'This manual addresses the recovery of historical land-use patterns from fragmentary cadastral records.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page frontmatter {\n  size: A4;\n  margin: 22mm 18mm;\n  @bottom-center { content: counter(page, lower-roman)'), label: '@page frontmatter rule with lower-roman counter byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page body {\n  size: A4;\n  margin: 22mm 18mm;\n  @bottom-center { content: counter(page); font-size: 9pt; }'), label: '@page body rule with arabic counter byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('section.frontmatter { page: frontmatter; }'), label: 'frontmatter page-assignment preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('section.body { page: body; counter-reset: page 0; }'), label: 'body page-assignment + counter-reset preserved' },
    { fn: (d) => d.querySelector('section.frontmatter h1')?.textContent === 'Acknowledgements', label: 'frontmatter heading preserved' },
    { fn: (d) => d.querySelector('section.frontmatter p')?.textContent === 'The author thanks the workshop participants for their patience and feedback.', label: 'frontmatter paragraph preserved' },
    { fn: (d) => d.querySelector('section.body h1')?.textContent === 'Introduction', label: 'body heading preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('section.body p')).some(p => p.textContent.startsWith('This manual addresses the recovery')), label: 'edit landed in body' },
    { fn: (d) => !(d.body?.textContent || '').includes('INTRO_LEAD'), label: 'anchor token removed' },
    { fn: (d) => Array.from(d.querySelectorAll('section.body p')).some(p => p.textContent === 'Three case studies follow.'), label: 'second body paragraph preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'INTRO_LEAD The subject of this manual is the recovery of historical land-use patterns from incomplete cadastral records.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
