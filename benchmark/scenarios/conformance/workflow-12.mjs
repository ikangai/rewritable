// WORKFLOW-12 — per-cell data-allow-failure (v0.6).
// Verifies (rwa-workflow-spec.md §3.3):
//   • A parallel cell with data-allow-failure="true" that rejects does
//     NOT halt the parallel block.
//   • Sibling cells (with or without allow-failure) finish normally.
//   • The failing cell's slot in the output object becomes
//     { __error: "<message>", __code: "<code or null>" }.
//   • Downstream sees the partial result and runs as usual.
//   • If a cell WITHOUT allow-failure also fails alongside, the
//     parallel block still halts (first un-tolerated rejection wins).

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Allow-failure test</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  function compile(sc){return new Function('ctx','prev','"use strict"; return (async () => { '+sc.textContent+'\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');}
  window.__downstreamPrev = undefined;
  async function runLeaf(node, prev, ctx){
    var sc = node.querySelector('script[type="text/rwa-step"]');
    var fn = compile(sc);
    return await fn(ctx, prev);
  }
  async function runParallel(table, prev, ctx){
    var cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
    var settled = await Promise.allSettled(cells.map(function(c){ return runLeaf(c, prev, ctx); }));
    var obj = {};
    var firstFatal = null;
    cells.forEach(function(cell, i){
      var r = settled[i];
      var allow = cell.dataset.allowFailure === 'true';
      if (r.status === 'fulfilled') {
        obj[cell.dataset.rwaLabel] = r.value;
      } else if (allow) {
        obj[cell.dataset.rwaLabel] = {
          __error: (r.reason && r.reason.message) || String(r.reason),
          __code: (r.reason && r.reason.code) || null,
        };
      } else if (!firstFatal) {
        firstFatal = r.reason;
      }
    });
    if (firstFatal) throw firstFatal;
    return obj;
  }
  async function runWorkflow(){
    window.__downstreamPrev = undefined;
    window.__lastError = null;
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var children = Array.from(rootOl.children).filter(function(c){return c.matches('li.rwa-step, table.rwa-parallel');});
    var prev;
    try {
      for (var i = 0; i < children.length; i++) {
        var n = children[i];
        if (n.matches('table.rwa-parallel')) prev = await runParallel(n, prev, {});
        else prev = await runLeaf(n, prev, {});
      }
      window.__downstreamPrev = prev;
    } catch (e) {
      window.__lastError = (e && e.message) || String(e);
    }
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

// Sub-case A: one allow-failure cell rejects, sibling succeeds → partial result, downstream runs.
const ALLOW_FAILURE_FIXTURE = `<table class="rwa-parallel">
<tbody><tr>
<td class="rwa-step" data-rwa-label="ok">
<header><h3>OK</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return "good"; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="flaky" data-allow-failure="true">
<header><h3>Flaky</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { var e = new Error("source unreachable"); e.code = "EAI_AGAIN"; throw e; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr></tbody>
</table>
<li class="rwa-step">
<header><h3>Downstream</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

// Sub-case B: allow-failure cell rejects AND a non-allow cell also rejects → block halts.
const MIXED_FAILURE_FIXTURE = `<table class="rwa-parallel">
<tbody><tr>
<td class="rwa-step" data-rwa-label="strict_fail">
<header><h3>Strict</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { throw new Error("strict boom"); }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="tolerated_fail" data-allow-failure="true">
<header><h3>Tolerated</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { throw new Error("tolerated boom"); }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr></tbody>
</table>
<li class="rwa-step">
<header><h3>Should not run</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return "wrong"; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-12',
  category: 'WORKFLOW',
  description: 'data-allow-failure — cell rejection contained as {__error,__code} in result object; sibling + downstream continue; mixed fatal+tolerated still halts',
  weight: 1,

  async run({ harness }) {
    // Sub-case A: allow-failure isolated
    {
      const ctx = await harness.fresh();
      try {
        await ctx.setDoc(WF_HEAD + ALLOW_FAILURE_FIXTURE + WF_TAIL);
        const win = ctx.window;
        for (let i = 0; i < 20; i++) {
          if (typeof win.__wfRunWorkflow === 'function') break;
          await new Promise(r => setTimeout(r, 25));
        }
        await win.__wfRunWorkflow();
        if (win.__lastError) {
          return { pass: false, reason: `case A: pipeline halted unexpectedly with "${win.__lastError}"` };
        }
        const downstream = win.__downstreamPrev;
        if (!downstream || downstream.ok !== 'good') {
          return { pass: false, reason: `case A: downstream prev missing ok="good", got ${JSON.stringify(downstream)}` };
        }
        const flaky = downstream.flaky;
        if (!flaky || typeof flaky.__error !== 'string' || !flaky.__error.includes('source unreachable')) {
          return { pass: false, reason: `case A: expected flaky.__error containing "source unreachable", got ${JSON.stringify(flaky)}` };
        }
        if (flaky.__code !== 'EAI_AGAIN') {
          return { pass: false, reason: `case A: expected flaky.__code="EAI_AGAIN", got ${JSON.stringify(flaky.__code)}` };
        }
      } finally {
        ctx.dispose();
      }
    }
    // Sub-case B: mixed fatal + tolerated still halts
    {
      const ctx = await harness.fresh();
      try {
        await ctx.setDoc(WF_HEAD + MIXED_FAILURE_FIXTURE + WF_TAIL);
        const win = ctx.window;
        for (let i = 0; i < 20; i++) {
          if (typeof win.__wfRunWorkflow === 'function') break;
          await new Promise(r => setTimeout(r, 25));
        }
        await win.__wfRunWorkflow();
        if (!win.__lastError || !win.__lastError.includes('strict boom')) {
          return { pass: false, reason: `case B: expected pipeline to halt with "strict boom", got ${JSON.stringify(win.__lastError)}` };
        }
        if (typeof win.__downstreamPrev !== 'undefined') {
          return { pass: false, reason: `case B: downstream ran but should not have (got prev=${JSON.stringify(win.__downstreamPrev)})` };
        }
      } finally {
        ctx.dispose();
      }
    }
    return { pass: true, reason: 'allow-failure containment works; mixed fatal+tolerated still halts; downstream sees partial result with __error/__code keys' };
  },
};
