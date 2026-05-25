// EDGE-13 — parseBridgeEnvelope tolerates ANSI escape sequences in stdout.
//
// `claude -p` (the bridge backend) sometimes emits ANSI color codes around
// the JSON envelope, especially when its TTY-detection mis-fires. The
// parser walks balanced braces and tracks string state; ANSI escape bytes
// (`\x1B[...m`) are neither `{`, `}`, nor `"`, so they pass through harmlessly.
//
// Construction: synthesize a stdout-shaped string with ANSI escapes around
// a valid `{ tool, envelope }` JSON object and pass it to
// window.parseBridgeEnvelope. Expect the parser to return the parsed object,
// with `tool` and `envelope` fields intact.

export default {
  id: 'EDGE-13',
  category: 'EDGE',
  description: 'parseBridgeEnvelope handles ANSI escape sequences around the JSON envelope',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const parse = ctx.window.parseBridgeEnvelope;
      if (typeof parse !== 'function') {
        return { pass: false, reason: 'window.parseBridgeEnvelope not exposed' };
      }
      const ESC = '\x1B';
      // ANSI: bold-red prefix, reset suffix, around the envelope.
      const stdout =
        `${ESC}[1;31mclaude:${ESC}[0m here is the envelope:\n` +
        `${ESC}[36m{"tool":"apply_edits","envelope":{"version":"rwa-edit/1","edits":[{"find":"X","replace":"Y"}]}}${ESC}[0m\n` +
        `${ESC}[2mdone.${ESC}[0m`;

      const parsed = parse(stdout);
      if (!parsed || typeof parsed !== 'object') {
        return { pass: false, reason: `expected parsed object, got ${parsed}` };
      }
      if (parsed.tool !== 'apply_edits') {
        return { pass: false, reason: `expected tool="apply_edits", got ${parsed.tool}` };
      }
      if (!parsed.envelope || parsed.envelope.version !== 'rwa-edit/1') {
        return { pass: false, reason: `envelope missing or wrong version: ${JSON.stringify(parsed.envelope)}` };
      }
      const edits = parsed.envelope.edits;
      if (!Array.isArray(edits) || edits.length !== 1 || edits[0].find !== 'X' || edits[0].replace !== 'Y') {
        return { pass: false, reason: `edits not preserved through ANSI noise: ${JSON.stringify(edits)}` };
      }
      return { pass: true, reason: 'parser walked balanced braces past ANSI escapes' };
    } finally {
      ctx.dispose();
    }
  },
};
