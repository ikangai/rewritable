// The phone agent seam — the two MODEL judgment-call steps of the voice loop
// (Rule 5: classification and QA are legit model uses; routing/parsing around
// them is plain code). The model call is INJECTED as `chat({system,user}) ->
// Promise<string>` so the whole module is offline-testable with a scripted fake
// (see agent.test.mjs). The default `chat` is a minimal OpenAI-compatible client
// built LAZILY — importing this module needs no key and no network; a missing
// key throws a clear error only WHEN the default chat is actually called.
//
// Zero npm deps: node built-ins + global fetch only. Mirrors the seam style of
// `surfaces/telegram/telegram-api.mjs`.
//
// This is a SPIKE — the real client is deliberately minimal. Tests never use it.

const CLASSIFY_SYSTEM =
  'You classify whether the user wants to ASK about a document or EDIT it. ' +
  'Reply with exactly one word: ask or edit.';

const ANSWER_SYSTEM =
  'Answer the user\'s question using ONLY the provided document. ' +
  'Be concise — this is spoken aloud over the phone.';

// Parse a free-form classification reply into 'ask' | 'edit'. Robust to verbose
// replies ("I think you want to EDIT it") and to garbage. SAFE DEFAULT: anything
// ambiguous/empty/unrecognized → 'ask', because 'ask' is read-only and 'edit'
// mutates the document — a misparse must never trigger an unintended edit. When
// a reply mentions both words, 'edit' wins: it is the intent the user has to
// explicitly want.
function parseIntent(reply) {
  const text = String(reply ?? '').toLowerCase();
  if (/\bedit\b/.test(text)) return 'edit';
  if (/\bask\b/.test(text)) return 'ask';
  return 'ask';
}

/**
 * Build the phone agent over an injected (or default) model `chat`.
 * @param {object} [deps]
 * @param {(p:{system:string,user:string}) => Promise<string>} [deps.chat]
 *   the model call. Default: a lazily-built OpenAI-compatible client (needs a key).
 * @returns {{ classifyIntent:(utterance:string,doc:string)=>Promise<'ask'|'edit'>,
 *             answer:(question:string,doc:string)=>Promise<string> }}
 */
export function makeAgent({ chat } = {}) {
  // Lazily resolve the real client only if no chat was injected AND a method is
  // called. Import-time stays side-effect-free (no key read, no network).
  let resolvedChat = chat;
  function getChat() {
    if (!resolvedChat) resolvedChat = makeDefaultChat();
    return resolvedChat;
  }

  async function classifyIntent(utterance, doc) {
    // The doc is supplied as short context so the model can disambiguate
    // (e.g. "the budget" reads as edit-able when the doc is a budget). Kept
    // brief — classification doesn't need the whole document.
    const user =
      `Document (context):\n${docContext(doc)}\n\n` +
      `User said: ${String(utterance ?? '')}\n\n` +
      'Does the user want to ask or edit? One word.';
    const reply = await getChat()({ system: CLASSIFY_SYSTEM, user });
    return parseIntent(reply);
  }

  async function answer(question, doc) {
    const user =
      `Document:\n${String(doc ?? '')}\n\n` +
      `Question: ${String(question ?? '')}`;
    const reply = await getChat()({ system: ANSWER_SYSTEM, user });
    return String(reply ?? '').trim();
  }

  return { classifyIntent, answer };
}

// Truncate the doc for the classification prompt — full text is unnecessary to
// decide ask-vs-edit, and short prompts keep the turn snappy on a phone call.
function docContext(doc, max = 1200) {
  const s = String(doc ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// --- default real client (lazy; spike-minimal) -----------------------------

// Resolve base URL + key from the env the same way the rest of the repo does
// (cli/src/backend.mjs): the openrouter default backend, key from
// RWA_OPENROUTER_KEY || OPENROUTER_API_KEY. Kept intentionally minimal — this is
// the seam's fallback, exercised live, never in tests.
function makeDefaultChat(env = process.env) {
  const baseUrl = env.RWA_AGENT_BASE_URL || 'https://openrouter.ai/api/v1';
  const apiKey = env.RWA_OPENROUTER_KEY || env.OPENROUTER_API_KEY || '';
  const model = env.RWA_AGENT_MODEL || 'anthropic/claude-3.5-sonnet';

  return async function chat({ system, user }) {
    if (!apiKey) {
      throw new Error(
        'phone agent: no model API key configured — set RWA_OPENROUTER_KEY ' +
        '(or OPENROUTER_API_KEY), or inject a `chat` into makeAgent().',
      );
    }
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch {
      // Re-wrap: a raw fetch error can carry the request URL — keep it out of
      // the message (the URL is benign here, but the key is in headers and the
      // discipline matches telegram-api.mjs).
      throw new Error('phone agent: model request failed');
    }
    if (!res.ok) throw new Error(`phone agent: model request failed (HTTP ${res.status})`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('phone agent: model response was not JSON');
    }
    return data?.choices?.[0]?.message?.content ?? '';
  };
}
