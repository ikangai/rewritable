// WORKFLOW-11 — container-level pin (v0.5).
// Verifies (rwa-workflow-spec.md §5.1):
//   • A foreach <li> with data-pinned-output returns the parsed value
//     without iterating; inner steps' outputs are NOT updated.
//   • A parallel <table> with data-pinned-output returns the parsed
//     value without running cells.
//   • Downstream sees the pinned value as prev.
//   • A leaf's data-pinned-output INSIDE a pinned container is never
//     consulted — the container short-circuit happens first.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Container pin test</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  function compile(sc){return new Function('ctx','prev','"use strict"; return (async () => { '+sc.textContent+'\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');}
  window.__leafCallCount = 0;
  async function runLeaf(node, prev, ctx){
    if (node.dataset.pinnedOutput != null) {
      var pinned = JSON.parse(node.dataset.pinnedOutput);
      var out0 = node.querySelector(':scope > output.rwa-step-output');
      if (out0) out0.textContent = typeof pinned === 'string' ? pinned : JSON.stringify(pinned);
      return pinned;
    }
    window.__leafCallCount++;
    var sc = node.querySelector('script[type="text/rwa-step"]');
    var fn = compile(sc);
    var r = await fn(ctx, prev);
    var out = node.querySelector(':scope > output.rwa-step-output');
    if (out) out.textContent = typeof r === 'string' ? r : JSON.stringify(r);
    return r;
  }
  async function runForeach(node, prev, ctx){
    // v0.5: container pin short-circuit
    if (node.dataset.pinnedOutput != null) {
      var pinned = JSON.parse(node.dataset.pinnedOutput);
      var out = null;
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].tagName === 'OUTPUT') { out = node.children[i]; break; }
      }
      if (out) out.textContent = JSON.stringify(pinned);
      return pinned;
    }
    var innerOl = node.querySelector('ol.rwa-flow');
    var inner = Array.from(innerOl.children).filter(function(c){return c.matches('li.rwa-step, table.rwa-parallel');});
    var perIter = [];
    if (!Array.isArray(prev)) throw new Error('foreach upstream not array');
    for (var i = 0; i < prev.length; i++) {
      var iterCtx = { iter: { index: i, item: prev[i], total: prev.length } };
      var innerPrev = prev[i];
      for (var j = 0; j < inner.length; j++) {
        if (inner[j].matches('table.rwa-parallel')) innerPrev = await runParallel(inner[j], innerPrev, iterCtx);
        else innerPrev = await runLeaf(inner[j], innerPrev, iterCtx);
      }
      perIter.push(innerPrev);
    }
    return perIter;
  }
  async function runParallel(table, prev, ctx){
    // v0.5: container pin short-circuit
    if (table.dataset.pinnedOutput != null) {
      return JSON.parse(table.dataset.pinnedOutput);
    }
    var cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
    var results = await Promise.all(cells.map(function(c){ return runLeaf(c, prev, ctx); }));
    var out = {};
    cells.forEach(function(c, i){ out[c.dataset.rwaLabel] = results[i]; });
    return out;
  }
  async function runWorkflow(){
    window.__leafCallCount = 0;
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var children = Array.from(rootOl.children).filter(function(c){return c.matches('li.rwa-step, table.rwa-parallel');});
    var prev;
    for (var i = 0; i < children.length; i++) {
      var n = children[i];
      if (n.matches('li.rwa-step.rwa-foreach')) prev = await runForeach(n, prev, {});
      else if (n.matches('table.rwa-parallel')) prev = await runParallel(n, prev, {});
      else prev = await runLeaf(n, prev, {});
    }
    window.__lastResult = prev;
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

// Sub-fixture 1: pinned foreach. Inner step would throw if reached.
const PINNED_FOREACH_FIXTURE = `<li class="rwa-step rwa-foreach" data-pinned-output="[10,20]">
<header><h3>Pinned foreach</h3></header>
<ol class="rwa-flow">
<li class="rwa-step">
<header><h3>Inner</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { throw new Error("should not run when foreach is pinned"); }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
</ol>
<output class="rwa-step-output"></output>
</li>
<li class="rwa-step">
<header><h3>Echo</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return JSON.stringify(prev); }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

// Sub-fixture 2: pinned parallel. Cells would throw if reached.
const PINNED_PARALLEL_FIXTURE = `<table class="rwa-parallel" data-pinned-output='{"x":1,"y":2}'>
<tbody><tr>
<td class="rwa-step" data-rwa-label="x">
<header><h3>X</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { throw new Error("should not run when parallel is pinned"); }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="y">
<header><h3>Y</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { throw new Error("should not run when parallel is pinned"); }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr></tbody>
</table>
<li class="rwa-step">
<header><h3>Echo</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return JSON.stringify(prev); }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-11',
  category: 'WORKFLOW',
  description: 'container pin — foreach + parallel short-circuit; inner steps never run; downstream sees pinned value',
  weight: 1,

  async run({ harness }) {
    // Sub-case A: pinned foreach
    {
      const ctx = await harness.fresh();
      try {
        await ctx.setDoc(WF_HEAD + PINNED_FOREACH_FIXTURE + WF_TAIL);
        const win = ctx.window;
        for (let i = 0; i < 20; i++) {
          if (typeof win.__wfRunWorkflow === 'function') break;
          await new Promise(r => setTimeout(r, 25));
        }
        await win.__wfRunWorkflow();
        if (win.__leafCallCount !== 1) {
          return { pass: false, reason: `foreach-pin: expected 1 leaf call (only Echo), got ${win.__leafCallCount}` };
        }
        if (win.__lastResult !== '[10,20]') {
          return { pass: false, reason: `foreach-pin: echo step expected '[10,20]', got ${JSON.stringify(win.__lastResult)}` };
        }
      } finally {
        ctx.dispose();
      }
    }
    // Sub-case B: pinned parallel
    {
      const ctx = await harness.fresh();
      try {
        await ctx.setDoc(WF_HEAD + PINNED_PARALLEL_FIXTURE + WF_TAIL);
        const win = ctx.window;
        for (let i = 0; i < 20; i++) {
          if (typeof win.__wfRunWorkflow === 'function') break;
          await new Promise(r => setTimeout(r, 25));
        }
        await win.__wfRunWorkflow();
        if (win.__leafCallCount !== 1) {
          return { pass: false, reason: `parallel-pin: expected 1 leaf call (only Echo), got ${win.__leafCallCount}` };
        }
        if (win.__lastResult !== '{"x":1,"y":2}') {
          return { pass: false, reason: `parallel-pin: echo step expected '{"x":1,"y":2}', got ${JSON.stringify(win.__lastResult)}` };
        }
      } finally {
        ctx.dispose();
      }
    }
    return { pass: true, reason: 'foreach + parallel container pins both short-circuit; inner steps untouched; downstream sees pinned values' };
  },
};
