// ATOM-01 — validation-before-apply atomicity (rule 3).
//
// Envelope contains 3 edits where the middle one fails. Spec §13 rule 3
// requires the entire batch to be rejected with no observable mutation.
// Runtime implementation note: applyEdits mutates a local `work` variable
// in-loop, but commitDoc is only called after the full loop completes —
// so a throw mid-loop discards `work` without touching IDB.

export default {
  id: 'ATOM-01',
  category: 'ATOM',
  description: 'mid-batch find_not_found rolls back entire batch (no IDB mutation)',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docWithMarkers = '<div class="hello"><p>MARKER_ALPHA</p><p>MARKER_BETA</p><p>MARKER_GAMMA</p></div>';
      const result = await expectRwaError(
        ctx.applyEdits(
          {
            version: 'rwa-edit/1',
            edits: [
              { find: 'MARKER_ALPHA', replace: 'REPLACED_ALPHA' },
              { find: 'DEFINITELY_NOT_IN_DOCUMENT_XYZ', replace: '(unused)' },
              { find: 'MARKER_GAMMA', replace: 'REPLACED_GAMMA' },
            ],
          },
          docWithMarkers,
        ),
        'find_not_found',
      );
      if (!result.pass) return result;
      if (result.error.editIndex !== 1) {
        return { pass: false, reason: `expected editIndex=1, got ${result.error.editIndex}` };
      }
      // The docWithMarkers fixture was passed as currentDocRaw, not committed.
      // So IDB still has the seed's default. The atomicity check that matters:
      // no commit was attempted (no rwa_hist entry).
      const hist = await ctx.getHistory();
      if (hist.some(h => h?.kind === 'edit_batch')) {
        return { pass: false, reason: 'partial commit landed in rwa_hist despite rejection' };
      }
      return { pass: true, reason: 'mid-batch failure rolled back atomically (no commit)' };
    } finally {
      ctx.dispose();
    }
  },
};
