// INTL-01 — Arabic doc with dir="rtl" on parent; edit one paragraph;
// dir attribute and surrounding RTL structure byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article dir="rtl" lang="ar">
<p>هذا النص الأول العربي.</p>
<p class="edit-me">EDIT_ME_AR هذا النص للتعديل.</p>
<p>هذا النص الثالث العربي.</p>
</article>`;

export default {
  id: 'INTL-01',
  category: 'INTL',
  tag: 'content',
  description: 'edit one Arabic paragraph; dir="rtl" + surrounding paragraphs byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Tighten the second Arabic paragraph (the one with class="edit-me"). Keep dir="rtl" and the other two paragraphs byte-identical.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_ME_AR هذا النص للتعديل.', replace: 'النص المعدل بإيجاز.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'article[dir="rtl"][lang="ar"]', label: 'dir+lang preserved' },
    { selector: 'p.edit-me', textContains: 'المعدل', label: 'edit landed' },
    { fn: (d) => d.body.textContent.includes('هذا النص الأول العربي.'), label: 'p1 unchanged' },
    { fn: (d) => d.body.textContent.includes('هذا النص الثالث العربي.'), label: 'p3 unchanged' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_ME_AR هذا النص للتعديل.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
