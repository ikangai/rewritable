// WORKFLOW-10 — parallel label validation.
// Verifies (rwa-workflow-spec.md §2.3 + §6):
//   • Parallel cells MUST carry data-rwa-label.
//   • Label MUST match /^[a-z][a-z0-9_]{0,31}$/ (lowercase snake_case, ≤32 chars).
//   • Labels MUST be unique within a single parallel <tr>.
//   • Violations throw parallel_label_invalid; pipeline halts before running cells.
//
// Three sub-cases tested in one scenario via successive setDoc fixtures:
//   (a) Missing label
//   (b) Invalid characters in label
//   (c) Duplicate labels

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Label test</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  function compile(sc){return new Function('ctx','prev','"use strict"; return (async () => { '+sc.textContent+'\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');}
  function validateLabels(cells){
    var labelRe = /^[a-z][a-z0-9_]{0,31}$/;
    var seen = {};
    for (var i = 0; i < cells.length; i++) {
      var lbl = cells[i].dataset.rwaLabel;
      if (!lbl || !labelRe.test(lbl)) {
        var e = new Error('cell ' + i + ': bad label "' + lbl + '"'); e.code = 'parallel_label_invalid'; throw e;
      }
      if (seen[lbl]) {
        var e2 = new Error('cell ' + i + ': duplicate label "' + lbl + '"'); e2.code = 'parallel_label_invalid'; throw e2;
      }
      seen[lbl] = true;
    }
  }
  window.__cellsRan = 0;
  async function runLeaf(node, prev, ctx){
    window.__cellsRan++;
    var sc = node.querySelector('script[type="text/rwa-step"]');
    var fn = compile(sc);
    return await fn(ctx, prev);
  }
  async function runParallel(table, prev, ctx){
    var cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
    validateLabels(cells);
    var results = await Promise.all(cells.map(function(c){ return runLeaf(c, prev, ctx); }));
    var out = {};
    cells.forEach(function(c, i){ out[c.dataset.rwaLabel] = results[i]; });
    return out;
  }
  async function runWorkflow(){
    window.__cellsRan = 0;
    window.__lastError = null;
    var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow');
    var children = Array.from(rootOl.children).filter(function(c){ return c.matches('table.rwa-parallel'); });
    try {
      for (var i = 0; i < children.length; i++) await runParallel(children[i], undefined, {});
    } catch (e) {
      window.__lastError = e.code || (e && e.message) || String(e);
    }
  }
  window.__wfRunWorkflow = runWorkflow;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

const cellHtml = (lblAttr) => `<td class="rwa-step"${lblAttr ? ' data-rwa-label="' + lblAttr + '"' : ''}>
<header><h3>cell</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return 1; }
</` + `script></details>
<output class="rwa-step-output"></output>
</td>
`;

const tableHtml = (cells) => `<table class="rwa-parallel"><tbody><tr>
${cells}
</tr></tbody></table>
`;

const cases = [
  { name: 'missing label', cells: cellHtml('valid_a') + cellHtml(null) },
  { name: 'invalid chars',  cells: cellHtml('valid_a') + cellHtml('Bad-Label') },
  { name: 'duplicate',      cells: cellHtml('dup') + cellHtml('dup') },
];

export default {
  id: 'WORKFLOW-10',
  category: 'WORKFLOW',
  description: 'parallel label validation — missing/invalid/duplicate label throws parallel_label_invalid before any cell runs',
  weight: 1,

  async run({ harness }) {
    for (const c of cases) {
      const ctx = await harness.fresh();
      try {
        await ctx.setDoc(WF_HEAD + tableHtml(c.cells) + WF_TAIL);
        const win = ctx.window;
        for (let i = 0; i < 20; i++) {
          if (typeof win.__wfRunWorkflow === 'function') break;
          await new Promise(r => setTimeout(r, 25));
        }
        await win.__wfRunWorkflow();
        if (win.__lastError !== 'parallel_label_invalid') {
          return { pass: false, reason: `case "${c.name}": expected parallel_label_invalid, got ${JSON.stringify(win.__lastError)}` };
        }
        if (win.__cellsRan !== 0) {
          return { pass: false, reason: `case "${c.name}": cells ran (${win.__cellsRan}) — validation must reject BEFORE Promise.all` };
        }
      } finally {
        ctx.dispose();
      }
    }
    return { pass: true, reason: 'all three label-validation cases throw parallel_label_invalid before any cell runs' };
  },
};
