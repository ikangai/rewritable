// WORKFLOW-05 — test-step uses cached upstream output. A step's
// per-step ▶ Test button runs JUST that step, feeding it the upstream
// neighbor's data-last-output (or data-pinned-output) as `prev`.
//
// Fixture: 2 steps. Step 0 has data-last-output='"cached"' (from a
// hypothetical earlier run). Step 1's body echoes prev with a prefix.
// Trigger testStep on step 1 (no Run on the whole workflow). Expect
// step 1's <output> to read "from-cache:cached" — proving the test
// helper fed cached upstream as prev.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Test step test</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  async function testStep(li) {
    var all = Array.from(document.querySelectorAll('li.rwa-step'));
    var idx = all.indexOf(li);
    if (idx < 0) return;
    var sc = li.querySelector('script[type="text/rwa-step"]');
    if (!sc) return;
    li.classList.remove('done', 'failed');
    li.classList.add('running');
    try {
      var prev;
      if (idx > 0) {
        var p = all[idx - 1];
        var src = p.dataset.pinnedOutput != null ? p.dataset.pinnedOutput : p.dataset.lastOutput;
        if (src != null) { try { prev = JSON.parse(src); } catch (_) { prev = src; } }
      }
      var fn = new Function('ctx', 'prev', '"use strict"; return (async () => { ' + sc.textContent + '\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');
      var r = await fn({}, prev);
      li.classList.remove('running');
      li.classList.add('done');
      var out = li.querySelector('.rwa-step-output');
      if (out) out.textContent = typeof r === 'string' ? r : JSON.stringify(r);
      try { li.dataset.lastOutput = JSON.stringify(r); } catch (_) {}
    } catch (e) {
      li.classList.remove('running');
      li.classList.add('failed');
      var outE = li.querySelector('.rwa-step-output');
      if (outE) outE.textContent = 'Error: ' + (e && e.message || e);
    }
  }
  window.__wfTestStep = testStep;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

const STEP_WITH_CACHE = `<li class="rwa-step" data-last-output="&quot;cached&quot;">
<header><h3>Cached upstream</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { throw new Error("should not be called in this test"); }
</` + `script></details>
<output class="rwa-step-output">cached</output>
</li>
`;

const STEP_ECHO = `<li class="rwa-step">
<header><h3>Echo</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return "from-cache:" + prev; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-05',
  category: 'WORKFLOW',
  description: 'test-step uses upstream data-last-output as prev (no whole-workflow run)',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + STEP_WITH_CACHE + STEP_ECHO + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfTestStep === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      if (typeof win.__wfTestStep !== 'function') {
        return { pass: false, reason: 'runner IIFE did not expose testStep' };
      }
      const steps = win.document.querySelectorAll('li.rwa-step');
      // Invoke testStep on step 1 only — step 0 should NOT be re-run.
      await win.__wfTestStep(steps[1]);

      const step1Out = steps[1].querySelector('.rwa-step-output')?.textContent;
      if (step1Out !== 'from-cache:cached') {
        return { pass: false, reason: `step 1 output expected "from-cache:cached", got ${JSON.stringify(step1Out)}` };
      }
      // Step 0 should be untouched — its <output> still reads "cached" from the fixture,
      // its body was never invoked (no exception escaped).
      const step0Out = steps[0].querySelector('.rwa-step-output')?.textContent;
      if (step0Out !== 'cached') {
        return { pass: false, reason: `step 0 output should be untouched, got ${JSON.stringify(step0Out)}` };
      }
      // step 1's last-output should now be cached too
      if (steps[1].dataset.lastOutput !== '"from-cache:cached"') {
        return { pass: false, reason: `step 1 data-last-output expected '"from-cache:cached"', got ${JSON.stringify(steps[1].dataset.lastOutput)}` };
      }
      return { pass: true, reason: 'test-step fed upstream data-last-output as prev; ran only the target step' };
    } finally {
      ctx.dispose();
    }
  },
};
