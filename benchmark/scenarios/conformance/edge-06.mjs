// EDGE-06 — find spanning a multi-byte UTF-8 boundary (emoji, CJK).
//
// Spec §5b.5 EDGE-06: "Edit succeeds; the runtime's substring search is
// UTF-8-aware (or operates on full strings, not byte chunks)." JS strings
// are UTF-16 internally so indexOf works on code units, which sidesteps
// UTF-8-byte-chunking hazards entirely. This scenario asserts that.

export default {
  id: 'EDGE-06',
  category: 'EDGE',
  description: 'find spanning emoji/CJK characters → edit succeeds',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // Mix of multi-byte chars: emoji (4 UTF-8 bytes), CJK (3 UTF-8 bytes), non-BMP math (4 bytes).
      const anchor = '🎯日本語𝓆🜨'; // emoji + Japanese + non-BMP fraktur + emoji
      const doc = '<div class="hello"><p>before ' + anchor + ' after</p></div>';
      const result = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: anchor, replace: 'PLAIN' }] },
        doc,
      );
      if (typeof result !== 'string') return { pass: false, reason: `expected string result, got ${typeof result}` };
      if (result.includes(anchor)) return { pass: false, reason: 'multi-byte anchor still in result' };
      if (!result.includes('PLAIN')) return { pass: false, reason: 'replacement missing' };
      return { pass: true, reason: 'multi-byte anchor located + replaced cleanly' };
    } finally {
      ctx.dispose();
    }
  },
};
