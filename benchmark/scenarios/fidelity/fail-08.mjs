// FAIL-08 — model declines to edit (prose-only response). Runtime exits
// the loop cleanly without committing; surfaces the prose to the user.

const FIXTURE = `<article><p>FIXTURE</p></article>`;

export default {
  id: 'FAIL-08',
  category: 'FAIL',
  description: 'model returns prose only (no tool_use); runtime exits cleanly, no commit',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'I cannot do that.',
  // Stub returns no tool_calls, just content text.
  stub: () => async () => ({
    tool_calls: [],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }),
  success: (doc, fixture) => ({
    score: doc === fixture ? 2 : 0,
    total: 1,
    passed: doc === fixture ? 1 : 0,
    results: [{ ok: doc === fixture, label: 'doc unchanged after model decline' }],
  }),
  stability: (fixture, doc, envelope) => {
    if (envelope) return { drift_bytes: fixture.length, drift_ratio: 1, score: 0, reason: 'unexpected envelope after decline' };
    return { drift_bytes: 0, drift_ratio: 0, score: 2, reason: 'declined cleanly' };
  },
};
