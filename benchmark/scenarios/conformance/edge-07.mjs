// EDGE-07 — IDB transaction aborts mid-commit.
//
// Spec §5b.5 EDGE-07: "Doc is unchanged; undo stack is unchanged; audit
// log is unchanged. Atomicity of the single-transaction commit holds
// against errors, not just clean rejections."
//
// Implementation: import fake-indexeddb's IDBObjectStore class, patch its
// prototype.put to throw a QuotaExceededError when called on the 'rwa_doc'
// store. The runtime's commitDoc opens one readwrite transaction over
// [rwa_doc, rwa_undo, rwa_hist] — IDB transaction semantics guarantee that
// a throw during any put aborts the transaction without applying any of
// the put operations.

import { IDBObjectStore } from 'fake-indexeddb';

export default {
  id: 'EDGE-07',
  category: 'EDGE',
  description: 'IDB put error mid-commit → atomic rollback (no doc, undo, or hist write)',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    const origPut = IDBObjectStore.prototype.put;
    try {
      const before = await ctx.getDoc();
      const histBefore = await ctx.getHistory();
      const undoBefore = await ctx.getUndoStack();

      IDBObjectStore.prototype.put = function (val, key) {
        if (this.name === 'rwa_doc') {
          const err = new Error('Mock quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
        return origPut.call(this, val, key);
      };

      let rejected = false;
      try {
        await ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'Untitled', replace: 'Edited' }] },
          before,
        );
      } catch (err) {
        rejected = true;
      }

      // Restore prototype before reading state — getHistory/getUndoStack
      // also use put internally and would fail if still patched.
      IDBObjectStore.prototype.put = origPut;

      if (!rejected) {
        return { pass: false, reason: 'commit succeeded despite injected put error' };
      }
      const after = await ctx.getDoc();
      const histAfter = await ctx.getHistory();
      const undoAfter = await ctx.getUndoStack();
      if (after !== before) return { pass: false, reason: 'doc changed after aborted commit' };
      if (histAfter.length !== histBefore.length) return { pass: false, reason: `hist grew: ${histBefore.length} → ${histAfter.length}` };
      if (undoAfter.length !== undoBefore.length) return { pass: false, reason: `undo grew: ${undoBefore.length} → ${undoAfter.length}` };
      return { pass: true, reason: 'IDB commit error rolled back atomically' };
    } finally {
      // Defense in depth — restore even if an unexpected throw happened above.
      IDBObjectStore.prototype.put = origPut;
      ctx.dispose();
    }
  },
};
