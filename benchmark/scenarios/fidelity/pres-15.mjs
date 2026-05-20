// PRES-15 — multi-section article with running header (@page margin-box)
// AND semantic <footer>. Edit deep prose in section 2 only. The running
// header text, the @page rule, h1 page-break behavior, AND the semantic
// footer with its links must all be byte-identical. This is the
// "real-world report" scenario: many invariants stacked, edit threads
// through them without disturbance.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page {
  size: A4;
  margin: 22mm 18mm;
  @top-center { content: "Quarterly Operations Report — Q1 2026"; font-size: 9pt; color: #444; }
  @bottom-center { content: "Page " counter(page); font-size: 9pt; color: #444; }
}
@media print {
  h1 { page-break-before: always; break-before: page; }
  table, figure { break-inside: avoid; }
}
</style>
<header class="report-masthead">
<p class="classification">Internal — Distribute to operations leads only</p>
<h1 class="title">Quarterly Operations Report</h1>
<p class="period">Reporting period: 1 Jan 2026 – 31 Mar 2026</p>
</header>
<article>
<h1>Executive summary</h1>
<p>The headline metrics improved across the board this quarter.</p>
<h1>Section 2 — Incident response</h1>
<p>S2_LEAD The mean time to detect dropped from 14 minutes in Q4 to 9 minutes this quarter, driven by the rollout of the new alerting rules.</p>
<p>A follow-up paragraph that should remain untouched by the edit.</p>
<h1>Section 3 — Cost</h1>
<p>Costs grew 4% in line with headcount.</p>
</article>
<footer class="report-footer">
<p class="contact">Prepared by the Operations team · ops@example.org</p>
<nav class="report-actions"><a href="/report/q1-2026.pdf">Download PDF</a> · <a href="/report/q1-2026.csv">Raw data (CSV)</a></nav>
</footer>`;

export default {
  id: 'PRES-15',
  category: 'PRES',
  tag: 'content',
  description: 'edit deep section-2 prose only; @page header, @media print rules, masthead, and semantic footer byte-identical',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'In Section 2 of the article, rewrite only the paragraph that starts with "S2_LEAD" so it reads: "Mean time to detect fell from 14 minutes in Q4 to 9 minutes — a 36% improvement attributable to the new alerting rules.". Leave the @page margin-box header/footer, the @media print rules, the report masthead, the second paragraph of Section 2, all other sections, and the semantic <footer> alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'S2_LEAD The mean time to detect dropped from 14 minutes in Q4 to 9 minutes this quarter, driven by the rollout of the new alerting rules.',
        replace: 'Mean time to detect fell from 14 minutes in Q4 to 9 minutes — a 36% improvement attributable to the new alerting rules.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-center { content: "Quarterly Operations Report — Q1 2026"'), label: '@top-center header text preserved verbatim' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@bottom-center { content: "Page " counter(page)'), label: '@bottom-center page counter preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@media print'), label: '@media print block present' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('page-break-before: always'), label: 'h1 page-break rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('break-inside: avoid'), label: 'table/figure break-inside rule preserved' },
    { fn: (d) => d.querySelector('header.report-masthead .classification')?.textContent === 'Internal — Distribute to operations leads only', label: 'masthead classification preserved' },
    { fn: (d) => d.querySelector('header.report-masthead .period')?.textContent === 'Reporting period: 1 Jan 2026 – 31 Mar 2026', label: 'masthead period preserved' },
    { fn: (d) => d.querySelectorAll('article h1').length === 3, label: 'article still has 3 H1 section headings' },
    { fn: (d) => Array.from(d.querySelectorAll('article h1')).map(h => h.textContent).join('|') === 'Executive summary|Section 2 — Incident response|Section 3 — Cost', label: 'section order preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('Mean time to detect fell from 14 minutes')), label: 'edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('S2_LEAD'), label: 'anchor token removed' },
    { fn: (d) => d.querySelector('footer.report-footer .contact')?.textContent === 'Prepared by the Operations team · ops@example.org', label: 'semantic footer contact preserved' },
    { fn: (d) => d.querySelectorAll('footer.report-footer .report-actions a').length === 2, label: 'footer action links preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'S2_LEAD The mean time to detect dropped from 14 minutes in Q4 to 9 minutes this quarter, driven by the rollout of the new alerting rules.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
