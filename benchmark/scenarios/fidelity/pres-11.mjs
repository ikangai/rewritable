// PRES-11 — document with semantic <header> + <article> + <footer>. Edit
// only the article body. Header (with nav + logo + tagline) and footer
// (with copyright + secondary links) must be byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<header class="site-header">
<a class="logo" href="#" aria-label="Home">Acme Research</a>
<nav class="primary-nav">
<a href="#research">Research</a>
<a href="#publications">Publications</a>
<a href="#team">Team</a>
<a href="#contact">Contact</a>
</nav>
<p class="tagline">Applied measurement, written down.</p>
</header>
<article class="post">
<h1>On retry budgets</h1>
<p>POST_ANCHOR The first draft of this post argued that retries are always cheap. They aren't.</p>
<p>A second paragraph elaborates on bounded budgets, jitter, and idempotence.</p>
</article>
<footer class="site-footer">
<p class="copy">© 2026 Acme Research — all rights reserved.</p>
<nav class="secondary-nav"><a href="#privacy">Privacy</a> · <a href="#imprint">Imprint</a> · <a href="#rss">RSS</a></nav>
</footer>`;

export default {
  id: 'PRES-11',
  category: 'PRES',
  tag: 'content',
  description: 'edit article body; semantic <header> + <footer> byte-identical',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the first article paragraph (the one that begins with "POST_ANCHOR") to read: "Retry budgets only earn their keep when the underlying call is cheap to repeat — assume otherwise.". Do not touch the site header (logo, nav, tagline) or site footer (copyright, secondary nav).',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'POST_ANCHOR The first draft of this post argued that retries are always cheap. They aren\'t.',
        replace: 'Retry budgets only earn their keep when the underlying call is cheap to repeat — assume otherwise.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('header.site-header .logo')?.textContent === 'Acme Research', label: 'header logo preserved' },
    { fn: (d) => d.querySelectorAll('header .primary-nav a').length === 4, label: 'header has 4 nav links' },
    { fn: (d) => Array.from(d.querySelectorAll('header .primary-nav a')).map(a => a.textContent).join('|') === 'Research|Publications|Team|Contact', label: 'header nav order + labels preserved' },
    { fn: (d) => d.querySelector('header .tagline')?.textContent === 'Applied measurement, written down.', label: 'tagline preserved' },
    { fn: (d) => d.querySelector('footer.site-footer .copy')?.textContent === '© 2026 Acme Research — all rights reserved.', label: 'footer copyright preserved' },
    { fn: (d) => d.querySelectorAll('footer .secondary-nav a').length === 3, label: 'footer has 3 secondary links' },
    { fn: (d) => d.querySelector('article.post h1')?.textContent === 'On retry budgets', label: 'article h1 unchanged' },
    { fn: (d) => Array.from(d.querySelectorAll('article.post p')).some(p => p.textContent.startsWith('Retry budgets only earn their keep')), label: 'article edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('POST_ANCHOR'), label: 'anchor token removed' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'POST_ANCHOR The first draft of this post argued that retries are always cheap. They aren\'t.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
