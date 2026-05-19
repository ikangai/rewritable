// Multi-turn tool-use agent loop against an OpenAI-compatible
// /chat/completions endpoint. Mirrors the browser runtime's modify() shape in
// seeds/rewritable.html: a retry budget of 3, single tool_call per turn,
// corrective user message on no_tool_call, tool_result on invalid_json.
//
// Backend HTTP errors are terminal (not retried) for v1 — same posture as the
// runtime, which surfaces network failures directly to the user.
//
// Parallel tool_calls are not supported: the loop takes tool_calls[0] and
// ignores the rest. The seed's modify() loop is also single-call-per-turn, so
// this matches existing behavior. Multi-call dispatching is a v2 concern.

const RETRY_BUDGET = 3;

export class AgentError extends Error {
  constructor(subcode, details = {}) {
    super(subcode);
    this.subcode = subcode;
    this.details = details;
  }
}

/**
 * Run a multi-turn tool-use loop. Returns the first valid envelope produced
 * by the model.
 *
 * @param {object}   opts
 * @param {string}   opts.systemPrompt - System role content.
 * @param {Array}    opts.toolSchemas  - Tool definitions (OpenAI-compatible).
 * @param {string}   opts.currentDoc   - Document content for the user message.
 * @param {string}   opts.instruction  - User instruction for the user message.
 * @param {{baseUrl: string, model: string, apiKey?: string}} opts.backend
 * @param {(info: {attempt: number, reason: string, toolName?: string}) => void} [opts.onRetry]
 *   Optional callback fired each time a retry is queued. `attempt` is the
 *   attempt that just failed (1-indexed).
 * @returns {Promise<{envelope: object, toolName: string, messages: Array}>}
 * @throws {AgentError} subcode: 'no_envelope_after_retries' | 'backend_error'
 */
export async function runAgentLoop({
  systemPrompt,
  toolSchemas,
  currentDoc,
  instruction,
  backend,
  onRetry,
}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: `Current document:\n\n${currentDoc}\n\nInstruction: ${instruction}` },
  ];

  for (let attempt = 1; attempt <= RETRY_BUDGET; attempt++) {
    let response;
    try {
      response = await callBackend(backend, { messages, tools: toolSchemas });
    } catch (e) {
      // Network or HTTP error — terminal for v1.
      throw new AgentError('backend_error', { attempt, message: e.message });
    }

    const message = response?.choices?.[0]?.message;
    if (!message) {
      throw new AgentError('backend_error', {
        attempt,
        message: 'malformed response: no message in choices[0]',
      });
    }
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      if (onRetry) onRetry({ attempt, reason: 'no_tool_call' });
      messages.push({
        role: 'user',
        content: 'Retry: you must call one of the provided tools (no plain text). Try again.',
      });
      continue;
    }

    // v1: take the first tool_call, ignore any others.
    const call = message.tool_calls[0];
    let envelope;
    try {
      envelope = JSON.parse(call.function.arguments);
    } catch {
      if (onRetry) onRetry({ attempt, reason: 'invalid_json', toolName: call.function.name });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: 'Invalid JSON in tool arguments. Re-emit valid JSON.',
      });
      continue;
    }

    return { envelope, toolName: call.function.name, messages };
  }

  throw new AgentError('no_envelope_after_retries', { retries: RETRY_BUDGET });
}

async function callBackend({ baseUrl, model, apiKey }, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, ...body }),
  });
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch {}
    throw new Error(`backend returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
