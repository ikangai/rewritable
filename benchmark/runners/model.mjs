// Model abstraction for the fidelity runner.
//
// A "model" is an async function:
//   (messages, tools) -> { tool_calls: ToolCall[], usage: { prompt_tokens, completion_tokens } }
//
// Two implementations:
//
// 1. stubModel(spec) — returns a function that emits exactly the configured
//    tool call. Useful for testing the harness wiring without burning API
//    credits. Includes synthetic token counts based on message length.
//
// 2. openRouterModel(opts) — wraps OpenRouter. Reads RWA_OPENROUTER_KEY from
//    env and the model name from opts.model. NOT exercised in this loop —
//    requires an API key the loop doesn't have access to.
//
// Both produce a `fetch` handler suitable for harness.setFetchHandler().

/**
 * @typedef {Object} ToolCallSpec
 * @property {string} name — 'apply_edits' or 'replace_document'
 * @property {object} envelope — the rwa-edit/1 envelope to send
 */

/**
 * Build a stub model from a list of turn specs. The first turn yields the
 * first spec; subsequent turns advance the index. After exhausting the list,
 * subsequent calls throw — surfacing harness misconfiguration loudly rather
 * than looping silently.
 *
 * Each turn spec can also be a function (messages, tools) => ToolCallSpec
 * for richer behavior (e.g. emit different envelopes based on prior tool
 * results).
 *
 * @param {(ToolCallSpec | ((messages: any[], tools: any) => ToolCallSpec))[]} turns
 * @returns {(messages: any[], tools: any) => Promise<{ tool_calls, usage }>}
 */
export function stubModel(turns) {
  let idx = 0;
  return async (messages, tools) => {
    if (idx >= turns.length) {
      throw new Error(`stubModel: exhausted at turn ${idx + 1} (only ${turns.length} configured)`);
    }
    const turn = turns[idx++];
    const spec = typeof turn === 'function' ? turn(messages, tools) : turn;
    // Synthetic token estimation: roughly 1 token per 4 chars of input.
    const inputChars = messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const outputChars = JSON.stringify(spec.envelope).length;
    return {
      tool_calls: [{
        id: `stub_${idx}`,
        type: 'function',
        function: { name: spec.name, arguments: JSON.stringify(spec.envelope) },
      }],
      usage: {
        prompt_tokens: Math.ceil(inputChars / 4),
        completion_tokens: Math.ceil(outputChars / 4),
        total_tokens: Math.ceil((inputChars + outputChars) / 4),
      },
    };
  };
}

/**
 * Convert a model function into a fetch handler the harness can use.
 * Returns an object exposing { handler, getStats() } so the runner can
 * read accumulated stats after modify() completes.
 */
export function modelToFetch(model) {
  let totalInput = 0, totalOutput = 0, calls = 0;
  const handler = async (url, opts) => {
    calls++;
    const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
    const result = await model(body.messages || [], body.tools);
    if (result.usage) {
      totalInput += result.usage.prompt_tokens || 0;
      totalOutput += result.usage.completion_tokens || 0;
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: result.tool_calls } }],
        usage: result.usage,
      }),
    };
  };
  const getStats = () => ({
    fetch_calls: calls,
    tokens_in: totalInput,
    tokens_out: totalOutput,
    tokens_total: totalInput + totalOutput,
  });
  return { handler, getStats };
}

/**
 * Real OpenRouter model — placeholder. Activate by setting
 * RWA_OPENROUTER_KEY in the environment and `model` in opts.
 *
 * @param {{ model: string, apiKey?: string, baseUrl?: string }} opts
 */
export function openRouterModel(opts = {}) {
  const apiKey = opts.apiKey || process.env.RWA_OPENROUTER_KEY;
  if (!apiKey) throw new Error('openRouterModel: RWA_OPENROUTER_KEY not set');
  const baseUrl = opts.baseUrl || 'https://openrouter.ai/api/v1';
  const model = opts.model || 'google/gemini-3-flash-preview';
  return async (messages, tools) => {
    const r = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'HTTP-Referer': 'https://github.com/ikangai/rewritable',
        'X-Title': 'rwa-edit-bench',
      },
      body: JSON.stringify({ model, max_tokens: 32000, messages, tools, tool_choice: 'auto' }),
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${r.statusText}`);
    const data = await r.json();
    const msg = data.choices?.[0]?.message;
    return { tool_calls: msg?.tool_calls || [], usage: data.usage || {} };
  };
}
