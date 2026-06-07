# North-star execution program — sequencing the remaining surfaces

**Status:** program / roadmap. Author: galois, 2026-06-07. Standing companion to
`docs/plans/2026-06-04-north-star-universal-surfaces.md` (the vision) and
`docs/specs/rwa-operations-api.md` (the contract). This file is the *order of
operations*: what to build, in what sequence, and exactly where each thread stops
for a decision, a secret, or infrastructure.

## What's already done (the near tier)

The contract is named and three surfaces speak it end-to-end:

- **Operations API** named + routed (`docs/specs/rwa-operations-api.md`).
- **`rwa clone <url>`** — webpage → rewritable (import adapter, SSRF-guarded).
- **`rwa publish-site <file>`** — durable scp publish (publish adapter).
- **`authoring-rewritables` skill** re-vendored to current main (ships the 7b CSP).

Everything below is the **mid + far tiers**. The organizing fact:
`bootstrap`/`import`/`publish` need no new infrastructure; **`modify` at a distance
does.** So create-surfaces are cheap, edit-surfaces gate on one shared foundation.

## The dependency spine

```
                       ┌─────────────────────────────────────────┐
   create-and-publish  │  (no new infra — just adapters)          │
   ──────────────────► │  Telegram Phase A · email-in · webhook   │
                       └─────────────────────────────────────────┘
                                        │ independent
   ┌───────────────────────────────────▼─────────────────────────┐
   │  FOUNDATION: writable hosted runtime + identity/auth          │  ◄── the gate
   │  (hosted projection of the file + rwa-edit/1 commit-back)     │
   └───────────────────────────────────┬─────────────────────────┘
                                        │ unblocks
                       ┌────────────────▼────────────────┐
   edit-at-a-distance  │ Telegram Phase B · Phone (voice) │
                       └──────────────────────────────────┘
```

The foundation is the single highest-leverage build: it unblocks *every*
remote-edit surface at once. Until it exists, remote surfaces can only create.

## Threads, in execution order

Each thread states: **autonomy** (what I can do without you), and **gate** (what
only you can provide — a decision, a secret, or infra). I will not silently cross a
gate.

### Thread 0 — Re-vendor skill seed ✅ DONE
Outside the repo, zero collision. Done 2026-06-07 @ 60ee6c8.

### Thread 1 — This roadmap ✅ (you're reading it)

### Thread 2 — Hosted-edit foundation **design**
- **Autonomy:** the full architecture (hosted projection model, the
  `modify`-at-a-distance round-trip, how the file stays canonical, the API surface
  mapped onto the operations contract). Written in
  `docs/plans/2026-06-07-hosted-edit-foundation-design.md`.
- **Gate — ONE decision:** the **auth/identity model** (per-rwa capability token vs
  account-linked vs hybrid). It shapes all downstream edit code, so it is asked
  before any foundation code is written. Options + recommendation are in the design
  doc.

### Thread 3 — Telegram **Phase A** (create-and-publish)
- **What:** `/new a doc about X` (and forwarded md/text → `import`) → bot returns a
  published link. Pure `bootstrap`/`import` + `publish`; **no identity, no
  foundation** needed.
- **Autonomy:** the bot adapter is *thin* — it maps Telegram updates onto the
  existing operations contract (reuse `seed`/`import`/`publish`, never reimplement).
  I can write it and test it fully offline behind a `deps` seam (fake Bot API +
  fake publish), the same pattern as `fetch-page`/`publish-site`.
- **Gate — to RUN (not to write):** a **Telegram bot token** (`@BotFather`) and a
  **host** to run the long-poll/webhook process. The code lands + is green in CI
  without either; going live needs both from you.

### Thread 4 — Hosted-edit foundation **build**
- **Depends on:** Thread 2's auth decision.
- **Autonomy:** the service code (extend `service/` — still zero-dep Node `http`; a
  writable store keyed by identity; serve a live editable projection; accept
  `rwa-edit/1` commits; regenerate the canonical file on demand). Offline-testable.
- **Gate — to DEPLOY:** server/host + DNS + a secret store for identity. Writing and
  testing is autonomous; deploying is yours.

### Thread 5 — Telegram **Phase B** (edit) + **Phone** spike
- **Depends on:** Thread 4 deployed.
- **Phase B:** reply-to-edit a hosted rwa → `modify` round-trip through the
  foundation.
- **Phone:** Twilio voice + STT + agent + TTS over a hosted rwa — a **timeboxed
  1-day spike** to feel the UX, *not* a roadmap dependency.
- **Gate:** Twilio account + number + paid usage (phone); the deployed foundation
  (both). Spike needs your Twilio creds.

## How I work this under the shared checkout

Other instances are actively committing (seed: skinning, skill-layer, CSP). So:
- **Isolation:** each build thread in its own `.worktrees/<thread>` branch.
- **Disjointness first:** these threads live in `cli/` (Telegram adapter), `service/`
  (foundation), and `docs/` — **not the seed**. I confirm file-set disjointness from
  any live WIP before every merge, and merge only with an idle index.
- **Commits:** explicit paths only (`git commit -- <paths>`), never `-a`/`-A`.
- **Coordinate:** announce thread start + merge intent in the group chat; answer
  @mentions.
- **Each thread:** brainstorm (if design-bearing) → plan → subagent-driven TDD →
  two-stage review → finish. Same discipline that shipped clone + publish-site.

## The honest ceiling

I can deliver, autonomously and verified: Thread 0 (done), the Thread 1/2 designs,
and the *offline-testable code* for Threads 3 and 4. I **cannot** autonomously:
stand up a deployed server, mint a Telegram/Twilio token, or provision DNS/secrets.
Those are the gates above — at each, I stop, hand you a precise "here's what to
provision and how to plug it in," and continue once it's available. "Done" will
always mean done-and-verified, never "wrote code that can't run" reported as
shipped.
