// WORKFLOW-18 — ctx.signal cancellation (v0.11).
// Verifies (rwa-workflow-spec.md §4 + §6):
//   • ctx.signal is an AbortSignal threaded into every step.
//   • Calling abort() mid-pipeline halts at the next step boundary.
//   • The runner throws abort_signaled; downstream steps don't run.
//   • A fresh signal accompanies each Run (no stale state across Runs).
//
// Why intent matters (Rule 9): the signal is the durable cancellation
// hook for long workflows. Tests that just check "signal exists" wouldn't
// catch a runner that forgets to honor it.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Cancellation</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  function compile(sc){return new Function('ctx','prev','"use strict"; return (async () => { '+sc.textContent+'\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');}
  function throwIfAborted(c){
    if (c && c.signal && c.signal.aborted) { var e = new Error('abort_signaled'); e.code = 'abort_signaled'; throw e; }
  }
  window.__leafCallCount = 0;
  async function runLeaf(node, prev, ctx){
    throwIfAborted(ctx);
    window.__leafCallCount++;
    var sc = node.querySelector('script[type="text/rwa-step"]');
    var fn = compile(sc);
    return await fn(ctx, prev);
  }
  async function runWorkflow(controller){
    window.__leafCallCount = 0;
    window.__lastError = null;
    var ctx = { credentials: {}, signal: controller.signal };
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var nodes = Array.from(rootOl.children).filter(function(c){return c.matches('li.rwa-step');});
    var prev;
    try {
      for (var i = 0; i < nodes.length; i++) prev = await runLeaf(nodes[i], prev, ctx);
      window.__lastResult = prev;
    } catch (e) {
      window.__lastError = e && (e.code || e.message);
    }
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

// 4 steps: A, B, C, D. We'll abort after B finishes; expect C and D
// to be skipped, lastError === 'abort_signaled', __leafCallCount === 2.
const STEPS = `<li class="rwa-step">
<header><h3>A</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return 'A'; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
<li class="rwa-step">
<header><h3>B</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { window.__abortHere && window.__abortHere(); return 'B'; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
<li class="rwa-step">
<header><h3>C</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return 'C'; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
<li class="rwa-step">
<header><h3>D</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return 'D'; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-18',
  category: 'WORKFLOW',
  description: 'ctx.signal cancellation — abort during step B halts at next boundary; C+D never run; error is abort_signaled',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + STEPS + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRunWorkflow === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      // Hook the abort point at B
      const controller = new win.AbortController();
      win.__abortHere = function () { controller.abort(); };
      await win.__wfRunWorkflow(controller);

      if (win.__lastError !== 'abort_signaled') {
        return { pass: false, reason: `expected abort_signaled, got ${JSON.stringify(win.__lastError)}` };
      }
      // A + B ran; C + D didn't (abort fired during B, caught at C's boundary)
      if (win.__leafCallCount !== 2) {
        return { pass: false, reason: `expected 2 leaf calls (A, B), got ${win.__leafCallCount}` };
      }
      if (typeof win.__lastResult !== 'undefined') {
        return { pass: false, reason: `__lastResult should remain undefined, got ${JSON.stringify(win.__lastResult)}` };
      }

      // Fresh signal per Run — start a new controller, no abort, expect 4 leaf calls.
      delete win.__abortHere;
      const controller2 = new win.AbortController();
      await win.__wfRunWorkflow(controller2);
      if (win.__lastError !== null) {
        return { pass: false, reason: `second run unexpectedly errored: ${JSON.stringify(win.__lastError)}` };
      }
      if (win.__leafCallCount !== 4) {
        return { pass: false, reason: `second run expected 4 leaf calls, got ${win.__leafCallCount}` };
      }
      if (win.__lastResult !== 'D') {
        return { pass: false, reason: `second run expected lastResult "D", got ${JSON.stringify(win.__lastResult)}` };
      }
      return { pass: true, reason: 'abort halted at next boundary after B; C+D skipped; abort_signaled surfaced; fresh signal for second Run worked' };
    } finally {
      ctx.dispose();
    }
  },
};
