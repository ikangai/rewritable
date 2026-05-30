// AFFORD-03 — cross-surface CONVERGENCE on the flagship datatable: the LIVE
// runtime.describe() (registry ∪ trustworthy-declaration) and the embedded
// #rwa-affordances DECLARATION report the SAME affordance KINDS — the only diff is
// `verified` (the runtime can vouch for a wired affordance; the declaration's
// author-claim cannot). WHY: this is "a file knows what it is, IDENTICALLY, on
// every surface." If the union dropped/duplicated a slot, or the declaration
// drifted from what the runtime actually wires, the two KIND-sets diverge and this
// fails — the no-silent-drift gate for the whole self-description story.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSelfDescription, parseDeclaration } from '../../../tools/self-description.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATATABLE = path.resolve(here, '../../../examples/datatable/datatable.html');
const sortKinds = (affs) => affs.map(a => a.kind).sort();

export default {
  id: 'AFFORD-03',
  category: 'AFFORD',
  weight: 1,
  description: 'datatable: live describe() KINDS == declaration KINDS; verified the only live-only diff (wired vs claimed)',

  async run({ harness }) {
    if (!fs.existsSync(DATATABLE)) return { pass: false, reason: 'datatable fixture missing' };
    const bytes = fs.readFileSync(DATATABLE, 'utf8');

    // Surface 1 — the static, no-JS declaration.
    const decl = parseDeclaration(bytes).declaration;
    if (!decl) return { pass: false, reason: 'datatable carries no readable #rwa-affordances declaration' };
    const declKinds = sortKinds(decl.affordances);

    // Surface 2 — the live runtime (registry ∪ trustworthy declaration).
    const ctx = await harness.fresh({ html: bytes });
    try {
      const d = ctx.window.runtime.describe();
      const v = validateSelfDescription(d);
      if (!v.valid) return { pass: false, reason: 'live describe() fails the oracle: ' + v.errors.join('; ') };

      const liveKinds = sortKinds(d.affordances);
      if (JSON.stringify(liveKinds) !== JSON.stringify(declKinds)) {
        return { pass: false, reason: `KIND drift: live [${liveKinds}] != declared [${declKinds}]` };
      }

      // `verified` is the only live-only difference: the registry-wired affordances
      // (edit-surface, compute) carry verified:true; the declared-only views do not.
      const verified = d.affordances.filter(a => a.verified === true).map(a => a.kind).sort();
      const claimed = d.affordances.filter(a => a.verified !== true).map(a => a.kind).sort();
      if (JSON.stringify(verified) !== JSON.stringify(['compute', 'edit-surface'])) {
        return { pass: false, reason: `expected registry-verified [compute,edit-surface]; got [${verified}]` };
      }
      if (JSON.stringify(claimed) !== JSON.stringify(['view', 'view'])) {
        return { pass: false, reason: `expected declared-only [view,view] (no verified); got [${claimed}]` };
      }
      return { pass: true, reason: `convergence: live KINDS == declared KINDS [${liveKinds}]; verified=[compute,edit-surface] wired, [view,view] author-claimed` };
    } finally { ctx.dispose(); }
  },
};
