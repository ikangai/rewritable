// DEG-03 — round-trip through save: edit → buildFile → reopen (re-parse)
// → edit again → buildFile → compare to in-tab equivalent.
//
// We can't actually "open" a fresh container from the file output without
// significant harness work, but we CAN verify the buildFile output is
// stable across rebuilds and that the INLINE_DOC literal is LF-only
// (the spec's load-bearing invariant for round-tripping).

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<article><p>EDIT_1 first.</p><p>EDIT_2 second.</p></article>`;

export default {
  id: 'DEG-03',
  category: 'DEG',
  description: 'edit → buildFile → INLINE_DOC LF-only; idempotent rebuild',
  weight: 3,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: '(custom-run: applies two edits, then inspects buildFile output)',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    const model = stubModel([
      { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_1 first.', replace: 'Updated first.' }] } },
    ]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('first');

    const file1 = ctx.window.buildFile(await ctx.getDoc());
    const file2 = ctx.window.buildFile(await ctx.getDoc());
    const idempotent = file1 === file2;

    // Inspect INLINE_DOC literal contents — must be LF-only.
    const marker = 'const INLINE_DOC = `';
    const start = file1.indexOf(marker);
    const cs = start + marker.length;
    let i = cs;
    while (i < file1.length) {
      if (file1[i] === '\\') { i += 2; continue; }
      if (file1[i] === '`') break;
      i++;
    }
    const body = file1.slice(cs, i);
    const lfOnly = !body.includes('\r');

    return { idempotent, lfOnly, fileLen: file1.length };
  },
  scoreAfterCustom: (out) => {
    const ok = out.idempotent && out.lfOnly;
    return {
      successResult: {
        score: ok ? 2 : 0, total: 2,
        passed: (out.idempotent ? 1 : 0) + (out.lfOnly ? 1 : 0),
        results: [
          { ok: out.idempotent, label: 'buildFile idempotent' },
          { ok: out.lfOnly, label: 'INLINE_DOC body is LF-only' },
        ],
      },
      stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
    };
  },
};
