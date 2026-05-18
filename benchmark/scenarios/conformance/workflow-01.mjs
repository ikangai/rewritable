// WORKFLOW-01 — adding a step to an empty workflow file via apply_edits.
// This is the canonical second-prompt (and later) path per the v0.2 design:
// the first prompt uses replace_document to lay down the structure, then
// every subsequent step add / edit / remove goes through apply_edits.
//
// Verifies, against a minimal workflow-shape fixture:
//   1. The new <li class="rwa-step"> + <script type="text/rwa-step"> lands
//      without tripping structural_shape_changed (the SHAPE-02 exemption
//      applies through the realistic workflow shape).
//   2. The wf-style and runner frozen-zone markers survive byte-identical.
//   3. The committed doc has the step in the expected place.

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

const NEW_STEP = `<li class="rwa-step">
<header><h3>Greet</h3><p>Returns a string.</p></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return "hello"; }
</script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-01',
  category: 'WORKFLOW',
  description: 'apply_edits adds an <li class="rwa-step"> to an empty workflow — shape unchanged, frozen zones intact',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // setDoc bypasses runtime validation — necessary here because the
      // fixture introduces frozen zones that the seed default doesn't have.
      // The substrate's no-new-frozen-zones rule (frozenZonesIntact in
      // replaceDocument requires before.length === after.length) refuses
      // any agent-driven addition of zones, but a test fixture install
      // should not be subject to that rule.
      await ctx.setDoc(WF_BODY);
      const docBefore = await ctx.getDoc();
      // Anchor on the closing </ol>; replace with newStep + </ol>.
      // </ol> is unique in the doc (no nested workflow structures in v0.2).
      await ctx.applyEdits(
        {
          version: 'rwa-edit/1',
          edits: [{ find: '</ol>', replace: NEW_STEP + '</ol>' }],
        },
        docBefore,
      );
      const docAfter = await ctx.getDoc();

      // 1. Step landed.
      if (!docAfter.includes('class="rwa-step"')) {
        return { pass: false, reason: 'committed doc does not contain rwa-step <li>' };
      }
      // The new <h3>Greet</h3> must appear inside the <ol>.
      const olOpenIdx = docAfter.indexOf('<ol class="rwa-flow">');
      const olCloseIdx = docAfter.indexOf('</ol>', olOpenIdx);
      const stepInsideOl = docAfter.indexOf('<h3>Greet</h3>') > olOpenIdx
        && docAfter.indexOf('<h3>Greet</h3>') < olCloseIdx;
      if (!stepInsideOl) {
        return { pass: false, reason: 'new step is outside <ol class="rwa-flow">' };
      }
      // 2. Frozen-zone markers survived byte-identical.
      if (!docAfter.includes('<!-- rwa:frozen:begin wf-style -->\n<style>.rwa-step{border:1px solid #eee;}</style>\n<!-- rwa:frozen:end wf-style -->')) {
        return { pass: false, reason: 'wf-style frozen zone not byte-identical' };
      }
      if (!docAfter.includes("<!-- rwa:frozen:begin runner -->\n<script>(function(){'use strict';})();</script>\n<!-- rwa:frozen:end runner -->")) {
        return { pass: false, reason: 'runner frozen zone not byte-identical' };
      }
      return { pass: true, reason: 'step added inside <ol class="rwa-flow">; shape unchanged; both frozen zones intact' };
    } finally {
      ctx.dispose();
    }
  },
};
