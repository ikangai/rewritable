// MPAGE-05 — table of contents with manual page numbers in a <nav>/<ol>
// structure. Edit ONE TOC entry's title; the page number on that entry
// stays byte-identical; every OTHER entry's title AND page number both
// byte-identical. This is the "edit a TOC label without touching the page
// numbers" case — a model that "tidies" the dotted leaders or rebalances
// the table fails here.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page { size: A4; margin: 22mm 18mm; @top-center { content: "Field Manual"; font-size: 9pt; } }
nav.toc ol { list-style: none; padding: 0; }
nav.toc li { display: flex; align-items: baseline; }
nav.toc .title { flex: 0 1 auto; }
nav.toc .dots { flex: 1 1 auto; border-bottom: 1px dotted #999; margin: 0 6px 4px; min-width: 24px; }
nav.toc .page { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
</style>
<nav class="toc">
<h2>Contents</h2>
<ol>
<li><span class="title">Preface</span><span class="dots"></span><span class="page">vii</span></li>
<li><span class="title">Setting up the workshop</span><span class="dots"></span><span class="page">1</span></li>
<li><span class="title">First principles</span><span class="dots"></span><span class="page">15</span></li>
<li><span class="title">Common mistakes</span><span class="dots"></span><span class="page">42</span></li>
<li><span class="title">Glossary</span><span class="dots"></span><span class="page">108</span></li>
</ol>
</nav>`;

export default {
  id: 'MPAGE-05',
  category: 'MPAGE',
  tag: 'structural_regular',
  description: 'TOC: edit one entry title ("First principles" → "First principles and warnings"); page numbers + other titles byte-identical',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'In the table of contents, change "First principles" to "First principles and warnings". Leave the page number ("15") next to it alone, and leave every other TOC entry — title and page number both — untouched.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: '<span class="title">First principles</span>',
        replace: '<span class="title">First principles and warnings</span>' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('nav.toc ol li').length === 5, label: '5 TOC entries preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('nav.toc li .title')).map(s => s.textContent).join('|') === 'Preface|Setting up the workshop|First principles and warnings|Common mistakes|Glossary', label: 'titles: third entry renamed, others byte-identical' },
    { fn: (d) => Array.from(d.querySelectorAll('nav.toc li .page')).map(s => s.textContent).join('|') === 'vii|1|15|42|108', label: 'page numbers byte-identical (including roman "vii")' },
    { fn: (d) => d.querySelectorAll('nav.toc li .dots').length === 5, label: 'dotted leaders preserved on every row' },
    { fn: (d) => d.querySelector('nav.toc h2')?.textContent === 'Contents', label: 'TOC heading preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('font-variant-numeric: tabular-nums'), label: 'tabular-nums rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('border-bottom: 1px dotted #999'), label: 'dotted-leader rule preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, '<span class="title">First principles</span>');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
