// benchmark/runners/hybrid-mode.mjs — supervisor + worker orchestration.
//
// Round 2 — atomic-apply iteration. Round 1 committed each tier-step
// independently via ctx.applyEdits / ctx.modify; the May 2026 hybrid run
// showed cumulative drift across commits on `mixed`-tag scenarios
// (meanT=0.33 vs DSL pro 0.89). Round 2 collects all step envelopes against
// an in-memory shadow doc and applies them atomically as a single
// apply_edits call when possible.
//
// Architecture under test:
//   1. SUPERVISOR (strong) reads doc + user instruction, emits a typed plan
//      via submit_plan. Sharper prompt for paste detection vs round 1.
//   2. For each step, the orchestrator dispatches in-memory:
//        structural → strong+DSL (runDslMode → compile)
//        content    → cheap+apply_edits (runApplyEditsMode — returns envelope)
//        paste      → verbatim insert envelope (no model)
//      Each step's envelope is applied to a shadow doc; subsequent steps see
//      the post-shadow state.
//   3. After all steps, the accumulated envelope is applied ONCE via
//      ctx.applyEdits, atomically. If any step emitted replace_document,
//      we fall back to per-step commits (those plans are rare and the
//      replace_document case is its own escape).

import { runDslMode } from './dsl-mode.mjs';
import { runApplyEditsMode } from './apply-edits-mode.mjs';
import { applyEnvelopeToDoc } from '../oracles/dsl-compiler.mjs';

const SUPERVISOR_SYSTEM_PROMPT = `You are an orchestrator for an HTML document editor. Decompose the user's instruction into a sequence of sub-steps via the \`submit_plan\` tool.

Each step has a \`tier\`:

1. **structural** — for HTML structure changes: insert/delete elements, add/change attributes, wrap, reorder. Dispatched to a strong worker that emits a constrained DSL plan. Use for: "add a row", "wrap each card", "rename a class", "delete an item", "change href".

2. **content** — for prose text changes: rewrite, translate, summarize, fix wording. Dispatched to a cheap worker that emits surgical find/replace edits. Use for: "rewrite this paragraph", "translate to French", "fix the typo", "tighten the prose".

3. **paste** — for VERBATIM insertion of literal content from the user's instruction. The user-supplied bytes are inserted exactly as-is, no model in the loop.

   USE PASTE WHEN: the user instruction includes a literal block of content (a code block, a CSV table, a long quoted prose excerpt, a JSON config) that should be inserted into the document AS-IS, with no rewriting or "improvement". This is the §6.1 "substantial paste" case.

   STRONG INDICATORS of paste:
   - The instruction contains the words "verbatim", "as-is", "paste", "insert this", "byte-identical", "exactly as written", "no reformatting", "no summarization".
   - The instruction contains a fenced code block, multi-row CSV, JSON, XML/HTML, or a long literal quote that is the content to be inserted.
   - The user supplies the content followed by a single insertion location.

   IF YOU DETECT PASTE: emit a SINGLE op with tier="paste". Do NOT split paste into multiple ops. Do NOT route paste content through the content tier — content workers WILL paraphrase it. Set:
   - paste_content: the EXACT bytes the user supplied. Preserve every space, newline, and special character verbatim. Do NOT rewrite, simplify, or fix typos.
   - paste_anchor_after: a unique substring already in the current document; the content will be inserted immediately after this substring. Choose an anchor that makes the insertion location unambiguous.

Mixed instructions like "add a 6th list item AND update the prose count from 'Five' to 'Six'" become two ops in order: structural (insert <li>) + content (update prose count). The shadow doc evolves between steps, so step N sees the post-step-(N-1) state.

Do NOT over-decompose. A single content rewrite that incidentally touches formatting is one op, not two. A single structural change with associated text update can be two coupled ops, but resist splitting cleanly atomic edits into more than they need.

For each step's \`instruction\`, write a clear single-purpose imperative. The dispatched worker sees the document plus your instruction, but does NOT see other ops in your plan. If a step depends on a previous step's effect, mention that effect in the instruction (e.g. "After the new <li> for 'Reason six' was added, update prose 'Five reasons' to 'Six reasons'").

CURRENT DOCUMENT:
<<<DOC>>>`;

const SUPERVISOR_TOOL_SCHEMA = [{
  type: 'function',
  function: {
    name: 'submit_plan',
    description: 'Submit the decomposed plan as an ordered sequence of typed sub-steps.',
    parameters: {
      type: 'object',
      required: ['ops'],
      properties: {
        ops: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['tier', 'instruction'],
            properties: {
              tier: { type: 'string', enum: ['structural', 'content', 'paste'] },
              instruction: { type: 'string', description: 'imperative for the worker; for paste tier it should describe the operation but the actual content goes in paste_content' },
              paste_content: { type: 'string', description: 'paste tier only: exact bytes to insert, byte-identical to user input' },
              paste_anchor_after: { type: 'string', description: 'paste tier only: unique substring in current doc; content inserted immediately after it' },
            },
          },
        },
      },
    },
  },
}];

function emptyTierStats() {
  return { fetch_calls: 0, tokens_in: 0, tokens_out: 0 };
}

function addStats(target, src) {
  target.fetch_calls += src.fetch_calls || 0;
  target.tokens_in += src.tokens_in || 0;
  target.tokens_out += src.tokens_out || 0;
}

/**
 * Run the supervisor + worker orchestration. Returns:
 *   { stats, plan, error, envelopeShape }
 * Applies the merged envelope to ctx itself.
 */
export async function runHybridMode(ctx, userPrompt, models) {
  const { supervisor, structuralWorker, contentWorker } = models;
  const stats = {
    supervisor: emptyTierStats(),
    structural: emptyTierStats(),
    content: emptyTierStats(),
    paste: emptyTierStats(),
  };

  const initialDoc = await ctx.getDoc();

  // ── 1. Supervisor: emit plan ────────────────────────────────────────
  const supSystemContent = SUPERVISOR_SYSTEM_PROMPT.replace('<<<DOC>>>', initialDoc);
  const supResp = await supervisor([
    { role: 'system', content: supSystemContent },
    { role: 'user', content: userPrompt },
  ], SUPERVISOR_TOOL_SCHEMA);
  stats.supervisor.fetch_calls++;
  stats.supervisor.tokens_in += supResp.usage?.prompt_tokens || 0;
  stats.supervisor.tokens_out += supResp.usage?.completion_tokens || 0;

  const supCall = supResp.tool_calls?.[0];
  if (!supCall || supCall.function?.name !== 'submit_plan') {
    return { stats, plan: null, error: { code: 'supervisor_no_plan' }, envelopeShape: 'none' };
  }
  let plan;
  try {
    plan = JSON.parse(supCall.function.arguments);
  } catch (err) {
    return { stats, plan: null, error: { code: 'supervisor_bad_json', message: err.message }, envelopeShape: 'none' };
  }
  if (!plan || !Array.isArray(plan.ops) || plan.ops.length === 0) {
    return { stats, plan, error: { code: 'supervisor_empty_plan' }, envelopeShape: 'none' };
  }

  // ── 2. Dispatch each step against an in-memory shadow doc ───────────
  // No commits between steps. Each worker sees the post-prior-step state via
  // the shadow; envelopes accumulate and apply once at the end.
  let shadow = initialDoc;
  const accumulated = []; // [{ tool, envelope }]

  for (const step of plan.ops) {
    const tier = step?.tier;
    let stepEnvelope = null;

    if (tier === 'structural') {
      const dslOut = await runDslMode(shadow, step.instruction || '', structuralWorker);
      addStats(stats.structural, dslOut.stats);
      if (dslOut.envelope) stepEnvelope = dslOut.envelope;
    } else if (tier === 'content') {
      const apOut = await runApplyEditsMode(shadow, step.instruction || '', contentWorker);
      addStats(stats.content, apOut.stats);
      if (apOut.envelope) stepEnvelope = apOut.envelope;
    } else if (tier === 'paste') {
      const anchor = step.paste_anchor_after;
      const content = step.paste_content;
      if (typeof anchor === 'string' && typeof content === 'string' && anchor.length > 0) {
        stepEnvelope = {
          tool: 'apply_edits',
          envelope: {
            version: 'rwa-edit/1',
            edits: [{ find: anchor, replace: anchor + content }],
          },
        };
      }
      // No model usage for paste tier; stats.paste stays at zero.
    }
    // Unknown tier → silently skipped (round-1 behaviour preserved).

    if (!stepEnvelope) continue;

    // Advance the shadow. If shadow-apply throws (anchor not unique, etc.),
    // discard this step's envelope rather than corrupt subsequent anchors.
    try {
      shadow = applyEnvelopeToDoc(shadow, stepEnvelope);
      accumulated.push(stepEnvelope);
    } catch (_shadowErr) {
      // step's envelope can't apply against shadow — skip it. The remaining
      // steps get the unchanged shadow.
    }
  }

  if (accumulated.length === 0) {
    return { stats, plan, error: { code: 'no_steps_applied' }, envelopeShape: 'empty' };
  }

  // ── 3. Apply accumulated envelopes via ctx ──────────────────────────
  // If all steps emitted apply_edits, merge them into ONE envelope and
  // commit atomically. This kills the per-step-commit drift we saw in
  // round 1 on `mixed`-tag scenarios.
  // If any step emitted replace_document, fall back to per-step commits in
  // order — replace_document mid-plan is the spec's escape hatch and rare.
  const allApplyEdits = accumulated.every(e => e.tool === 'apply_edits');
  const docNow = await ctx.getDoc();

  if (allApplyEdits) {
    const merged = {
      version: 'rwa-edit/1',
      edits: accumulated.flatMap(e => e.envelope.edits || []),
    };
    try {
      await ctx.applyEdits(merged, docNow);
      return { stats, plan, error: null, envelopeShape: 'merged_apply_edits', stepCount: accumulated.length };
    } catch (_applyErr) {
      // Merged apply rejected (frozen zone, structural shape, etc.). The
      // doc is unchanged; oracles score against the unchanged doc.
      return { stats, plan, error: { code: 'merged_apply_rejected', message: _applyErr?.message }, envelopeShape: 'merged_rejected' };
    }
  }

  // Mixed apply_edits + replace_document → commit each in order.
  for (const env of accumulated) {
    const cur = await ctx.getDoc();
    try {
      if (env.tool === 'apply_edits') {
        await ctx.applyEdits(env.envelope, cur);
      } else if (env.tool === 'replace_document') {
        await ctx.replaceDocument(env.envelope, cur);
      }
    } catch (_err) { /* per-step rejection; continue */ }
  }
  return { stats, plan, error: null, envelopeShape: 'mixed_per_step', stepCount: accumulated.length };
}

/**
 * Aggregate per-tier stats into the runner's flat shape (tokens_in, etc.).
 */
export function flattenStats(tierStats) {
  let tokens_in = 0, tokens_out = 0, fetch_calls = 0;
  for (const t of Object.values(tierStats)) {
    tokens_in += t.tokens_in;
    tokens_out += t.tokens_out;
    fetch_calls += t.fetch_calls;
  }
  return { tokens_in, tokens_out, tokens_total: tokens_in + tokens_out, fetch_calls };
}
