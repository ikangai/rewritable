// WORKFLOW-02 — two sequential step inserts. Verifies the multi-step
// workflow product flow:
//   1. Each insert lands at the end of <ol class="rwa-flow"> in the order
//      they were applied (Greet first, then Shout).
//   2. The substrate auto-injects data-rwa-id on every committed <li>
//      (LI is in ANCHORABLE_TAGS; the doc is id-blessed via the seed h1).
//   3. The audit log accumulates two edit_batch records — one per insert.

const WF_BODY = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Test workflow</h1></header>
<ol class="rwa-flow">
</ol>
<footer><button class="rwa-run">Run</button></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){'use strict';})();</script>
<!-- rwa:frozen:end runner -->`;

const stepHtml = (title, body) => `<li class="rwa-step">
<header><h3>${title}</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
${body}
</script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-02',
  category: 'WORKFLOW',
  description: 'two sequential step inserts — order preserved, data-rwa-id assigned to each, audit log records both',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // setDoc bypasses runtime validation (see WORKFLOW-01 for the
      // no-new-frozen-zones rationale).
      await ctx.setDoc(WF_BODY);

      // Insert 1: Greet.
      let doc = await ctx.getDoc();
      await ctx.applyEdits(
        {
          version: 'rwa-edit/1',
          edits: [{
            find: '</ol>',
            replace: stepHtml('Greet', 'async function run(ctx, prev){return "hi";}') + '</ol>',
          }],
        },
        doc,
      );

      // Insert 2: Shout. Re-read post-commit doc so the anchor resolves
      // against the new state. </ol> is still unique.
      doc = await ctx.getDoc();
      await ctx.applyEdits(
        {
          version: 'rwa-edit/1',
          edits: [{
            find: '</ol>',
            replace: stepHtml('Shout', 'async function run(ctx, prev){return prev.toUpperCase();}') + '</ol>',
          }],
        },
        doc,
      );

      const finalDoc = await ctx.getDoc();

      // 1. Order check — Greet's <h3> precedes Shout's.
      const greetIdx = finalDoc.indexOf('<h3>Greet</h3>');
      const shoutIdx = finalDoc.indexOf('<h3>Shout</h3>');
      if (greetIdx < 0 || shoutIdx < 0) {
        return { pass: false, reason: 'one or both step headings missing in final doc' };
      }
      if (greetIdx >= shoutIdx) {
        return { pass: false, reason: 'step order wrong — Greet should precede Shout' };
      }

      // 2. data-rwa-id assigned to each rwa-step <li>. The runtime injects
      //    on commit because the doc is id-blessed (the seed h1 carries one).
      const liMatches = [...finalDoc.matchAll(/<li[^>]*class="rwa-step"[^>]*>/g)];
      if (liMatches.length !== 2) {
        return { pass: false, reason: `expected 2 <li class="rwa-step">, got ${liMatches.length}` };
      }
      for (const m of liMatches) {
        if (!/data-rwa-id="[a-z0-9]{8}"/.test(m[0])) {
          return { pass: false, reason: `<li> missing data-rwa-id: ${m[0]}` };
        }
      }

      // 3. Audit log: 2 edit_batch entries from the two inserts.
      //    (Plus 1 replace_document from the setup; we don't assert on that.)
      const hist = await ctx.getHistory();
      const batches = hist.filter(h => h?.kind === 'edit_batch');
      if (batches.length !== 2) {
        return { pass: false, reason: `expected 2 edit_batch entries in rwa_hist, got ${batches.length}` };
      }

      return {
        pass: true,
        reason: 'two inserts; order preserved; both <li> have data-rwa-id; audit log has 2 edit_batch records',
      };
    } finally {
      ctx.dispose();
    }
  },
};
