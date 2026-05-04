// CONFORM-14 — two modify() calls in flight simultaneously → second returns
// concurrent_modify immediately, first proceeds normally.
//
// Spec §10: concurrent_modify is a distinct failure code. The runtime in
// seeds/rewritable.html guards via the `modifyMutex` flag in modify() but
// signals collision via UI status only — it returns undefined rather than
// rejecting with a structured code. This scenario asserts the spec; if it
// fails, the runtime is signalling concurrency through the UI surface only.

export default {
  id: 'CONFORM-14',
  category: 'CONFORM',
  description: 'second modify() while first is in flight → concurrent_modify code',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // Hang fetch so the first modify stays in flight.
      let firstFetchHit = false;
      let releaseFirst;
      const firstSettled = new Promise((resolve) => { releaseFirst = resolve; });
      ctx.setFetchHandler(async () => {
        firstFetchHit = true;
        await firstSettled;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'never gets here' } }],
          }),
        };
      });

      const p1 = ctx.modify('first call');
      // Wait briefly for modify() to enter the fetch.
      await new Promise(r => setTimeout(r, 50));
      if (!firstFetchHit) {
        releaseFirst();
        await p1.catch(() => {});
        return { pass: false, reason: 'first modify did not reach fetch within 50ms' };
      }

      // Now fire the second one. Per spec, this should return/reject with
      // concurrent_modify before any model round-trip is consumed.
      let secondCode = null;
      let secondResolved = null;
      try {
        secondResolved = await ctx.modify('second call');
      } catch (err) {
        secondCode = err?.code;
      }

      // Release the first so we can clean up.
      releaseFirst();
      await p1.catch(() => {});

      if (secondCode === 'concurrent_modify') {
        return { pass: true, reason: 'second modify rejected with concurrent_modify' };
      }
      return {
        pass: false,
        reason: secondCode
          ? `expected concurrent_modify, got code=${secondCode}`
          : `runtime returned ${secondResolved} silently (no structured code) — spec wants concurrent_modify`,
      };
    } finally {
      ctx.dispose();
    }
  },
};
