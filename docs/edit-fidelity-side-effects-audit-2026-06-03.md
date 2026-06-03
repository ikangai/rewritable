# Edit-fidelity & side-effects audit — 2026-06-03

Read-only audit + the fixes it produced. Goal: **make sure edit fidelity is 100%
and edits have no unintended side effects.** Measured against `benchmark/`
(deterministic conformance + stub fidelity) and a real model via the bridge
backend (`claude -p` through web_cli_bridge → Opus).

## Verdict

- **Side-effects: none at the substrate level — proven.** Every committed edit
  applies through one path (`apply_edits` = exact find/replace splice; DSL
  compiles to it; `replace_document` is the explicit escape hatch). The splice
  *cannot* change bytes outside the model's envelope. Confirmed by conformance
  **82/82**, stub fidelity **108 @ meanS=2.00/meanT=2.00/drift=0**, e2e
  **294/0**, lens **254/0**, bridge-security **8/0**, and all CLI suites — plus
  byte-level inspection of real-model edits.
- **Fidelity (did the intended edit land): substrate-faithful.** Given a correct
  envelope the runtime applies it with zero drift (stub = 100%). Real-model
  misses exist but are **model behaviour + benchmark measurement artifacts, not
  substrate bugs** (detail below).
- **One real substrate bug found & fixed:** the lens anchoring↔table ordinal
  desync (could splice an anchored edit into the wrong element). Commit
  `1cb52e0`.
- **One benchmark measurement defect found & fixed:** `computeDriftFromEdits`
  over-reported side-effects for padded anchors. Commit `f4273b1`.

## Real-model screen (108 scenarios, bridge=Opus, fixed oracle)

`meanS=1.69  meanT=1.81  median_drift=0` — but the headline understates reality
because of measurement artifacts. Per-scenario classification:

| Class | Count | Meaning |
|---|---|---|
| Perfect (S=2,T=2,drift=0) | 69 | faithful edit, no side effects |
| S=2 & T<2 ("side-effect suspects") | 4 | **all artifacts — zero real side-effects** (see below) |
| S<2 & T=2 | 19 | fidelity/success miss, **doc otherwise clean (no side effects)** |
| S<2 & T<2 | 6 | no-op or failure-mode-stub scenarios (unchanged doc ⇒ no side effects) |

### The 4 "side-effect suspects" — each triaged to an artifact

- **BULK-03** (S=2,T=0,drift=1): model used `apply_edits`/DSL instead of the
  prompt's requested `replace_document`; the rename is byte-correct. T=0 is the
  scenario's tool-choice penalty, not a side effect.
- **CONT-02** (S=2,T=0,drift=0.15): footnote renumber done correctly via a
  1-edit list rewrite; the scenario's expected regions encode the *stub's*
  2-edit decomposition. Diff shows every changed byte is part of the requested
  renumber. No unintended change.
- **INTL-02 / INTL-06** (S=2,T=0,drift=1): model **no-op'd** (doc byte-identical).
  An unchanged doc has *zero* side effects; drift=1 is the `!envelope.edits`
  fallback mis-scoring "no edit" as "maximal drift". (Also exposes a scenario
  oracle gap: S=2 even on a no-op because those checks only assert invariants
  that hold trivially when nothing changed.)

**Conclusion:** since `apply_edits` is an exact splice, any T<2 on a *successful*
edit can only be (a) the model targeting a region the scenario under-declared,
or (b) the model itself over-editing — never the substrate. Across 108
real-model scenarios, **zero genuine substrate side-effects.**

## Fixes landed

### 1. `computeDriftFromEdits` scores the effective changed core (`f4273b1`)

The stability oracle measured the **full `edit.find` span** against the expected
region. But the system prompt tells the model to *widen anchors with surrounding
context for uniqueness* (`seeds/rewritable.html`), and those shared affixes
splice back byte-identical — they change no bytes outside the core. Example
(ID-02, real model): `find='>HEADING_TEXT Original title</h2>'`,
`replace='>Updated title</h2>'` — actual change is only the heading text (id and
tags identical, S=2) — yet the old oracle scored the whole `<h2>` span as drift
(T=0, drift=0.23). Fix: strip the common find/replace prefix+suffix to get the
effective changed core. Provably safe (core ⊆ full span ⇒ no drift-0 scenario
can regress; stub stays 2.00/2.00/0) and still catches genuine co-modifications
(the core widens). Cleared ID-02/CONT-01/FID-06/IRREG-03 → 2.00/2.00/0. Pinned by
new `benchmark/oracles/diff.test.mjs` cases (padded-anchor, insertion,
co-modification-safety, out-of-region, absent-find).

### 2. Lens anchoring↔table ordinal desync (`1cb52e0`)

`buildSourcePositionMap` descends into `TABLE` to record per-`<td>` entries (TD
is anchorable, spec 0.11), but `anchorableOrdinal` and `liveNodeForEntry` stopped
at the `TABLE`. The unrecorded TD entries shifted every ordinal **after** a
table, so in any document-kind file containing a `<table>`, clicking a block
after the table anchored to a `<td>`'s source range — a later anchored edit
would splice into the cell, not the paragraph (a real side effect). Fix: mirror
the `TABLE` descent into both live walks so all three walks agree; `<td>` cells
are now directly anchorable too. Regression: `tests/lens.mjs` L-TABLE. Found by
shannon (gh #134) during action-layer stress-testing.

## Bridge harness enablement (`6ad10fa`, `de9d176`)

- `benchmark/runners/model.mjs`: `RWA_BRIDGE_TOKEN` (bearer auth — web_cli_bridge
  gained token auth after the 2026-05-27 RCE fix) + `RWA_CLAUDE_BIN` (the
  GUI-launched bridge has a bare PATH; point it at the absolute `claude`).
  Dropped `--permission-mode bypassPermissions` from the benchmark's bridge
  command — the bridge agent only emits a text envelope (no tools), so it was
  both pointless and the exact RCE anti-pattern the shared seed already removed.
- `benchmark/runners/run-fidelity.mjs`: `RWA_FID_ONLY` (case-insensitive subset
  filter by id-prefix / category / tag) + `RWA_FID_N` (per-scenario N override)
  to make slow real-model runs tractable.

To reproduce a real-model screen:
```
RWA_BRIDGE_TOKEN=<token> RWA_CLAUDE_BIN=/opt/homebrew/bin/claude \
  node benchmark/runners/run-fidelity.mjs bridge apply_edits
# subset: add RWA_FID_ONLY=ID,CONT,INTL RWA_FID_N=1
```

## Residual (benchmark measurement fairness — not substrate; future work)

These cause the *benchmark* to understate real-model quality; none are product
bugs. Left as-is to avoid masking real misses, flagged here:

1. **No-op scored as drift=1.** When the model makes no edit (doc unchanged), the
   `!envelope.edits` fallback returns drift=1/T=0. An unchanged doc has no side
   effects; T should be 2. Affects INTL-01/02/03/06, ROB-05, some FAIL-*. A
   centralised "result===fixture ⇒ drift=0" override in the runner would fix the
   headline `meanT` honestly (S still records the miss).
2. **Success oracles over-fit to stub wording.** FID-02 requires the literal word
   "rewritten"; INTL-01 requires the stub's specific Arabic word "المعدل". A
   real model that edits correctly with different wording fails these. Causes
   false S<2.
3. **`replace_document` legitimately chosen → drift=1 penalty** (BULK-03 et al.).
4. **Failure-mode scenarios are stub-only** (FAIL-*): they inject a specific
   pathological envelope to test runtime handling; a real model doesn't
   reproduce it, so S/T are meaningless under a real model. Consider a
   `stubOnly: true` flag the real-model runner skips.
