// MPAGE-10 — CSS Paged Media bookmark properties that drive the PDF
// outline / table-of-contents in print engines like Prince and Weasyprint.
// `bookmark-level`, `bookmark-label: content()`, `bookmark-state: open`
// declared on h1/h2 with hierarchy. Edit a paragraph; ALL three bookmark
// rules at both levels stay byte-identical. These rules are unknown to
// most models — easy "tidy" target.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page { size: A4; margin: 22mm 18mm; @bottom-center { content: counter(page); font-size: 9pt; } }
h1 { bookmark-level: 1; bookmark-label: content(); bookmark-state: open; }
h2 { bookmark-level: 2; bookmark-label: content(); bookmark-state: closed; }
h3 { bookmark-level: 3; bookmark-label: content(); bookmark-state: closed; }
</style>
<article>
<h1>Operations Handbook</h1>
<h2>Incident response</h2>
<p>BODY_LEAD When a primary system degrades, the on-call engineer follows the runbook for that service while a second engineer captures a timeline in the incident channel.</p>
<h3>Severity scoring</h3>
<p>Severity is scored on customer impact, not engineering effort.</p>
<h2>Change management</h2>
<p>All production changes go through review by a second engineer before rollout.</p>
</article>`;

export default {
  id: 'MPAGE-10',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit body prose; PDF outline rules (bookmark-level/label/state at h1/h2/h3) byte-identical at all three levels',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the paragraph starting with "BODY_LEAD" to read: "When a primary system degrades, the on-call engineer works the runbook while a second engineer keeps a timeline in the incident channel.". Leave every heading, every other paragraph, and the entire stylesheet — including the bookmark rules — alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'BODY_LEAD When a primary system degrades, the on-call engineer follows the runbook for that service while a second engineer captures a timeline in the incident channel.',
        replace: 'When a primary system degrades, the on-call engineer works the runbook while a second engineer keeps a timeline in the incident channel.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('h1 { bookmark-level: 1; bookmark-label: content(); bookmark-state: open; }'), label: 'h1 bookmark rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('h2 { bookmark-level: 2; bookmark-label: content(); bookmark-state: closed; }'), label: 'h2 bookmark rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('h3 { bookmark-level: 3; bookmark-label: content(); bookmark-state: closed; }'), label: 'h3 bookmark rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@bottom-center { content: counter(page)'), label: '@bottom-center page counter preserved' },
    { fn: (d) => d.querySelector('article h1')?.textContent === 'Operations Handbook', label: 'h1 preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article h2')).map(h => h.textContent).join('|') === 'Incident response|Change management', label: 'h2 order preserved' },
    { fn: (d) => d.querySelector('article h3')?.textContent === 'Severity scoring', label: 'h3 preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('When a primary system degrades, the on-call engineer works the runbook')), label: 'edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('BODY_LEAD'), label: 'anchor token removed' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent === 'Severity is scored on customer impact, not engineering effort.'), label: 'severity paragraph preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('All production changes go through review')), label: 'change-management paragraph preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'BODY_LEAD When a primary system degrades, the on-call engineer follows the runbook for that service while a second engineer captures a timeline in the incident channel.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
