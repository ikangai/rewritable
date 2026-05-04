// AUDIT-02 — replace_document records have kind='replace_document', a
// `reason` string, and NO `envelope` field (spec §12: doc body is not
// duplicated into history).

export default {
  id: 'AUDIT-02',
  category: 'AUDIT',
  description: 'replace_document → rwa_hist record has reason but no envelope',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const seedDoc = await ctx.getDoc();
      await ctx.replaceDocument(
        { version: 'rwa-edit/1', doc: '<div class="hello"><p>X</p></div>', reason: 'AUDIT-02 escape' },
        seedDoc,
      );
      const hist = await ctx.getHistory();
      if (hist.length !== 1) return { pass: false, reason: `expected hist.length=1, got ${hist.length}` };
      const rec = hist[0];
      if (rec?.kind !== 'replace_document') {
        return { pass: false, reason: `expected kind='replace_document', got ${rec?.kind}` };
      }
      if (rec.reason !== 'AUDIT-02 escape') {
        return { pass: false, reason: `expected reason='AUDIT-02 escape', got ${rec.reason}` };
      }
      if ('envelope' in rec && rec.envelope != null) {
        return { pass: false, reason: 'envelope unexpectedly present on replace_document record' };
      }
      return { pass: true, reason: `replace_document record: kind ok, reason ok, no envelope` };
    } finally {
      ctx.dispose();
    }
  },
};
