// FAIL-05 — two ⌘K calls in quick succession; second returns
// concurrent_modify immediately, before any model round-trip.
//
// Tests the spec contract added in the second runtime-fix loop: modify()
// throws RwaEditError('concurrent_modify') when the mutex is held.

import { runSelectorOracle } from '../../oracles/selector.mjs';

const FIXTURE = `<article><p>FIXTURE</p></article>`;

export default {
  id: 'FAIL-05',
  // Constant stability — concurrent_modify lifecycle, scored via customRun; no drift dimension.
  driftProbe: 'none',
  category: 'FAIL',
  tag: 'failure_mode',
  description: 'second modify() while first is in flight → concurrent_modify before round-trip',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: '(driven directly via ctx.modify in this scenario)',

  // Skip the standard stub flow entirely — this scenario directly exercises
  // the modify() path twice and asserts concurrent_modify is thrown.
  // Use the runner's standard contract: scenario.run is invoked
  // separately; if absent, runner uses stub. We need a stub even though
  // we don't actually use it (run-fidelity always sets up the fetch
  // handler). Provide a never-matching stub.
  stub: () => async () => ({ tool_calls: [], usage: {} }),

  success: () => ({ score: 2, total: 1, passed: 1, results: [{ ok: true }] }),
  stability: () => ({ drift_bytes: 0, drift_ratio: 0, score: 2 }),

  // Custom run lifecycle to test concurrent_modify directly. The runner's
  // runOnce calls scenario.run if present (as a hook beyond the standard
  // modify-then-score path).
  customRun: async ({ ctx, fixture }) => {
    let firstFetchHit = false;
    let releaseFirst;
    const firstSettled = new Promise(r => { releaseFirst = r; });
    ctx.setFetchHandler(async () => {
      firstFetchHit = true;
      await firstSettled;
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
    });

    const p1 = ctx.modify('first');
    await new Promise(r => setTimeout(r, 50));

    let secondCode = null;
    try { await ctx.modify('second'); }
    catch (err) { secondCode = err?.code; }

    releaseFirst();
    await p1.catch(() => {});

    return { firstFetchHit, secondCode };
  },

  // Scoring runs after customRun; oracles receive its output
  scoreAfterCustom: (out, fixture, doc) => ({
    successResult: {
      score: out.firstFetchHit && out.secondCode === 'concurrent_modify' ? 2 : 0,
      total: 2,
      passed: (out.firstFetchHit ? 1 : 0) + (out.secondCode === 'concurrent_modify' ? 1 : 0),
      results: [
        { ok: out.firstFetchHit, label: 'first reached fetch' },
        { ok: out.secondCode === 'concurrent_modify', label: 'second got concurrent_modify' },
      ],
    },
    stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2, reason: 'concurrency-only test' },
  }),
};
