// WORKFLOW-07 — foreach iteration.
// Verifies (rwa-workflow-spec.md §2.2 / §3.2):
//   • <li class="rwa-step rwa-foreach"> with a nested <ol class="rwa-flow">
//   • Upstream array iterated once per item, prev = item for the first inner step.
//   • ctx.iter = { index, item, total } available to inner steps.
//   • Output is an array of per-iteration final results.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Foreach test</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  function compile(sc){return new Function('ctx','prev','"use strict"; return (async () => { '+sc.textContent+'\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');}
  async function runLeaf(node, prev, ctx){
    var sc = node.querySelector('script[type="text/rwa-step"]');
    var fn = compile(sc);
    var r = await fn(ctx, prev);
    var out = node.querySelector(':scope > output.rwa-step-output');
    if (out) out.textContent = typeof r === 'string' ? r : JSON.stringify(r);
    return r;
  }
  async function runForeach(node, prev, ctx){
    if (!Array.isArray(prev)) {
      var e = new Error('foreach upstream is not array'); e.code = 'foreach_upstream_not_array'; throw e;
    }
    var innerOl = node.querySelector(':scope > ol.rwa-flow');
    var inner = Array.from(innerOl.children).filter(function(c){ return c.matches('li.rwa-step, table.rwa-parallel'); });
    var perIter = [];
    for (var i = 0; i < prev.length; i++) {
      var iterCtx = Object.assign({}, ctx, { iter: { index: i, item: prev[i], total: prev.length } });
      var innerPrev = prev[i];
      for (var j = 0; j < inner.length; j++) {
        innerPrev = await runLeaf(inner[j], innerPrev, iterCtx);
      }
      perIter.push(innerPrev);
    }
    // Direct child <output> only (avoid matching the inner step's output).
    var outF = null;
    for (var k = 0; k < node.children.length; k++) {
      if (node.children[k].tagName === 'OUTPUT') { outF = node.children[k]; break; }
    }
    if (outF) outF.textContent = JSON.stringify(perIter);
    return perIter;
  }
  async function runWorkflow(){
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var children = Array.from(rootOl.children).filter(function(c){ return c.matches('li.rwa-step, table.rwa-parallel'); });
    var prev;
    for (var i = 0; i < children.length; i++) {
      var n = children[i];
      if (n.matches('li.rwa-step.rwa-foreach')) prev = await runForeach(n, prev, {});
      else prev = await runLeaf(n, prev, {});
    }
    window.__lastResult = prev;
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

const SOURCE = `<li class="rwa-step">
<header><h3>Source</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return ["a", "b", "c"]; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

const FOREACH = `<li class="rwa-step rwa-foreach">
<header><h3>For each item</h3></header>
<ol class="rwa-flow">
<li class="rwa-step">
<header><h3>Decorate</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) {
  return ctx.iter.index + ':' + prev + '/' + ctx.iter.total;
}
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
</ol>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-07',
  category: 'WORKFLOW',
  description: 'foreach — iterates upstream array; prev=item, ctx.iter populated; output is array of per-iter results',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + SOURCE + FOREACH + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRunWorkflow === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      await win.__wfRunWorkflow();

      const lastResult = win.__lastResult;
      const expected = ['0:a/3', '1:b/3', '2:c/3'];
      if (!Array.isArray(lastResult) || lastResult.length !== 3
          || lastResult[0] !== expected[0] || lastResult[1] !== expected[1] || lastResult[2] !== expected[2]) {
        return { pass: false, reason: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(lastResult)}` };
      }
      // foreach's <output> shows the array of per-iteration final returns
      const foreachOut = win.document.querySelector('li.rwa-step.rwa-foreach > output.rwa-step-output')?.textContent;
      if (foreachOut !== JSON.stringify(expected)) {
        return { pass: false, reason: `foreach output expected ${JSON.stringify(JSON.stringify(expected))}, got ${JSON.stringify(foreachOut)}` };
      }
      return { pass: true, reason: 'foreach iterated 3x with correct ctx.iter values; output is array of per-iter results' };
    } finally {
      ctx.dispose();
    }
  },
};
