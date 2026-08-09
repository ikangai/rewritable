// Model abstraction for the fidelity runner.
//
// A "model" is an async function:
//   (messages, tools) -> { tool_calls: ToolCall[], usage: { prompt_tokens, completion_tokens } }
//
// Three implementations:
//
// 1. stubModel(spec) — returns a function that emits exactly the configured
//    tool call. Useful for testing the harness wiring without burning API
//    credits. Includes synthetic token counts based on message length.
//
// 2. openRouterModel(opts) — wraps OpenRouter. Reads RWA_OPENROUTER_KEY from
//    env and the model name from opts.model.
//
// 3. bridgeModel(opts) — wraps the local `claude -p` CLI via the
//    web_cli_bridge localhost shim (POST http://127.0.0.1:8765/run). Mirrors
//    the seed's modifyViaBridge prompt synthesis: serializes the multi-turn
//    message history into a single prompt, asks claude -p to emit one JSON
//    envelope, parses it, and presents as an OpenAI-compatible tool_calls[].
//
// All produce a `fetch` handler suitable for harness.setFetchHandler().

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
  const toolCounts = Object.create(null);
  const handler = async (url, opts) => {
    calls++;
    const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
    const result = await model(body.messages || [], body.tools);
    if (result.usage) {
      totalInput += result.usage.prompt_tokens || 0;
      totalOutput += result.usage.completion_tokens || 0;
    }
    for (const tc of result.tool_calls || []) {
      const name = tc.function?.name || 'unknown';
      toolCounts[name] = (toolCounts[name] || 0) + 1;
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
    tool_counts: { ...toolCounts },
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

/**
 * Bridge model — single-shot via `claude -p` through the web_cli_bridge
 * localhost shim. Each call:
 *   1. Serialize messages into one prompt the way modifyViaBridge does;
 *   2. POST { command } to BRIDGE_URL where command pipes the prompt
 *      (base64-encoded for shell safety) into `claude -p --output-format json`;
 *   3. Parse claude's stdout (JSON), extract `.result` text;
 *   4. Walk that text for a balanced `{tool, envelope}` object via
 *      parseBridgeEnvelope (mirrored from seeds/rewritable.html);
 *   5. Return as if it were a chat completion with a single tool_call.
 *
 * Stateless across calls — claude -p starts a fresh session each invocation.
 * Multi-turn retries from the seed's modify() loop just rebuild the full
 * message history each retry; the prompt synthesis below includes every
 * message so claude sees the failure context.
 *
 * Cost: uses the LOCAL claude CLI which authenticates to the user's
 * subscription — billed against subscription quota, not metered API tokens.
 * The cost.usd in claude -p's output is informational only.
 *
 * @param {{ url?: string, timeoutMs?: number }} opts
 */
export function bridgeModel(opts = {}) {
  const url = opts.url || process.env.RWA_BRIDGE_URL || 'http://127.0.0.1:8765/run';
  // The bridge requires a bearer token when one is configured (web_cli_bridge
  // gained token auth after the 2026-05-27 RCE fix). Read it from the
  // environment so the secret never lands in source. Empty/absent → no header
  // (auth-off bridges still work).
  const token = opts.token || process.env.RWA_BRIDGE_TOKEN || '';
  // The bridge runs commands under a GUI-launched process whose PATH is the
  // bare system default (no homebrew/npm). Allow pointing at an absolute
  // `claude` so the shim can find it; defaults to bare `claude` for shells
  // that already have it on PATH.
  const claudeBin = opts.claudeBin || process.env.RWA_CLAUDE_BIN || 'claude';
  // Pin the model instead of riding the CLI default. The default drifts with
  // CLI updates, which breaks run-to-run comparability — and claude-fable-5
  // (the default as of CLI 2.1.224) stochastically hard-refuses a subset of
  // benchmark prompts (stop_reason:"refusal") that opus/sonnet accept.
  // Charset-gated because the value is spliced into a shell command.
  const claudeModel = opts.model || process.env.RWA_CLAUDE_MODEL || '';
  if (claudeModel && !/^[A-Za-z0-9._:@-]+$/.test(claudeModel)) {
    throw new Error(`bridgeModel: RWA_CLAUDE_MODEL ${JSON.stringify(claudeModel)} — letters/digits/._:@- only`);
  }
  // Opus calls regularly hit 30–90s on long docs; benchmark scenarios with
  // ~2k input tokens land in that range. 6 minutes leaves headroom for the
  // longest legitimate calls without wedging the bench on a hung claude.
  const timeoutMs = opts.timeoutMs ?? 360_000;
  return async (messages /* , tools */) => {
    // Serialize the message history. The seed's modifyViaBridge wraps the
    // SYSTEM_PROMPT + user prompt + bridge instructions into one string; we
    // reproduce that shape, but also pass back any retry context (prior
    // assistant + tool messages from the modify() loop) so claude sees the
    // failure feedback the OpenRouter path would have benefited from.
    const promptParts = [];
    for (const m of messages) {
      const role = String(m.role || '').toUpperCase();
      if (m.role === 'assistant' && m.tool_calls) {
        const calls = m.tool_calls
          .map(tc => `${tc.function?.name}(${tc.function?.arguments})`)
          .join('\n');
        promptParts.push(`[${role} previously called]\n${calls}`);
      } else if (m.role === 'tool') {
        promptParts.push(`[TOOL RESULT for call ${m.tool_call_id || ''}]\n${m.content}`);
      } else if (typeof m.content === 'string') {
        promptParts.push(`[${role}]\n${m.content}`);
      } else if (m.content != null) {
        promptParts.push(`[${role}]\n${JSON.stringify(m.content)}`);
      }
    }
    const instructions = [
      '',
      'This backend is single-shot (no tool-calling protocol). Output ONLY a single JSON envelope as your last response — no markdown fences, no commentary, no preamble.',
      'The envelope MUST be one of these three exact shapes:',
      '',
      '{"tool":"apply_dsl_plan","envelope":{"version":"rwa-edit-dsl/1","ops":[...]}}',
      '',
      '{"tool":"apply_edits","envelope":{"version":"rwa-edit/1","edits":[{"find":"...","replace":"..."}]}}',
      '',
      '{"tool":"replace_document","envelope":{"version":"rwa-edit/1","doc":"...","reason":"..."}}',
      '',
      'Pick the tool per the same preference rules: structural → apply_dsl_plan, content → apply_edits, wholesale → replace_document.',
    ].join('\n');
    const fullPrompt = promptParts.join('\n\n') + '\n\n' + instructions;

    // Base64-encode so shell quoting can't trip on backticks / $ / newlines
    // in the doc. The CLI side decodes and pipes to claude -p's stdin.
    const promptB64 = Buffer.from(fullPrompt, 'utf8').toString('base64');
    // No --permission-mode bypassPermissions: the bridge agent only emits a
    // text envelope (it needs no tools), so granting unattended tool access
    // would be both pointless and the exact RCE anti-pattern the shared seed's
    // bridgeCommand removed (audit 2026-05-27). Default mode never prompts here
    // because the single-shot prompt asks only for JSON text.
    const cmd = `echo '${promptB64}' | base64 -d | ${claudeBin} -p${claudeModel ? ` --model ${claudeModel}` : ''} --output-format json`;

    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`bridge call exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ command: cmd }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`bridge ${r.status}: ${r.statusText}`);
      const shim = await r.json();
      if (shim.exit_code !== 0) {
        const tail = (shim.stderr || '').trim().split('\n').slice(-3).join('\n').slice(0, 300);
        throw new Error(`claude -p exit ${shim.exit_code}${tail ? ': ' + tail : ''}`);
      }
      let cli;
      try {
        cli = JSON.parse(shim.stdout);
      } catch (e) {
        throw new Error(`bridge: claude --output-format json gave non-JSON stdout (${e.message}): ${shim.stdout.slice(0, 300)}`);
      }
      const text = cli.result || '';
      const parsed = parseBridgeEnvelope(text);
      if (!parsed) {
        throw new Error('bridge: no parseable envelope in claude output. Preview: ' + text.slice(0, 300));
      }
      const usage = cli.usage || {};
      return {
        tool_calls: [{
          id: 'bridge_' + (cli.session_id || '1').slice(0, 8),
          type: 'function',
          function: {
            name: parsed.tool,
            arguments: JSON.stringify(parsed.envelope),
          },
        }],
        usage: {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

// Mirror of seeds/rewritable.html parseBridgeEnvelope (~line 3520). Walks
// the first balanced top-level JSON object out of `text`, honoring string +
// backslash state so quoted braces don't shift depth. Strips a leading
// ```json / ```html fence and a trailing ``` if present.
function parseBridgeEnvelope(text) {
  if (typeof text !== 'string') return null;
  const fenceStripped = text.replace(/```(?:json|html)?\s*/i, '').replace(/```\s*$/i, '');
  const start = fenceStripped.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < fenceStripped.length; i++) {
    const ch = fenceStripped[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(fenceStripped.slice(start, i + 1));
          if (obj && typeof obj === 'object' && typeof obj.tool === 'string' && obj.envelope) return obj;
          return null;
        } catch (_) { return null; }
      }
    }
  }
  return null;
}
