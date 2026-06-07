# Phone Spike Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. This is a TIMEBOXED SPIKE — keep it lean, happy-path-first, offline-testable. Reuse, don't reimplement.

**Goal:** A `surfaces/phone/` zero-dep TwiML webhook handler so that — given a Twilio voice call — you can ASK questions about and EDIT a pre-bound hosted rewritable by voice, over the live hosted-edit foundation.

**Architecture:** Twilio does telephony + STT (`<Gather input="speech">`) + TTS (`<Say>`). `twiml.mjs` builds XML-escaped TwiML. `phone-bot.mjs` `handleTurn(params, deps) → twimlString` is the pure core (classify → ask via foundation.readDoc+agent.answer, or edit via the Phase B export→rwaEdit→modify loop), plus a thin http server + main(). `agent.mjs` is the injected agent seam (classify/answer). Reuses `surfaces/telegram/foundation-api.mjs` + the Phase B `rwaEdit` (import from `../telegram/rwa-exec.mjs`). All I/O injected → fully offline tests.

**Tech Stack:** Node ESM, zero npm deps, `node:test`. Foundation = the live https://rewritable.ikangai.com (via foundation-api, config base URL).

**Design:** `docs/plans/2026-06-07-phone-spike-design.md` (authoritative). Honor: XML-escape all `<Say>` text; capability token NEVER spoken/logged; argv-array/leading-dash discipline inherited via the reused rwaEdit; voice-shaped errors (never silence — apologize + re-gather); tests assert TwiML output + exact modify payload + token-absence.

**Conventions:** match `surfaces/telegram/` module style (deps-seam, pure core + thin main). Branch `phone-spike`; commit explicit paths only (SHARED checkout, others active); zsh (separate quoted path args; NO backticks in commit messages).

---

### Task 1: `twiml.mjs` — TwiML builders (XML-escaping)
**Files:** Create `surfaces/phone/twiml.mjs` + `surfaces/phone/twiml.test.mjs`.
- `escapeXml(s)` (`& < > " '`), `say(text)`, `gather({action, prompt, hints?})` (emits `<Gather input="speech" action="..."><Say>prompt</Say></Gather>`), `hangup()`, `respond(...parts) → '<?xml…?><Response>…</Response>'`.
- **TDD tests:** each builder emits valid TwiML; `say('<b>5 & 6 "x"')` → fully XML-escaped inside `<Say>` (the load-bearing safety — caller speech + doc answers flow here); `gather` carries the action URL + a nested prompt; `respond` wraps parts in one `<Response>` with the XML prolog; assert NO unescaped `<`/`&` from input survives.
- Steps: failing tests → FAIL → implement → PASS → commit `surfaces/phone/twiml.mjs surfaces/phone/twiml.test.mjs`, msg `feat(phone): TwiML builders (XML-escaping say/gather/hangup/respond)`.

### Task 2: `agent.mjs` — injected agent seam (classify + answer)
**Files:** Create `surfaces/phone/agent.mjs` + `surfaces/phone/agent.test.mjs`.
- `makeAgent({ chat })` where `chat` is an injected OpenAI-compat call seam (default: a real backend client resolved from env like the CLI's backend; tests inject a fake `chat`). Returns `{ classifyIntent(utterance, doc) → 'ask'|'edit', answer(question, doc) → text }`.
- `classifyIntent`: prompt the model to return exactly `ask` or `edit` for the utterance; normalize/parse the reply to one of the two; default to `'ask'` if ambiguous (safe: read-only). (Rule 5 — classification is a legit model use.)
- `answer`: prompt the model to answer the question using the doc body; return the text.
- Keep the real `chat` impl MINIMAL (reuse the backend base-url/key resolution pattern; it's a spike — an openrouter-style POST is fine). The point is the SEAM; tests never hit a network.
- **TDD tests (fake chat):** classifyIntent returns 'ask'/'edit' from scripted replies; ambiguous/garbage reply → defaults to 'ask'; answer returns the model text; the doc body is included in the prompt sent to `chat` (assert); no network in tests.
- Steps: failing tests → FAIL → implement → PASS → commit `surfaces/phone/agent.mjs surfaces/phone/agent.test.mjs`, msg `feat(phone): agent seam — intent classify + doc QA (injected chat, offline-tested)`.

### Task 3: `phone-bot.mjs` — `handleTurn` dispatch (the core)
**Files:** Create `surfaces/phone/phone-bot.mjs` + `surfaces/phone/phone-bot.test.mjs`.
- `handleTurn(params, deps) → twimlString`. `params` = Twilio POST fields (`SpeechResult`, `CallSid`, `From`, etc.). `deps = { foundation, agent, exec, twiml, env, log, writeTemp, unlinkTemp }`. The bound doc = `{ id: deps.env.PHONE_DOC_ID, token: deps.env.PHONE_DOC_TOKEN }`.
- **Greeting/no-speech:** missing/empty `SpeechResult` (call start OR un-caught speech) → `respond(say(greeting), gather({action:'/phone/turn'}))`. Greeting on call-start uses the doc title (best-effort `foundation.describe`; on failure just a generic greeting — never fail the call).
- **goodbye/hangup:** SpeechResult matches a goodbye intent (simple contains check: bye/goodbye/hang up/stop) → `respond(say('Goodbye.'), hangup())`.
- **classify** SpeechResult → ask | edit:
  - **ask** → `foundation.readDoc(id,token)` → `agent.answer(speech, doc)` → `respond(say(answer), gather(...))`.
  - **edit** → `foundation.readDoc`(baseHash) → `foundation.exportDoc`→`writeTemp(.html)` → `exec.rwaEdit(tempPath, speech)` → `foundation.modify(id,token,{envelope:{version:'rwa-edit/1',doc:newBody,reason:speech}, baseHash, actor:'phone:'+(From||'caller')})` → `respond(say('Done. ' + shortConfirm), gather(...))`; clean temp in finally.
- **Errors (Rule 12, voice-shaped — never silence):** any foundation/agent/edit failure → `respond(say("Sorry, I couldn't do that. Try again."), gather(...))` + `log(rawError)` (raw NEVER spoken). `409 stale_base` → re-readDoc + retry modify ONCE, else say "the document changed, try again." + gather. `404`/`401` on the bound doc → `respond(say("That document isn't available."), hangup())`. `rwaEdit` `bad_instruction` → "I couldn't apply that." + gather. The whole `handleTurn` body wrapped so a throw → apology + gather (call survives), never an unhandled throw.
- **Security:** the capability token is NEVER put in any `say()` text or `log` arg.
- **TDD tests (all fakes):** empty SpeechResult → greeting + gather; goodbye → say+hangup; ask → readDoc + agent.answer, TwiML `<Say>` contains the (escaped) answer + a `<Gather>`; edit → the EXACT modify payload `{envelope:{version:'rwa-edit/1',doc:newBody,reason:speech},baseHash,actor:'phone:<From>'}` + a confirmation `<Say>`; 409 retry-once (fresh baseHash) then give-up; 404 → say+hangup; failure → apology + gather (no throw); **token never in any TwiML or log** (scan, using a token-bearing fake); edit temp cleaned (assert unlinkTemp called on success AND on rwaEdit failure).
- Steps: failing tests → FAIL → implement (handleTurn only; server+main in Task 4) → PASS → commit `surfaces/phone/phone-bot.mjs surfaces/phone/phone-bot.test.mjs`, msg `feat(phone): handleTurn voice dispatch — ask + edit over the foundation (gated, voice-shaped errors)`.

### Task 4: http server + main() + README
**Files:** Modify `surfaces/phone/phone-bot.mjs` (add the `http` server routing `/phone/incoming` (call start) + `/phone/turn` to `handleTurn`, parsing Twilio's `application/x-www-form-urlencoded` POST body, `Content-Type: text/xml` responses) + `main()` (wire real `foundation = makeFoundationApi(RWA_FOUNDATION_URL)`, real `agent` from backend env, `exec` = the telegram `rwaEdit`, `writeTemp`/`unlinkTemp`, env, log; guard so import doesn't listen). Create `surfaces/phone/README.md`.
- README: what it is (spike), the Twilio setup (point the number's Voice webhook at `https://<host>/phone/incoming`), env (`RWA_FOUNDATION_URL`, `PHONE_DOC_ID`, `PHONE_DOC_TOKEN`, backend key), the gates (Twilio account+number+public URL + key), security (token never spoken/logged; one bound doc; no PIN — demo line), and the manual-acceptance step (call the number, ask + edit). Note it's a spike (happy-path; out-of-scope list).
- A small test for the form-body parser (parse `a=1&b=hello%20world` → {a:'1', b:'hello world'}) if you add one; the server/main are otherwise read-reviewed.
- Steps: implement → run ALL `surfaces/phone/*.test.mjs` (+ confirm `surfaces/telegram/*` still green, untouched) → commit `surfaces/phone/phone-bot.mjs surfaces/phone/README.md` (+ the parser test file if separate), msg `feat(phone): http server + main wiring + README (spike run instructions + gates)`.

### Task 5: gate
Run all `surfaces/**/*.test.mjs` green + cli/ disjoint green. No commit. Then final review → gated merge.

## Success criteria
- handleTurn routes greeting/goodbye/ask/edit correctly; edit posts the EXACT modify payload; 409 retry-once; voice-shaped errors never leave silence; token never in TwiML/log; temp cleaned. All TwiML XML-escaped. Offline tests only. Reuses foundation-api + Phase B rwaEdit (no reimplementation). Telegram + cli suites untouched/green.

## Out of scope (spike)
multi-doc; PIN; external STT/TTS; streaming/barge-in; create-by-phone; recording.
