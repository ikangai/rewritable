// ROB-02 — fixture has mixed CRLF and LF line endings; first edit
// canonicalizes to LF; subsequent edits succeed normally.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

// Mixed CRLF in source (will be canonicalized by harness's resolveFixture).
const FIXTURE = '<article>\r\n<p>line one</p>\r\n<p>EDIT_ANCHOR</p>\n<p>line three</p>\n</article>';

export default {
  id: 'ROB-02',
  category: 'ROB',
  description: 'mixed CRLF/LF fixture; runtime canonLF makes edit succeed',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Replace EDIT_ANCHOR with "line two".',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_ANCHOR', replace: 'line two' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.body.textContent.includes('line two'), label: 'edit landed' },
    { fn: (d) => !doc.includes('\r'), label: 'doc is LF-only after canon' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'EDIT_ANCHOR');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
