// WORKFLOW-09 — parallel error halts pipeline.
// Verifies (rwa-workflow-spec.md §3.3 + §6):
//   • One parallel cell rejects → Promise.all rejects → pipeline halts.
//   • Failing cell gets .failed class with error message in its <output>.
//   • Sibling cells' resolved results are NOT piped downstream.
//   • Downstream step after the parallel block does NOT run.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Parallel error test</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  function compile(sc){return new Function('ctx','prev','"use strict"; return (async () => { '+sc.textContent+'\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');}
  window.__downstreamRan = false;
  async function runLeaf(node, prev, ctx){
    var sc = node.querySelector('script[type="text/rwa-step"]');
    try {
      var fn = compile(sc);
      var r = await fn(ctx, prev);
      node.classList.add('done');
      var out = node.querySelector(':scope > output.rwa-step-output')
        || (function(){for (var k=0;k<node.children.length;k++) if (node.children[k].tagName==='OUTPUT') return node.children[k];})();
      if (out) out.textContent = typeof r === 'string' ? r : JSON.stringify(r);
      return r;
    } catch (e) {
      node.classList.add('failed');
      var outE = node.querySelector(':scope > output.rwa-step-output')
        || (function(){for (var k=0;k<node.children.length;k++) if (node.children[k].tagName==='OUTPUT') return node.children[k];})();
      if (outE) outE.textContent = 'Error: ' + (e && e.message || e);
      throw e;
    }
  }
  async function runParallel(table, prev, ctx){
    var cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
    var results = await Promise.all(cells.map(function(c){ return runLeaf(c, prev, ctx); }));
    var out = {};
    cells.forEach(function(c, i){ out[c.dataset.rwaLabel] = results[i]; });
    return out;
  }
  async function runWorkflow(){
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var children = Array.from(rootOl.children).filter(function(c){ return c.matches('li.rwa-step, table.rwa-parallel'); });
    var prev;
    try {
      for (var i = 0; i < children.length; i++) {
        var n = children[i];
        if (n.matches('table.rwa-parallel')) prev = await runParallel(n, prev, {});
        else prev = await runLeaf(n, prev, {});
      }
      window.__lastResult = prev;
    } catch (e) {
      window.__lastError = e && e.message || String(e);
    }
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

const SOURCE = `<li class="rwa-step">
<header><h3>Source</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return 1; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

const PARALLEL = `<table class="rwa-parallel">
<tbody><tr>
<td class="rwa-step" data-rwa-label="ok">
<header><h3>OK</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev * 100; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="boom">
<header><h3>BOOM</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { throw new Error("intentional"); }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr></tbody>
</table>
`;

const DOWNSTREAM = `<li class="rwa-step">
<header><h3>Should not run</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { window.__downstreamRan = true; return "unexpected"; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-09',
  category: 'WORKFLOW',
  description: 'parallel error — one cell rejects → pipeline halts; failing cell shows .failed; downstream does NOT run',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + SOURCE + PARALLEL + DOWNSTREAM + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRunWorkflow === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      await win.__wfRunWorkflow();

      // Error captured
      if (!win.__lastError || !win.__lastError.includes('intentional')) {
        return { pass: false, reason: `expected error containing "intentional", got ${JSON.stringify(win.__lastError)}` };
      }
      // Failing cell has .failed class
      const boomCell = win.document.querySelector('td.rwa-step[data-rwa-label="boom"]');
      if (!boomCell.classList.contains('failed')) {
        return { pass: false, reason: 'boom cell should have .failed class' };
      }
      // Surviving cell still got its result rendered (the runner wrote its output before the rejection)
      const okCell = win.document.querySelector('td.rwa-step[data-rwa-label="ok"]');
      if (okCell.querySelector('.rwa-step-output').textContent !== '100') {
        return { pass: false, reason: `ok cell output expected "100", got ${JSON.stringify(okCell.querySelector('.rwa-step-output').textContent)}` };
      }
      // Downstream did NOT run
      if (win.__downstreamRan) {
        return { pass: false, reason: 'downstream step ran despite parallel error — pipeline should have halted' };
      }
      // __lastResult was never assigned
      if (typeof win.__lastResult !== 'undefined') {
        return { pass: false, reason: `__lastResult should remain undefined, got ${JSON.stringify(win.__lastResult)}` };
      }
      return { pass: true, reason: 'parallel cell error propagated; failing cell marked .failed; sibling rendered but pipeline halted; downstream did not run' };
    } finally {
      ctx.dispose();
    }
  },
};
