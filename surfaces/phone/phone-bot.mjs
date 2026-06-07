// The phone voice-dispatch core: `handleTurn(params, deps) → Promise<twimlString>`.
//
// One Twilio voice "turn" = one HTTP webhook POST. Twilio does telephony + STT
// (`<Gather input="speech">`) + TTS (`<Say>`); this function is the pure decision
// core that, given the POSTed fields, decides what the caller hears next and what
// (if anything) to change in the bound rewritable. The thin http server + main()
// that wire the real foundation/agent/exec/fs live in Task 4 — this module is
// `handleTurn` ONLY, so it is fully offline-testable with scripted fakes.
//
// REUSE, don't reimplement (the operations-API rule): the foundation round-trips
// go through `surfaces/telegram/foundation-api.mjs` (makeFoundationApi → readDoc/
// exportDoc/modify/describe) and the local edit goes through the Phase-B
// `rwaEdit` in `surfaces/telegram/rwa-exec.mjs` (which already carries the argv-
// array + leading-dash flag-smuggling walls). This file owns ONLY the voice
// shaping: routing the intent and turning each outcome into XML-escaped TwiML.
//
// SECURITY — the capability token === write access to the bound doc. It is read
// from `deps.env.PHONE_DOC_TOKEN`, handed to the foundation client, and NEVER put
// into any `say()` text or any `log()` argument. The foundation client itself
// redacts the token from its own errors (see foundation-api.mjs); we never log the
// binding, and we never interpolate the token into spoken text. Pinned by the
// token-absence test (a sentinel token scanned across every path's output + logs).
//
// VOICE-SHAPED ERRORS (Rule 12, but voice): a phone call must NEVER end in silence
// or an unhandled throw. The WHOLE body is wrapped so that any throw degrades to an
// apology + re-gather — the call continues. Only two outcomes hang up: a clean
// goodbye, and a dead bound doc (404/401), which is unrecoverable for this call.
//
// Zero npm deps: node built-ins + the two reused local modules. The model and all
// I/O are injected.

import { FoundationError } from '../telegram/foundation-api.mjs';

// Goodbye intents — a simple substring check on the lowercased transcript. STT is
// lossy, so we match on common terminal phrases the caller is likely to say.
const GOODBYE_RE = /\b(good\s?bye|bye|hang up|stop|that'?s all)\b/;

// The action every <Gather> posts back to — one webhook route handles every turn.
const TURN_ACTION = '/phone/turn';

// Spoken strings, kept together so the voice copy is reviewable in one place. None
// of these ever interpolate untrusted text or the token.
const PROMPT = 'Ask a question, or tell me a change.';
const APOLOGY = "Sorry, I couldn't do that. Please try again.";
const CANT_APPLY = "I couldn't apply that. Try rephrasing.";
const DOC_CHANGED = 'The document changed. Please try again.';
const UNAVAILABLE = "That document isn't available.";
const DONE = 'Done. I updated the document.';

/**
 * Build the call-start / re-gather greeting. Best-effort: tries the doc title via
 * `foundation.describe` for a friendlier opener, but ANY failure (network, auth,
 * a missing title) degrades to a generic greeting — a greeting must NEVER fail the
 * call. The describe round-trip carries the token but its result (a title) does
 * not, and a describe error is swallowed (not logged with the binding), so the
 * token cannot leak here.
 *
 * @param {{describe:Function}} foundation
 * @param {string} id @param {string} token
 * @returns {Promise<string>} the greeting text (already plain, escaped by say()).
 */
export async function GREETING(foundation, id, token) {
  try {
    const desc = await foundation.describe(id, token);
    const title = desc && typeof desc.title === 'string' ? desc.title.trim() : '';
    if (title) return `You're connected to ${title}. ${PROMPT}`;
  } catch {
    // best-effort only — fall through to the generic greeting.
  }
  return `You're connected to your document. ${PROMPT}`;
}

/**
 * Handle one voice turn.
 * @param {Record<string,string>} params  Twilio POST fields (SpeechResult, From, …).
 * @param {{foundation:object, agent:object, exec:object, twiml:object,
 *          env:{PHONE_DOC_ID:string,PHONE_DOC_TOKEN:string}, log:Function,
 *          writeTemp:Function, unlinkTemp:Function}} deps
 * @returns {Promise<string>} a complete TwiML <Response> document.
 */
export async function handleTurn(params, deps) {
  const { foundation, agent, twiml, env } = deps;
  const { say, gather, hangup, respond } = twiml;
  const id = env.PHONE_DOC_ID;
  const token = env.PHONE_DOC_TOKEN;

  // The standard "keep the call going" tail: speak `text`, then listen again.
  const sayAndGather = (text) => respond(say(text), gather({ action: TURN_ACTION, prompt: PROMPT }));
  // A clean end-of-call.
  const sayAndHangup = (text) => respond(say(text), hangup());

  try {
    const speech = typeof params.SpeechResult === 'string' ? params.SpeechResult.trim() : '';

    // 1) No speech (call start, or an un-recognized turn) → greet + gather.
    if (!speech) {
      const greeting = await GREETING(foundation, id, token);
      return respond(say(greeting), gather({ action: TURN_ACTION, prompt: PROMPT }));
    }

    // 2) Goodbye → end the call cleanly.
    if (GOODBYE_RE.test(speech.toLowerCase())) {
      return sayAndHangup('Goodbye.');
    }

    // 3) Classify the intent (model judgment call — ask is the safe default).
    const intent = await agent.classifyIntent(speech, undefined);

    if (intent === 'edit') {
      return await handleEdit(speech, params, deps, { id, token, sayAndGather });
    }
    // ask (and any non-'edit' classification) — read-only QA.
    return await handleAsk(speech, deps, { id, token, sayAndGather });
  } catch (err) {
    // Whole-body catch: map a FoundationError to its voice shape; anything else is
    // a generic apology. The call NEVER dies on an unhandled throw.
    return mapError(err, deps, { sayAndGather, sayAndHangup });
  }
}

// ── ask ───────────────────────────────────────────────────────────────────────

// Read the bound doc, ask the agent, speak the (escaped) answer, re-gather. A
// FoundationError (e.g. 404/401 on the bound doc) propagates to the whole-body
// catch, which maps it to the right voice shape.
async function handleAsk(speech, deps, { id, token, sayAndGather }) {
  const read = await deps.foundation.readDoc(id, token);
  const answer = await deps.agent.answer(speech, read.doc);
  return sayAndGather(answer);
}

// ── edit ──────────────────────────────────────────────────────────────────────

// readDoc(baseHash) → exportDoc → writeTemp → rwaEdit → modify(replace_document),
// with the exported temp cleaned in a `finally` on EVERY exit. A bad_instruction
// or a non-ok rwaEdit result is handled as DATA (voice-shaped, no throw, no
// modify); a FoundationError propagates to the whole-body catch (which handles the
// 409 retry-once and 404/401 mapping).
async function handleEdit(speech, params, deps, { id, token, sayAndGather }) {
  const { foundation, exec, writeTemp, unlinkTemp, log } = deps;

  // Two contract-forced GETs: readDoc gives the baseHash (optimistic concurrency)
  // but not the bytes; exportDoc gives the bytes but not the hash. We need both.
  const read = await foundation.readDoc(id, token);
  const bytes = await foundation.exportDoc(id, token);
  const tempPath = writeTemp(bytes, '.html');

  try {
    const edited = await exec.rwaEdit(tempPath, speech);
    if (!edited || !edited.ok) {
      if (edited && edited.code === 'bad_instruction') {
        return sayAndGather(CANT_APPLY);
      }
      // A real edit/doc failure: log the raw failure host-side (NEVER spoken), then
      // apologize. The token is not in `edited` (it's the rwaEdit result object).
      log('phone: rwaEdit failed', edited);
      return sayAndGather(APOLOGY);
    }
    // Commit the whole new body via replace_document, 409 retry-once.
    return await modifyWithRetry(speech, params, deps, { id, token, newBody: edited.doc, baseHash: read.baseHash, sayAndGather });
  } finally {
    try { await unlinkTemp(tempPath); } catch (e) { log('phone: temp cleanup failed', e); }
  }
}

// Build the rwa-edit/1 replace_document envelope + actor, POST /modify, and on a
// 409 stale_base re-read the FRESH baseHash and retry exactly ONCE. A non-stale
// FoundationError propagates to the whole-body catch.
async function modifyWithRetry(speech, params, deps, { id, token, newBody, baseHash, sayAndGather }) {
  const { foundation } = deps;
  const actor = 'phone:' + (params.From || 'caller');
  const buildPayload = (hash) => ({
    envelope: { version: 'rwa-edit/1', doc: newBody, reason: speech },
    baseHash: hash,
    actor,
  });

  try {
    await foundation.modify(id, token, buildPayload(baseHash));
    return sayAndGather(DONE);
  } catch (err) {
    if (!(err instanceof FoundationError) || err.code !== 'stale_base') throw err;
    // 409: the doc moved under us. Fall through to the single retry.
  }

  // Re-read the fresh baseHash and retry ONCE. A FoundationError on the re-read
  // propagates to the whole-body catch; a second stale_base gives up voice-shaped.
  const fresh = await foundation.readDoc(id, token);
  try {
    await foundation.modify(id, token, buildPayload(fresh.baseHash));
    return sayAndGather(DONE);
  } catch (err) {
    if (err instanceof FoundationError && err.code === 'stale_base') {
      return sayAndGather(DOC_CHANGED);
    }
    throw err;
  }
}

// ── error mapping ──────────────────────────────────────────────────────────────

// Map a thrown error to a voice-shaped TwiML response. 404/401 on the bound doc is
// unrecoverable for this call → hang up. Everything else (request_failed,
// bad_request, 422 subcodes, an agent throw, etc.) → apology + re-gather, with the
// raw error logged host-side. The token is never in the spoken text; the foundation
// client already redacts it from its own error, and we log the error object as-is
// (which carries only code/status/detail), never the binding.
function mapError(err, deps, { sayAndGather, sayAndHangup }) {
  if (err instanceof FoundationError && (err.code === 'not_found' || err.code === 'unauthorized')) {
    return sayAndHangup(UNAVAILABLE);
  }
  deps.log('phone: turn error', err);
  return sayAndGather(APOLOGY);
}
