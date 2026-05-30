# datatable — the flagship affordance example

`datatable.html` is a self-contained [rewritable](../../README.md) that embodies
the ikangai thesis **["a rewritable file should know what it is"](https://www.ikangai.com/a-rewritable-file-should-know-what-it-is/)**:
a file's *type* is a **registered bundle of affordances**, not a static schema.

It's the blog's own worked example — a small quarterly budget — carrying four
affordances on one self-rewriting page, served to both humans and agents:

| Affordance | What it is here | Mechanism |
|---|---|---|
| **View** | grid (default) + a "Summary by category" bar chart | document JS renders `#dt-data`; toggle in the toolbar |
| **Edit-surface** | click a cell → edit inline → commit, **no model** | `runtime.applyEnvelope` (the substrate's model-free edit path) |
| **Compute** | the **Total** column + grand total | pure derivation at render — never stored, so it can't drift |
| **Tool** | an agent edits rows via the `rwa-edit/1` contract | `rwa edit` / the lens, operating on `#dt-data` |

It **declares** these in a machine-readable `#rwa-affordances` block — a
[`self-description/1`](../../docs/specs/rwa-self-description-spec.md) `declared`
projection (v1.1), readable with no JavaScript and validated by the contract's
oracle. The block carries `data-rwa-frozen`, so the runtime/lens edit path can't
silently drift the file's self-knowledge (the CLI enforces attribute-form frozen
zones too).

It also **registers** its edit-surface + compute affordances live via
`runtime.provide(…)`, so `runtime.describe()` reports them from the *verified
registry* — not the kind-template guess. The two views stay declared-only (they're
in-doc renders, not `setView` providers), so the declaration is the honest superset:
**live registry ⊆ declaration, no drift.** That closes the truthfulness gap this
example was built to surface — the registry is the live source, the declaration the
static bridge for readers (`rwa doc` / `rwa ls`) that can't run JS. Direct edits
also self-attribute in history as `actor: "user:cell"` (R5 actor passthrough).

## Try it

- **As a human:** open `datatable.html` in any modern browser. Click a cell, type,
  press Enter — the value commits through the same audited pipeline the AI lens
  uses (it lands in history; `⌘Z` undoes it; `⌘S` writes the file back). Toggle
  **Grid / Summary**. Add or delete rows. No server, no build, no API key.
- **As an agent:** `rwa doc examples/datatable/datatable.html` reads the editable
  body; `rwa edit examples/datatable/datatable.html` (envelope or instruction)
  rewrites rows in `#dt-data`. The grid re-renders from whatever the data says.

## Why it matters (what this example proves)

The substrate already exposes a **model-free edit path** — `runtime.applyEnvelope`
— that routes a synthesized `rwa-edit/1` envelope through the full commit pipeline
(frozen-zone + shape checks, undo, history, events), labelled by a `surface` so the
audit log distinguishes a direct human edit (`datatable:cell-edit`) from an
agent/lens edit. Until now **no shipped artifact exercised it** (the kanban board
even skips it). This is the proof it works, and the reference consumer the
self-description contract is validated against.

Two robustness lessons it surfaced (now handled here, worth folding into the
substrate guidance for any interactive rewritable):

1. **Serialize direct edits — still needed after R5.** Originally this dodged
   `concurrent_modify` (the runtime freed its modify mutex *after* re-render).
   R5 (`ccef441`) moved commit-serialization into the runtime, but `window.__dtBusy`
   is **not** redundant for this consumer: each edit is a *whole-block* `find`/
   `replace` on `#dt-data`, and the `find` anchor is read from
   `getCurrentDocCache()` at commit time. R5's queue serializes *commits* but does
   not re-read a queued caller's anchor — so two un-chained whole-block edits would
   make the second's `find` stale (`find_not_found`). `__dtBusy` chains
   *read-then-commit*, recomputing the anchor after each commit. (R5's own
   characterization test passes without consumer chaining only because its edits
   are *disjoint* anchors, not whole-block rewrites.)
2. **No raw `</script` in document scripts.** `escapeForTL` protects the
   *bootstrap's* template literal, but template-literal evaluation restores the
   sequence in the runtime doc text — which then closes an inner `<script>` when
   the document is re-rendered via `innerHTML`. Build the needle split
   (`'<' + '/script'`) so the source never contains it.

## Rebuild

`datatable.html` is generated from `_source.html` + the canonical seed:

```sh
node examples/datatable/build.mjs            # uses seeds/rewritable.html
node examples/datatable/build.mjs <seed>     # or pin a specific seed
```

`_source.html` is the **genesis** content only — once the container is in use it
rewrites its own `INLINE_DOC`, so the two diverge by design.

## Test

```sh
cd tests && node datatable.mjs        # jsdom + fake-indexeddb, 41 assertions
```

Drives a real cell edit through `applyEnvelope` and asserts persistence into
`rwa_doc`, a surface-labelled `rwa_hist` record with `actor:"user:cell"`,
compute-column consistency, undo, input veto, add-row, a rapid-edit burst, the
agent Tool path (`rwa edit` → `rwa doc`), the frozen-declaration tamper rejection,
the declaration's oracle validity, and **live ⇄ declared parity** (the registered
`describe()` affordances are a subset of the declaration — no drift). Also
smoke-tested in a real browser (Chrome + real IndexedDB).
