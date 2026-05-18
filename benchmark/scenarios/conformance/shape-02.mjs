// SHAPE-02 — regression guard for the script-type exemption (commit 1190307
// + the workflow v0.2 product type). computeShape counts only EXECUTABLE
// scripts (no type, text/javascript, application/javascript, module) toward
// the doc's structural shape. Scripts with custom MIME types like
// text/rwa-step carry data, not behavior — adding or removing them must NOT
// trip structural_shape_changed.
//
// Without this exemption, the workflow product is unbuildable: every node
// insertion adds a <script type="text/rwa-step"> and would be rejected as
// a shape change.
//
// Setup: a doc with one executable script + one paragraph.
// Edit: insert a <script type="text/rwa-step"> next to the paragraph.
// Expect: applyEdits succeeds; the new script appears in the committed doc.

export default {
  id: 'SHAPE-02',
  category: 'SHAPE',
  description: 'applyEdits accepts adding a <script type="text/rwa-step"> — non-executable scripts exempt from the shape-count rule',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // setDoc bypasses runtime validation — the only safe way to install a
      // fixture with frozen zones or pre-injected data-rwa-id values. Without
      // it we'd hit either the no-new-frozen-zones rule or the auto-injection
      // of data-rwa-id onto anchorable elements (P, H1-H6, etc.), which
      // changes literal anchors out from under us.
      await ctx.setDoc('<article><script>window.foo=1;</script><p>x</p></article>');
      const docBefore = await ctx.getDoc();
      const newScript = '<script type="text/rwa-step">async function run(ctx, prev){return "ok";}</script>';
      // Anchor on the existing <script>...</script> — scripts aren't in
      // ANCHORABLE_TAGS, so no auto-injection touches them.
      await ctx.applyEdits(
        {
          version: 'rwa-edit/1',
          edits: [{ find: '<script>window.foo=1;</script>', replace: '<script>window.foo=1;</script>' + newScript }],
        },
        docBefore,
      );
      const docAfter = await ctx.getDoc();
      if (!docAfter.includes(newScript)) {
        return { pass: false, reason: 'committed doc does not contain the new <script type="text/rwa-step">' };
      }
      // Reaching this line proves the shape-check did not throw
      // structural_shape_changed — that's the regression we guard.
      return { pass: true, reason: 'text/rwa-step script added; shape-check exempted the non-executable type' };
    } finally {
      ctx.dispose();
    }
  },
};
