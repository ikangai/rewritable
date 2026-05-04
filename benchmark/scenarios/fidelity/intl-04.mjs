// INTL-04 — mixed-script doc: English prose, Chinese examples in callout,
// Greek mathematical notation; edit only the English; Chinese and Greek
// byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<p class="en" lang="en">EDIT_EN Initial English text to tighten.</p>
<aside class="zh" lang="zh">中文示例：测试不变性。</aside>
<p class="el" lang="el">Α² + Β² = Γ² (πυθαγόρειο θεώρημα)</p>
</article>`;

export default {
  id: 'INTL-04',
  category: 'INTL',
  description: 'edit only the English paragraph; Chinese and Greek byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Tighten the English paragraph. Don\'t touch the Chinese aside or the Greek formula.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_EN Initial English text to tighten.', replace: 'Tightened English text.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p.en', textContains: 'Tightened', label: 'English edited' },
    { selector: 'aside.zh', textEquals: '中文示例：测试不变性。', label: 'Chinese byte-identical' },
    { selector: 'p.el', textContains: 'Α² + Β² = Γ²', label: 'Greek formula intact' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_EN Initial English text to tighten.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
