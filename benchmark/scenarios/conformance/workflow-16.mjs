// WORKFLOW-16 — multi-row parallel validation errors (v0.9).
// Verifies (rwa-workflow-spec.md §3.3 + §6):
//   • parallel_row_mismatch when rows have different cell counts.
//   • parallel_label_mismatch when a column's cells disagree on
//     data-rwa-label across rows.
//
// Both errors must be detected BEFORE any cell runs (validation
// happens at parallelColumns extraction time).

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Multi-row errors</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  window.__cellsRan = 0;
  function compile(sc){return new Function('ctx','prev','"use strict"; return (async () => { '+sc.textContent+'\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');}
  async function runLeaf(node, prev, ctx){
    window.__cellsRan++;
    var sc = node.querySelector('script[type="text/rwa-step"]');
    var fn = compile(sc);
    return await fn(ctx, prev);
  }
  function parallelColumns(table){
    var labelRe = /^[a-z][a-z0-9_]{0,31}$/;
    var rows = Array.from(table.querySelectorAll(':scope > tbody > tr'));
    var rowCells = rows.map(function(tr){return Array.from(tr.querySelectorAll(':scope > td.rwa-step'));});
    var colCount = rowCells[0].length;
    for (var r = 1; r < rowCells.length; r++) {
      if (rowCells[r].length !== colCount) {
        var e = new Error('row ' + r + ' mismatch'); e.code = 'parallel_row_mismatch'; throw e;
      }
    }
    for (var c = 0; c < colCount; c++) {
      var col = rowCells.map(function(row){return row[c];});
      var label = col[0].dataset.rwaLabel;
      if (!label || !labelRe.test(label)) { var e2 = new Error('bad label'); e2.code = 'parallel_label_invalid'; throw e2; }
      for (var k = 1; k < col.length; k++) {
        if (col[k].dataset.rwaLabel !== label) { var e3 = new Error('label mismatch col ' + c); e3.code = 'parallel_label_mismatch'; throw e3; }
      }
    }
  }
  async function runParallel(table, prev, ctx){
    parallelColumns(table);
    // Stop here in this test — no need to run.
  }
  async function runWorkflow(){
    window.__cellsRan = 0;
    window.__lastError = null;
    var table = document.querySelector('table.rwa-parallel');
    try { await runParallel(table, undefined, {}); }
    catch (e) { window.__lastError = e.code || (e && e.message) || String(e); }
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

// Case A: 2-cell first row, 3-cell second row.
const ROW_MISMATCH = `<table class="rwa-parallel">
<tbody>
<tr>
<td class="rwa-step" data-rwa-label="a"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
<td class="rwa-step" data-rwa-label="b"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
</tr>
<tr>
<td class="rwa-step" data-rwa-label="a"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
<td class="rwa-step" data-rwa-label="b"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
<td class="rwa-step" data-rwa-label="c"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
</tr>
</tbody>
</table>
`;

// Case B: 2 rows, 2 cols, column 0's labels disagree (row0=foo, row1=bar).
const LABEL_MISMATCH = `<table class="rwa-parallel">
<tbody>
<tr>
<td class="rwa-step" data-rwa-label="foo"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
<td class="rwa-step" data-rwa-label="y"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
</tr>
<tr>
<td class="rwa-step" data-rwa-label="bar"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
<td class="rwa-step" data-rwa-label="y"><details><summary>c</summary><script type="text/rwa-step">async function run(){}</` + `script></details><output class="rwa-step-output"></output></td>
</tr>
</tbody>
</table>
`;

export default {
  id: 'WORKFLOW-16',
  category: 'WORKFLOW',
  description: 'multi-row parallel — row-count and per-column label-consistency validation throws before any cell runs',
  weight: 1,

  async run({ harness }) {
    // Case A
    {
      const ctx = await harness.fresh();
      try {
        await ctx.setDoc(WF_HEAD + ROW_MISMATCH + WF_TAIL);
        const win = ctx.window;
        for (let i = 0; i < 20; i++) {
          if (typeof win.__wfRunWorkflow === 'function') break;
          await new Promise(r => setTimeout(r, 25));
        }
        await win.__wfRunWorkflow();
        if (win.__lastError !== 'parallel_row_mismatch') {
          return { pass: false, reason: `case A: expected parallel_row_mismatch, got ${JSON.stringify(win.__lastError)}` };
        }
        if (win.__cellsRan !== 0) {
          return { pass: false, reason: `case A: cells ran (${win.__cellsRan}) — validation must reject before any execution` };
        }
      } finally {
        ctx.dispose();
      }
    }
    // Case B
    {
      const ctx = await harness.fresh();
      try {
        await ctx.setDoc(WF_HEAD + LABEL_MISMATCH + WF_TAIL);
        const win = ctx.window;
        for (let i = 0; i < 20; i++) {
          if (typeof win.__wfRunWorkflow === 'function') break;
          await new Promise(r => setTimeout(r, 25));
        }
        await win.__wfRunWorkflow();
        if (win.__lastError !== 'parallel_label_mismatch') {
          return { pass: false, reason: `case B: expected parallel_label_mismatch, got ${JSON.stringify(win.__lastError)}` };
        }
        if (win.__cellsRan !== 0) {
          return { pass: false, reason: `case B: cells ran (${win.__cellsRan})` };
        }
      } finally {
        ctx.dispose();
      }
    }
    return { pass: true, reason: 'row-count + column-label mismatches throw before any cell runs' };
  },
};
