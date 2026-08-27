// HOST-01 — "one contract, one more door": the HOSTED apply path yields a
// result byte-identical to the SUBSTRATE/seed apply of the same envelope on the
// same starting doc.
//
// The hosted-edit runtime (service/) is a NEW surface on the SAME rwa-edit/1
// contract — its /modify endpoint runs the vendored CLI apply pipeline
// (service/lib/edit.mjs applyPlan, byte-identical to cli/src) server-side
// instead of the browser/IDB substrate running window.applyEdits. The whole
// design rests on these two doors producing the SAME bytes for the SAME edit:
// a file edited in the hosted runtime and the same file edited locally in the
// browser must converge, or "the file stays canonical" is a lie.
//
// This scenario proves that convergence end-to-end and pure-node:
//   • SUBSTRATE side — the seed's window.applyEdits(envelope, body) (the exact
//     oracle every other CONFORM-* scenario uses) → the post-edit editable body.
//   • HOSTED side — splice the SAME body into a real rewritable (the seed
//     bytes), run the vendored file-level applyPlan (what /modify executes),
//     read the file back, extract its INLINE_DOC body.
//   • Assert the two bodies are byte-identical, AND that the edit actually
//     landed (guards against both paths silently no-op'ing to the same input).
//
// Byte-parity of the vendored pipeline vs the CLI pipeline, and of the actual
// /modify handler, is separately pinned by service/tests/{vendored-apply,
// hosted}.test.mjs. This scenario closes the loop the conformance suite owns:
// hosted apply == SUBSTRATE apply, in the same harness as every other CONFORM.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The hosted runtime's vendored apply pipeline — the same modules /modify runs.
import { applyPlan } from '../../../service/lib/edit.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../../../service/lib/seed.mjs';

export default {
  id: 'HOST-01',
  category: 'HOST',
  description: 'hosted apply (vendored applyPlan) === substrate apply (seed window.applyEdits), byte-identical',
  weight: 1,

  async run({ harness }) {
    // LF-only body so canonLF is a no-op and the round-trip is exact on both
    // sides. A unique anchor ("Quarterly Review") + a frozen zone that the edit
    // must leave untouched — so a real validating apply runs on both paths.
    const body =
      '<article><h1>Quarterly Review</h1>' +
      '<p>Revenue grew across all regions this period.</p>' +
      '<!-- rwa:frozen:begin sig --><footer>Approved by Finance</footer><!-- rwa:frozen:end sig -->' +
      '</article>';
    const envelope = {
      version: 'rwa-edit/1',
      edits: [{ find: 'Revenue grew across all regions', replace: 'Revenue grew sharply in EMEA' }],
    };

    // ── SUBSTRATE side: the seed's own window.applyEdits, the oracle every
    // other CONFORM-* scenario uses. Returns the post-edit editable body.
    const ctx = await harness.fresh();
    let substrateBody;
    try {
      substrateBody = await ctx.applyEdits(structuredClone(envelope), body);
    } finally {
      ctx.dispose();
    }

    // ── HOSTED side: splice the SAME body into the SAME seed bytes, then run
    // the vendored file-level applyPlan (the code path /modify executes) and
    // read the resulting INLINE_DOC body back out.
    const dir = mkdtempSync(join(tmpdir(), 'rwa-host-01-'));
    let hostedBody;
    try {
      const file = join(dir, 'hosted.html');
      writeFileSync(file, replaceInlineDoc(harness.SEED_BYTES, body), 'utf8');
      const r = await applyPlan(file, structuredClone(envelope));
      if (r.exitCode !== 0) {
        return { pass: false, reason: `hosted applyPlan exitCode=${r.exitCode}` };
      }
      hostedBody = extractInlineDoc(readFileSync(file, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // #32: `data-rwa-id` backfill is a COMMIT-stage concern on both surfaces —
    // the seed injects it in commitDoc, not in window.applyEdits, and the file
    // pipeline injects it in applyPlan, which is the CLI's commit. So the two
    // sides of THIS comparison are at different layers with respect to ids, and
    // the ids themselves come from a CSPRNG and can never compare byte-wise.
    //
    // Strip them from both sides rather than weaken what this scenario asserts:
    // hosted apply and substrate apply must agree on the CONTENT transformation.
    // That the two surfaces also agree on WHICH blocks get an id — same tag set,
    // same frozen-zone skips, same outer-wins scan — is pinned separately and
    // far more precisely by tests/block-id-parity.mjs (37 property checks).
    const stripIds = (s) => s.replace(/ data-rwa-id="[a-z2-7]{8}"/g, '');
    hostedBody = stripIds(hostedBody);
    substrateBody = stripIds(substrateBody);

    // The load-bearing assertion: same envelope, same starting doc → same bytes.
    if (hostedBody !== substrateBody) {
      // Surface the first divergence point to make a regression debuggable.
      let i = 0;
      while (i < hostedBody.length && i < substrateBody.length && hostedBody[i] === substrateBody[i]) i++;
      return {
        pass: false,
        reason: `hosted apply diverged from substrate apply at byte ${i} ` +
          `(hosted=${hostedBody.length}b, substrate=${substrateBody.length}b)`,
      };
    }

    // Guard: the edit must actually have landed on the shared body — otherwise
    // both paths could agree by being no-ops on the original input.
    if (!hostedBody.includes('Revenue grew sharply in EMEA') ||
        hostedBody.includes('Revenue grew across all regions')) {
      return { pass: false, reason: 'edit did not land — both paths agreed on an un-applied no-op' };
    }
    // Guard: the frozen zone survived byte-identically (a real validating apply).
    if (!hostedBody.includes('<!-- rwa:frozen:begin sig --><footer>Approved by Finance</footer><!-- rwa:frozen:end sig -->')) {
      return { pass: false, reason: 'frozen zone not preserved by the apply' };
    }

    return { pass: true, reason: `hosted apply === substrate apply, byte-identical (${hostedBody.length}b)` };
  },
};
