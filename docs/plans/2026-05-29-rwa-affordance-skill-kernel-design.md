# rwa affordance/skill kernel — design

*2026-05-29. A design, not yet a spec. Follows directly from
`2026-05-29-rwa-type-system-positioning.md`, which concluded that affordances
are skills and the type system and skill layer are one design problem over a
shared kernel. This doc designs that kernel: the one mechanism that both
built-in type affordances and third-party skills run on, differing only by
trust. Governance of installed skills already lives in
`docs/specs/re-write-able-actions-spec-v0.7.md` (install dialog, permission
grammar, provenance, Worker isolation); this kernel is the **execution /
registration engine** that spec is silent on.*

*Decided in session: extension model = provider registration; provider
taxonomy = view / edit-surface / tool / compute / hook; `compute` is its own
pure kind; write-path = staged live-region buffer. Proposed / derived:
thread-affinity ↔ trust coupling, capability binding per kind, provenance
split, type manifest. Open items listed at the end.*

*Validation pass (same day): the smallest slice — `presentation` as a single
first-party `view` provider — was prototyped against the real runtime. The
registration-API shape **survived**; several "for free" claims did **not**
(one blocker). Corrections from that pass are folded in below and marked
**[validated]** / **[corrected]**. Full record:
`docs/plans/2026-05-29-rwa-kernel-prototype-findings.md`; runnable POC:
`docs/plans/prototypes/2026-05-29-presentation-view-provider-poc.html`.*

---

## What the kernel is

`runtime.on` today is **observe-only pub/sub** over three lifecycle events —
`commit`, `modify`, `status` (`seeds/rewritable.html:728-754`). Listeners are
notified after the fact; they cannot intercept, contribute, or register new
surfaces. The kernel is what that grows into: **from observe-only over three
events → contribute/intercept, capability-gated, provenance-aware, able to
register new surfaces.**

A **behavior** registers one or more **providers**. A **type** is a bundle of
built-in providers + a starter + agent-framing. A **third-party skill** is the
same — providers on the same API — distinguished only by provenance.

This operationalizes three gaps already flagged in
`docs/runtime-product-agnosticism-audit.md`: **R4** (new render mode) = the
`view` kind; **R5** (concurrency beyond `modifyMutex`) = the write-path;
**R8** (surface-vs-actor split) = how non-agent edits are attributed.

## Extension model: provider registration

A behavior registers typed providers; the runtime invokes them at the right
moments. This subsumes lifecycle hooks (a `hook` is one provider kind), binds
capabilities per provider kind, and maps 1:1 to "a type is a bundle of named
contributions." First-party vs installed is a provenance check on the *same*
registration API.

## Provider taxonomy (5 kinds)

| Kind | Contributes | Thread | Capability |
|---|---|---|---|
| **view** | an alternate rendering of the doc/region (present-mode, grid, app UI) | main (needs DOM) | none\* — pure render of doc state |
| **edit-surface** | a direct *human* edit path on a region (cell edit, drag); no LLM | main (needs DOM) | doc-write (baseline) |
| **tool** | a new agent/lens operation (derive column, query, app command) | Worker-able | declared per-tool via v0.7 grammar |
| **compute** | a reactive derived value, recomputed on change (recalc) | Worker-able | none — pure, no I/O *by construction* |
| **hook** | a callback on a lifecycle event (subsumes the pure-pubsub model) | Worker-able | declared via v0.7 grammar |

**Type → providers mapping:** `document` = base, no providers. `presentation`
= one `view`. `datatable` = `view` + `edit-surface` + `tool` + `compute`.
`application` = `view` + `edit-surface` + `tool`.

\* **[corrected]** For a main-thread first-party `view`, "capability: none" is
an *unenforced convention*, not a runtime guarantee — the provider shares the
bootstrap closure and can reach `runtime.modify`/`db`/`fs`. Enforcement would
require passing only `docText` + a frozen read-only `ctx` (not closing over
runtime writers), or a re-entrancy guard that fails loud if `render` calls
`modify`. Do not present the binding as runtime-enforced.

### Load-bearing finding: thread-affinity gates trust

`view` and `edit-surface` need the DOM → **main-thread only → cannot be
Worker-isolated.** v0.7's entire isolation story is Worker-mode. Therefore a
*third-party* skill that wants to provide a `view` or `edit-surface` is
inherently un-sandboxable and must be a **higher-trust category.** `tool` /
`compute` / `hook` are the Worker-safe kinds. The taxonomy and v0.7's
isolation model couple exactly here.

**[corrected] The mechanism is unconditional code execution, not just "DOM
UI."** `view`/`edit-surface` output flows through `m.innerHTML` followed by a
`<script>` re-execution loop (`seeds/rewritable.html:850-855`) with **no CSP**
— so it is *arbitrary main-thread code execution* (it can reach `runtime.db`,
`runtime.fs`, the API key in `sessionStorage`). For first-party this is fine.
For the installed path, the dialog disclosure must read **"this skill can run
arbitrary code on the page,"** not the softer "renders its own UI." And since
`presentation` has no need to emit scripts, the first-party `view` contract
should **strip/assert-absent `<script>` in `render` output** (fail-loud, per
CLAUDE.md Rule 12), so the contract a future third-party path inherits is "no
scripts" rather than "all scripts run."

### `compute` is pure by construction

`compute` is a runtime-orchestrated **pure derivation**: declared inputs (a
region/cells) → declared outputs (derived cells/columns), deterministic, **no
I/O**. Purity is what makes it need zero capability and keeps "recalc as
affordance" from sliding into a formula engine. The runtime recomputes when
inputs change, writes outputs into the live overlay (below), and flushes them
with everything else. Cycle detection / dependency ordering is an open item.

## Write-path: staged live-region buffer

Today `modify()` is the only writer (`modifyMutex` → read → agent → atomic
commit of `(rwa_doc, rwa_undo, rwa_hist)` → re-render → release).
`edit-surface` and `compute` are **non-agent writers**, and a grid keystroke
cannot pay a full IDB commit. So:

`currentDoc` (LF-canonical text in IDB) **stays the source of truth.** Direct
and compute edits mutate a **tracked live overlay** on the rendered region.
The overlay flushes to `currentDoc` and commits at **boundaries:**

- on **blur** of the edit-surface region,
- on **idle-debounce** (N ms after the last change),
- **before any agent `modify()`** — the agent must never see a stale doc
  while uncommitted overlay edits exist,
- on **⌘S** (commit/export),
- best-effort on **tab hide / unload** (iOS eviction safety).

**Flush reconciliation:** the overlay serializes back into the LF-canonical
text of `currentDoc`, then goes through the **normal atomic commit**
(`rwa_doc`/`rwa_undo`/`rwa_hist`) with `actor` attribution (`user:cell`,
`compute:derived`). Frozen zones are out of bounds for edit-surface regions
(declared regions must lie outside frozen zones); `data-rwa-id` is
preserved/backfilled at flush, same as the existing commit path.

**[corrected — flush ordering is a design hole, not a guarantee.]** The
earlier claim that flush "acquires `modifyMutex`, so it cannot race the agent;
the before-agent-modify boundary guarantees ordering" is **not enforceable at
the current `modify()` structure.** `modify()` takes the mutex at
`seeds/rewritable.html:3313` but only *after* dispatching the bridge backend
at `:3297` (`return modifyViaBridge`), and reads `getDoc()` at `:3320` — there
is no atomic flush-then-acquire seam between "called" and "mutex held," and the
bridge path bypasses any top-of-`modify` flush hook entirely. Enforcing the
boundary requires refactoring `modify()`/`modifyViaBridge()` to take the mutex
at one shared entry (before `:3297`) and run `flushPendingOverlays()` inside
the held mutex via a **reentrant** commit path (so flush's `commitDoc` does
not re-check the mutex boolean). Until that refactor, the write path is **not**
untouchable while ordering holds — the two claims are mutually exclusive.
Tracked as the central `edit-surface`/`compute` open item (R5).

This preserves "`currentDoc` is source of truth," the atomic-commit
invariant, and reuses the dirty-state machinery — while giving the direct
surface the latency it needs. "No model in the loop" means no *LLM*, not no
*text-model*.

## Provenance / trust split

Same registration API; the kernel branches on where the provider came from:

- **First-party (built-in type affordances).** Provider code ships **inside
  the bootstrap / the type's frozen bundle** — part of the immutable anchor,
  never in IDB, never agent-visible. Implicit capability grants. No install
  dialog. Selected by `PRODUCT_KIND`.
- **Installed (third-party skills).** Arrive as a `.rwa-skill.json` envelope
  (v0.7 §2.1), pass through the install dialog (§1), permission grammar (§3),
  and Worker isolation (§4). The kernel checks provenance to decide
  grant-model and isolation.

The only difference between an affordance and a skill is this provenance
check. That is what makes "composed on one substrate, not N harnesses"
buildable: **the kernel is the composition mechanism.**

## The type manifest

A type becomes:

```
type = {
  kind,                 // PRODUCT_KIND value
  providers: [ ... ],   // built-in providers (view/edit-surface/tool/compute/hook)
  starter,              // INLINE_DOC body
  framing,              // SYSTEM_PROMPTS entry
  lens, palette         // existing surface overrides
}
```

This **supersedes the thin `--kind` machinery** (today: ~6 substituted
regions + a prompt entry — a starter template, not an affordance system). The
6 substitutions become a subset (starter + framing + lens + palette); the new
`providers[]` bundle is the affordance system. `KIND_TABLE` /
`kindOverrides()` in `cli/src/seed.mjs` grow a `providers` dimension.

**[validated — sequencing]** Do **not** wire `providers[]` into `KIND_TABLE` /
`kindOverrides()` until the registration API is validated against the runtime.
The prototype registered the provider **directly in the bootstrap**, precisely
to avoid coupling two unproven things (the API and the emit-time manifest).
Manifest integration is a *next step after*, not concurrent.

## Invariants the kernel must preserve

- Bootstrap is the anchor: byte-identical except `INLINE_DOC`; runtime never
  in IDB, never visible to the agent. **Provider code is bootstrap-resident
  for first-party; agent still sees only the document.** **[corrected]**
  Agent-invisibility of provider *code* is structural (it's in `FROZEN`, never
  in `INLINE_DOC`), but agent-invisibility of provider *output* is **not
  automatic**: it holds only if the agent-facing source
  (`setSourceMap`/`currentDocCache`, `seeds/rewritable.html:866`/`:1903`) is
  derived from `docText`, never from the mounted (transformed) value. A naive
  `html = view.render(html)` would feed `<section class="rwa-slide">` wrappers
  into the agent's context — a breach of `re-write-able-spec.md:86`. Treat this
  as a construction requirement, asserted by test (no `rwa-slide` substring in
  `currentDocCache` with an active view).
- `currentDoc` is the source of truth; commits are atomic; commits carry no
  undo state.
- Frozen zones are author invariants; `data-rwa-id` preserved across commits.
- Reserved namespaces (`rwa_*`, `rwa_hist.kind`, etc.) stay runtime-only;
  provider-defined stores go through `runtime.db` (non-`rwa_` names).

## Relationship to actions spec v0.7

v0.7 governs *installed* providers (the gate). This kernel is the *engine*
(registration + execution) that v0.7 assumes but never specifies. They compose:
a third-party `tool`/`hook` declares capabilities in v0.7 grammar and runs
under v0.7 Worker isolation; a third-party `view`/`edit-surface` triggers the
v0.7 install dialog's new "cannot be isolated" disclosure. When this kernel is
specced, v0.7 (or a v0.8) gains a cross-reference to it.

## Resolved by the prototype (carry into the spec)

- **[validated] Registration API shape.** A **declarative** provider spec with
  one *pure* `render(doc) → html` slot (plus an optional *impure*
  `mounted(m, ctx)` post-mount slot for transient UI state), registered via
  `runtime.provide(kind, spec)` (returns an `unregister` closure); `setView`
  toggles. Single nullable slot for first-party; a persisted `Map` is deferred
  to the installed path. Declarative beats a callback bag because the render
  path is already a "give me HTML, I mount it" pipeline
  (`seeds/rewritable.html:829-873`). `runtime.provide`/`setView` are new
  *members on the plain object literal* at `:3694` (the object is **not**
  frozen — only `status` is non-configurable).
- **[validated] `view` render-mode contract (R4).** Concrete clauses the
  prototype established: (a) `render(doc) → html` is a one-way, **synchronous**,
  display-only transform whose output **MUST NOT** be read back into
  `currentDoc` (preservation of `data-rwa-id`/frozen zones holds because render
  output is mount-only and `commitDoc` operates on the doc *text*, `:2890` —
  not because "wrappers ride attributes along"); (b) the agent-facing source
  must derive from `docText`, never the mounted value; (c) `render` MUST emit
  **all** id-keyed elements every render (may hide via CSS; must not omit, or
  form-state round-trip at `:856-861` silently drops values), MUST NOT reorder,
  MUST NOT wrap in an `ANCHORABLE_TAGS` element (`SECTION` is safe; 1:1
  wrap-in-place keeps ordinal walks aligned), MUST NOT strip `data-rwa-id`, and
  MUST NOT emit reserved ids/markers (`#rwa-lens`, etc. — validate at
  `provide`/`setView`, throw); (d) `setView` MUST guard on `modifyMutex` (like
  `undo`, `:2504`) and `releaseAnchor()` on activation; the anchored-modify
  render path (`:2548 → :2566`) must be gated on `activeView === null`
  ("suspend the click listener" alone is insufficient — **the BLOCKER**); (e)
  add a `@media print { #rwa-lens { display:none !important } }` rule — the
  lens reparents to `<body>` (`:2270`) and is otherwise not print-hidden.

## Open items (not decided here)

- **[updated] Lifecycle & load order / fail-loud cases.** Unknown provider
  kind throws; a second `provide('view', …)` in one session replaces (single
  slot); reserved-id/marker in `render` output throws at `provide`/`setView`
  time; `setView` during `modifyMutex` is rejected with status, not queued.
- **Write-path flush ordering (R5)** — the central unresolved item: the
  before-agent-modify boundary is unenforceable at the current `modify()` seam
  (see Write-path above). Needs the shared-entry-mutex + reentrant-commit
  refactor before any `edit-surface`/`compute` provider is safe. Not exercised
  by the read-only `view` slice.
- **Edit-surface transient-DOM hook** — `renderDoc` is full-replace; a view or
  edit-surface owning *uncommitted* DOM (half-typed cells, compute decorations)
  needs a capture/restore hook in `renderDoc` that does not exist yet. This,
  not the `:849` branch, is the real `edit-surface` risk.
- **compute dependency model** — cycle detection, recompute ordering.
- **Worker message contract for providers** — extending v0.7 §4.4 to carry
  provider invocations (tool/compute/hook) across the Worker boundary.
- **Composition (graph) face** — a type's bus interface (`table/v1`, …)
  remains deferred with `rwa-graph/1`. This kernel is the solo/affordance
  face only.

---

*Status: kernel spine designed, then validated against the real runtime by
prototyping the `presentation` `view` slice. The registration-API shape and
`view` render-mode contract are now [validated]; the write-path flush ordering
is downgraded to a flagged design hole; one BLOCKER (anchor/ordinal desync) and
several "for free" claims were caught and corrected. Next: the write-path
refactor (shared-entry mutex + reentrant commit) is the gate before any
`edit-surface`/`compute` provider — that, or hardening the validated `view`
contract into a spec amendment, is the real next move. Findings:
`docs/plans/2026-05-29-rwa-kernel-prototype-findings.md`.*
