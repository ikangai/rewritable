# rwa product types — the layer-cake taxonomy

*v0.1, draft, 2026-05-18. Names the architectural layers, maps the four
product types onto them, points at the canonical spec for each. Short by
design — the file's job is to be a routing index, not a re-statement of
spec content.*

---

## Why this exists

Conversations about "is the rwa runtime product-agnostic?" repeatedly
stalled on the same confusion: the four product types (document,
workflow, app, multi-agent workspace) were being framed as peers on one
axis. They are not peers. They live at different *architectural layers*.
Asking whether the substrate runtime is agnostic across products that
require different layers above it is the wrong question — the right
question is "which layers does each product need, and which layers
exist?"

This document names the layers, maps the products, and routes the
reader to the spec that owns each layer's contract.

## The three layers

```
┌─────────────────────────────────────────────────────────────┐
│  Skill layer        — permission-gated skills, vault, bus,  │
│                       install dialog, Worker-mode isolation │
│                       Spec: re-write-able-actions-spec-v0.7 │
├─────────────────────────────────────────────────────────────┤
│  Graph layer        — multi-step workflows, stage model,    │
│                       per-item state, batch dispatch        │
│                       Spec: rwa-graph/1 (deferred)          │
├─────────────────────────────────────────────────────────────┤
│  Substrate layer    — single self-contained .html, INLINE_DOC│
│                       in IDB, lens, modify/commit/undo,     │
│                       agent invocation via apply_edits /    │
│                       apply_dsl_plan / replace_document     │
│                       Spec: re-write-able-spec.md (v0.10)   │
│                       Edit protocol: rwa-edit-spec.md (v1.4)│
│                       DSL: rwa-edit-dsl-spec.md (v0.1)      │
│                       Lens: docs/specs/rwa-lens-spec.md     │
│                       Runtime: seeds/rewritable.html        │
└─────────────────────────────────────────────────────────────┘
```

Lower layers serve higher layers. The substrate provides storage,
rendering, the commit invariant, and the agent loop. The graph layer
(once spec'd) will orchestrate substrate edits across stages, calling
into the substrate for each step's `modify()`. The skill layer extends
the agent loop with capability-gated skills and an install dialog,
calling into the substrate for storage and into the graph layer (where
present) for workflow orchestration.

A given container can live entirely at the substrate (a pure prose
document, an app artifact with one interactive surface). A container can
add the graph layer on top of the substrate (a workflow that runs items
through stages). A container can add the skill layer (a multi-agent
workspace with vault, permissioned skills, and Worker-mode isolation).
The substrate is necessary for everything; the higher layers are
opt-in.

## The four product types, mapped

**These are primary stances, not exclusive categories.** A single file
leans toward one product type; the layers and content shapes compose
freely. A document can embed an app inside its body (substrate-layer
composition, see `re-write-able-spec.md` §5.8). A workflow's per-item
processing typically *produces* documents. A multi-agent workspace's
converged output is typically a document the user reads. The four
types name the primary stance — the orientation — not a hermetic
boundary. The closing sentence under each type below names that type's
siblings or composition surfaces explicitly.

### 1. Document — substrate layer

A pure prose container. INLINE_DOC is mostly text; the agent applies
surgical edits via `apply_edits`. Nothing above substrate is needed.
The canonical worked examples ship in-repo:

- `seeds/rewritable.html` (blank starter)
- `hello.html` (one-liner)
- `re-write-able-spec.html` (the spec doc, rendered as a re-writeable)

Documents and apps are sibling content-shapes on the substrate;
documents are also where the other product types' outputs typically
converge — workflow per-item results and workspace converged outputs
both land here.

### 2. Workflow — graph layer (over substrate)

A multi-step process: items move through stages (e.g. `inbox →
in-progress → done`), each stage may invoke an agent task on the item,
and per-item state is the durable artifact. Requires a graph layer
above the substrate — a stage model, per-item state machine, batch
dispatch, in-flight lens-lock semantics. This layer's spec
(`rwa-graph/1`) is referenced by `re-write-able-actions-spec-v0.7.md`
§5.3 but not yet committed to the repo. Until it lands, workflows are
expressible only as ad-hoc patterns inside artifacts (see app type).

Once `rwa-graph/1` lands, workflows compose with documents (per-item
output, substrate layer) and optionally with the skill layer
(per-stage agents as permissioned skills).

### 3. App — substrate layer

An interactive artifact: drop zone, form, list, board, tracker.
Inline JS renders a UI; the artifact calls `window.modify()` to drive
the agent against a structured data region inside the INLINE_DOC.
Lives at the substrate — apps need no additional layer; they exploit
substrate primitives (`<script>` re-execution on render, form-state
preservation across commits, frozen zones around UI chrome).
Conventions documented at `docs/specs/rwa-artifact-conventions.md`;
worked example `demo/invoice-tracker.html`.

Apps and documents are siblings at the substrate layer. The
distinction is content-shape (prose vs. interactive UI), not
architectural layer.

### 4. Multi-agent workspace — skill layer (over substrate)

Multiple agents collaborating in one container: distinguished by role,
prompt, and capabilities; per-agent vault namespaces; attributed edits;
inter-agent messaging via the bus; isolation via Worker mode. Requires
the full skill layer. The contract is specified in
`docs/specs/re-write-able-actions-spec-v0.7.md`; the substrate does not
yet implement it (no vault, no permission grammar, no Worker pool, no
install dialog). The path from here is "implement what's specified,"
not "design from scratch."

The workspace's converged output is typically a document on the
substrate — workspaces produce artifacts the user reads, with the
substrate as the convergence target.

## What this means for the substrate

The substrate's job is to be **document-default with clean override
hooks**. Not product-agnostic. Document and app live here, and the
defaults — prose typography on `#rwa-doc-mount`, lens placeholder
copy, click-to-anchor on `ANCHORABLE_TAGS`, the SYSTEM_PROMPT framing
— are calibrated for them. Graph and skill containers reach down into
the substrate through the public runtime API; they need the substrate's
defaults to be **overridable**, not absent.

The recommendations in
`docs/runtime-product-agnosticism-audit.md` distribute across layers:

| Recommendation | Layer | Notes |
|---|---|---|
| R1 — parameterize SYSTEM_PROMPT | substrate | the override hook |
| R2 — actor field on lensMeta / rwa_hist | substrate (→ skill) | per-agent attribution; lands at substrate, consumed by skill |
| R3 — decouple lens UI from doc-product | substrate | override hooks for placeholder + click-to-anchor |
| R4 — drop single-mount full-replace | substrate | new render mode; touches the bootstrap contract |
| R5 — concurrency model beyond modifyMutex | substrate (→ graph) | queue lives at substrate, used by graph orchestration |
| R6 — retired | — | the skill layer already specifies the model (`idb:<store>` permission, `skills:*` reserved bus prefix) |
| R7 — capability gate | skill | already specified in actions spec §3 / §4 — implementation, not design |
| R8 — surface vs. actor split | substrate | data-model fix |
| R9 — `rwa new app\|workflow\|workspace` templates | cross-layer | each template wires the layers its product needs |
| R10 — this document | meta | the layer-cake itself |

R7 doesn't belong at the substrate at all; it implements
`re-write-able-actions-spec-v0.7.md`. R6 retires because the actions
spec already specifies the per-skill namespace model. R4 is the only
recommendation that touches the substrate's commit contract — it's a
bootstrap-level change, not a render-level change, and warrants a spec
amendment before code.

## What this is not

- **Not a contract.** The layer-cake is descriptive; the contracts live
  in the specs each layer owns. If this document drifts from those
  specs, the specs win.
- **Not a roadmap.** This document maps current state. Whether the
  graph layer ships before the skill layer (or vice versa) is a
  product question answered elsewhere.
- **Not a substitute for the actions spec.** The skill-layer section
  here is two paragraphs; the spec is ~680 lines. Read the spec.

## Forward references

- **Graph layer.** `rwa-graph/1` spec does not yet exist in the repo.
  When it lands, the route should be `docs/specs/rwa-graph-spec.md`
  (or wherever the spec author files it) and this document should be
  amended with the section number references for batch dispatch and
  the in-flight lens lock.
- **Actions-spec antecedents (v0.6 / v0.6.1).** `re-write-able-actions-spec-v0.7.md`
  is the latest draft in an independent drafting cycle and references
  earlier drafts at v0.6 (§§ 2.1, 2.2, 2.4, 4.1, 5.4, 8.2, plus invariants
  10 and 12) and v0.6.1 (§ 4), as well as the v0.10 main substrate
  spec's lens-lock semantics. None of the v0.6 / v0.6.1 drafts are
  committed to this repo yet. The action-layer drafting cycle is
  independent of substrate versioning (the substrate is on `re-write-able-spec.md`
  v0.10, on its own track); these drafts should land before agents try
  to extend v0.7 in ways that depend on them. The audit addendum
  (`docs/runtime-product-agnosticism-audit.md`, 2026-05-18) calls out
  v0.6 § 2.4 specifically as the structural reference — its defense-in-
  depth proxy mechanisms are load-bearing for the actions spec's
  Shape A attack-shape defense path — and recommends leading with it
  when the antecedents land.

---

*Spec version 0.1 — initial layer-cake taxonomy. Names the substrate /
graph / skill layers, maps the four product types, routes to the
canonical spec for each. Will be amended when `rwa-graph/1` lands.*
