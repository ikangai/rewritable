// WORKFLOW-06 — parallel fan-out / fan-in.
// Verifies the v0.4 parallel primitive (rwa-workflow-spec.md §2.3):
//   • <table class="rwa-parallel"> with <tbody><tr> and N <td class="rwa-step"> cells.
//   • Each cell receives the same upstream prev.
//   • Cells execute via Promise.all; output is { [label]: cellReturn }.
//   • Downstream sees that object as prev.
//
// Minimal runner shim defines runWorkflow with just the linear+parallel
// dispatch needed for this scenario — keeps the test isolated from any
// drift in the seed's full runner.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Parallel test</h1></header>
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
  async function runParallel(table, prev, ctx){
    var cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
    var results = await Promise.all(cells.map(async function(c){
      var r = await runLeaf(c, prev, ctx);
      var out = c.querySelector(':scope > output.rwa-step-output');
      if (out) out.textContent = typeof r === 'string' ? r : JSON.stringify(r);
      return r;
    }));
    var out = {};
    cells.forEach(function(c, i){ out[c.dataset.rwaLabel] = results[i]; });
    return out;
  }
  async function runWorkflow(){
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var children = Array.from(rootOl.children).filter(function(c){ return c.matches('li.rwa-step, table.rwa-parallel'); });
    var prev;
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node.matches('table.rwa-parallel')) prev = await runParallel(node, prev, {});
      else prev = await runLeaf(node, prev, {});
      var out = node.querySelector(':scope > output.rwa-step-output');
      if (out) out.textContent = typeof prev === 'string' ? prev : JSON.stringify(prev);
    }
    window.__lastResult = prev;
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

const SOURCE = `<li class="rwa-step">
<header><h3>Source</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return 7; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

const PARALLEL_TABLE = `<table class="rwa-parallel">
<tbody><tr>
<td class="rwa-step" data-rwa-label="doubled">
<header><h3>Doubled</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev * 2; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="squared">
<header><h3>Squared</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev * prev; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="echoed">
<header><h3>Echoed</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr></tbody>
</table>
`;

const SINK = `<li class="rwa-step">
<header><h3>Sink</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev.doubled + prev.squared + prev.echoed; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-06',
  category: 'WORKFLOW',
  description: 'parallel fan-out / fan-in — all cells get same upstream prev; output is keyed by data-rwa-label; downstream sees the object',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + SOURCE + PARALLEL_TABLE + SINK + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRunWorkflow === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      if (typeof win.__wfRunWorkflow !== 'function') {
        return { pass: false, reason: 'runner did not expose __wfRunWorkflow' };
      }
      await win.__wfRunWorkflow();

      // 1. Each parallel cell ran with prev=7.
      const cells = win.document.querySelectorAll('td.rwa-step');
      const expectations = { doubled: '14', squared: '49', echoed: '7' };
      for (const cell of cells) {
        const label = cell.dataset.rwaLabel;
        const out = cell.querySelector('.rwa-step-output')?.textContent;
        if (out !== expectations[label]) {
          return { pass: false, reason: `cell ${label} expected ${expectations[label]}, got ${JSON.stringify(out)}` };
        }
      }

      // 2. Sink received the labeled object as prev → 14 + 49 + 7 = 70.
      const sinkOut = win.document.querySelectorAll('li.rwa-step')[1].querySelector('.rwa-step-output')?.textContent;
      if (sinkOut !== '70') {
        return { pass: false, reason: `sink expected "70", got ${JSON.stringify(sinkOut)}` };
      }

      // 3. The parallel block's output is committed as the JSON object.
      const lastResult = win.__lastResult;
      if (lastResult !== 70) {
        return { pass: false, reason: `final result expected 70, got ${JSON.stringify(lastResult)}` };
      }
      return { pass: true, reason: 'parallel fan-out fed all cells from same upstream; fan-in object keyed by label flowed downstream' };
    } finally {
      ctx.dispose();
    }
  },
};
