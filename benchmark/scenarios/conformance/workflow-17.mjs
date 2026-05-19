// WORKFLOW-17 — ctx.iter.parent (v0.10).
// Verifies (rwa-workflow-spec.md §3.2):
//   • Nested foreach iterations chain via ctx.iter.parent.
//   • Top-level foreach has ctx.iter.parent === undefined.
//   • The chain walks arbitrarily deep (grandparent via .parent.parent).

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Iter parent</h1></header>
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
    return await fn(ctx, prev);
  }
  function flowChildren(ol){return Array.from(ol.children).filter(function(c){return c.matches('li.rwa-step, table.rwa-parallel');});}
  async function runForeach(node, prev, ctx){
    if (!Array.isArray(prev)) throw new Error('foreach upstream not array');
    var innerOl = node.querySelector(':scope > ol.rwa-flow');
    var inner = flowChildren(innerOl);
    var perIter = [];
    for (var i = 0; i < prev.length; i++) {
      var iterCtx = Object.assign({}, ctx, {
        iter: { index: i, item: prev[i], total: prev.length, parent: ctx.iter || undefined },
      });
      var innerPrev = prev[i];
      for (var j = 0; j < inner.length; j++) innerPrev = await runNode(inner[j], innerPrev, iterCtx);
      perIter.push(innerPrev);
    }
    return perIter;
  }
  async function runNode(n, prev, ctx){
    if (n.matches('li.rwa-step.rwa-foreach')) return runForeach(n, prev, ctx);
    return runLeaf(n, prev, ctx);
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

// Outer foreach over [['a','b'], ['c']] (two outer iterations, each
// containing a small inner array). Inner foreach prints index/item
// from both levels.
const SOURCE = `<li class="rwa-step">
<header><h3>Source</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return [["a","b"], ["c"]]; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

const OUTER = `<li class="rwa-step rwa-foreach">
<header><h3>Outer</h3></header>
<ol class="rwa-flow">
<li class="rwa-step rwa-foreach">
<header><h3>Inner</h3></header>
<ol class="rwa-flow">
<li class="rwa-step">
<header><h3>Tag</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) {
  return {
    inner_index: ctx.iter.index,
    inner_item: ctx.iter.item,
    outer_index: ctx.iter.parent.index,
    outer_total: ctx.iter.parent.total,
    grand_parent_undefined: ctx.iter.parent.parent === undefined,
  };
}
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
</ol>
<output class="rwa-step-output"></output>
</li>
</ol>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-17',
  category: 'WORKFLOW',
  description: 'ctx.iter.parent — nested foreach exposes outer iter chain; top-level parent is undefined',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + SOURCE + OUTER + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRunWorkflow === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      await win.__wfRunWorkflow();
      const r = win.__lastResult;
      // Result: outer iter 0 has 2 inner items, outer iter 1 has 1.
      // Each Tag step returns { inner_index, inner_item, outer_index, outer_total, grand_parent_undefined: true }.
      // The outer foreach's output is array of inner-foreach outputs (arrays).
      // The top-level (outer) foreach's output is the perIter of inner foreaches' outputs.
      // r[0] = inner foreach perIter for outer index=0 → [{...}, {...}] for items "a", "b"
      // r[1] = inner foreach perIter for outer index=1 → [{...}] for item "c"
      const flat = [].concat(r[0], r[1]);
      if (flat.length !== 3) {
        return { pass: false, reason: `expected 3 leaf results, got ${flat.length}: ${JSON.stringify(r)}` };
      }
      // First leaf: outer index=0, inner index=0, item="a"
      const expected = [
        { inner_index: 0, inner_item: 'a', outer_index: 0, outer_total: 2, grand_parent_undefined: true },
        { inner_index: 1, inner_item: 'b', outer_index: 0, outer_total: 2, grand_parent_undefined: true },
        { inner_index: 0, inner_item: 'c', outer_index: 1, outer_total: 2, grand_parent_undefined: true },
      ];
      for (let i = 0; i < expected.length; i++) {
        for (const k of Object.keys(expected[i])) {
          if (flat[i][k] !== expected[i][k]) {
            return { pass: false, reason: `result[${i}].${k} expected ${JSON.stringify(expected[i][k])}, got ${JSON.stringify(flat[i][k])}` };
          }
        }
      }
      return { pass: true, reason: 'nested foreach iter.parent chain walks correctly; top-level grandparent is undefined' };
    } finally {
      ctx.dispose();
    }
  },
};
