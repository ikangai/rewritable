// WORKFLOW-03 — pin short-circuit. Verifies the v0.3 invariant that an
// <li class="rwa-step"> carrying data-pinned-output skips its run()
// function entirely and threads the pinned value forward as `prev`.
//
// Setup: 2-step fixture. Step 0 has data-pinned-output='"pinned"' and
// a body that would throw if called. Step 1 echoes prev. We expect
// step 0 to render its pinned value (no throw), and step 1 to receive
// "pinned" as prev.

const WF_BODY_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Pin test</h1></header>
<ol class="rwa-flow">
`;

const WF_BODY_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  // Minimal runner subset for the test — matches v0.3 contract:
  // pin short-circuit before calling run(); render pinned value into <output>.
  async function runWorkflow() {
    var btn = document.querySelector('.rwa-run');
    if (btn) btn.disabled = true;
    try {
      var steps = Array.from(document.querySelectorAll('li.rwa-step'));
      var prev;
      for (var i = 0; i < steps.length; i++) {
        var li = steps[i];
        if (li.dataset.pinnedOutput != null) {
          prev = JSON.parse(li.dataset.pinnedOutput);
          li.classList.add('done');
          var outP = li.querySelector('.rwa-step-output');
          if (outP) outP.textContent = typeof prev === 'string' ? prev : JSON.stringify(prev);
          continue;
        }
        var sc = li.querySelector('script[type="text/rwa-step"]');
        var fn = new Function('ctx', 'prev', '"use strict"; return (async () => { ' + sc.textContent + '\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');
        prev = await fn({}, prev);
        li.classList.add('done');
        var out = li.querySelector('.rwa-step-output');
        if (out) out.textContent = typeof prev === 'string' ? prev : JSON.stringify(prev);
      }
      var status = document.querySelector('.rwa-run-status');
      if (status) status.textContent = 'done';
    } catch (e) {
      var statusE = document.querySelector('.rwa-run-status');
      if (statusE) statusE.textContent = 'error:' + (e && e.message || e);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  var btn = document.querySelector('.rwa-run');
  if (btn) btn.addEventListener('click', runWorkflow);
  // Expose for tests
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

const PINNED_STEP = `<li class="rwa-step" data-pinned-output="&quot;pinned&quot;">
<header><h3>Greet (pinned)</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { throw new Error("should not be called when pinned"); }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

const ECHO_STEP = `<li class="rwa-step">
<header><h3>Echo</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return "received:" + prev; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-03',
  category: 'WORKFLOW',
  description: 'pin short-circuit — <li> with data-pinned-output skips run() and threads pinned value to next step',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_BODY_HEAD + PINNED_STEP + ECHO_STEP + WF_BODY_TAIL);
      const win = ctx.window;
      // Wait for the inline runner script to install __wfRunWorkflow
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRunWorkflow === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      if (typeof win.__wfRunWorkflow !== 'function') {
        return { pass: false, reason: 'runner IIFE did not expose __wfRunWorkflow' };
      }
      await win.__wfRunWorkflow();

      const steps = win.document.querySelectorAll('li.rwa-step');
      // Step 0 should have run pinned: classes done, output is "pinned", no exception thrown.
      const step0Out = steps[0].querySelector('.rwa-step-output')?.textContent;
      if (step0Out !== 'pinned') {
        return { pass: false, reason: `pinned step output expected "pinned", got ${JSON.stringify(step0Out)}` };
      }
      // Step 1 received pinned value as prev
      const step1Out = steps[1].querySelector('.rwa-step-output')?.textContent;
      if (step1Out !== 'received:pinned') {
        return { pass: false, reason: `echo step output expected "received:pinned", got ${JSON.stringify(step1Out)}` };
      }
      // Status should be done (no error)
      const status = win.document.querySelector('.rwa-run-status')?.textContent;
      if (status !== 'done') {
        return { pass: false, reason: `run-status expected "done", got ${JSON.stringify(status)}` };
      }
      return { pass: true, reason: 'pinned step short-circuited; pinned value threaded to next step' };
    } finally {
      ctx.dispose();
    }
  },
};
