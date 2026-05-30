// AFFORD-01 — the provider kernel reports registered edit-surface/compute LIVE.
// WHY: "a file knows what it is" only holds if a file that DOES edit-surface +
// compute can REGISTER them so describe() reports them — not guess from the kind,
// not rely only on a static declaration. A regression that dropped a slot from
// the registry enumeration, or that accepted an unknown kind (letting a file
// overclaim a phantom affordance the runtime can't account for), fails here.
import { validateSelfDescription } from '../../../tools/self-description.mjs';

export default {
  id: 'AFFORD-01',
  category: 'AFFORD',
  weight: 1,
  description: 'runtime.provide(edit-surface|compute) → describe() reports them live; unknown kind rejected; unregister works',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const rt = ctx.window.runtime;
      if (typeof rt.provide !== 'function') return { pass: false, reason: 'runtime.provide not exposed' };
      if (rt.describe().affordances.length !== 0) return { pass: false, reason: 'a base document should report no affordances' };

      const offES = rt.provide('edit-surface', { kind: 'edit-surface', name: 'cell', label: 'Edit cells' });
      rt.provide('compute', { kind: 'compute', name: 'total', label: 'Total' });
      const d = rt.describe();
      const has = (k, n) => d.affordances.some(a => a.kind === k && a.name === n && a.provenance === 'first-party' && typeof a.label === 'string');
      if (!has('edit-surface', 'cell')) return { pass: false, reason: 'describe() did not report the registered edit-surface' };
      if (!has('compute', 'total')) return { pass: false, reason: 'describe() did not report the registered compute' };
      if (!validateSelfDescription(d).valid) return { pass: false, reason: 'describe() with edit-surface+compute fails the self-description/1 oracle' };

      let threw = false;
      try { rt.provide('telepathy', { kind: 'telepathy', name: 'x', label: 'x' }); } catch { threw = true; }
      if (!threw) return { pass: false, reason: 'runtime.provide accepted an unknown provider kind (a file could overclaim)' };

      if (typeof offES === 'function') offES();
      if (rt.describe().affordances.some(a => a.kind === 'edit-surface')) {
        return { pass: false, reason: 'unregister did not remove the edit-surface from describe()' };
      }
      return { pass: true, reason: 'edit-surface+compute registered → reported live + validated; unknown kind rejected; unregister works' };
    } finally { ctx.dispose(); }
  },
};
