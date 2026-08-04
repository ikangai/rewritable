# Blindspot remediation — sequencing plan

**Status:** PROPOSED (2026-08-04, agent-16). Nothing built. Issues [#1–#16](https://github.com/ikangai/rewritable/issues) filed.
**Trigger:** operator goal — two blindspot passes over the repo ("what are my unknown unknowns?"),
2026-08-03 and 2026-08-04.
**Scope of this document:** the order to attack the findings in, and why that order. The findings
themselves live in the issues; this does not restate them.
**Method:** §3, adopted from Weng, *"Harness Engineering for Self-Improvement"* (2026-07-04).

> The blindspots are not random. They are the negative space of the project's own methods.
> Verification is jsdom, so interaction, touch and performance are unseen. Documentation is
> spec-and-mirror aimed at agents, so human onboarding, legal surface and prior art are unseen.
> Threat analysis is per-feature, so chains that cross features are unseen. Each method is strong;
> that is exactly why its complement is invisible from inside.

## 1. What the audit found

Sixteen findings across two passes. Three matter disproportionately:

| # | Finding | Why it leads |
|---|---|---|
| [#1](https://github.com/ikangai/rewritable/issues/1) | IDB unconditionally beats the file's `INLINE_DOC` at boot | Silent data loss; contradicts the core durability promise; already reproduced once |
| [#2](https://github.com/ikangai/rewritable/issues/2) | No LICENSE; npm published without license/repo/author; no SECURITY.md | Legally blocks all adoption; hours to fix |
| [#3](https://github.com/ikangai/rewritable/issues/3) | No CI | ~20 mirror obligations, ~6 gated; the rest rest on memory |

The remainder group into: security posture ([#4](https://github.com/ikangai/rewritable/issues/4),
[#5](https://github.com/ikangai/rewritable/issues/5)), verification capability
([#8](https://github.com/ikangai/rewritable/issues/8), [#9](https://github.com/ikangai/rewritable/issues/9)),
spec truth ([#6](https://github.com/ikangai/rewritable/issues/6), [#7](https://github.com/ikangai/rewritable/issues/7)),
user reach ([#10](https://github.com/ikangai/rewritable/issues/10), [#11](https://github.com/ikangai/rewritable/issues/11)),
and longevity/ops ([#12](https://github.com/ikangai/rewritable/issues/12)–[#16](https://github.com/ikangai/rewritable/issues/16)).

## 2. Sequencing rationale

Three constraints drive the order.

**CI comes before seed surgery.** #1 is the highest-value fix and it changes the boot path — the
most load-bearing code in the project. Doing that with no automated gate, in a repo where a fleet
of agents commits in parallel, is the wrong order. #3 is cheap and makes everything after it safer.

**Decisions come before their code.** #4, #5 and #11 are not "go implement X" — they are "decide
what posture we hold, then implement it". Writing code first would encode a posture nobody chose.
Each needs a short written decision from the operator; only then does an implementation task exist.

**Capability before the bugs it catches.** #10 (no tap target for the whole-document prompt) is a
symptom; #9 (no real-browser lane) is why it went unseen for a month. Fixing #10 alone leaves the
next such regression equally invisible. Fix the symptom cheaply now *and* build the lane, but track
them as distinct outcomes.

## 3. Method: harness-engineering discipline

Adopted after reading Lilian Weng, *"Harness Engineering for Self-Improvement"*
(2026-07-04, `lilianweng.github.io/posts/2026-07-04-harness/`). Her definition:

> the system surrounding a base model that orchestrates execution and decides how the model thinks
> and plans, calls tools and acts, perceives and manages context, stores artifacts, and evaluates
> results.

**That is a description of `seeds/rewritable.html`.** The seed orchestrates execution
(`modify()`), decides how the model thinks (`SYSTEM_PROMPTS`), calls tools (`apply_edits` /
`apply_dsl_plan` / `replace_document`), perceives and manages context (the doc between `<DOC>` tags,
frozen zones, `data-rwa-id`), stores artifacts (IDB + the file), and evaluates results (the
validator chain). A rewritable is a harness that ships as one file. Three of her principles change
how the phases below should be executed.

**3.1 — The evaluator sits outside the loop.** Weng: *"A self-improvement loop optimizes whatever
signal it is given… The evaluator and permission control should likely sit outside the loop that
evolves harness."* AHE enforces this concretely: harness edits *"cannot disable the verifier, swap
the model, or raise reasoning budgets"*, so recorded gains stay *"attributable to harness edits."*

Applied here: this repo is developed by a fleet of agents that write both the code and the tests
that pin it. That is the closed loop she warns about, and today it has no gate at all (#3). So #3
is not hygiene — it is the missing evaluator. Two design constraints follow, and they belong in
#3's implementation:

- CI configuration and the benchmark oracles must not be editable in the same change as the code
  they gate. Weakening a gate should be a visible, separate act.
- The benchmark's referee oracles (`benchmark/oracles/dsl-compiler.mjs`,
  `tools/self-description.mjs`) are already exactly Weng's "verification outside the loop" — an
  independent implementation the code is judged against, not a test the code's author wrote. **This
  is the project's strongest existing asset in her terms.** Extend that pattern; don't dilute it.

**3.2 — Held-in and held-out splits.** Weng: *"Candidate edits are evaluated by regression tests on
held-in and held-out splits"* — held-in confirms the weakness resolves, held-out confirms no new
issue appears, and only candidates clean on **both** merge.

The repo already does this informally: plan docs report the targeted suite plus a "neighbours green"
sweep. Name it and enforce it. Every phase below states its held-in test (the new one pinning the
fix) and relies on CI for held-out (the existing suites + conformance).

**3.3 — Decision observability: every edit carries a falsifiable prediction.** Weng: *"Every edit is
paired with a prediction for the next round to validate,"* with each change documenting failure
evidence, inferred root cause, targeted fix, and predicted impact.

The issues already carry evidence, root cause, and fix. They do **not** carry predictions. Each
phase below now states one — a claim that can be checked and can turn out wrong. A fix whose
prediction fails is information, not embarrassment; recording it is what makes the next round
cheaper.

**On human oversight.** Weng: *"Humans should move up the stack, not be removed from the loop…
oversight at the right time, at the right abstraction level."* §5 (operator decisions) is that
touch-point design, and the reading validates keeping it as a hard gate rather than defaulting the
calls.

**One warning worth heeding.** Among her failure modes: *diversity collapse in evolutionary loops*,
and *over-optimism* — *"declaring success despite noisy failed experiments."* This repo is developed
by a population of near-identical agents reviewing each other's work, reporting large green
test counts over a verification surface that cannot see the interaction layer (#9). Both failure
modes are live here, not hypothetical. CLAUDE.md Rule 12 exists for the second one; the first has
no mitigation today beyond the operator.

## 4. Phases

### Phase 0 — Foundations

*Goal: make the repo safe to change and legal to use. No product decisions required.*

**0.1 — Project meta (#2).** Add `LICENSE` (MIT) at root. Add `license`, `repository`, `author` to
`cli/package.json`. Add `SECURITY.md` with a disclosure address, response window, and scope
(seed / CLI / hosted service). Optionally `CODE_OF_CONDUCT.md` and `.github/` issue templates.
Publish a CLI patch release so registry metadata is correct.
*Verification:* `npm view rewritable license` returns MIT; GitHub shows a license header and a
Security policy tab.
*Size:* a few hours. No dependencies. **Start here.**

**0.2 — CI (#3).** A GitHub Actions workflow on push + PR running what already exists: root
`tests/*.mjs`, `cli/ npm test`, `service/ npm test`, and `benchmark/` conformance +
`fidelity:stub` (stub needs no API key). Add a reference-freshness job asserting
`node tools/regenerate-refs.mjs` yields no diff.
*Verification:* deliberately drift one mirror (e.g. edit `RWA_SKINS` in the seed only) and confirm
CI fails.
*Size:* half a day. Depends on nothing.

**Exit criteria:** a red build is possible, and the project is legally usable.

**Prediction (§3.3):** wiring up the existing suites unchanged will surface at least one already-red
signal — a stale reference, a drifted hand-mirror, or a suite that no longer runs clean on a cold
checkout. If CI goes green on the first try across all four suites, be suspicious that a suite is
not actually running rather than relieved.

---

### Phase 1 — Stop the bleeding

*Goal: close the one finding that can destroy user work.*

**1.1 — Boot reconciliation design (#1).** Write `docs/plans/2026-08-XX-boot-reconciliation-design.md`
before touching the seed. It must resolve:
- where the `INLINE_DOC` hash is stored (`rwa_state` is the natural home — it is already
  machine-local and excluded from the file by Invariant 1)
- the three-case decision table: hashes equal → IDB wins (today's behaviour); differ + IDB clean →
  adopt `INLINE_DOC`; differ + IDB dirty → user chooses, never silent
- what "IDB clean" means precisely, and whether the hosted runtime's existing `baseHash` divergence
  vocabulary can be reused rather than inventing a second one
- the restatement of **Invariant 6**, which currently says IDB is the source of truth after
  hydration. The fix narrows that; the invariant must be rewritten deliberately, not left to drift
  (this is itself an instance of #7)

**1.2 — Build it.** Seed change at `getDoc()` (`seeds/rewritable.html:1189`) plus the chooser UI.
Mirror considerations: this is boot-path only, so the CLI apply-path mirror is untouched — but
confirm, do not assume.
*Verification:* new `tests/boot-reconcile.mjs` covering all three cases plus the fresh-container
path; full seed suite + conformance green; references regenerated. A real-browser pass is required
here — the failure mode is inherently about reopening a file (see #9).

**1.3 — Touch entry point (#10).** Independent of the above and much smaller: restore a persistent
tappable affordance that calls `openPal()` unscoped, and add `(pointer: coarse)` handling for the
selection bubble (`:2111`) and image chip (`:1310-1313`).
*Verification:* jsdom can pin that the element exists and is wired; only a real device or emulation
can pin that it works — carry it into Phase 3's lane.

**Exit criteria:** external edits to a container can no longer vanish silently; the core gesture is
reachable without a keyboard.

**Prediction (§3.3):** the three-case decision table will not survive contact with real containers
unchanged — the "IDB clean" definition is the load-bearing part and the likeliest thing to be wrong,
because a container that has been opened but not edited may still hold a hydrated `rwa_doc` that is
byte-equal to a *previous* `INLINE_DOC`. Expect to need a stored hash rather than a live comparison,
and expect the first design draft to miss it.

---

### Phase 2 — Decide the security posture

*Goal: replace an inherited threat model with a chosen one. Output is decisions plus a document;
code follows from them.*

**2.1 — Write the missing threat document (#4).** The `file://` received-container case, stated as
explicitly as `docs/plans/2026-05-17-share-subdomain-isolation.md` already states the hosted case.
It must cover: main-realm document scripts, the null-origin shared storage surface, and the fact
that the primary gesture is now "open a file someone sent you and type your key into it".

**2.2 — Decide mitigations (#4).** Options and their real costs: a document-realm CSP (currently
blocked by the inline-script seed design); moving the key out of a document-readable realm; a trust
ceremony on first open of a container the user did not author; or explicit accepted risk with a
user-facing warning. **Accepting the risk is a legitimate outcome — accepting it without recording
the decision is not.**

**2.3 — Close the `replace_document` chain (#5).** Decide among: consent-gating script/style
*introduction*; extending the shape check with a confirmed override; fencing the document body in
the prompt with delimiters it cannot forge; or rendering injected scripts inert unless trusted.
Then implement, and update `rwa-edit-spec.md`'s "deliberate constraint" passage to carry the
security rationale rather than only the ergonomic one.
*Verification:* a test asserting an agent-authored `replace_document` introducing a `<script>` is
refused or gated on the normal ⌘K path.

**Note on disclosure.** #4 and #5 are public issues on a public repo, written deliberately at the
level of *which property is missing* rather than as working recipes. Once `SECURITY.md` exists
(0.1), any concrete exploit discussion belongs in a private advisory. See §6.

**Exit criteria:** the posture is written down and either implemented or explicitly accepted.

**Prediction (§3.3):** gating script introduction in `replace_document` will break at least one
existing legitimate flow — the workflow kind's `<script type="text/rwa-step">` step bodies are
authored by the agent through exactly this path. If the gate lands with no flow broken, it is
probably not actually covering the path it claims to.

---

### Phase 3 — Close the verification gap

*Goal: make the invisible classes visible, so Phase 1/2 fixes stay fixed.*

**3.1 — Real-browser lane (#9).** Playwright covering what jsdom structurally cannot: pointer and
touch input, native selection, drag-drop, focus, and the FSA save path where feasible. Start with a
handful of smoke journeys rather than parity — the goal is to have a lane, then grow it. Fold in
1.3's touch assertions and 1.2's reopen-the-file scenario. Wire into CI (0.2).

**3.2 — Scale fixtures and budgets (#8).** Add fixtures at 50 KB / 200 KB / 800 KB. Set explicit
budgets for render, sourcemap rebuild, and commit at each size; assert them in the benchmark.
**Measure before optimising** — the whole-document commit write-amplification (`:6747`, `:6737-6738`)
and the unmemoised `buildSourcePositionMap` (`:3176-3230`) are the suspects, but neither is a
confirmed problem until the numbers exist.

**Exit criteria:** a touch regression and a scale regression both fail CI.

**Prediction (§3.3):** the first real-browser run will fail on something currently believed green.
The hosted-edit work already has one documented instance (a `baseHash` bug jsdom missed). If the
lane comes up clean on existing behaviour, the journeys are too shallow to be measuring anything.

**Prediction (§3.3):** `buildSourcePositionMap` — not the whole-document IDB write — will dominate
at 200 KB, because it runs a fresh `DOMParser` parse plus a full regex scan on **every** render
while the commit write happens once per commit. Stated so it can be wrong: if the numbers say
otherwise, the undo-stack amplification is the real target and this plan was mistaken about which
one to optimise.

---

### Phase 4 — Spec truth

*Goal: the canonical spec stops asserting things that are not built.*

**4.1 — Multi-tab (#6).** Decide: build the §10.3 `BroadcastChannel` lock, or correct §10.3 to
describe reality and move the design to a plan doc. Note this interacts with #1 — the losing tab's
state can outlive the winner's under today's boot rule.

**4.2 — Spec-fiction sweep (#7).** Sweep the normative specs for present-tense descriptions of
unbuilt behaviour; mark each Built / Planned / Aspirational, using the convention the actions specs
already model well. Consider a lightweight CI gate: normative sections name the test that pins them,
and CI asserts the named test exists.

**Exit criteria:** every normative claim is either pinned by a test or labelled as not built.

---

### Phase 5 — Longevity, reach, and service hygiene

*Lower urgency, but #12's cheap half is time-sensitive.*

**5.1 — Seed version marker (#12).** Add `RWA_SEED_VERSION` **now**. It is trivial today and
unrecoverable for containers already in the wild — every day without it is more unidentifiable
files. Design `rwa upgrade` separately, after reading TiddlyWiki's upgrade wizard (#16).

**5.2 — Service legal + abuse (#13).** Operator takedown tooling; an abuse contact covering
published documents, not just skills; ToS / privacy / impressum. The impressum is an EU legal
requirement.

**5.3 — Cloud sync (#14).** Manually exercise the FSA save path on iCloud- and Dropbox-synced
directories. Document what happens; handle or warn. Best done after #1, since a sync-restored older
file is exactly the divergence case #1 addresses.

**5.4 — Usage signal (#15).** Aggregate per-route counters, no per-user identifiers, no client-side
tracking. Enough to answer "is this used at all".

**5.5 — Onboarding (#11).** Needs a product decision first: demo proxy, guest quota, or
bring-your-own-key as a permanent recorded boundary. #15 should land first — it tells you how many
people actually bounce here.

**5.6 — Prior art (#16).** Read TiddlyWiki's upgrade, saver, and plugin-trust mechanisms. Add an
honest §15 entry. The agent-authored rewrite loop is the genuine novelty and reads stronger beside
an acknowledged ancestor than in its absence.

## 5. Decisions only the operator can make

These block their phases. None can be defaulted by an implementer.

1. **License** — MIT as the README states, or something else? (#2, blocks 0.1)
2. **Security posture** — which of the #4 mitigations are in scope, and is explicit accepted risk
   the answer for the rest? (blocks 2.2)
3. **`replace_document` script introduction** — gate it, or keep the capability and document the
   risk? This is a real ergonomic cost either way. (blocks 2.3)
4. **Multi-tab** — build the lock or correct the spec? (blocks 4.1)
5. **Onboarding boundary** — is bring-your-own-key permanent? (blocks 5.5)
6. **Service legal** — is the hosted service staying public and anonymous? If yes, 5.2 is not
   optional. (blocks 5.2)

## 6. Notes and non-goals

- **Not a refactor — but the non-goal is weaker than it was.** Nothing here proposes breaking up the
  10,470-line seed, and that stays out of scope. The original framing was "a known tradeoff, not a
  blindspot." The harness reading (§3) undercuts half of that. Weng's OS analogy — *"a harness
  should encapsulate complicated logic while keeping the interface simple"* — is a principled
  argument that ~20 hand-maintained mirrors are **duplicated** complexity rather than
  **encapsulated** complexity, which is the failure mode that analogy names. CI (#3) makes the
  duplication safe; it does not make it good. Worth revisiting as its own design question once
  Phases 0–2 land, rather than continuing to file it under taste.
- **Issues #4 and #5 are public.** They are written restrained for that reason. If the operator
  prefers them private, convert with:
  `gh issue view 4 --json title,body` → open a draft security advisory → close the issue.
- **Estimates are rough sizes, not commitments.** Phase 0 is hours; Phase 1 is days including
  design; Phases 2–5 are scoped by the decisions above.
- **CLAUDE.md alignment.** Phase 1.1 and Phase 2 exist because of Rule 1 (think before coding) —
  each is a design/decision step before a code step. The "measure before optimising" instruction in
  3.2 is Rule 2. The Invariant 6 restatement in 1.1 is Rule 7: surface the conflict rather than
  averaging it.

---

*Plan version 2 — proposed, unbuilt. Supersedes nothing. Findings: issues #1–#16. v2 adds §3
(harness-engineering discipline: evaluator outside the loop, held-in/held-out splits, falsifiable
predictions per phase) after reading Weng 2026-07-04, and weakens the "not a refactor" non-goal
accordingly.*
