// WORKFLOW-08 — nested composition: parallel inside foreach.
// Verifies (rwa-workflow-spec.md §3.4):
//   • A foreach body containing a parallel block runs the parallel block
//     once per iteration, each iteration's parallel-output object becomes
//     that iteration's final result.
//   • ctx.iter from the foreach is visible to each parallel cell.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Nested test</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  function compile(sc){return new Function('ctx','prev','"use strict"; return (async () => { '+sc.textContent+'\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');}
  function isForeach(n){return n.matches && n.matches('li.rwa-step.rwa-foreach');}
  function isParallel(n){return n.matches && n.matches('table.rwa-parallel');}
  function isLeaf(n){return n.matches && (n.matches('li.rwa-step:not(.rwa-foreach)') || n.matches('td.rwa-step'));}
  function flowChildren(ol){return Array.from(ol.children).filter(function(c){return c.matches('li.rwa-step, table.rwa-parallel');});}
  async function runLeaf(node, prev, ctx){
    var sc = node.querySelector('script[type="text/rwa-step"]');
    var fn = compile(sc);
    return await fn(ctx, prev);
  }
  async function runParallel(table, prev, ctx){
    var cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
    var results = await Promise.all(cells.map(function(c){ return runLeaf(c, prev, ctx); }));
    var out = {};
    cells.forEach(function(c, i){ out[c.dataset.rwaLabel] = results[i]; });
    return out;
  }
  async function runForeach(node, prev, ctx){
    if (!Array.isArray(prev)) throw new Error('foreach upstream is not array');
    var innerOl = node.querySelector('ol.rwa-flow');
    var inner = flowChildren(innerOl);
    var perIter = [];
    for (var i = 0; i < prev.length; i++) {
      var iterCtx = Object.assign({}, ctx, { iter: { index: i, item: prev[i], total: prev.length } });
      var innerPrev = prev[i];
      for (var j = 0; j < inner.length; j++) {
        innerPrev = await runNode(inner[j], innerPrev, iterCtx);
      }
      perIter.push(innerPrev);
    }
    return perIter;
  }
  async function runNode(n, prev, ctx){
    if (isForeach(n)) return runForeach(n, prev, ctx);
    if (isParallel(n)) return runParallel(n, prev, ctx);
    if (isLeaf(n)) return runLeaf(n, prev, ctx);
    throw new Error('unknown node');
  }
  async function runWorkflow(){
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var children = flowChildren(rootOl);
    var prev;
    for (var i = 0; i < children.length; i++) prev = await runNode(children[i], prev, {});
    window.__lastResult = prev;
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

const SOURCE = `<li class="rwa-step">
<header><h3>Source</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return [3, 5]; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

const NESTED = `<li class="rwa-step rwa-foreach">
<header><h3>For each n</h3></header>
<ol class="rwa-flow">
<table class="rwa-parallel">
<tbody><tr>
<td class="rwa-step" data-rwa-label="plus_idx">
<header><h3>n + index</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev + ctx.iter.index; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="times_total">
<header><h3>n * total</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev * ctx.iter.total; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr></tbody>
</table>
</ol>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-08',
  category: 'WORKFLOW',
  description: 'parallel inside foreach — each iteration runs the parallel block; ctx.iter from outer foreach is visible to parallel cells',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + SOURCE + NESTED + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRunWorkflow === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      await win.__wfRunWorkflow();

      const lastResult = win.__lastResult;
      // prev = [3, 5], total = 2
      //   i=0, item=3: plus_idx = 3+0 = 3,  times_total = 3*2 = 6  → { plus_idx: 3, times_total: 6 }
      //   i=1, item=5: plus_idx = 5+1 = 6,  times_total = 5*2 = 10 → { plus_idx: 6, times_total: 10 }
      const expected = [
        { plus_idx: 3, times_total: 6 },
        { plus_idx: 6, times_total: 10 },
      ];
      if (JSON.stringify(lastResult) !== JSON.stringify(expected)) {
        return { pass: false, reason: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(lastResult)}` };
      }
      return { pass: true, reason: 'parallel inside foreach: each iteration spawned its own parallel block; ctx.iter threaded into cells' };
    } finally {
      ctx.dispose();
    }
  },
};
