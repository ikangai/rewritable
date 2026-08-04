// SHAPE-01 — rule 9 + rule 10 reinforcement: shape preservation under
// apply_edits, no silent escalation to replace_document.
//
// Scripts: this scenario uses the modify() multi-turn loop with stubbed
// fetch. We set up an initial doc with a <script> (via replaceDocument),
// then have the "model" emit apply_edits removing the script. The runtime
// should reject with structural_shape_changed (computeShape catches script
// count changes) and feed the failure back. The model's second turn emits
// replace_document with a non-script doc. The runtime applies it.
//
// Assertions:
//   - modify() succeeds (final state has no script)
//   - rwa_hist's newest entry is { kind: 'replace_document' } from the retry
//   - No 'edit_batch' record exists for the rejected turn-1 envelope (a
//     silent-escalation runtime would write one)

export default {
  id: 'SHAPE-01',
  category: 'SHAPE',
  description: 'apply_edits shape change → rejection + model-driven replace_document retry',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // Setup: a doc with a <script>. Use the fixture-only ctx.setDoc bypass
      // rather than ctx.replaceDocument — since issue #5, replaceDocument
      // itself refuses to INCREASE the script count unless scripts are
      // allowed for this container (this harness boots PRODUCT_KIND ===
      // 'document' with no rwa_state override), which is exactly what would
      // happen here. That gate is orthogonal to what SHAPE-01 exercises
      // (apply_edits shape rejection + a replace_document retry that REMOVES
      // the script, a decrease the gate never blocks) — setDoc seeds the
      // fixture without going through runtime validation at all.
      await ctx.setDoc('<div class="hello"><script>window.foo=1;</script><p>x</p></div>');

      // Stub the model: turn 1 emits apply_edits removing the script;
      // turn 2 emits replace_document with a no-script doc.
      let turn = 0;
      ctx.setFetchHandler(async () => {
        turn++;
        let toolCall;
        if (turn === 1) {
          toolCall = {
            id: 'call_1', type: 'function',
            function: {
              name: 'apply_edits',
              arguments: JSON.stringify({
                version: 'rwa-edit/1',
                edits: [{ find: '<script>window.foo=1;</script>', replace: '' }],
              }),
            },
          };
        } else if (turn === 2) {
          toolCall = {
            id: 'call_2', type: 'function',
            function: {
              name: 'replace_document',
              arguments: JSON.stringify({
                version: 'rwa-edit/1',
                doc: '<div class="hello"><p>x</p></div>',
                reason: 'rule 9 forced escalation to replace_document',
              }),
            },
          };
        } else {
          throw new Error(`unexpected turn ${turn}`);
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: { role: 'assistant', content: '', tool_calls: [toolCall] },
            }],
          }),
        };
      });

      await ctx.modify('remove the script');

      const docAfter = await ctx.getDoc();
      if (docAfter.includes('<script>')) {
        return { pass: false, reason: 'script not removed — modify() did not succeed' };
      }
      if (turn !== 2) {
        return { pass: false, reason: `expected 2 model turns, got ${turn}` };
      }

      const hist = await ctx.getHistory();
      // newest-first ordering per spec §12
      if (!hist[0] || hist[0].kind !== 'replace_document') {
        return { pass: false, reason: `expected hist[0] = replace_document, got ${JSON.stringify(hist[0])}` };
      }
      // The rejected turn-1 envelope must NOT appear as an edit_batch record.
      const editBatchEntries = hist.filter(h => h?.kind === 'edit_batch');
      if (editBatchEntries.length > 0) {
        return {
          pass: false,
          reason: `silent escalation detected — ${editBatchEntries.length} edit_batch record(s) present despite apply_edits being rejected`,
        };
      }
      return { pass: true, reason: 'apply_edits rejected (script count), model retried with replace_document, no silent escalation' };
    } finally {
      ctx.dispose();
    }
  },
};
