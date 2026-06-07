# Phone spike — "talk to your document" (design)

**Status:** design, validated with Martin 2026-06-07. The far-tier surface from the
north-star program (`docs/plans/2026-06-07-north-star-execution-program.md`). An
explicit **timeboxed spike** — the goal is to *feel the UX*, not to ship a polished
product. Client of the live hosted-edit foundation
(`https://rewritable.ikangai.com/r/`); reuses the Phase B edit mechanism and
`surfaces/telegram/foundation-api.mjs`. A thin adapter onto the operations contract
(`docs/specs/rwa-operations-api.md`) — reimplements nothing.

## What it is

A `surfaces/phone/` zero-dep Node `http` webhook handler that speaks **TwiML**
(Twilio's XML). Twilio provides the telephony, built-in speech-to-text
(`<Gather input="speech">`), and text-to-speech (`<Say>`) — we never touch audio.
Call a number → talk to a hosted rewritable: **ask questions about it AND edit it by
voice.**

## Gate (to run live; the spike is built + offline-tested without it)

- A **Twilio account + voice number**, configured to POST its voice webhook to our
  **public URL** (Twilio requires a public endpoint — unlike Telegram's long-poll).
- A **backend key** (the agent runs adapter-side: classify + answer + edit).
- `RWA_FOUNDATION_URL` (the live foundation) + `PHONE_DOC_ID` + its capability token.

## Bound document

One pre-bound doc per number: `PHONE_DOC_ID` + capability token in env. Call in →
you're talking to THAT doc. Multi-doc selection and a spoken PIN are deferred (spike
scope). Auth = whoever has the number (fine for a demo line).

## Call flow (turn-based voice loop)

1. **Call start** → Twilio POSTs the webhook → respond TwiML: `<Say>` greeting
   ("You're connected to <doc title>. Ask a question, or tell me a change.") +
   `<Gather input="speech" action="/phone/turn">`.
2. **Each turn** → Twilio POSTs `SpeechResult` (transcript) → handler:
   - **classify intent** ask vs edit — a model judgment call (Rule 5: classification);
   - **ask** → `foundation.readDoc` → `agent.answer(question, doc)` → `<Say>` answer;
   - **edit** → the Phase-B loop: `readDoc`(baseHash) → `exportDoc`(temp) → `rwaEdit`
     → `foundation.modify({envelope:{version:'rwa-edit/1',doc:newBody,reason},baseHash,
     actor:'phone:<caller>'})` → `<Say>` "Done — I <summary>.";
   - then `<Gather>` again (loop). "Goodbye"/silence/timeout → `<Say>` bye + `<Hangup>`.

## Modules (`surfaces/phone/`)

- `twiml.mjs` — pure TwiML builders: `say(text)`, `gather({action, prompt})`,
  `hangup()`, `respond(...parts) → XML`. **XML-escapes all text** (caller content +
  doc-derived answers land in `<Say>`). Zero deps.
- `agent.mjs` — the injected agent seam: `classifyIntent(utterance, doc) →
  'ask'|'edit'` and `answer(question, doc) → text` (an OpenAI-compat call reusing the
  backend-resolution pattern; real impl needs a key, faked in tests).
- `phone-bot.mjs` — `handleTurn(params, deps) → twimlString` (the pure core, like
  `handleUpdate`), plus a thin `http` server + `main()`. `deps = { foundation, agent,
  exec, twiml, env, log }`. Reuses `surfaces/telegram/foundation-api.mjs` and the
  Phase B `rwaEdit`.

## Error handling (Rule 12 — voice-shaped: never leave the caller in silence)

- agent/foundation/edit failure → spoken apology + re-`<Gather>` (the call survives,
  like the poll loop survives a throw): "Sorry, I couldn't do that — try again." Raw
  error → `log`, never spoken.
- `409 stale_base` → retry-once (reuse Phase B), else "the document changed, try
  again."
- `404`/`401` on the bound doc → "that document isn't available" + `<Hangup>`.
- empty/garbled `SpeechResult` → "I didn't catch that" + re-gather.
- **The capability token is never spoken or logged** (only in foundation headers).

## Testing (offline; no Twilio / agent / network)

Drive `handleTurn` with faked Twilio POST params (`{SpeechResult, CallSid, From,
…}`), a fake `foundation`, a fake `agent` (scripted classify/answer), a fake `exec`
(rwaEdit). Assert the **TwiML output**: XML-escaped `<Say>` text, the right
`<Gather action>`, `<Hangup>` on goodbye; ask vs edit routing; the **exact** `modify`
payload on edit; 409 retry-once; **token never in TwiML or log**; survive-failure
re-gather; empty-speech re-gather. `twiml.mjs` gets its own escaping tests.
`main()`/server wiring is read-reviewed, not unit-tested.

## Files

- `surfaces/phone/twiml.mjs` + `.test.mjs`
- `surfaces/phone/agent.mjs` + `.test.mjs`
- `surfaces/phone/phone-bot.mjs` + `.test.mjs`
- `surfaces/phone/README.md` (run + gates + manual-acceptance: call the number)

## Out of scope (spike)

Multi-doc selection; spoken PIN/auth; external STT/TTS (Whisper/ElevenLabs);
barge-in/streaming; call recording; create-by-phone (edit/ask an existing bound doc
only); per-subdomain concerns (server-side client, no browser session).
