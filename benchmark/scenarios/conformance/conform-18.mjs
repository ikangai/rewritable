// CONFORM-18 — model returns two parallel tool_calls in one assistant message;
// runtime takes [0], silently drops [1].
//
// Anthropic and OpenAI providers can emit multiple tool_calls in one
// completion (the "I'll do A and B" pattern). The seed runtime is
// single-call-per-turn by design: modify() takes `toolCalls[0]` (line 3343)
// and ignores the rest. The retry path's tool_result echo-back trims
// tool_calls to just the consumed one (line 3354) so providers don't
// reject the next turn for an unmatched tool_use id.
//
// This scenario stubs fetch to return two tool_calls in one message and
// verifies that:
//   1. modify() completes successfully (no throw),
//   2. the doc reflects the envelope from tool_calls[0],
//   3. the audit record's envelope matches tool_calls[0],
//   4. the second tool_call's envelope is NOT applied.

export default {
  id: 'CONFORM-18',
  category: 'CONFORM',
  description: 'two parallel tool_calls in one response → runtime takes [0], silently drops [1]',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // Seed a small doc that has both anchors so we can prove which one ran.
      await ctx.setDoc('<article><p>ALPHA</p><p>BETA</p></article>');
      const docBefore = await ctx.getDoc();

      // First call returns two tool_calls. Second call (not expected) would
      // also need to be handled — but a successful first call ends the loop.
      ctx.setFetchHandler(async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_first',
                  type: 'function',
                  function: {
                    name: 'apply_edits',
                    arguments: JSON.stringify({
                      version: 'rwa-edit/1',
                      edits: [{ find: 'ALPHA', replace: 'FIRST_WINS' }],
                    }),
                  },
                },
                {
                  id: 'call_second',
                  type: 'function',
                  function: {
                    name: 'apply_edits',
                    arguments: JSON.stringify({
                      version: 'rwa-edit/1',
                      edits: [{ find: 'BETA', replace: 'SECOND_WOULD_HAVE_RUN' }],
                    }),
                  },
                },
              ],
            },
          }],
        }),
      }));

      await ctx.modify('parallel tool_calls test');

      const docAfter = await ctx.getDoc();
      if (!docAfter.includes('FIRST_WINS')) {
        return { pass: false, reason: 'first tool_call envelope was not applied' };
      }
      if (docAfter.includes('SECOND_WOULD_HAVE_RUN')) {
        return { pass: false, reason: 'second tool_call envelope leaked into the doc' };
      }
      if (!docAfter.includes('BETA')) {
        return { pass: false, reason: 'BETA anchor missing from result — doc shape changed unexpectedly' };
      }
      if (docAfter === docBefore) {
        return { pass: false, reason: 'doc unchanged — first tool_call did not commit' };
      }

      // Audit record should reflect the first envelope, not the second.
      const hist = await ctx.getHistory();
      const newest = hist[0];
      if (!newest || newest.kind !== 'edit_batch') {
        return { pass: false, reason: `expected edit_batch record at hist[0], got ${JSON.stringify(newest)?.slice(0, 100)}` };
      }
      const recordedFind = newest.envelope?.edits?.[0]?.find;
      if (recordedFind !== 'ALPHA') {
        return { pass: false, reason: `audit record reflects wrong envelope (find=${recordedFind})` };
      }

      return { pass: true, reason: 'tool_calls[0] applied; tool_calls[1] silently ignored; audit matches [0]' };
    } finally {
      ctx.dispose();
    }
  },
};
