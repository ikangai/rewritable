// AUTHOR-03 — malformed zone (begin without matching end) → zone reported
// with error='unterminated'.
//
// Spec §7.2: the runtime should surface this clearly. The exact UX is
// implementation-defined but extractFrozenZones returning an error-tagged
// zone makes the malformed state inspectable.

export default {
  id: 'AUTHOR-03',
  category: 'AUTHOR',
  description: 'malformed zone (begin without end) → reported as { name, error: "unterminated" }',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const doc = '<div class="hello"><h1>Hi</h1></div>\n<!-- rwa:frozen:begin orphan -->\n<p>content with no terminator</p>';
      const zones = ctx.window.extractFrozenZones(doc);
      const orphan = zones.find(z => z.name === 'orphan');
      if (!orphan) return { pass: false, reason: `orphan not in zones: ${JSON.stringify(zones)}` };
      if (orphan.error !== 'unterminated') {
        return { pass: false, reason: `expected error='unterminated', got error=${JSON.stringify(orphan.error)}` };
      }
      return { pass: true, reason: 'unterminated zone surfaced with clear error tag' };
    } finally {
      ctx.dispose();
    }
  },
};
