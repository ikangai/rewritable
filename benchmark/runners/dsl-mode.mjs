// benchmark/runners/dsl-mode.mjs — model-driven DSL plan path.
//
// Parallel to the runtime's modify() pathway, but the model emits an
// `apply_dsl_plan` tool call instead of `apply_edits`/`replace_document`. We
// compile the plan via dsl-compiler.mjs and apply through ctx.applyEdits /
// ctx.replaceDocument so runtime validation (mutex, frozen zones, structural
// shape) still runs.
//
// The runtime does NOT yet ship a DSL tool surface — this module exists to
// measure whether a real model can write good DSL plans BEFORE we modify
// seeds/rewritable.html. If the answer is "no", we don't ship the runtime
// change. If "yes", the runtime graft has empirical justification.

import { compileDslPlan, DslCompileError } from '../oracles/dsl-compiler.mjs';

export const DSL_TOOL_SCHEMA = [{
  type: 'function',
  function: {
    name: 'apply_dsl_plan',
    description: "Apply a structural transform plan to the current document. Use this for any structural change. For prose rewrites or wholesale redesigns, use replace_document op as the sole op in the plan.",
    parameters: {
      type: 'object',
      required: ['version', 'ops'],
      properties: {
        version: { type: 'string', enum: ['rwa-edit-dsl/1'] },
        ops: {
          type: 'array',
          minItems: 1,
          description: 'Sequence of ops applied in order. Anchors in op N+1 must match the doc as if op N had already been applied.',
          items: {
            oneOf: [
              {
                type: 'object', required: ['op', 'find', 'replace'],
                properties: {
                  op: { const: 'replace' },
                  find: { type: 'string', description: 'unique substring to replace; or unique within `region` if scoped' },
                  replace: { type: 'string' },
                  region: { type: 'string', description: 'optional: anchor pair scoping the search window' },
                  all: { type: 'boolean', description: 'optional: replace all matches in the search window (default false)' },
                },
              },
              {
                type: 'object', required: ['op', 'content'],
                properties: {
                  op: { const: 'insert' },
                  content: { type: 'string', description: 'new bytes to insert' },
                  after: { type: 'string', description: 'unique anchor; content goes after the anchor' },
                  before: { type: 'string', description: 'unique anchor; content goes before the anchor' },
                },
              },
              {
                type: 'object', required: ['op', 'target'],
                properties: {
                  op: { const: 'delete' },
                  target: { type: 'string', description: 'unique substring to remove' },
                },
              },
              {
                type: 'object', required: ['op', 'anchor', 'attr', 'value'],
                properties: {
                  op: { const: 'set_attr' },
                  anchor: { type: 'string', description: 'partial opening tag, must start with `<` and end BEFORE the closing `>`. Example: `<p class="callout"` (no trailing `>`)' },
                  attr: { type: 'string' },
                  value: { type: 'string' },
                },
              },
              {
                type: 'object', required: ['op', 'doc', 'reason'],
                properties: {
                  op: { const: 'replace_document' },
                  doc: { type: 'string', description: 'entire new document' },
                  reason: { type: 'string' },
                },
              },
            ],
          },
        },
      },
    },
  },
}];

const SYSTEM_PROMPT = `You are an editor for an HTML document. The user gives an instruction; you respond by calling the \`apply_dsl_plan\` tool with a structured-edit plan.

The plan is a JSON object with version "rwa-edit-dsl/1" and an array of ops. Each op is one of:

- \`replace\` — { "op": "replace", "find": "<unique substring>", "replace": "<new substring>" }
- \`insert\` — { "op": "insert", "content": "<new bytes>", "after": "<unique anchor>" }  (or "before")
- \`delete\` — { "op": "delete", "target": "<unique substring>" }
- \`set_attr\` — { "op": "set_attr", "anchor": "<partial opening tag, no trailing \\\`>\\\`>", "attr": "<name>", "value": "<value>" }
- \`replace_document\` — { "op": "replace_document", "doc": "<entire new doc>", "reason": "<short why>" }   (must be the SOLE op if used)

Rules:
1. Anchors and \`find\`/\`target\` substrings MUST be uniquely locatable in the current document. If the substring you want to anchor on appears multiple times, extend it with surrounding context until it's unique.
2. For changes that affect N similar elements (e.g. rename a class on every card), emit N separate ops, each anchored on enough context to be unique.
3. Use \`replace_document\` ONLY for wholesale redesigns or pure-prose rewrites where structural transforms don't fit — every other case prefers the four positive ops because they preserve untouched bytes byte-identical.
4. Frozen zones are HTML regions marked with \`<!-- rwa:frozen:begin <name> -->\` ... \`<!-- rwa:frozen:end <name> -->\` (or \`data-rwa-frozen\`). The runtime will reject any op that modifies content inside a frozen zone.
5. Do not emit reserved markers in your op fields: \`rwa:frozen:begin\`, \`rwa:frozen:end\`, \`<!-- rwa:\`, \`/* rwa:\`, \`// rwa:\`, \`data-rwa-frozen\`.

If your op fails (anchor non-unique, anchor not found, frozen zone violation, etc.), the runtime will tell you what went wrong via a tool_result. Adjust and try again — you have up to 3 attempts.

CURRENT DOCUMENT:
<<<DOC>>>`;

const FROZEN_ZONE_HINT = `\n\nFrozen zones in this document: <<<FROZEN>>>`;

/**
 * Run one DSL-mode round against a model. Returns:
 *   { envelope, plan, stats, error }
 *
 * `envelope` is the compiled rwa-edit/1 envelope (apply_edits or replace_document)
 * ready to hand to ctx.applyEdits / ctx.replaceDocument. Null if the model
 * never produced a compileable plan within the retry budget.
 *
 * `stats` covers the model side only (token counts, fetch calls).
 *
 * @param {string} doc — current doc text (LF-canonical)
 * @param {string} userPrompt — the user's instruction
 * @param {(messages, tools) => Promise<{tool_calls, usage}>} model — model fn
 * @param {object} [opts]
 * @param {string[]} [opts.frozenZones] — zone names to declare in the prompt
 * @param {number} [opts.retryBudget] — default 3 (matches rwa-edit/1)
 */
export async function runDslMode(doc, userPrompt, model, opts = {}) {
  const retryBudget = opts.retryBudget ?? 3;
  const frozenZones = opts.frozenZones ?? [];

  let systemContent = SYSTEM_PROMPT.replace('<<<DOC>>>', doc);
  if (frozenZones.length > 0) {
    systemContent += FROZEN_ZONE_HINT.replace('<<<FROZEN>>>', frozenZones.join(', '));
  }

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userPrompt },
  ];

  const stats = { fetch_calls: 0, tokens_in: 0, tokens_out: 0 };
  let lastError = null;

  for (let attempt = 0; attempt < retryBudget; attempt++) {
    stats.fetch_calls++;
    const resp = await model(messages, DSL_TOOL_SCHEMA);
    stats.tokens_in += resp.usage?.prompt_tokens || 0;
    stats.tokens_out += resp.usage?.completion_tokens || 0;

    const call = resp.tool_calls?.[0];
    if (!call) {
      // Model returned prose without a tool call — clean exit, no commit.
      return { envelope: null, plan: null, stats, error: { code: 'no_tool_call', message: 'model returned no tool_call' } };
    }
    if (call.function?.name !== 'apply_dsl_plan') {
      return { envelope: null, plan: null, stats, error: { code: 'wrong_tool', message: `expected apply_dsl_plan, got ${call.function?.name}` } };
    }

    let plan;
    try {
      plan = JSON.parse(call.function.arguments);
    } catch (err) {
      lastError = { code: 'arguments_not_json', message: err.message };
      messages.push({ role: 'assistant', content: '', tool_calls: [call] });
      messages.push({ role: 'tool', tool_call_id: call.id, name: 'apply_dsl_plan', content: JSON.stringify(lastError) });
      continue;
    }

    try {
      const envelope = compileDslPlan(plan, doc);
      return { envelope, plan, stats, error: null };
    } catch (err) {
      if (err instanceof DslCompileError) {
        lastError = { code: err.code, message: err.message };
      } else {
        lastError = { code: 'compile_unknown', message: err.message };
      }
      messages.push({ role: 'assistant', content: '', tool_calls: [call] });
      messages.push({ role: 'tool', tool_call_id: call.id, name: 'apply_dsl_plan', content: JSON.stringify(lastError) });
    }
  }

  return { envelope: null, plan: null, stats, error: lastError };
}
