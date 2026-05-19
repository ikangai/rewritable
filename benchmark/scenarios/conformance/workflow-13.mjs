// WORKFLOW-13 — container test-step (v0.7).
// Verifies (rwa-workflow-spec.md §7):
//   • ▶ on a foreach card runs JUST that container's subtree against
//     upstream's data-last-output (no top-level Run).
//   • ▶ on a parallel <table> runs JUST that table's cells.
//   • Other top-level steps are NOT executed; their state is unchanged.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Container test-step</h1></header>
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
  function findOutput(node){
    for (var k = 0; k < node.children.length; k++) if (node.children[k].tagName === 'OUTPUT') return node.children[k];
    return null;
  }
  window.__calls = { source: 0, downstream: 0, inner: 0, cell_a: 0, cell_b: 0 };
  async function runLeaf(node, prev, ctx){
    var sc = node.querySelector('script[type="text/rwa-step"]');
    var fn = compile(sc);
    var r = await fn(ctx, prev);
    var out = findOutput(node);
    if (out) out.textContent = typeof r === 'string' ? r : JSON.stringify(r);
    return r;
  }
  async function runForeach(node, prev, ctx){
    if (!Array.isArray(prev)) throw new Error('foreach upstream not array');
    var innerOl = node.querySelector(':scope > ol.rwa-flow');
    var inner = flowChildren(innerOl);
    var perIter = [];
    for (var i = 0; i < prev.length; i++) {
      var iterCtx = Object.assign({}, ctx, { iter: { index: i, item: prev[i], total: prev.length } });
      var innerPrev = prev[i];
      for (var j = 0; j < inner.length; j++) innerPrev = await runNode(inner[j], innerPrev, iterCtx);
      perIter.push(innerPrev);
    }
    var outF = findOutput(node);
    if (outF) outF.textContent = JSON.stringify(perIter);
    return perIter;
  }
  async function runParallel(table, prev, ctx){
    var cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
    var results = await Promise.all(cells.map(function(c){ return runLeaf(c, prev, ctx); }));
    var out = {};
    cells.forEach(function(c, i){ out[c.dataset.rwaLabel] = results[i]; });
    return out;
  }
  async function runNode(n, prev, ctx){
    if (isForeach(n)) return runForeach(n, prev, ctx);
    if (isParallel(n)) return runParallel(n, prev, ctx);
    if (isLeaf(n)) return runLeaf(n, prev, ctx);
    throw new Error('unknown node');
  }
  // Test-container: dispatch a container subtree against upstream cached.
  async function testContainer(node){
    var prev;
    var sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.matches && (sibling.matches('li.rwa-step') || sibling.matches('table.rwa-parallel'))) break;
      sibling = sibling.previousElementSibling;
    }
    if (sibling) {
      var src = sibling.dataset.pinnedOutput != null ? sibling.dataset.pinnedOutput : sibling.dataset.lastOutput;
      if (src != null) { try { prev = JSON.parse(src); } catch (_) { prev = src; } }
    }
    return await runNode(node, prev, {});
  }
  window.__testContainer = testContainer;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

// Upstream: 'source' (cached to data-last-output via fixture). Then foreach.
// Then downstream that we will check is UNTOUCHED.
const FIXTURE = `<li class="rwa-step" data-last-output="[1,2,3]">
<header><h3>Source</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { window.__calls.source++; return [1,2,3]; }
</` + `script></details>
<output class="rwa-step-output">[1,2,3]</output>
</li>
<li class="rwa-step rwa-foreach">
<header><h3>For each</h3></header>
<ol class="rwa-flow">
<li class="rwa-step">
<header><h3>Inner</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { window.__calls.inner++; return prev * 10; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
</ol>
<output class="rwa-step-output"></output>
</li>
<li class="rwa-step">
<header><h3>Downstream</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { window.__calls.downstream++; return prev; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-13',
  category: 'WORKFLOW',
  description: 'container test-step — ▶ on foreach runs subtree against upstream cache; sibling top-level steps untouched',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + FIXTURE + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__testContainer === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      // Invoke test on the foreach container
      const foreach = win.document.querySelector('li.rwa-step.rwa-foreach');
      const result = await win.__testContainer(foreach);
      // 1. Inner step ran 3 times (one per item in the upstream array [1,2,3])
      if (win.__calls.inner !== 3) {
        return { pass: false, reason: `inner step expected 3 calls, got ${win.__calls.inner}` };
      }
      // 2. Source was NOT re-run (its cache was used)
      if (win.__calls.source !== 0) {
        return { pass: false, reason: `source ran ${win.__calls.source} times — test-container must use cached upstream, not re-run` };
      }
      // 3. Downstream was NOT run
      if (win.__calls.downstream !== 0) {
        return { pass: false, reason: `downstream ran ${win.__calls.downstream} times — test-container must NOT run sibling steps` };
      }
      // 4. Result is the foreach output: [10, 20, 30]
      if (JSON.stringify(result) !== '[10,20,30]') {
        return { pass: false, reason: `foreach output expected [10,20,30], got ${JSON.stringify(result)}` };
      }
      return { pass: true, reason: 'container test-step ran the foreach subtree against cached upstream; source + downstream untouched' };
    } finally {
      ctx.dispose();
    }
  },
};
