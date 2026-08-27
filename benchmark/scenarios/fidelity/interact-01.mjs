// INTERACT-01 — kanban-style with localStorage; user moves card C from
// "todo" to "doing"; trigger an unrelated edit; card C remains in "doing"
// after re-render (because state persisted to localStorage).

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<div id="board">
<div class="col" data-col="todo"><h3>todo</h3><div class="cards"></div></div>
<div class="col" data-col="doing"><h3>doing</h3><div class="cards"></div></div>
</div>
<script>
(function() {
  const state = JSON.parse(localStorage.getItem('rwa_kanban_demo') || '{"todo":["A","B","C"],"doing":[]}');
  function render() {
    document.querySelectorAll('.col').forEach(col => {
      const k = col.getAttribute('data-col');
      col.querySelector('.cards').innerHTML = state[k].map(c => '<div class="card">' + c + '</div>').join('');
    });
  }
  render();
})();
</script>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'INTERACT-01',
  // scoreAfterCustom returns a HARDCODED stabilityResult (score: 2) — this scenario
  // asserts runtime behaviour, not document bytes, so it carries no drift dimension.
  driftProbe: 'none',
  category: 'INTERACT',
  tag: 'content',
  description: 'kanban state in localStorage persists across edit; card C still in "doing"',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    // Move card C from todo to doing — write directly to localStorage.
    ctx.window.localStorage.setItem('rwa_kanban_demo', JSON.stringify({ todo: ['A', 'B'], doing: ['C'] }));

    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');
    await new Promise(r => setTimeout(r, 50));

    const doing = Array.from(ctx.window.document.querySelectorAll('[data-col="doing"] .card')).map(c => c.textContent);
    return { doing };
  },
  scoreAfterCustom: (out) => {
    const ok = JSON.stringify(out.doing) === JSON.stringify(['C']);
    return {
      successResult: { score: ok ? 2 : 0, total: 1, passed: ok ? 1 : 0, results: [{ ok, label: `doing=${JSON.stringify(out.doing)}` }] },
      stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
    };
  },
};
