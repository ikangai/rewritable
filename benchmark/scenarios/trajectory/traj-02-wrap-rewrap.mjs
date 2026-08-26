// TRAJ-02 — repeated re-skinning of the pricing paragraph: each step wraps
// the CURRENT innermost wrapper one layer deeper in a new div with a fresh,
// never-reused class name, the way a "re-skin" that never cleans up its
// prior wrapper would. This is the class-accretion shape coherence.mjs's
// classChurn + growth dimensions exist to catch: per-edit fidelity is
// perfect on every single commit (each edit is one clean find/replace
// against unique, present text) while the doc silently grows a dozen nested
// wrapper layers.
//
// The wrap target is nested INSIDE <section id="pricing">, not the section
// itself — wrapping a TOP-LEVEL element is a real structural_shape_changed
// rejection (the runtime's computeShape() tracks the SET of top-level tag
// names precisely so apply_edits can't sneak in a new top-level wrapper;
// this is the same guard CLAUDE.md's skinning design routes around with its
// dedicated compose-then-commit primitive, not plain apply_edits). Nesting
// the wrap one level in exercises the same accretion shape a real
// "re-skin just this block" session produces, without hitting that guard.
//
// The FAQ section is left untouched throughout — a control showing this is a
// targeted, not whole-doc, accretion.

const PARAGRAPH = '<p>Standard plan: $29/month. Team plan: $99/month, includes 10 seats.</p>';

const START_DOC = `<section id="pricing">
<h2>Pricing</h2>
${PARAGRAPH}
</section>

<section id="faq">
<h2>FAQ</h2>
<p>Can I cancel anytime? Yes — no long-term contract.</p>
</section>

<style>
#pricing { padding: 24px; }
#faq { padding: 24px; }
.sk-base { color: #222; }
</style>`;

const THEMES = ['sunrise', 'dusk', 'forest', 'ocean', 'ember', 'slate', 'coral', 'mint', 'plum', 'sand', 'cloud', 'ash'];

function buildSteps() {
  const steps = [];
  let block = PARAGRAPH;
  for (let i = 1; i <= THEMES.length; i++) {
    const theme = THEMES[i - 1];
    const wrapped = `<div class="sk-wrap-${i} sk-theme-${theme}">\n${block}\n</div>`;
    steps.push({
      prompt: `Apply the "${theme}" skin to the pricing paragraph.`,
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [{ find: block, replace: wrapped }] },
    });
    block = wrapped;
  }
  return steps;
}

export default {
  id: 'TRAJ-02',
  description: '12 repeated re-skins of the pricing paragraph, each adding a new wrapper div/class without removing the last — the class-accretion shape',
  startDoc: START_DOC,
  steps: buildSteps(),
};
