// AUDIT-01 — rwa_hist shape & ordering for edit_batch records.
//
// Spec §12: rwa_hist is a newest-first array. Each successful apply_edits
// commit appends a record { kind: 'edit_batch', envelope, ts? } at index 0.
// HIST_CAP defaults to 15.

export default {
  id: 'AUDIT-01',
  category: 'AUDIT',
  description: '3 sequential apply_edits → rwa_hist has 3 newest-first edit_batch records with envelope',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // Sequential edits: writing → editing → thinking → planning
      let cur = await ctx.getDoc();
      cur = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'writing', replace: 'editing' }] },
        cur,
      );
      cur = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'editing,', replace: 'thinking,' }] },
        cur,
      );
      cur = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'thinking,', replace: 'planning,' }] },
        cur,
      );

      const hist = await ctx.getHistory();
      if (hist.length !== 3) {
        return { pass: false, reason: `expected hist.length=3, got ${hist.length}` };
      }
      // Newest-first: hist[0] is the planning edit, hist[2] is the writing edit.
      const findOf = (i) => hist[i]?.envelope?.edits?.[0]?.find;
      const replaceOf = (i) => hist[i]?.envelope?.edits?.[0]?.replace;
      if (findOf(0) !== 'thinking,' || replaceOf(0) !== 'planning,') {
        return { pass: false, reason: `hist[0] envelope wrong: find=${findOf(0)} replace=${replaceOf(0)}` };
      }
      if (findOf(2) !== 'writing' || replaceOf(2) !== 'editing') {
        return { pass: false, reason: `hist[2] envelope wrong: find=${findOf(2)} replace=${replaceOf(2)}` };
      }
      for (let i = 0; i < 3; i++) {
        if (hist[i]?.kind !== 'edit_batch') {
          return { pass: false, reason: `hist[${i}].kind=${hist[i]?.kind}, expected edit_batch` };
        }
        if (!hist[i]?.envelope) {
          return { pass: false, reason: `hist[${i}].envelope missing` };
        }
      }
      return { pass: true, reason: '3 edit_batch records newest-first with envelope payload' };
    } finally {
      ctx.dispose();
    }
  },
};
