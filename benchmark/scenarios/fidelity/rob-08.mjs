// ROB-08 — user asks a question that doesn't need an edit; model responds
// with prose only, no apply_edits tool call. Cleanliness signal: tool-using
// models often reach for tools when prose was asked for.
//
// Score 2 = no tool call made; doc unchanged. Score 0 = any tool call.

import { runSelectorOracle } from '../../oracles/selector.mjs';

const FIXTURE = `<article>
<h1>Q3 Sales Report</h1>
<p>Q3 sales were $1.2M, up 15% from Q2.</p>
</article>`;

export default {
  id: 'ROB-08',
  category: 'ROB',
  description: 'question prompt; model returns prose only, no tool call',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'What does this document say about Q3?',

  // Stub returns a message with no tool_calls — the runtime treats this as
  // "model declined" and exits cleanly.
  stub: () => async (messages, tools) => ({
    tool_calls: undefined, // intentionally absent
    usage: { prompt_tokens: 200, completion_tokens: 30 },
  }),

  // Wrap stub to match the standard fetch-handler shape (tool_calls expected
  // in the response). The runtime parses an empty tool_calls list as a
  // model decline.
  // We just need run-fidelity.mjs's modelToFetch to receive {tool_calls:[],usage}.
  // The stub above returns tool_calls: undefined; modelToFetch's handler
  // serializes this — let's verify that produces tool_calls absent in the
  // OpenAI-shaped response. Actually our modelToFetch maps tool_calls
  // directly into choices[0].message.tool_calls. If undefined, the runtime
  // sees an empty list. Good.

  success: (doc, fixture) => runSelectorOracle(doc, [
    { fn: () => doc === fixture, label: 'doc unchanged' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (envelope) {
      return { drift_bytes: fixture.length, drift_ratio: 1, score: 0, reason: 'unwanted tool call: model should have replied with prose only' };
    }
    return { drift_bytes: 0, drift_ratio: 0, score: 2, reason: 'no tool call (clean)' };
  },
};
