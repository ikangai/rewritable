# Hosted-edit foundation — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to implement this plan task-by-task.

**Goal:** A writable hosted runtime in `service/` that stores a rewritable's
canonical bytes, applies `rwa-edit/1` envelopes server-side (the CLI's apply path,
vendored), logs a durable history, serves a live editable web projection of the file,
and hands back byte-identical canonical `.html` on demand — gated by per-rwa
capability tokens.

**Architecture:** The service is the single deterministic, model-free, audited apply
path. The live projection serves the *real* `current.html` plus a small injected shim
that redirects the seed's commit to `POST /r/:id/modify` via **one additive, guarded
seed seam** (`window.__rwaCommitSink` in `commitDoc`). The agent always runs
client-side (user's key). Full design + rationale:
`docs/plans/2026-06-07-hosted-edit-foundation-build-design.md` and galois's
`docs/plans/2026-06-07-hosted-edit-foundation-design.md`. Auth = Option A
(capability-token-only).

**Tech stack:** Zero-dep Node `http` (`service/server.js`, CommonJS) + dynamic
`import()` of vendored ESM from `cli/src`. `node:crypto`, `node:fs`. Seed
(`seeds/rewritable.html`) jsdom tests via `tests/`. CLI via `node:test`.

**Worktree:** `.worktrees/hosted-edit-foundation` (branch `hosted-edit-foundation`).
Deps installed in `tests/`, `cli/`, `benchmark/`. Baseline green (CLI 331, conf 85).

**Coordination:** Step 1 edits the shared seed. BEFORE editing the seed, post the
exact hunk + line range to the group chat (`@galois @kepler @shannon`) and confirm no
one is mid-seed-edit. Commit with **explicit paths only** (`git commit -- <paths>`),
never `-a`/`-A` (shared checkout). Steps 2–8 are seed-disjoint (`service/` + `cli/`).

**Conventions to honor (from CLAUDE.md):**
- Surgical changes; match existing style; no new deps in `service/`.
- `apply-edits.mjs`/`dsl-compiler.mjs` are mirrors — vendor verbatim, pin by test.
- Reserved URL prefix `/r/` is NEW; `/s/` belongs to publishing — don't reuse.
- Fail loud (Rule 12); tests encode WHY (Rule 9).

---

## Task 1 — Seed seam: `window.__rwaCommitSink` in `commitDoc`

**Why:** The lens/⌘K commit path is closure-private; the live projection needs the
server to be the authoritative apply path. One additive, guarded hook at the single
shared write funnel (`commitDoc`, the only place `applyEdits`/`replaceDocument` write
IDB) makes this possible with zero behavior change when unset.

**Files:**
- Modify: `seeds/rewritable.html` (`commitDoc`, ~`:4170`)
- Test (new): `tests/commit-sink.mjs`
- Then: `node tools/regenerate-refs.mjs` (refs regen)

**Step 1.1 — Read the current `commitDoc` body.**
Run: `sed -n '4170,4212p' seeds/rewritable.html` (or Read offset 4170). Note the exact
IDB transaction so the seam is prepended without altering it.

**Step 1.2 — Write the failing test `tests/commit-sink.mjs`.**
Model it on `tests/region-commit.mjs` (same jsdom + fake-indexeddb harness, same
boot helper). Assert THREE behaviors (these encode the invariants):

```js
// Pseudocode of the assertions — adapt to the existing harness's boot/util shape.
// A) UNSET sink → byte-identical commit (apply_edits + replace_document + direct-text)
//    boot a container, no window.__rwaCommitSink; run an apply_edits modify; assert
//    rwa_doc/rwa_undo/rwa_hist written exactly as today (compare to a control run).
// B) SET sink → receives the reconstructed rwa-edit/1 envelope; local rwa_doc mirrors
//    the sink's returned doc; rwa_undo/rwa_hist are NOT advanced.
//    window.__rwaCommitSink = (env, hist, base) => { captured = {env, hist, base};
//      return SERVER_DOC; };
//    run apply_edits → assert captured.env === {version:'rwa-edit/1', edits:[...]}
//    run replace_document → assert captured.env === {version, doc:newDoc, reason}
//    assert getDoc() === SERVER_DOC; assert rwa_undo length unchanged.
// C) THROWING sink → commit rejects; local rwa_doc NOT advanced (stays == base).
//    window.__rwaCommitSink = () => { throw new Error('server 500'); };
//    expect modify()/commit to reject; assert getDoc() unchanged.
```

Run: `cd tests && node commit-sink.mjs` → Expected: FAIL (seam not present).

**Step 1.3 — Implement the seam.** Prepend inside `commitDoc`, before the existing
transaction (exact code in the design doc §"The one seed change"):

```js
async function commitDoc(currentDoc, newDoc, histRecord) {
  if (typeof window.__rwaCommitSink === 'function') {
    const envelope = histRecord.kind === 'edit_batch'
      ? histRecord.envelope
      : { version: 'rwa-edit/1', doc: newDoc, reason: histRecord.reason };
    const serverDoc = await window.__rwaCommitSink(envelope, histRecord, currentDoc);
    await idbPut(RWA.DOC, serverDoc);
    return serverDoc;
  }
  /* …existing body UNCHANGED… */
}
```

**Step 1.4 — Run the new test.** `cd tests && node commit-sink.mjs` → Expected: PASS.

**Step 1.5 — Regression: full seed/jsdom suite + conformance (sink unset everywhere).**
Run: `cd tests && for f in e2e region-commit skin-compose csp-boot lens view datatable identity write-path r5-concurrent-commit affordance-kernel vault skill-runtime skill-install skill-mvp skill-persistence session; do node $f.mjs || echo "FAIL $f"; done`
Then: `cd benchmark && node runners/run-conformance.mjs | tail -1` (expect 85/85).
Expected: all green (byte-identical behavior when sink unset).

**Step 1.6 — Regenerate references.** `node tools/regenerate-refs.mjs`; `git diff --stat`
should show only `hello.html`/`re-write-able-spec.html`/`rewritable.html` updated.

**Step 1.7 — Commit (POST the hunk to group chat FIRST).**
```bash
git add seeds/rewritable.html tests/commit-sink.mjs hello.html re-write-able-spec.html rewritable.html
git commit -- seeds/rewritable.html tests/commit-sink.mjs hello.html re-write-able-spec.html rewritable.html \
  -m "feat(seed): additive guarded commit sink (window.__rwaCommitSink) for hosted projection"
```
Mirror note: `cli/src/apply-edits.mjs` need NOT change (it has no `commitDoc` — the CLI
writes files, not IDB). Confirm CLI suite still green: `cd cli && node --test 'tests/*.test.mjs'`.

---

## Task 2 — Vendor the CLI apply pipeline into `service/lib/`

**Why:** The deploy is a flat scp of `service/`; the service must carry its own copy
of the apply path. Vendor verbatim (byte-identical, cmp-gated) so it stays diffable
against `cli/src`; load via dynamic `import()` from CJS `server.js` (no rewrite).

**Files:**
- Determine the import closure of `cli/src/edit.mjs`'s `applyPlan` (likely
  `apply-edits.mjs`, `dsl-compiler.mjs`, parts of `seed.mjs` for `escapeTL` + the
  INLINE_DOC backtick-walk + `extractInlineDoc`/`replaceInlineDoc`). Map it first:
  `grep -nE "^import|from '\\./" cli/src/edit.mjs cli/src/apply-edits.mjs cli/src/dsl-compiler.mjs`
- Create: `service/lib/<each vendored module>.mjs` (copies of the closure)
- Create: `service/lib/VENDORED.md` (what was copied, from where, the cmp command)
- Test (new): `service/tests/vendored-apply.test.mjs` (or extend the service harness)

**Step 2.1 — Map the closure.** Run the grep above; list every `cli/src` file
transitively reachable from `applyPlan`. Keep the list minimal (YAGNI).

**Step 2.2 — Write the failing cmp/drift test.** For each vendored file, assert it is
byte-identical to its `cli/src` source:
```js
import { readFileSync } from 'node:fs';
for (const [vendored, source] of PAIRS)
  assert.equal(readFileSync(vendored,'utf8'), readFileSync(source,'utf8'), `${vendored} drifted from ${source}`);
```
Run → FAIL (files not vendored yet).

**Step 2.3 — Copy the closure** verbatim into `service/lib/`. Write `VENDORED.md`.

**Step 2.4 — Write the apply round-trip test.** Prove the vendored path edits a file
identically to the CLI: take a fixture rewritable, apply a known `apply_edits`
envelope via the vendored `applyPlan`, and assert the output bytes equal
`rwa edit --plan` on the same fixture+envelope. (Reuse `cli/tests/fixtures` /
`cli/tests/helpers`.) Run → PASS after wiring.

**Step 2.5 — Commit.**
```bash
git add service/lib service/tests/vendored-apply.test.mjs
git commit -- service/lib service/tests/vendored-apply.test.mjs \
  -m "feat(service): vendor CLI apply pipeline into service/lib (cmp-gated)"
```

---

## Task 3 — Service store + ingest + auth primitives + describe/export

**Why:** The headless spine: create a hosted rwa, authenticate it, read it back.

**Files:**
- Modify: `service/server.js` (add `/r` routes; reuse existing helpers: atomic write,
  `DATA_DIR`, short-code gen, container validation, `DOC_UUID` substitution)
- Create: `service/lib/hosted.js` (store + auth helpers, CommonJS) — keep `server.js`
  thin, testable units in `hosted.js`
- Test (new): `service/tests/hosted.test.mjs`

**Step 3.1 — Failing tests for store + auth units in `hosted.js`:**
```
- mintToken() → 43-char base64url (32 bytes); two calls differ.
- hashToken(t) → sha-256 hex; verifyToken(t, hash) constant-time true; wrong → false.
- writeHosted(id, bytes) / readHosted(id) round-trip under a temp DATA_DIR.
- ingest(bytes) → {id, token}; rejects non-rewritable bytes (no DOC_UUID/bootstrap)
  with a typed error; substitutes a FRESH DOC_UUID (assert it changed); owner file
  holds capHash (not the raw token), createdAt, lastAccess.
```
Run → FAIL.

**Step 3.2 — Implement `hosted.js`** (`crypto.randomBytes`, `crypto.createHash`,
`crypto.timingSafeEqual` on equal-length buffers; reuse `server.js`'s container
validation + `UUID_RE` substitution + atomic tmp+rename). Run → PASS.

**Step 3.3 — Failing handler tests** (drive `server.js`'s request handler with a fake
`DATA_DIR`; pattern from how `service/` is currently structured — if no handler test
harness exists, add one that calls the route dispatcher with mock req/res):
```
- POST /r {valid rewritable bytes} → 200 {id, token, url}; files exist under DATA_DIR/<id>.
- POST /r {garbage} → 400 typed error.
- POST /r/:id/describe with Bearer token → 200 self-description/1 (reuse the CLI's
  computeSelfDescription / identity.mjs over the stored bytes); wrong token → 401;
  missing token → 401.
- GET /r/:id/export with token → 200, body === stored current.html bytes; bad → 401.
```
Run → FAIL.

**Step 3.4 — Implement the `/r`, `/r/:id/describe`, `/r/:id/export` routes** in
`server.js` (Bearer parse → `verifyToken` against `owner.capHash`; touch
`lastAccess`). `describe` reuses the vendored self-description (the CLI's
`identity.mjs` projection over the bytes). Run → PASS.

**Step 3.5 — Commit.**
```bash
git add service/server.js service/lib/hosted.js service/tests/hosted.test.mjs
git commit -- service/server.js service/lib/hosted.js service/tests/hosted.test.mjs \
  -m "feat(service): hosted store + capability auth + /r ingest, describe, export"
```

---

## Task 4 — `POST /r/:id/modify` (the authoritative apply)

**Why:** The write door. `/modify` == `rwa edit --plan` server-side, with optimistic
concurrency.

**Files:** Modify `service/server.js` + `service/lib/hosted.js`; test `service/tests/hosted.test.mjs`.

**Step 4.1 — Failing tests:**
```
- POST /r/:id/modify {envelope: valid apply_edits, baseHash: sha256(currentBytes')}
  with token → 200 {doc, selfDescription, histLen:1}; stored current.html updated;
  history.jsonl has one actor-attributed record. (baseHash is over the EDITABLE body
  the server applies to — define it precisely and use the same in client+server.)
- The returned doc === local seed apply of the same envelope (byte parity — the
  "one contract" guarantee). Compare against tests/ apply or cli applyPlan output.
- Stale baseHash → 409 (no write).
- Frozen-zone-violating envelope → 4xx with the envelope's typed error code
  (frozen_zone_violation / frozen_zone_corrupted) — server wall holds.
- Concurrent /modify for one id serialize (per-id lock); second sees fresh base.
- Wrong/missing token → 401.
```
Run → FAIL.

**Step 4.2 — Implement.** Per-id async lock (a `Map<id, Promise>` chain, mirroring the
seed's `modifyMutex`); read current bytes → compute base hash → compare to posted
`baseHash` (else 409) → run vendored `applyPlan(envelope)` over the file → on success
atomic-write `current.html`, append `history.jsonl` (actor from a request field, e.g.
`web:<session>` / `telegram:<u>`), touch `lastAccess` → return `{doc, selfDescription,
histLen}`. Apply errors → map the `RwaEditError`-shaped code to a 4xx. Run → PASS.

**Step 4.3 — Commit.**
```bash
git add service/server.js service/lib/hosted.js service/tests/hosted.test.mjs
git commit -- service/server.js service/lib/hosted.js service/tests/hosted.test.mjs \
  -m "feat(service): POST /r/:id/modify — vendored apply, history, baseHash 409, per-id lock"
```

---

## Task 5 — `undo`, `rotate`, `delete`, lastAccess sweep, per-token limit

**Files:** `service/server.js` + `service/lib/hosted.js`; tests in `service/tests/hosted.test.mjs`.

**Step 5.1 — Failing tests:**
```
- POST /r/:id/undo (token) → pops the last history.jsonl record, restores prior
  current.html, returns {doc, histLen-1}; on empty history → 409/no-op (decide + test).
- POST /r/:id/rotate (token) → new token; old token now 401; new token 200.
- DELETE /r/:id (token) → files gone; subsequent ops 404.
- sweepHosted(now): a doc with lastAccess older than 90d is removed; a fresh one kept.
- per-token /modify rate limit: N+1th within the window → 429.
```
Run → FAIL.

**Step 5.2 — Implement.** `undo` = re-derive prior bytes from `history.jsonl` (store
enough per record to reverse — simplest: each record also stores the pre-image doc, OR
replay from the seed bytes up to N-1; choose the simplest correct option and document
it). Extend the existing hourly sweep with the 90d-idle branch (guarded so it never
touches `/s/` shares). Run → PASS.

**Step 5.3 — Commit** (explicit paths) — `feat(service): hosted undo, rotate, delete, 90d sweep, per-token limit`.

---

## Task 6 — `GET /r/:id` live editable projection + injected shim

**Why:** The browser door. Serve the real file + the commit-redirect shim.

**Files:**
- Modify: `service/server.js` (`GET /r/:id` route)
- Create: `service/public/hosted-shim.js` (the injected script, read once at startup
  like other static assets; templated with `:id` at request time or parameterized via
  a global the shim reads)
- Test: `service/tests/hosted.test.mjs` (assert the served HTML contains the shim
  before `<script id="rwa-bootstrap">`, sets `window.__rwaCommitSink`, and references
  `/r/<id>/modify`). A jsdom/dom-level test of the shim's POST behavior is a bonus.

**Step 6.1 — Failing test:** `GET /r/:id` (id served via path; token via URL
`#k=` fragment, NOT validated server-side since fragments aren't sent — the shim reads
it client-side and the SUBSEQUENT /modify carries the Bearer) → 200; body =
stored `current.html` with the shim `<script>` injected ahead of the bootstrap.
Assert the shim wires `window.__rwaCommitSink`, the Undo button → `/r/:id/undo`, and
the 409→reload + 401/5xx→surface logic exists. Run → FAIL.

**Step 6.2 — Implement** `service/public/hosted-shim.js` (full behavior in the design
doc §"The injected shim") and the `GET /r/:id` route (inject the shim before
`<script id="rwa-bootstrap">`, substituting the id). Run → PASS.

**Step 6.3 — Commit** (explicit paths) — `feat(service): GET /r/:id live projection + commit-redirect shim`.

---

## Task 7 — CLI `rwa host <file>`

**Files:**
- Create: `cli/src/host.mjs` (`hostCmd` + `hostFile`, transport injected via `deps`)
- Modify: `cli/bin/rwa.mjs` (additive verb branch; exit codes mirror publish-site:
  2 file, 1 usage, 4 host_error)
- Modify: `cli/README.md`, `cli/TODO.md`
- Test (new): `cli/tests/host.test.mjs` (offline, injected transport)

**Step 7.1 — Failing test:** `hostFile(path, {transport})` reads the file, POSTs to
`<url>/r`, returns `{id, token, url}`; bad file → typed `file_error`; transport
error → `host_error`. Config flags-over-env (`RWA_HOST_URL`/`--url`). Run → FAIL.

**Step 7.2 — Implement** (pattern: `cli/src/publish-site.mjs`). Wire the bin verb.
Run → PASS; `cd cli && node --test 'tests/*.test.mjs'` stays green.

**Step 7.3 — Commit** (explicit paths) — `feat(cli): rwa host <file> — ingest into the hosted runtime`.

---

## Task 8 — Conformance scenario + docs + final green

**Files:**
- Add a benchmark conformance scenario `HOST-01`: applying an envelope via the hosted
  `/modify` yields bytes byte-identical to the local seed apply of the same envelope
  (the "one contract, one more door" guarantee). Place per `benchmark/` conventions.
- Modify: `CLAUDE.md` (routing entry for hosted runtime + `/r/` reserved prefix +
  `service/lib` mirror note + `rwa host`), `docs/specs/rwa-operations-api.md` (a
  hosted-runtime column/row in the surfaces map — index only, don't restate).

**Step 8.1 — Add HOST-01; run `cd benchmark && node runners/run-conformance.mjs`
(expect 86/86).**

**Step 8.2 — Full green sweep** (worktree): CLI `node --test 'tests/*.test.mjs'`;
all `tests/*.mjs` (incl. `commit-sink`); `service/tests/*`; conformance.

**Step 8.3 — Docs.** Update CLAUDE.md + operations-api (explicit-path commit).

**Step 8.4 — Commit** — `docs+test(hosted-edit): HOST-01 conformance + routing/operations-api`.

---

## Finish

When all 8 tasks are green: use **superpowers:finishing-a-development-branch** to merge
`hosted-edit-foundation` → `main`. Per the shared-checkout protocol: confirm file-set
disjointness from any live WIP, confirm an idle index, merge `--no-ff` with explicit
intent in the group chat, regen refs once on main if the seed changed. Then hand off
the **deploy gate** (host + DNS for `/r/` + writable `data/` volume) per the design
doc's "honest ceiling."

## Notes / decisions deferred (do NOT scope-creep)

- Keyboard ⌘Z hosted-redirect (2nd seam) — deferred; v1 ships the shim Undo button.
- Token expiry/TTL — rotation ships; TTL later.
- Account-linked identity — out (Option A); `owner` is the only future-accounts seam.
- `service/server.js` is CommonJS; vendored apply is ESM via dynamic `import()` — do
  NOT convert either; keep `service/lib` byte-diffable against `cli/src`.
