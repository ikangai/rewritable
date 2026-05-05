// INTL-06 — RTL+LTR boundary: Arabic prose containing English code in
// <code>; edit prose; code block byte-identical, dir boundaries preserved.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article dir="rtl" lang="ar">
<p>EDIT_AR هذا النص يستخدم <code dir="ltr">setTimeout(fn, 1000)</code> للجدولة.</p>
<p>مثال آخر للجدولة الزمنية.</p>
</article>`;

export default {
  id: 'INTL-06',
  category: 'INTL',
  tag: 'content',
  description: 'edit Arabic prose; <code dir="ltr"> block byte-identical, dir boundaries preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Tighten the Arabic prose. Keep the <code dir="ltr"> block byte-identical.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [{
        find: 'EDIT_AR هذا النص يستخدم <code dir="ltr">setTimeout(fn, 1000)</code> للجدولة.',
        replace: 'النص المعدل: <code dir="ltr">setTimeout(fn, 1000)</code>.',
      }] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'code[dir="ltr"]', textEquals: 'setTimeout(fn, 1000)', label: 'code byte-identical with dir="ltr"' },
    { selector: 'article[dir="rtl"][lang="ar"]', label: 'parent dir+lang preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_AR هذا النص يستخدم <code dir="ltr">setTimeout(fn, 1000)</code> للجدولة.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
