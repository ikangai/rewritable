// MPAGE-02 — alternating @page :left and @page :right with page numbers on
// opposite outside edges (book-style layout). Edit body prose; BOTH the
// :left and :right rules — and their respective margin-boxes — stay
// byte-identical. A model that collapses the two into one symmetric @page
// loses the book-style asymmetry; this scenario catches that.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page {
  size: A5;
  margin: 18mm;
}
@page :left {
  margin-left: 25mm;
  margin-right: 15mm;
  @top-left { content: counter(page); font-family: serif; font-size: 9pt; }
  @top-right { content: "Treatise on Quiet Things"; font-style: italic; font-size: 9pt; }
}
@page :right {
  margin-left: 15mm;
  margin-right: 25mm;
  @top-right { content: counter(page); font-family: serif; font-size: 9pt; }
  @top-left { content: "Chapter II — Patience"; font-style: italic; font-size: 9pt; }
}
</style>
<article>
<h1>Chapter II — Patience</h1>
<p>OPEN_PARA Patience is not the absence of motion but the willingness to remain in motion that one cannot see.</p>
<p>The gardener who waits is still gardening; the river that pools is still travelling.</p>
<p>Each of these holds the shape of work without the appearance of it.</p>
</article>`;

export default {
  id: 'MPAGE-02',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit body prose; alternating @page :left and @page :right rules (with margin-boxes) byte-identical',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the paragraph that starts with "OPEN_PARA" to read: "Patience is not the absence of motion; it is the willingness to remain in motion one cannot see.". Leave the @page rules, the chapter heading, and the other two paragraphs alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'OPEN_PARA Patience is not the absence of motion but the willingness to remain in motion that one cannot see.',
        replace: 'Patience is not the absence of motion; it is the willingness to remain in motion one cannot see.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page :left {\n  margin-left: 25mm;\n  margin-right: 15mm;'), label: '@page :left margin rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page :right {\n  margin-left: 15mm;\n  margin-right: 25mm;'), label: '@page :right margin rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-left { content: counter(page); font-family: serif; font-size: 9pt; }'), label: ':left @top-left page counter preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-right { content: "Treatise on Quiet Things"; font-style: italic; font-size: 9pt; }'), label: ':left @top-right title preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-right { content: counter(page); font-family: serif; font-size: 9pt; }'), label: ':right @top-right page counter preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@top-left { content: "Chapter II — Patience"; font-style: italic; font-size: 9pt; }'), label: ':right @top-left chapter name preserved' },
    { fn: (d) => d.querySelector('article h1')?.textContent === 'Chapter II — Patience', label: 'chapter heading preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('Patience is not the absence of motion; it is the willingness')), label: 'edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('OPEN_PARA'), label: 'anchor token removed' },
    { fn: (d) => d.querySelectorAll('article p').length === 3, label: '3 paragraphs preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.includes('The gardener who waits is still gardening')), label: 'second paragraph preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.includes('Each of these holds the shape of work')), label: 'third paragraph preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'OPEN_PARA Patience is not the absence of motion but the willingness to remain in motion that one cannot see.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
