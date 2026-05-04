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
 * Wholesale-rewrite "baseline" model — emulates the v0.x pre-rwa-edit/1
 * path where the agent rewrites the entire document each time. Used to
 * compute ΔS/ΔT vs rwa-edit/1 (the spec §6.1 headline).
 *
 * Behavior: takes a per-scenario `baselineDoc` (the "ideal" wholesale
 * rewrite) and emits replace_document with that doc. Scenarios that wish
 * to participate in baseline comparison declare their own baselineDoc.
 *
 * If a scenario has no baselineDoc, baselineModel falls back to the same
 * stub the rwa-edit/1 model would emit — this is fine for scenarios where
 * the edit and the wholesale rewrite are equivalent (rare).
 *
 * @param {string} baselineDoc — the doc the v0.x model would output
 */
export function baselineModel(baselineDoc) {
  return async (messages, tools) => ({
    tool_calls: [{
      id: 'baseline_1',
      type: 'function',
      function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: baselineDoc, reason: 'v0.x wholesale rewrite (baseline)' }),
      },
    }],
    usage: {
      prompt_tokens: Math.ceil((messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0)) / 4),
      completion_tokens: Math.ceil(baselineDoc.length / 4),
      total_tokens: 0,
    },
  });
}

/**
 * Real OpenRouter model — placeholder. Activate by setting
 * RWA_OPENROUTER_KEY in the environment and `model` in opts.
 *
 * @param {{ model: string, apiKey?: string, baseUrl?: string }} opts
 */
export function openRouterModel(opts = {}) {
  const apiKey = opts.apiKey || process.env.RWA_OPENROUTER_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('openRouterModel: neither RWA_OPENROUTER_KEY nor OPENROUTER_API_KEY set');
  const baseUrl = opts.baseUrl || 'https://openrouter.ai/api/v1';
  const model = opts.model || 'google/gemini-3-flash-preview';
  // Per-call timeout — bounds a hung provider response. Default 240s is well
  // above the longest legitimate call observed (kimi-k2.6 hit ~156s on a
  // reasoning-heavy scenario) but short enough to fail one run cleanly
  // rather than wedge an entire bench.
  const timeoutMs = opts.timeoutMs ?? 240_000;
  return async (messages, tools) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`OpenRouter call exceeded ${timeoutMs}ms`)), timeoutMs);
    try {
      const r = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'HTTP-Referer': 'https://github.com/ikangai/rewritable',
          'X-Title': 'rwa-edit-bench',
        },
        body: JSON.stringify({ model, max_tokens: 32000, messages, tools, tool_choice: 'auto' }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${r.statusText}`);
      const data = await r.json();
      const msg = data.choices?.[0]?.message;
      return { tool_calls: msg?.tool_calls || [], usage: data.usage || {} };
    } finally {
      clearTimeout(timer);
    }
  };
}
