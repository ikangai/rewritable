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

It **declares** these in a machine-readable `#rwa-affordances` block shaped to the
ratified [`self-description/1`](../../docs/specs/rwa-self-description-spec.md)
contract — so an agent (or a future runtime introspector) can learn what the file
is *without executing any JavaScript*.

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

1. **Serialize direct edits.** The runtime frees its modify mutex *after*
   re-render, so a fast second edit can hit `concurrent_modify`. The lens never
   does (its UI serializes input); a datatable with rapid typing will. The fix is
   a per-document commit queue (`window.__dtBusy` here) + a bounded retry.
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
cd tests && node datatable.mjs        # jsdom + fake-indexeddb, 25 assertions
```

Drives a real cell edit through `applyEnvelope` and asserts persistence into
`rwa_doc`, a surface-labelled `rwa_hist` record, compute-column consistency, undo,
input veto, add-row, the agent Tool path (`rwa edit` → `rwa doc`), and the
self-description manifest shape. Also smoke-tested in a real browser (Chrome +
real IndexedDB).
