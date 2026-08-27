// `rwa proxy --agent` — back-delegation with real multi-turn tool use (#36).
//
// ## What was already there, and why it was not enough
//
// The seed has shipped back-delegation twice: `bridge` (single-shot `claude -p`
// via web_cli_bridge) and `bridge-session` (a persistent claude session). The rwa
// already calls OUT to a local agent instead of an API, and for anyone with a
// Claude subscription that path is free. But every feature that needs a real
// conversation refuses it, in four places, with the same comment:
//
//     // L1 (content-aware restyle) needs a multi-turn tool-use backend. bridge /
//     // bridge-session are single-shot, so fall back to deterministic theme-only
//     if (!recipe || cfg.kind === 'bridge' || cfg.kind === 'bridge-session') { … }
//
// So back-delegation was never blocked by architecture. It was blocked by
// TRANSPORT: `claude -p` returns text, not a tool-use stream, so the container
// got one envelope and no conversation, and skin L1, prose extraction and the
// compose paths all degraded.
//
// ## What this is
//
// A translator. It speaks OpenAI-compatible `/v1/chat/completions` toward the
// container and agent-native toward the local agent, synthesizing genuine
// `tool_calls` from the agent's text. The container cannot tell it apart from
// Ollama, so **no seed change is required** and the `cfg.kind === 'bridge'`
// exclusions simply stop applying: a container pointed at this proxy is using a
// normal local-backend URL.
//
// Multi-turn falls out of that. `claude -p` is stateless, but the CONTAINER
// drives the loop and re-sends the whole `messages` array each turn — including
// the `tool` role results carrying a structured failure. Rendering that history
// faithfully back into the prompt IS the multi-turn support; there is no session
// to keep.
//
// ## The security boundary (non-negotiable — see #37)
//
// Back-delegation reverses who drives: the DOCUMENT now issues prompts into the
// user's agent. Document content is untrusted — that is the entire premise of
// the nonce fence the container wraps around it. And the local agent holds tools
// (filesystem, shell, network) the container never had, so a prompt reaching an
// agent with a Bash tool is categorically bigger than one reaching a bare
// completions endpoint.
//
// Therefore the default runner is deliberately capability-narrowed: a fresh
// `claude -p` per call (no inherited conversation, no session state), spawned
// through `execFile` with an ARGUMENT ARRAY and never a shell string, with the
// tool surface restricted to nothing. It answers a question; it does not act.
// `runAgent` is injectable so this is testable offline — and so a deployment
// that wants a different runner has to choose it explicitly rather than inherit
// one.

import { execFile } from 'node:child_process';

/** Per-call wall clock. A wedged agent must not wedge the container's ⌘K. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap on what one call may spend, so a document cannot bill without bound. */
export const DEFAULT_MAX_CALLS = 200;

export class AgentUpstreamError extends Error {
  constructor(code, detail) {
    super(code + (detail ? ': ' + detail : ''));
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Render an OpenAI `messages` array + tool schemas into one text prompt.
 *
 * The `tool` role is the load-bearing part. When the container's apply fails it
 * feeds the structured failure back as a tool result and expects the model to
 * correct itself — that retry loop is the difference between "one envelope" and
 * a conversation, and it is exactly what the single-shot bridge could not do.
 */
export function renderPrompt(messages, tools) {
  const out = [];
  const toolNames = (tools || []).map(t => t?.function?.name).filter(Boolean);

  for (const m of messages || []) {
    if (m.role === 'system') out.push(m.content);
    else if (m.role === 'user') out.push('=== REQUEST ===\n' + m.content);
    else if (m.role === 'assistant' && m.tool_calls?.length) {
      // Echo back what the agent proposed last turn, so it can see what it is
      // being corrected about rather than guessing from the failure alone.
      for (const tc of m.tool_calls) {
        out.push('=== YOUR PREVIOUS ATTEMPT (' + tc.function.name + ') ===\n' + tc.function.arguments);
      }
    } else if (m.role === 'assistant' && m.content) out.push('=== YOUR PREVIOUS REPLY ===\n' + m.content);
    else if (m.role === 'tool') {
      out.push('=== THAT ATTEMPT FAILED ===\n' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) +
        '\nCorrect the problem above and emit a new envelope. Do not repeat the same one.');
    }
  }

  out.push(
    '=== HOW TO ANSWER ===\n' +
    'Reply with ONE JSON object and nothing else — no prose, no explanation, no code fence is required ' +
    '(a ```json fence is tolerated). It must be a valid envelope for one of these tools: ' +
    (toolNames.length ? toolNames.join(', ') : 'apply_edits, replace_document') + '.\n' +
    'apply_edits:      {"version":"rwa-edit/1","edits":[{"find":"…","replace":"…"}]}\n' +
    'apply_dsl_plan:   {"version":"rwa-edit-dsl/1","ops":[…]}\n' +
    'replace_document: {"version":"rwa-edit/1","doc":"…","reason":"…"}\n' +
    'Anchors in `find` must match the document byte-for-byte.',
  );
  return out.join('\n\n');
}

// Envelope extraction. The agent is asked for bare JSON, but models fence, and
// they prepend. Rather than trust the shape, scan for balanced-brace candidates
// and keep the first that parses AND looks like an rwa-edit envelope — so a
// stray JSON object in prose cannot be mistaken for the answer.
export function parseEnvelope(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AgentUpstreamError('empty_agent_reply');
  const looksLikeEnvelope = (o) =>
    o && typeof o === 'object' && !Array.isArray(o) && typeof o.version === 'string' &&
    (Array.isArray(o.edits) || Array.isArray(o.ops) || typeof o.doc === 'string');

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(i, j + 1));
            if (looksLikeEnvelope(parsed)) return parsed;
          } catch { /* not JSON — keep scanning */ }
          break;
        }
      }
    }
  }
  throw new AgentUpstreamError('no_envelope_in_agent_reply', text.slice(0, 200));
}

/** Which tool an envelope is for — the same discriminator applyPlan uses. */
export function toolForEnvelope(env) {
  if (Array.isArray(env.ops)) return 'apply_dsl_plan';
  if (typeof env.doc === 'string') return 'replace_document';
  return 'apply_edits';
}

/**
 * The default runner: one fresh, capability-narrowed `claude -p` per call.
 *
 * `--allowedTools ''` is the boundary, not a nicety. The prompt this carries is
 * derived from document content, and document content is untrusted; an agent
 * that can answer but cannot act is the only shape that is safe to point at it.
 */
export function spawnClaudeRunner({ bin = 'claude', model = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return (prompt) => new Promise((resolve, reject) => {
    const args = ['-p', '--allowedTools', ''];
    if (model) args.push('--model', model);
    // execFile with an argument ARRAY — never a shell string. The prompt is
    // attacker-influenced text; handing it to a shell would be the whole ball
    // game. It goes over stdin, so it never touches argv either.
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) return reject(new AgentUpstreamError('agent_timeout', `${timeoutMs}ms`));
          if (err.code === 'ENOENT') return reject(new AgentUpstreamError('agent_not_found', bin));
          return reject(new AgentUpstreamError('agent_failed', String(stderr || err.message).slice(0, 300)));
        }
        resolve(String(stdout));
      });
    child.stdin.end(prompt);
  });
}

/**
 * Build the agent-backed `/v1/chat/completions` handler.
 *
 * @param {object} opts
 * @param {(prompt: string) => Promise<string>} [opts.runAgent] — injectable, so
 *   tests never spawn anything. Defaults to the narrowed claude runner above.
 * @param {number} [opts.maxCalls] — hard ceiling on calls for this proxy's life.
 *   Every back-delegated call spends the HUMAN's tokens inside their own
 *   session; an unmetered document is an unmetered spender.
 * @param {(e: object) => void} [opts.onCall] — observation hook, so the count is
 *   visible rather than merely enforced.
 */
export function createAgentUpstream({ runAgent, maxCalls = DEFAULT_MAX_CALLS, onCall = () => {}, model = 'claude' } = {}) {
  const run = runAgent || spawnClaudeRunner();
  let calls = 0;

  return {
    get calls() { return calls; },
    maxCalls,

    /** The model list a container's settings "Test" button probes. */
    models() {
      return { object: 'list', data: [{ id: model, object: 'model', owned_by: 'local-agent' }] };
    },

    /**
     * One completion. Returns an OpenAI-shaped response whose message carries
     * REAL `tool_calls` — which is the entire point: it is what makes the
     * container's multi-turn loop, and therefore skin L1 / prose extraction /
     * compose, work over a back-delegated backend.
     */
    async chat(body) {
      if (calls >= maxCalls) {
        throw new AgentUpstreamError('call_budget_exhausted', `${calls}/${maxCalls}`);
      }
      calls++;
      const prompt = renderPrompt(body?.messages, body?.tools);
      const started = Date.now();
      const text = await run(prompt);
      const envelope = parseEnvelope(text);
      const name = toolForEnvelope(envelope);
      onCall({ call: calls, maxCalls, tool: name, ms: Date.now() - started });
      return {
        id: 'rwa-agent-' + calls,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_' + calls,
              type: 'function',
              function: { name, arguments: JSON.stringify(envelope) },
            }],
          },
        }],
      };
    },
  };
}
