# rwa type system — positioning (pressure-tested)

*2026-05-29. A positioning decision, not a spec. Captures a pressure-test of
the "rewritables as Office replacement, every type a dedicated harness"
thesis. Outcome: keep the types, drop the slogan from the architecture,
sharpen the north star. The contracts still live in the layer/edit specs;
this doc decides what we're aiming at, not how the runtime works.*

---

## Decision (TL;DR)

- **North star:** *the self-contained file that edits itself* — portable,
  server-free, account-free, AI-native. This is the moat and the
  feature-killer.
- **"Office replacement" is a marketing on-ramp, not the architecture's
  organizing principle.** It ships in blog posts and pitches ("like
  Word/Excel/PowerPoint, but the file edits itself and needs no account"),
  not in the type model.
- **The type system is `document`-base + affordance layers**, not a set of
  peer harnesses. `datatable` / `presentation` / `application` are a prose
  document plus an added edit-affordance and a present/interact surface —
  each scoped to *the richest version that doesn't break self-containment.*
- **`datatable` is not Excel.** It is an agent-maintained table-*document*
  (typed records the agent can query, transform, and extend in place;
  derived columns computed at edit time), explicitly **not** a live
  formula/recalc calculator.
- **Lead the wedge where we win:** documents that travel across trust/org
  boundaries — where "opens anywhere, no account, carries its own AI" is
  decisive — not teams living inside a shared spreadsheet.

## Grounding: two "type" axes already exist, and they are not the same

Conversations stall because two different notions of "type" get conflated:

- **Axis A — architectural layer** (`docs/specs/rwa-product-types.md`):
  substrate → graph → skill. This is *capability depth* — what runtime
  machinery a container needs. Its thesis is explicitly "these are not
  peers; they live at different layers."
- **Axis B — product kind / harness** (the `--kind` machinery in
  `cli/src/seed.mjs` `KIND_TABLE`, the `SYSTEM_PROMPTS` registry in
  `seeds/rewritable.html`): what gets swapped *per type* — INLINE_DOC
  starter body, lens copy, palette, and the `SYSTEM_PROMPT` framing.

The Office framing is squarely **Axis B**. Its strong claim — "every type is
a dedicated specialized harness, treated as peers" — directly contradicts
Axis A's "not peers, different layers." Resolving that contradiction is the
substance of this doc, not a detail.

## Current state (what is actually built, 2026-05-29)

- Only **two** kinds are implemented as harnesses: `document` (default) and
  `workflow` (`KIND_TABLE`, `SYSTEM_PROMPTS`).
- **"App" is not a harness** — it is a document with interactive content
  (substrate composition); there is no `--kind app`.
- **`presentation` and `datatable` do not exist** anywhere — not in code,
  not in the four-type spec (whose types are document / workflow / app /
  multi-agent-workspace).
- A "kind" today is ~6 substituted regions + one prompt entry. **That is a
  starter template, not an affordance system.** The architecture this doc
  endorses is right; the current implementation is far below what the
  positioning demands.

## The pressure-test

**1. "Office replacement" benchmarks us on incumbents' strengths.** Office's
moats are feature depth, file-format compatibility, and live collaboration.
Our edge is the orthogonal axis: a single portable file that carries its own
intelligence and runs anywhere with no server, install, or account. "Replace
Excel" signs us up to chase formula-engine parity and `.xlsx` fidelity
forever, always behind, while spending nothing on the real edge. Great
on-ramp; terrible north star.

**2. The substrate's value prop is prose-surgical, describe-what-you-want
editing — which fights the spreadsheet model head-on.** Word and PowerPoint
are block/document-shaped; `apply_edits`-on-text serves them and "describe
what you want" is natural for them. A spreadsheet is a *direct-manipulation*
tool — people type values and formulas into cells; AI is a copilot, not the
primary edit path. The lens (LLM-as-primary-editor) is structurally
mismatched to Excel. Datatable is both the type where our core interaction
model is weakest *and* the one invoked to justify the whole framing — a red
flag.

**3. "Harness per type" fragments the one invariant that is the product.**
The substrate philosophy is "document-default with clean override hooks" —
one runtime, one commit contract, one edit protocol. N parallel edit
machineries drift: every invariant, tool change, and security fix must now
hold across N harnesses instead of one. That trades the "single
self-contained file, one runtime" guarantee — the moat — for a
feature-checklist that competes with Office on Office's terms.

**4. The category reframe, and where it itself breaks.** "Rewritable isn't
Office; Office is files + apps *separately*, and rewritable *collapses* them
— the file IS the app." The tempting category line was *self-contained
agentic document*. Pressure-testing that phrase:

- Of the three words, only **"self-contained"** has teeth — it kills
  features (no server, no account, nothing that breaks `file://`
  portability or needs live-multiplayer infra) and is our *only* true
  differentiator (Notion AI, Docs+Gemini, Coda, Copilot are all agentic
  documents; none are self-contained).
- **"agentic"** is table-stakes in 2026 — no edge.
- **"document"** is contested: the `application` type is self-contained and
  agentic but is *not* a consumed artifact. So "document" can be the
  category (covering all four types) *or* a meaningful constraint — not
  both. Held as a category it becomes decoration (slogan risk); held
  literally it excludes `application`.

Resolution: **demote "document" from category to type.** The north star is
"the self-contained file that edits itself"; document is its dominant — and
base — type.

## Verdict

- **NO** to "Office replacement" as the stated north star (overclaims,
  benchmarks on incumbents' strengths, dilutes the wedge).
- **YES** to Office-shaped types as a familiarity on-ramp in marketing.
- **Commit** the north star to *the self-contained file that edits itself.*
- **Organize types by edit-affordance**, bounded by self-containment, on a
  document base.

## The type model: document base + affordance layers

A type is a bundle of **{content-shape + edit-affordance + agent-framing +
starter}** layered on the document base — not a separate harness.

- **`document` (base)** — prose/blocks; edit-affordance = prose-surgical
  (`apply_edits` / DSL); the simplest, ~80%-of-use path stays first-class.
- **`presentation`** — a *sectioned* document + a present-mode renderer.
  Still prose/blocks; still `apply_edits`-friendly. Substrate-native; the
  affordance is layout + present-mode, not a new edit substrate.
- **`application`** — a document + interactive `<script>` regions driving
  `window.modify()` against a structured data region. Already how apps work;
  formalizing it as a type is mostly conventions + framing.
- **`datatable`** — a document of typed records; edit-affordance =
  structured-cell editing + agent-native table ops ("add a column computing
  X", "flag rows where Y", "summarize"). Derived values computed at edit
  time. **No live recalc engine.** Tripwire: the day "document is base"
  feels like it's *crippling* datatable, that's the signal we've drifted
  back toward the calculator we declined to build.

The two load-bearing choices interlock: **document-base + self-containment ⇒
datatable is a queryable/transformable table-document, not a spreadsheet.**

## The wedge

Lead where "opens anywhere, no account, carries its own AI" is decisive:
documents that cross trust/org boundaries — a contract sent to a client, a
report handed to a source, a spec living in a git repo, a take-home
artifact. Do **not** lead with teams-living-in-a-shared-spreadsheet (can't
win, don't want to fight).

## What this does not decide (open, for later sessions)

- **The affordance system itself.** Moving from thin `--kind` templates to
  real per-type affordances (a true present-mode; a real grid-edit UX) is a
  substantial build, not a prompt swap. Unspecced here.
- **Build sequencing.** Which type after document — presentation (cheapest,
  substrate-native) vs. datatable (highest-risk, defines whether the model
  holds). Not decided.
- **Relationship to the layer-cake.** `rwa-product-types.md` (Axis A) and
  this type-as-affordance model (Axis B) need a reconciling pass so the two
  axes are stated as orthogonal rather than competing. Not done here.
- **`workflow` and `multi-agent-workspace`** are left where the existing
  specs put them; this doc is about the Office-shaped content types.

---

*Status: positioning decided and pressure-tested. Next natural step is
either the affordance-system conceptual model or build sequencing — to be
opened in a later session. Supersedes nothing; complements
`docs/specs/rwa-product-types.md` on the orthogonal (Axis B) axis.*
