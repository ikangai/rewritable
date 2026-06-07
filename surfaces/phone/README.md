# rwa phone — voice spike (talk to your document)

A **timeboxed spike**: call a phone number and **talk to one bound rewritable** — ask
it questions, or speak a change and have it edited. Twilio handles the telephony,
speech-to-text (`<Gather input="speech">`), and text-to-speech (`<Say>`); this surface
is the thin decision core that, per voice turn, classifies *ask vs edit* and either
answers from the doc or runs the edit loop against the **hosted-edit foundation**.

It is a **thin adapter**, like the telegram bot: it reimplements no rewritable logic.
Reads/writes go through `surfaces/telegram/foundation-api.mjs` (the hosted-edit
foundation client) and edits run through the Phase B `rwaEdit` in
`surfaces/telegram/rwa-exec.mjs` (export → `rwa edit` → `rwa doc` → `modify`).

See the design (`docs/plans/2026-06-07-phone-spike-design.md`), the impl plan
(`docs/plans/2026-06-07-phone-spike-impl.md`), and the surface contract it speaks
(`docs/specs/rwa-operations-api.md`).

> **This is a spike, not production.** Happy-path only; the known limitations below are
> deliberate cuts to fit the timebox.

## How it works

One Twilio voice "turn" = one HTTP webhook POST. The server (`phone-bot.mjs`) parses
Twilio's `application/x-www-form-urlencoded` body, runs `handleTurn(params, deps)`, and
responds with `Content-Type: text/xml` TwiML:

- **call start / no speech** → a greeting (best-effort doc title via
  `foundation.describe`) + a `<Gather>` listening for speech;
- **goodbye** ("bye", "stop", "hang up", …) → `<Say>Goodbye.</Say><Hangup/>`;
- **otherwise** → classify the speech as **ask** or **edit** (model judgment call;
  `ask` is the safe default since it is read-only):
  - **ask** → `foundation.readDoc` → `agent.answer(question, doc)` → speak the answer +
    re-gather;
  - **edit** → `readDoc` (baseHash) → `exportDoc` → temp `.html` → `rwaEdit` →
    `foundation.modify({envelope:{version:'rwa-edit/1', doc, reason}, baseHash, actor})`
    (409 `stale_base` retries once with a fresh hash) → confirm + re-gather.

A call **never ends in silence**: every branch and the whole-body catch emit a
`<Response>` that either re-gathers (call continues) or hangs up cleanly. Only two
outcomes hang up — a clean goodbye, and a dead bound doc (404/401, unrecoverable).

## Env

| Var | Required | Purpose |
|---|---|---|
| `RWA_FOUNDATION_URL` | **yes** | Base URL of the hosted-edit foundation. |
| `PHONE_DOC_ID` | **yes** | The id of the ONE doc this line is bound to. |
| `PHONE_DOC_TOKEN` | **yes** | The capability token (= write access) for that doc. |
| `RWA_OPENROUTER_KEY` / `OPENROUTER_API_KEY` | for the model | Backend key for classify + answer (the default backend is openrouter). Not read at boot — a missing key fails loud on the first turn that calls the model. |
| `PORT` | no | Listen port (default `5060`). |

`main()` **fails loud** (stderr + non-zero exit) at startup if any of
`RWA_FOUNDATION_URL` / `PHONE_DOC_ID` / `PHONE_DOC_TOKEN` is missing.

## Gates to run it live

To actually take a call you need ALL of:

1. a **Twilio account + a voice-capable phone number**;
2. a **public URL** reaching this server (Twilio must POST to it — use a tunnel
   like ngrok in dev, or a real host);
3. a **model backend key** (for classify + answer);
4. a **hosted doc** on the foundation — its `id` and `token` (this is the doc the
   line talks to).

## Twilio setup

Point the number's **Voice webhook** at:

```
https://<public-host>/phone/incoming      (HTTP POST)
```

Every subsequent turn is driven by the `<Gather action="/phone/turn">` this server
emits, so both `/phone/incoming` and `/phone/turn` route to the same handler.

## Run it

```sh
export RWA_FOUNDATION_URL="https://<foundation-host>"
export PHONE_DOC_ID="<doc-id>"
export PHONE_DOC_TOKEN="<doc-token>"
export RWA_OPENROUTER_KEY="<key>"     # or OPENROUTER_API_KEY
# optional: export PORT=5060
node surfaces/phone/phone-bot.mjs
```

Then expose `PORT` publicly (tunnel/host) and point the Twilio number's Voice webhook
at `https://<public-host>/phone/incoming`.

## Security

- **The capability token === write access to the bound doc.** It is read from
  `PHONE_DOC_TOKEN`, handed only to the foundation client, and is **never spoken** in
  any `<Say>` and **never logged**. The foundation client redacts it from its own
  errors; pinned by a token-absence test that scans every path's output + logs.
- **The webhook is an UNAUTHENTICATED, write-capable endpoint.** It does **not**
  validate Twilio's `X-Twilio-Signature` header, so the threat is **not** limited to
  "anyone who calls the number" — **anyone who knows the public URL can POST to
  `/phone/turn` with curl and edit the bound doc directly, bypassing the phone
  entirely.** There is **no PIN and no caller/request auth** of any kind. Bind the line
  to a **throwaway/demo doc only**, never anything sensitive. The production follow-up
  is HMAC-validating each request against the Twilio auth token (rejecting any POST
  whose `X-Twilio-Signature` doesn't match).
- **One pre-bound doc.** The line talks to exactly one doc (id+token from env), so the
  blast radius of the open endpoint is that single bound doc — but see above: that doc
  is editable by anyone with the URL, not just callers.
- Untrusted text (transcribed speech, doc-derived answers) is XML-escaped before it
  reaches TwiML, so it can't inject TwiML elements.

## Manual acceptance

There are no live tests (a real call needs Twilio + a public URL). To verify by hand:

1. Wire the gates above and start the server; point the Twilio number at it.
2. **Call the number.** You should hear the greeting + be prompted to speak.
3. **Ask a question** about the doc — you should hear a spoken answer, then be prompted
   again.
4. **Speak a change** ("change the title to …") — you should hear a confirmation; verify
   the hosted doc actually changed.
5. Say "goodbye" — the call should hang up cleanly.

The pure core (`handleTurn`), the TwiML builders, the agent seam, and `parseForm` are
unit-tested offline (`surfaces/phone/*.test.mjs`); the http server + `main()` wiring is
read-reviewed.

## Known spike limitations

Deliberate cuts — not bugs, but the edges this spike does not cover:

- **No doc-aware disambiguation.** `classifyIntent` runs WITHOUT a pre-read of the doc
  (a latency trade-off — it saves a foundation round-trip per turn). Ambiguous phrases
  that would need the doc's content to resolve may be mis-classified.
- **No negation handling in the classifier.** "Don't edit, just tell me…" may classify
  as **edit** — the classifier matches the word *edit*, not the intent's polarity.
- **`answer` sends the full doc.** No truncation / context-window guard — a large doc
  can blow the model's context limit on an ask.
- **Unauthenticated, write-capable webhook.** The server does **not** validate Twilio's
  `X-Twilio-Signature`, so `/phone/turn` is an open write endpoint: anyone who knows the
  public URL can POST to it and edit the bound doc directly via curl — not just phone
  callers. There is no PIN or caller auth. **Bind only a throwaway/demo doc.** The
  production follow-up is HMAC-validating the request against the Twilio auth token. See
  Security above.
- **Body cap is 64KB.** `readBody` rejects any request body over 64KB with a 413 (Twilio
  turn bodies are tiny — a few form fields). This bounds the memory an unauthenticated
  caller can make the open endpoint allocate per request; it is a ceiling, not auth.
- **Twilio built-in STT/TTS only.** No custom recognizer, no SSML tuning, no barge-in
  niceties beyond the default `<Gather>`.
- **Happy-path.** Minimal retry/backoff; no per-call session memory beyond the single
  bound doc; no rate-limiting; no metrics.
