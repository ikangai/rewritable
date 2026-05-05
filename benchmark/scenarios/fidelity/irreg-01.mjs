// IRREG-01 — swap two paragraphs identified by content (not position).
// "Move the distributed-systems paragraph before the consensus paragraph."
// IDs travel with their content. The DSL can't express this cleanly without
// enumerating anchors; the supervisor would self-execute via apply_edits.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const P_CONSENSUS = '<p id="p-consensus">The consensus algorithms used in distributed systems often involve quorum-based voting and have well-understood liveness properties.</p>';
const P_DISTRIBUTED = '<p id="p-distributed">Distributed systems must tolerate network partitions, machine failures, and clock skew.</p>';
const P_CLOCKS = '<p id="p-clocks">Logical clocks, particularly Lamport timestamps and vector clocks, allow events to be ordered without a global synchronized clock.</p>';

const FIXTURE = `<article>
<h1>Notes on consensus</h1>
${P_CONSENSUS}
${P_DISTRIBUTED}
${P_CLOCKS}
</article>`;

export default {
  id: 'IRREG-01',
  category: 'IRREG',
  tag: 'structural_irregular',
  description: 'swap two paragraphs identified by content; logical-clocks paragraph stays put',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Reorder so the paragraph about distributed systems comes BEFORE the paragraph about consensus algorithms. The logical-clocks paragraph stays where it is. The IDs travel with their content (so p-distributed appears first, then p-consensus, then p-clocks).',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [{
        find: `${P_CONSENSUS}\n${P_DISTRIBUTED}`,
        replace: `${P_DISTRIBUTED}\n${P_CONSENSUS}`,
      }],
    } },
  ]),
  success: async (doc) => runSelectorOracle(doc, [
    { fn: (d) => {
        const ps = [...d.querySelectorAll('article > p')];
        return ps.length === 3
          && ps[0].id === 'p-distributed'
          && ps[1].id === 'p-consensus'
          && ps[2].id === 'p-clocks';
      }, label: 'paragraphs in order: distributed, consensus, clocks' },
    { fn: (d) => d.querySelector('#p-clocks')?.textContent.includes('Logical clocks'), label: 'clocks paragraph content unchanged' },
    { fn: (d) => d.querySelector('#p-distributed')?.textContent.includes('Distributed systems'), label: 'distributed paragraph content preserved' },
    { fn: (d) => d.querySelector('#p-consensus')?.textContent.includes('consensus algorithms'), label: 'consensus paragraph content preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, `${P_CONSENSUS}\n${P_DISTRIBUTED}`);
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
