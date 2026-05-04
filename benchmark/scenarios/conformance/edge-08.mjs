// EDGE-08 — FSA permission revoked between ⌘K and ⌘S.
//
// Spec §5b.5 EDGE-08: "IDB state reflects the new doc; the runtime
// surfaces the permission failure clearly; user can re-grant and commit
// successfully without re-running the edit."
//
// jsdom does not implement window.showSaveFilePicker or FileSystemFileHandle,
// so this scenario tests the structural property: the modify pathway and
// the save (commit) pathway are independent. A successful applyEdits
// commits to IDB regardless of file-system access.

export default {
  id: 'EDGE-08',
  category: 'EDGE',
  description: 'modify commits to IDB independently of file-system access (FSA stub)',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // jsdom has no showSaveFilePicker. The runtime's commit() function
      // tries FSA first and falls back to download. In our environment,
      // both paths are unavailable, but applyEdits should commit to IDB
      // without depending on either.
      const before = await ctx.getDoc();
      const after = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'Hello', replace: 'Hi' }] },
        before,
      );
      const fromIDB = await ctx.getDoc();
      if (fromIDB !== after) {
        return { pass: false, reason: `applyEdits returned doc differs from IDB state` };
      }
      if (!fromIDB.includes('Hi,')) return { pass: false, reason: 'edit did not land in IDB' };
      // Verify FSA is not required: window.showSaveFilePicker is undefined.
      if (typeof ctx.window.showSaveFilePicker === 'function') {
        return { pass: false, reason: 'jsdom unexpectedly implements showSaveFilePicker — invalidates this scenario' };
      }
      return { pass: true, reason: 'modify committed to IDB without FSA — separation of concerns holds' };
    } finally {
      ctx.dispose();
    }
  },
};
