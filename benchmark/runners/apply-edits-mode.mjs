// benchmark/runners/apply-edits-mode.mjs — apply_edits/replace_document tool
// loop that returns the model's envelope WITHOUT committing it. Mirrors
// seeds/rewritable.html SYSTEM_PROMPT/TOOL_SCHEMAS so the worker sees the
// same surface as the production runtime.
//
// Used by hybrid-mode.mjs as the content-tier worker. Returning the envelope
// (rather than driving ctx.modify) lets the orchestrator accumulate
// envelopes and apply them atomically at end-of-plan, killing the
// per-step-commit drift we saw in the round-1 hybrid run.

// SYSTEM_PROMPT mirrors seeds/rewritable.html line 276. If you bump the seed,
// bump this too — keep them byte-equivalent so worker quality matches the
// production runtime path.
const SYSTEM_PROMPT = `You are editing a rewritable HTML document. Apply the user's request as a small set of surgical edits via tool calls.

You have two tools:
  • apply_edits — preferred. Submit (find, replace) pairs. Each find must be a non-empty literal substring that appears exactly once in the doc.
  • replace_document — escape hatch. Use only for scaffolding a fresh document, or when the user explicitly asked for a wholesale redesign.

Rules for apply_edits:
  • Copy anchors from the doc verbatim. Do not retype them.
  • Whitespace and line endings in find must match the doc exactly.
  • If your natural anchor is not unique, extend it with surrounding context until it is.
  • Never include the substrings rwa:frozen:begin, rwa:frozen:end, the HTML/CSS/JS comment prefixes that start with rwa: (HTML <!--, CSS /*, JS //), or the attribute name data-rwa-frozen in find or replace. Frozen zones are listed in the user message and are off-limits.
  • Do not add or remove <script> or <style> tags via apply_edits — that requires replace_document.
  • If your edit's anchor would be longer than the changed region itself, replace_document is probably more appropriate.

Rules for replace_document:
  • Frozen-zone marker pairs and data-rwa-frozen elements must appear in the new doc with byte-identical content. They are author-declared invariants.
  • Provide a reason explaining why apply_edits was not appropriate.

If the user's input is itself substantial content (a long block of prose, an outline, a list of items), they want it rendered into the document, not summarized. When no surgical anchor exists for substantial content insertion, use replace_document.

Always call a tool. Respond with text-only only when you genuinely need to ask for clarification before editing.`;

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'apply_edits',
      description: 'Apply anchor-based string edits. Each edit specifies a literal substring to find (unique in the doc) and a replacement. Edits are applied in order, atomically. Frozen zones (rwa:frozen markers and data-rwa-frozen elements) are off-limits. <script>/<style> tag counts must not change.',
      parameters: {
        type: 'object',
        required: ['version', 'edits'],
        properties: {
          version: { type: 'string', enum: ['rwa-edit/1'] },
          reason: { type: 'string' },
          edits: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              required: ['find', 'replace'],
              properties: {
                find: { type: 'string', minLength: 1 },
                replace: { type: 'string' },
                reason: { type: 'string' }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_document',
      description: 'Wholesale-replace the document. Use only for scaffolding a fresh document or for a wholesale redesign the user explicitly requested. Frozen zones (rwa:frozen markers and data-rwa-frozen elements) must be preserved byte-identically.',
      parameters: {
        type: 'object',
        required: ['version', 'doc', 'reason'],
        properties: {
          version: { type: 'string', enum: ['rwa-edit/1'] },
          doc: { type: 'string' },
          reason: { type: 'string', minLength: 1 }
        }
      }
    }
  }
];

// Mirror seeds/rewritable.html buildUserPrompt() shape.
function buildUserPrompt(instr, doc, frozenZones) {
  const fzText = frozenZones.length === 0
    ? '(none)'
    : frozenZones.map(z => '- ' + z.name).join('\n');
  return 'User request:\n' + instr
    + '\n\nFrozen zones in the current doc (do not produce marker text in find/replace; do not modify their inner content):\n' + fzText
    + '\n\nThe current document follows. Make your edit by calling apply_edits or replace_document.\n\n<DOC>\n' + doc + '\n</DOC>';
}

// Lightweight frozen-zone scan — picks up `<!-- rwa:frozen:begin <name> -->`
// markers. Misses `data-rwa-frozen` attribute zones (would need an HTML
// parser); accepted for the benchmark, which mostly uses comment-marker form.
function extractFrozenZones(doc) {
  const out = [];
  const re = /<!--\s*rwa:frozen:begin\s+(\S+)\s*-->/g;
  let m;
  while ((m = re.exec(doc)) !== null) out.push({ name: m[1] });
  return out;
}

/**
 * One model loop emitting apply_edits or replace_document. Returns the
 * envelope as { tool, envelope } so the orchestrator can apply atomically.
 *
 * Multi-turn retry on JSON parse failure only. Application validation
 * (anchor uniqueness, frozen zone breach, etc.) is deferred to the caller's
 * apply step — matching how the round-1 hybrid failed silently on bad
 * envelopes; making the worker self-correct on apply errors is a future
 * iteration if real-model data shows that loop is needed.
 *
 * @param {string} doc — LF-canonical doc
 * @param {string} userPrompt — instruction
 * @param {(messages, tools) => Promise<{tool_calls, usage}>} model
 * @param {object} [opts]
 * @param {number} [opts.retryBudget=3]
 */
export async function runApplyEditsMode(doc, userPrompt, model, opts = {}) {
  const retryBudget = opts.retryBudget ?? 3;
  const frozenZones = extractFrozenZones(doc);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(userPrompt, doc, frozenZones) },
  ];
  const stats = { fetch_calls: 0, tokens_in: 0, tokens_out: 0 };
  let lastError = null;

  for (let attempt = 0; attempt < retryBudget; attempt++) {
    stats.fetch_calls++;
    const resp = await model(messages, TOOL_SCHEMAS);
    stats.tokens_in += resp.usage?.prompt_tokens || 0;
    stats.tokens_out += resp.usage?.completion_tokens || 0;

    const call = resp.tool_calls?.[0];
    if (!call) {
      return { envelope: null, stats, error: { code: 'no_tool_call' } };
    }
    const name = call.function?.name;
    if (name !== 'apply_edits' && name !== 'replace_document') {
      return { envelope: null, stats, error: { code: 'wrong_tool', message: name } };
    }
    let parsed;
    try {
      parsed = JSON.parse(call.function.arguments);
    } catch (err) {
      lastError = { code: 'arguments_not_json', message: err.message };
      messages.push({ role: 'assistant', content: '', tool_calls: [call] });
      messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(lastError) });
      continue;
    }
    return { envelope: { tool: name, envelope: parsed }, stats, error: null };
  }
  return { envelope: null, stats, error: lastError };
}
