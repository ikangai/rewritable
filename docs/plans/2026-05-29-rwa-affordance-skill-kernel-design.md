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
| **view** | an alternate rendering of the doc/region (present-mode, grid, app UI) | main (needs DOM) | none — pure render of doc state |
| **edit-surface** | a direct *human* edit path on a region (cell edit, drag); no LLM | main (needs DOM) | doc-write (baseline) |
| **tool** | a new agent/lens operation (derive column, query, app command) | Worker-able | declared per-tool via v0.7 grammar |
| **compute** | a reactive derived value, recomputed on change (recalc) | Worker-able | none — pure, no I/O *by construction* |
| **hook** | a callback on a lifecycle event (subsumes the pure-pubsub model) | Worker-able | declared via v0.7 grammar |

**Type → providers mapping:** `document` = base, no providers. `presentation`
= one `view`. `datatable` = `view` + `edit-surface` + `tool` + `compute`.
`application` = `view` + `edit-surface` + `tool`.

### Load-bearing finding: thread-affinity gates trust

`view` and `edit-surface` need the DOM → **main-thread only → cannot be
Worker-isolated.** v0.7's entire isolation story is Worker-mode. Therefore a
*third-party* skill that wants to provide a `view` or `edit-surface` is
inherently un-sandboxable and must be a **higher-trust category** — the
install dialog must say so explicitly ("this skill renders its own UI on the
main page and cannot be isolated"). `tool` / `compute` / `hook` are the
Worker-safe kinds. The taxonomy and v0.7's isolation model couple exactly
here.

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
`compute:derived`). Flush **acquires `modifyMutex`**, so it cannot race the
agent; the before-agent-modify boundary guarantees ordering. Frozen zones are
out of bounds for edit-surface regions (declared regions must lie outside
frozen zones); `data-rwa-id` is preserved/backfilled at flush, same as the
existing commit path.

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

## Invariants the kernel must preserve

- Bootstrap is the anchor: byte-identical except `INLINE_DOC`; runtime never
  in IDB, never visible to the agent. **Provider code is bootstrap-resident
  for first-party; agent still sees only the document.**
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

## Open items (not decided here)

- **Concrete registration API** — exact call signature(s) and provider
  object shapes per kind. (`runtime.provide(kind, spec)`? declarative
  manifest? both?)
- **Render-mode contract (R4)** — how a `view` owns a mount and re-renders,
  replacing/coexisting with the current single-mount full-replace. Touches
  the bootstrap render contract → spec amendment before code.
- **Lifecycle & load order** — when providers activate/teardown; error
  handling (the fail-loud culture: unknown provider kind, capability
  violation, flush failure).
- **compute dependency model** — cycle detection, recompute ordering.
- **Worker message contract for providers** — extending v0.7 §4.4 to carry
  provider invocations (tool/compute/hook) across the Worker boundary.
- **Composition (graph) face** — a type's bus interface (`table/v1`, …)
  remains deferred with `rwa-graph/1`. This kernel is the solo/affordance
  face only.

---

*Status: kernel spine designed (extension model, taxonomy, write-path, trust
split, manifest). Next: either resolve the open items toward a spec, or
prototype the smallest end-to-end slice — e.g. `presentation` as a single
first-party `view` provider — to validate the registration API against the
real runtime before committing the taxonomy.*
