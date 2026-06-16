// AFFORD-02 — a custom kind's STATIC self-description is [] (honest "I don't
// know"), not a wrong kind-template guess. WHY: the kind-template can only
// honestly guess kinds the runtime FIRST-PARTY-provides (document / presentation
// / workflow); a custom kind (datatable) is consumer-built via provide()/the
// declaration, so a static kind-derived guess would be a LIE — the real datatable
// proved the old illustrative guess wrong (it claimed a phantom `tool`). The real
// answer comes from the registry (live) or a trustworthy declaration
// (declared > live > static). A regression that re-added illustrative kind entries
// trades honesty for a guess, and fails here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSelfDescription, KIND_PROVIDERS } from '../../../tools/self-description.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATATABLE = path.resolve(here, '../../../examples/datatable/datatable.html');

export default {
  id: 'AFFORD-02',
  category: 'AFFORD',
  weight: 1,
  description: 'static self-description for a custom kind is [] (honest); KIND_PROVIDERS holds only first-party kinds',

  async run() {
    const keys = Object.keys(KIND_PROVIDERS).sort();
    // skill-host (v0.8) and workspace are FIRST-PARTY kinds with an empty provider
    // bundle ([]) — like document/workflow; skill-host's affordances are all INSTALLED
    // skills, not table-derived, and workspace surfaces none statically.
    // The guard still rejects CUSTOM/consumer kinds (e.g. datatable) sneaking in.
    if (JSON.stringify(keys) !== JSON.stringify(['document', 'presentation', 'skill-host', 'workflow', 'workspace'])) {
      return { pass: false, reason: `KIND_PROVIDERS should hold only first-party kinds; got [${keys}]` };
    }
    if (!fs.existsSync(DATATABLE)) return { pass: false, reason: 'datatable fixture missing' };
    const sd = computeSelfDescription(fs.readFileSync(DATATABLE, 'utf8'));
    if (sd.kind !== 'datatable') return { pass: false, reason: `expected kind datatable, got ${sd.kind}` };
    if (sd.affordances.length !== 0) {
      return { pass: false, reason: `a custom kind's static guess must be [] (honest), got [${sd.affordances.map(a => a.kind)}]` };
    }
    return { pass: true, reason: 'custom kind → static affordances [] (honest-unknown); KIND_PROVIDERS first-party-only' };
  },
};
