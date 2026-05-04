// BULK-03 — mass refactor: rename a CSS class used in 40 places. Correct
// tool choice = replace_document; the model judges that 40 anchor edits
// would hit the per-batch heuristic and chooses the escape hatch.
//
// Scoring is unusual: high score for choosing the right tool, even if the
// substantive change is identical to what 40 anchor edits would produce.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDrift, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

function buildFixture() {
  // 40 elements with the same class.
  const items = Array.from({ length: 40 }, (_, i) => `<div class="old-class">Item ${i}</div>`).join('\n');
  return `<style>.old-class { padding: 1rem; }</style>\n<div class="container">\n${items}\n</div>`;
}

function buildAfter() {
  const items = Array.from({ length: 40 }, (_, i) => `<div class="new-class">Item ${i}</div>`).join('\n');
  return `<style>.new-class { padding: 1rem; }</style>\n<div class="container">\n${items}\n</div>`;
}

export default {
  id: 'BULK-03',
  category: 'BULK',
  description: 'mass class rename via replace_document (correct tool choice for 40-site change)',
  weight: 1,
  N: 3,
  fixtureContent: buildFixture(),
  prompt: 'Rename the CSS class .old-class → .new-class. It appears 40 times. Use replace_document.',
  stub: () => stubModel([
    {
      name: 'replace_document',
      envelope: { version: 'rwa-edit/1', doc: buildAfter(), reason: 'class rename across 40 sites' },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('.new-class').length === 40, label: '40 elements renamed' },
    { fn: (d) => d.querySelectorAll('.old-class').length === 0, label: 'no leftover old class' },
    { fn: (d) => (d.querySelector('style')?.textContent || '').includes('.new-class'), label: 'CSS rule renamed' },
  ]),
  // For replace_document, the envelope is { kind: 'replace_document' } and
  // there are no edits to verify. Use the byte-diff fallback against the
  // ENTIRE fixture as the expected region — replace_document legitimately
  // rewrites everything.
  stability: (fixture, doc, envelope) => {
    if (envelope) {
      // edit_batch — wrong tool used (would imply 40 anchor edits, hitting
      // the per-batch heuristic).
      return { drift_bytes: fixture.length, drift_ratio: 1, score: 0, reason: 'wrong tool: used apply_edits instead of replace_document' };
    }
    // No edit_batch envelope → replace_document was used. Score by content
    // match (success oracle handles that); stability is implicit pass for
    // wholesale rewrites that preserve the structure.
    const wholeRegion = [0, fixture.length];
    const d = computeDrift(fixture, doc, [wholeRegion]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
