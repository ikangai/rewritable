// INTL-03 — Japanese doc with kanji+kana; edit one paragraph; surrounding
// paragraphs (no spaces between words) byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article lang="ja">
<p>最初の段落です。これは編集されません。</p>
<p class="edit-me">JA_EDIT_HERE 二番目の段落を更新します。</p>
<p>これが三番目の段落です。これも変更されません。</p>
</article>`;

export default {
  id: 'INTL-03',
  category: 'INTL',
  tag: 'content',
  description: 'edit one Japanese paragraph; CJK boundaries respected; siblings byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: '二番目の段落を簡潔に書き直します。一番目と三番目の段落はそのままにします。',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'JA_EDIT_HERE 二番目の段落を更新します。', replace: '簡潔な二番目の段落です。' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'p.edit-me', textContains: '簡潔', label: 'edit landed' },
    { fn: (d) => d.body.textContent.includes('最初の段落です。これは編集されません。'), label: 'p1 byte-identical' },
    { fn: (d) => d.body.textContent.includes('これが三番目の段落です。これも変更されません。'), label: 'p3 byte-identical' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'JA_EDIT_HERE 二番目の段落を更新します。');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
