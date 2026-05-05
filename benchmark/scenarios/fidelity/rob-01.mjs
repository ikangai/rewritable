// ROB-01 — doc is a tutorial *about* rewritable; contains literal
// `rwa:frozen:begin` as prose; edit elsewhere succeeds without tripping
// the substring-presence rule.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<h1>Tutorial</h1>
<p>This article describes rwa-edit/1 frozen zones. You'll see comments like "rwa:frozen:begin theme" and "rwa:frozen:end theme" wrapping protected regions.</p>
<p>EDIT_HERE A separate paragraph to edit.</p>
</article>`;

export default {
  id: 'ROB-01',
  category: 'ROB',
  tag: 'content',
  description: 'edit succeeds without tripping reserved-marker check on prose content',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Tighten the EDIT_HERE paragraph. The first paragraph (which describes rwa-edit semantics in prose) must stay byte-identical.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_HERE A separate paragraph to edit.', replace: 'Tightened paragraph.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.body.textContent.includes('rwa:frozen:begin theme'), label: 'tutorial prose preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('p')).some(p => p.textContent.includes('Tightened')), label: 'edit landed in some <p>' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_HERE A separate paragraph to edit.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
