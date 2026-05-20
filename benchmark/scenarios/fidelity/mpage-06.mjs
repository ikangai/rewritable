// MPAGE-06 — cross-references using `target-counter(attr(href), page)`.
// Generated content in `a.xref::after` injects "(see page N)" by reading
// the page counter at the link target. Edit body prose; the `::after`
// rule with its target-counter() function must remain byte-identical, AND
// the anchor IDs that the xrefs point to must remain intact.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page { size: A4; margin: 22mm 18mm; }
a.xref { color: #0a4; text-decoration: none; }
a.xref::after { content: " (see page " target-counter(attr(href), page) ")"; color: #777; font-size: 90%; }
h2[id] { scroll-margin-top: 18mm; }
</style>
<article>
<h2 id="setup">Workshop setup</h2>
<p>You will need the tools listed in the glossary.</p>
<h2 id="errors">Common errors</h2>
<p>BODY_LEAD Most failures trace back to skipping <a class="xref" href="#setup">the workshop setup steps</a> or forgetting to verify the <a class="xref" href="#glossary">glossary tooling</a> before starting.</p>
<h2 id="glossary">Glossary</h2>
<p>Terms used throughout this manual.</p>
</article>`;

export default {
  id: 'MPAGE-06',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit body prose around xrefs; `target-counter(attr(href), page)` ::after rule byte-identical; anchor ids intact',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the paragraph starting with "BODY_LEAD" to read: "Most failures trace back to skipping <a class="xref" href="#setup">the setup steps</a> or to running before checking the <a class="xref" href="#glossary">glossary tooling</a>.". Leave every other paragraph, every heading, every id, and the entire stylesheet alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'BODY_LEAD Most failures trace back to skipping <a class="xref" href="#setup">the workshop setup steps</a> or forgetting to verify the <a class="xref" href="#glossary">glossary tooling</a> before starting.',
        replace: 'Most failures trace back to skipping <a class="xref" href="#setup">the setup steps</a> or to running before checking the <a class="xref" href="#glossary">glossary tooling</a>.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('a.xref::after { content: " (see page " target-counter(attr(href), page) ")"; color: #777; font-size: 90%; }'), label: '::after target-counter rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('a.xref { color: #0a4; text-decoration: none; }'), label: 'a.xref base rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('h2[id] { scroll-margin-top: 18mm; }'), label: 'h2 scroll-margin rule preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('h2[id]')).map(h => h.id).join('|') === 'setup|errors|glossary', label: 'all three anchor ids preserved in order' },
    { fn: (d) => d.querySelectorAll('a.xref').length === 2, label: '2 xrefs in edited paragraph' },
    { fn: (d) => Array.from(d.querySelectorAll('a.xref')).map(a => a.getAttribute('href')).join('|') === '#setup|#glossary', label: 'xref hrefs unchanged' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('Most failures trace back to skipping the setup steps')), label: 'edit landed (textContent of edited paragraph)' },
    { fn: (d) => !(d.body?.textContent || '').includes('BODY_LEAD'), label: 'anchor token removed' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent === 'You will need the tools listed in the glossary.'), label: 'setup paragraph preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent === 'Terms used throughout this manual.'), label: 'glossary paragraph preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'BODY_LEAD Most failures trace back to skipping <a class="xref" href="#setup">the workshop setup steps</a> or forgetting to verify the <a class="xref" href="#glossary">glossary tooling</a> before starting.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
