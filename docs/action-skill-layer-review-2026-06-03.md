# Action layer / skill layer — review & stress test (2026-06-03)

Reviewer: shannon. Read-only review + ephemeral browser fixtures; no shared source modified.
Method: spec read → 4-site implementation map → full existing test-suite run (baseline) →
adversarial multi-agent code review (14 confirmed findings, re-triaged) → **real-Chrome visual
testing of every product kind** via chrome-devtools-mcp, containers served at `http://localhost:8799`.

---

## 1. Headline: what is actually implemented

The "action/skill layer" is partly a shipped substrate surface and partly a deferred design. This
distinction is load-bearing for the review, so it leads.

| Layer | Spec | Status |
|---|---|---|
| **Substrate action surface** | rwa-lens-spec, rwa-self-description-spec, product-types | **SHIPPED** — lens, provider/affordance kernel, self-description/1, kind machinery, visual interfaces |
| Graph layer (`rwa-graph/1`) | — | deferred by design |
| **Skill layer** (`re-write-able-actions-spec-v0.7`) | v0.7 | **SPEC-ONLY — zero implementation** |

**The v0.7 skill layer is entirely unimplemented.** A whole-repo sweep (seed, cli, service, tests,
benchmark, tools) found **no code** for: the install dialog, `.rwa-skill.json`/`rwa-skill/1` envelope,
vault (`runtime.vault`, Argon2id), message bus (`runtime.bus`), Worker-mode skill execution
(spawn/in-Worker shadowing/identity_tag/pool), the permission-pattern grammar (`network:`/`vault:`/
`fsa:`/`bus:`/`idb:`), Ed25519 provenance/`rwa_sources`/lookalike detection, recognizable-combinations/
forced-Worker, `runtime.skills.invoke`, or CSP generation. Confirmed live: the runtime surface is
`{id, db, fs, modify, commit, undo, applyEnvelope, on, provide, setView, describe, status}` — **no
vault/bus/skills**. v0.7 says "the action layer is *implementable* end-to-end"; it is not implemented.
This is consistent with CLAUDE.md (skill layer "deferred") — flagged here so nobody reviews a phantom.

**What *is* the user-facing action harness today (and was reviewed/tested):**
- **The lens** — the primary action surface (direct-text + slash-command, anchored + default).
- **The provider/affordance kernel** — `runtime.provide`/`runtime.describe`; `view` executes,
  `edit-surface`/`compute` are declarative-only in v1.
- **self-description/1** across four mirror sites (oracle `tools/self-description.mjs`,
  `cli/src/identity.mjs`, `cli/src/doc.mjs`, seed `runtimeDescribe`).
- **The PRODUCT_KIND machinery** — document / workflow / presentation.
- **The visual interfaces**: lens card, ⓘ info panel, presentation slide chrome, datatable grid/
  summary + cell-edit, workflow runner gestures.

## 2. How the *type* defines actions / interaction (verified)

`PRODUCT_KIND` is the interaction stance. It is consistent across the three sites (SYSTEM_PROMPTS in
the seed, KIND_TABLE/kindOverrides in `cli/src/seed.mjs`, KIND_PROVIDERS in identity/oracle) — no drift
found; an unknown kind falls back safely to `document`.

| Kind | Lens placeholder | Click-to-anchor | First-party affordance | Distinct interaction |
|---|---|---|---|---|
| document | "Write, or describe what you want." | **on** | none | block anchoring + prose edits |
| presentation | "Add a slide, or describe a change." | off | `view:presentation` (verified) | Present toggle + slide nav |
| workflow | "Describe what you want this workflow to do." | off | none (frozen runner) | run/pin/test/delete/insert/drag |
| datatable* | "Write, or describe…" | — | cell(verified)+total(verified)+grid/summary(declared) | model-free cell-edit + computed column |

\* datatable is a *consumer-built* custom kind (example), not a built-in template — it earns its
affordances at runtime via `provide()` + an edit-unreachable `#rwa-affordances` declaration.

## 3. Test baseline — all green

- `tests/` jsdom suite: kernel 10, view 17, datatable 46, identity 50, lens 246, write-path 10, r5 3, e2e 294 — **all pass**
- `cli/tests/` (21 files incl. doc, identity, ls, edit-dispatch) — **all pass**
- `benchmark` conformance **82/82**; oracle tests 11+5 pass

## 4. Visual interface testing (real Chrome, per kind)

Exercised the actual event handlers/rendering jsdom can't catch. Screenshots in `.claude/shots/`.

- **Document lens:** direct-text append (actor `user:lens`, scope eof), multi-paragraph split, ⌘Z
  undo ("↩ UNDONE" chip), click-to-anchor (badge + highlight + lens reposition), **anchored insert
  lands after the anchor block** (not EOF), Esc release, `/`→command-mode, info panel renders
  describe() ("RE-WRITEABLE · DOCUMENT", "5 addressable blocks", Edit/Undo/Save, "The file knows what it is").
- **Datatable:** cell-edit 1→2 → compute recalc TOTAL $12k→$24k, budget $41,070→$53,070, self-attributed
  `actor:"user:cell" surface:"datatable:cell-edit"`; ⌘Z reverts via the same audited pipeline;
  GRID↔SUMMARY toggle (grouped %).
- **Presentation:** PRESENT toggle → `activeView:"presentation"`, 3 slides, → nav; **Invariant 8
  holds** (stored bytes never gain `<section>`/`rwa-slide`).
- **Workflow:** runner renders the full gesture set; **Run** cascades 21→42 (prev-threading), status
  "✓ done (2 nodes)", `data-last-output` cached; **Pin** → `data-pinned-output`, committed
  `surface:"visual:wf-pin-step"`. (Scaffolded via `rwa edit --plan` replace_document — frozen zones preserved.)

## 5. Findings (re-triaged; severities corrected against reproduction & threat model)

### HIGH — Anchoring↔table ordinal desync  *(reproduced end-to-end)*
`buildSourcePositionMap` (seed `seeds/rewritable.html:1990-2044`, lines 2004 + 2028) descends into
`TABLE` to record `TD` entries, but the two live walks — `anchorableOrdinal` (2372-2388) and
`liveNodeForEntry` (2394-2415) — do **not** descend. The three walks must agree; they don't.
**Effect:** in any document-kind container (click-to-anchor) containing a `<table>`, clicking a block
*at/after* the table anchors to the wrong entry (a TD). **Reproduced** (`/tmp/rwa-visual/tabletest.html`):
clicking "After the table paragraph" → badge **"anchored on td"** while the highlight sits on the
`<p>` — logical anchor (a TD source range) and visual highlight disagree, so an anchored insert/edit
splices into a table cell, not the paragraph the user sees. Clicking a TD directly is a no-op (ordinal −1).
**Fix:** add the same `if (child.tagName === 'TABLE') walk(child)` exception to both `anchorableOrdinal`
and `liveNodeForEntry`; add a jsdom regression that anchors a block after a table. (Seed change → regenerate references.)

### MEDIUM — Typed `/command` lost on no-API-key  *(reproduced)*
`modify()` (`seeds/rewritable.html:3907-3913`) does `return;` (not `throw`) on the no-key preflight
after showing "no API key — open ⚙ settings" and opening settings. But `submitLens` (2515-2524) only
preserves the draft when the awaited call **throws** (the documented intent at 2515-2517; the
concurrent-modify path at 3918 correctly throws). So a first-run user who types an instruction and
submits loses it. **Fix:** throw after surfacing the error, or restore `input.value` on this path.

### LOW
- **commitCore null-conflation (latent).** `commitCore` (2909) routes *both* `synthesizeDefaultAppend`
  null (empty-doc, correct) and `synthesizeAnchoredInsert` null (resolution failure) into
  `replace_document`. Currently safe only because the renderDoc(874)→releaseAnchor invariant prevents
  a stale anchor from ever reaching submit (the workflow flagged this as "critical data loss"; I
  **reproduced the trigger and it is NOT reachable** — the anchor self-releases on re-render). Harden
  defensively: make an anchored null abort instead of falling through to whole-document replace.
- **Actor provenance inconsistency.** Workflow runner gestures commit `actor:"user:lens"` (surface
  correctly `"visual:wf-pin-step"`), while the datatable edit-surface self-attributes `actor:"user:cell"`.
  Pass a distinct actor from the runner gestures for parity.
- **History 1000-entry cap drops silently** (`3147-3149`) — a note/affordance would help.
- **wrapDirectText in a TD context** (2308) yields odd HTML once TD anchoring becomes legitimate (post-fix).
- **a11y:** lens/settings inputs lack labels; the settings API-key password field is not in a `<form>`.

### INFO — out of threat model (workflow over-rated these as HIGH security bugs)
The self-description trust model defends against the **agent drifting the declaration via text edits**,
and that path *is* closed (agent edits land inside `#rwa-doc-mount`, can't add `data-rwa-frozen`; a
text-injected `#rwa-affordances` is never trusted; the CLI enforces it statically). The flagged
"escapes" require an **in-document `<script>`** — trusted author code the substrate explicitly allows
for interactive docs:
- **AFT-001/002** — live `describe()` reads the live DOM, so an in-doc script could inject a fake
  `#rwa-affordances` outside the mount and have it trusted. By design; worth a spec note that *live*
  self-description honesty assumes no adversarial in-document script (the CLI static projection makes no such assumption).
- **ACTOR-001/003** — `actor` passed to `runtime.applyEnvelope` is a provenance *hint*, never
  authenticated (by design). Not a security boundary; don't treat it as one.

## 6. What held up

- Lens state machine (default/anchored), the mutex + `nonAgentCommitChain` serialization (R5 — the
  concurrent-commit acceptance test passes and the datatable burst surfaced no `concurrent_modify`).
- self-description/1: registry-verified vs declared, `declared > static` precedence, the
  edit-reachability gate (closed against the text vector), 4-site alignment (mirror tests pin it).
- Frozen-zone + class-lock enforcement (marker + `data-rwa-frozen` attribute + reserved-substring)
  across seed and `cli/src/apply-edits.mjs` — no defects found.
- Presentation Invariant 8 (render is mount-only); workflow runner execution + per-step state.
- Pre-actor history records still render.

## 7. Recommendations (priority order)
1. Fix the anchoring↔table desync (HIGH; clean, isolated; add the regression test). Coordinate — seed is hot.
2. Preserve the lens draft on the no-key path (MEDIUM).
3. Harden `commitCore` against the anchored-null path; unify non-lens UI actor attribution (LOW).
4. Add a spec note bounding *live* self-description honesty (in-doc scripts are trusted author code).
5. When the v0.7 skill layer is built, the install dialog is the design driver — keep the
   bounded-vocabulary dialog as the acceptance fixture.
