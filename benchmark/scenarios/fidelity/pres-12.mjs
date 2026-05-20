// PRES-12 — surgical footer edit: update the copyright year only. The
// header, article body, and the rest of the footer (links, ARIA labels)
// must be byte-identical. Models often rewrite the footer as one block
// when asked to "update the year" — this scenario catches that.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<header class="site-header"><h1>Field notes</h1><p class="subtitle">Long-form writing on measurement.</p></header>
<article>
<h2>Why p99 lies</h2>
<p>A long-form essay about why the 99th-percentile latency metric is rarely the one to optimize on.</p>
<p>Edits below this line would land in the wrong place if a model rewrites the footer wholesale.</p>
</article>
<footer class="site-footer" aria-label="site footer">
<p class="copy">© 2024 Field Notes Collective. Some rights reserved under CC BY-SA 4.0.</p>
<p class="address">Berlin · Vienna · Amsterdam</p>
<nav><a rel="license" href="https://creativecommons.org/licenses/by-sa/4.0/">License</a> · <a href="/feed.xml">Feed</a> · <a href="mailto:editors@example.org">Contact editors</a></nav>
</footer>`;

export default {
  id: 'PRES-12',
  category: 'PRES',
  tag: 'content',
  description: 'update copyright year 2024 → 2026 in footer; rest of footer + header + article byte-identical',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Update the copyright year in the footer from 2024 to 2026. Nothing else in the footer changes — the address, the license link, the feed link, the editors mailto, and the aria-label all stay exactly as they are.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: '© 2024 Field Notes Collective', replace: '© 2026 Field Notes Collective' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('footer.site-footer .copy')?.textContent.startsWith('© 2026 Field Notes Collective'), label: 'year updated' },
    { fn: (d) => d.querySelector('footer.site-footer .copy')?.textContent.includes('Some rights reserved under CC BY-SA 4.0'), label: 'license phrasing preserved' },
    { fn: (d) => d.querySelector('footer.site-footer')?.getAttribute('aria-label') === 'site footer', label: 'footer aria-label preserved' },
    { fn: (d) => d.querySelector('footer.site-footer .address')?.textContent === 'Berlin · Vienna · Amsterdam', label: 'address line preserved' },
    { fn: (d) => d.querySelectorAll('footer.site-footer nav a').length === 3, label: 'all 3 footer links preserved' },
    { fn: (d) => d.querySelector('footer.site-footer nav a[rel="license"]')?.getAttribute('href') === 'https://creativecommons.org/licenses/by-sa/4.0/', label: 'license href preserved' },
    { fn: (d) => d.querySelector('header.site-header h1')?.textContent === 'Field notes', label: 'header h1 unchanged' },
    { fn: (d) => d.querySelectorAll('article p').length === 2, label: 'article still has 2 paragraphs' },
    { fn: (d) => !(d.body?.textContent || '').includes('© 2024'), label: 'no leftover old year' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, '© 2024 Field Notes Collective');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
