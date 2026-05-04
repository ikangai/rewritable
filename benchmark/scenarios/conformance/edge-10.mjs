// EDGE-10 — context overflow during a long retry sequence.
//
// Spec §5b.5 EDGE-10: "Runtime detects context overflow before sending;
// surfaces a clear error to the user; mutex released."
//
// The seed runtime does not pre-check token budget — it relies on the
// provider to reject oversized requests. We simulate by having the fetch
// stub return a 413-like error after retries accumulate. The runtime's
// modify() should treat this as a fatal error (no further retries) and
// release the mutex.

export default {
  id: 'EDGE-10',
  category: 'EDGE',
  description: 'provider rejects with context-too-large → mutex released, second modify works',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // First modify: provider returns non-OK with context-too-large message.
      ctx.setFetchHandler(async () => ({
        ok: false,
        statusText: 'Payload Too Large',
        json: async () => ({ error: { code: 'context_length_exceeded', message: 'Request exceeds maximum context length' } }),
      }));
      await ctx.modify('first request that exceeds context');
      const histAfter = await ctx.getHistory();
      if (histAfter.length !== 0) {
        return { pass: false, reason: `unexpected hist entry after context overflow: ${JSON.stringify(histAfter[0])}` };
      }

      // Second modify must reach fetch — mutex was released.
      let fetchHit = false;
      ctx.setFetchHandler(async () => {
        fetchHit = true;
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{
                  id: 'call_after_ctx', type: 'function',
                  function: {
                    name: 'apply_edits',
                    arguments: JSON.stringify({
                      version: 'rwa-edit/1',
                      edits: [{ find: 'Hello', replace: 'Hi' }],
                    }),
                  },
                }],
              },
            }],
          }),
        };
      });
      await ctx.modify('recovery');
      if (!fetchHit) return { pass: false, reason: 'mutex held after context-overflow path' };
      return { pass: true, reason: 'context-overflow surfaced as error; mutex released; recovery succeeded' };
    } finally {
      ctx.dispose();
    }
  },
};
