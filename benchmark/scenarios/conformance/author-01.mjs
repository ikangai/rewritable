// AUTHOR-01 — externally-edited container has a new frozen zone added.
//
// Spec §7.2: zones evolve via external editing only. On next open, the
// runtime must discover the new zone and present it in the agent's
// frozen_zones input. extractFrozenZones is the function that produces
// that input — testing it directly is sufficient to verify the wiring.

export default {
  id: 'AUTHOR-01',
  category: 'AUTHOR',
  description: 'doc with new <!-- rwa:frozen:begin appendix --> zone → runtime discovers it',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const doc = '<div class="hello"><h1>Hi</h1></div>\n<!-- rwa:frozen:begin appendix -->\n<p>frozen content</p>\n<!-- rwa:frozen:end appendix -->';
      if (typeof ctx.window.extractFrozenZones !== 'function') {
        return { pass: false, reason: 'runtime did not expose extractFrozenZones — cannot test zone discovery' };
      }
      const zones = ctx.window.extractFrozenZones(doc);
      if (!Array.isArray(zones)) return { pass: false, reason: `expected array, got ${typeof zones}` };
      const appendix = zones.find(z => z.name === 'appendix');
      if (!appendix) return { pass: false, reason: `appendix zone not discovered (zones: ${JSON.stringify(zones)})` };
      if (appendix.error) return { pass: false, reason: `appendix zone reported error: ${appendix.error}` };
      if (typeof appendix.inner !== 'string') return { pass: false, reason: `appendix.inner not a string` };
      if (!appendix.inner.includes('frozen content')) {
        return { pass: false, reason: `appendix.inner missing expected content: ${JSON.stringify(appendix.inner)}` };
      }
      return { pass: true, reason: `discovered appendix zone with ${appendix.inner.length} bytes of inner content` };
    } finally {
      ctx.dispose();
    }
  },
};
