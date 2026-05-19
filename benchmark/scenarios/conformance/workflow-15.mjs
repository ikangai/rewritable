// WORKFLOW-15 — multi-row parallel (v0.9).
// Verifies (rwa-workflow-spec.md §3.3 "Multi-row case"):
//   • A <table class="rwa-parallel"> with multiple rows runs each column
//     as a sequential pipeline, all columns concurrently via Promise.all.
//   • Cell 0 (top of column) receives the parallel block's upstream prev.
//   • Subsequent cells in the column receive the previous cell's return.
//   • Output is { [colLabel]: lastCellInColumn.return }.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Multi-row parallel</h1></header>
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
  function parallelColumns(table){
    var labelRe = /^[a-z][a-z0-9_]{0,31}$/;
    var tbody = table.querySelector(':scope > tbody');
    var rows = Array.from(tbody.querySelectorAll(':scope > tr'));
    var rowCells = rows.map(function(tr){return Array.from(tr.querySelectorAll(':scope > td.rwa-step'));});
    var colCount = rowCells[0].length;
    for (var r = 1; r < rowCells.length; r++) {
      if (rowCells[r].length !== colCount) {
        var e = new Error('row mismatch'); e.code = 'parallel_row_mismatch'; throw e;
      }
    }
    var columns = [];
    for (var c = 0; c < colCount; c++) {
      var col = rowCells.map(function(row){return row[c];});
      var label = col[0].dataset.rwaLabel;
      if (!label || !labelRe.test(label)) { var e2 = new Error('bad label'); e2.code = 'parallel_label_invalid'; throw e2; }
      for (var k = 1; k < col.length; k++) {
        if (col[k].dataset.rwaLabel !== label) { var e3 = new Error('label mismatch'); e3.code = 'parallel_label_mismatch'; throw e3; }
      }
      columns.push({label: label, cells: col});
    }
    return columns;
  }
  async function runParallel(table, prev, ctx){
    var columns = parallelColumns(table);
    var settled = await Promise.allSettled(columns.map(async function(col){
      var p = prev;
      for (var i = 0; i < col.cells.length; i++) p = await runLeaf(col.cells[i], p, ctx);
      return p;
    }));
    var obj = {};
    var firstFatal = null;
    columns.forEach(function(col, i){
      var r = settled[i];
      if (r.status === 'fulfilled') obj[col.label] = r.value;
      else if (!firstFatal) firstFatal = r.reason;
    });
    if (firstFatal) throw firstFatal;
    return obj;
  }
  async function runWorkflow(){
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var children = Array.from(rootOl.children).filter(function(c){return c.matches('li.rwa-step, table.rwa-parallel');});
    var prev;
    for (var i = 0; i < children.length; i++) {
      var n = children[i];
      if (n.matches('table.rwa-parallel')) prev = await runParallel(n, prev, {});
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
async function run(ctx, prev) { return 5; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

// 2 columns × 3 rows: doubled and squared, each running 3 stages.
// col 'd' (doubled): cell 0 → prev*2; cell 1 → prev+1; cell 2 → prev*10
//   With upstream=5: 10, 11, 110
// col 's' (squared): cell 0 → prev*prev; cell 1 → prev-1; cell 2 → prev*100
//   With upstream=5: 25, 24, 2400
const MULTIROW = `<table class="rwa-parallel">
<tbody>
<tr>
<td class="rwa-step" data-rwa-label="d">
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev * 2; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="s">
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev * prev; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr>
<tr>
<td class="rwa-step" data-rwa-label="d">
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev + 1; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="s">
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev - 1; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr>
<tr>
<td class="rwa-step" data-rwa-label="d">
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev * 10; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
<td class="rwa-step" data-rwa-label="s">
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return prev * 100; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
</tr>
</tbody>
</table>
`;

export default {
  id: 'WORKFLOW-15',
  category: 'WORKFLOW',
  description: 'multi-row parallel — each column runs as a sequential pipeline; columns in parallel; output keyed by column label',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + SOURCE + MULTIROW + WF_TAIL);
      const win = ctx.window;
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRunWorkflow === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      await win.__wfRunWorkflow();
      const r = win.__lastResult;
      // col d: 5*2=10, 10+1=11, 11*10=110
      // col s: 5*5=25, 25-1=24, 24*100=2400
      if (!r || r.d !== 110 || r.s !== 2400) {
        return { pass: false, reason: `expected {d:110, s:2400}, got ${JSON.stringify(r)}` };
      }
      return { pass: true, reason: '2 columns × 3 rows; each column threaded prev sequentially; output keyed by column label' };
    } finally {
      ctx.dispose();
    }
  },
};
