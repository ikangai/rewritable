# rwa-identity/1 — a rewritable that knows what it is

> **Superseded → re-anchored (2026-05-30).** The wave converged this design and
> two sibling proposals into ONE ratified contract: **`self-description/1`**
> (`docs/specs/rwa-self-description-spec.md`, commit `b987ecd`), with the
> reference computer + referee oracle in `tools/self-description.mjs`. That spec
> credits this design for `title`, `blocks`, and the human-panel framing (§9).
> The shape moved from my `affordances:{edit/view/…}` map to the kernel-pure
> **registered provider bundle** (`affordances:[{kind,name,label,provenance}]`)
> plus a separate `baseline` block for the substrate-universals. This doc is kept
> as the **consumer-lane (CLI `rwa doc`) view** of that contract; the canonical
> shape lives in the spec. Implementation: `cli/src/identity.mjs` (publish-safe
> mirror of the oracle) + `rwa doc --json` (the static projection, pinned to the
> oracle by test).

*Design, 2026-05-30, newton. Anchors the blog thesis ("a rewritable file
should know what it is") into a concrete, minimal contract: every container
can answer **"what am I, and what can be done with me?"** to both an agent
and a human, through one shared shape.*

---

## Thesis

From <https://www.ikangai.com/a-rewritable-file-should-know-what-it-is/>: a
file registers its **type as a bundle of affordances** — View, Edit-surface,
Tool, Compute, Hook — and one portable runtime serves both humans (via
edit-surfaces and views) and agents (via tools). *"A type is not a schema. It
is a registered bundle of affordances."*

The substrate already has the raw materials: `PRODUCT_KIND` (baked at
creation), a live **view-provider registry** (`runtime.provide('view', …)`,
spec §5.10, with a first-party `presentation` view), author-declared **frozen
zones** (invariants), and **`data-rwa-id`** block identity. What is missing is
a way to *enumerate* and *answer*. Today the file knows its kind but cannot
tell you what it is or what you can do with it.

## The contract: `rwa-identity/1`

*Shape conceded to the prototype-validated kernel taxonomy
(`2026-05-29-rwa-affordance-skill-kernel-design.md`) — `affordances` is a
**registered bundle** of the five provider kinds, not a category map. Universal
substrate ops (lens-edit, undo, save, print) are **baseline**, not affordances.
bohr's RFC referees the final field names.*

A single JSON shape, the answer to "what am I?":

```jsonc
{
  "format": "rwa-identity/1",
  "source": "static",       // "static" (CLI, from bytes) | "live" (runtime introspection)
  "uuid": "…",              // DOC_UUID — correlate edits/history/shares
  "kind": "presentation",   // PRODUCT_KIND — the registration key
  "title": "Q1 Architecture", // first <h1> of the body, or null
  "affordances": [          // the registered bundle: kernel's 5 provider kinds
    { "kind": "view", "name": "presentation", "label": "Present", "provenance": "first-party" }
  ],
  "invariants": { "frozenZones": ["signature"] } // author-declared locks
}
```

`affordances` is a flat list; each entry's `kind` is one of the five —
`view` / `edit-surface` / `tool` / `compute` / `hook`. A `document` reports
`[]` (no registered providers); a `presentation` reports one `view`. The two
surfaces **agree by construction**: the live path enumerates the actual
provider registry; the static path derives the same first-party bundle from
`kind`. `source` marks which path produced the answer — the CLI's `"static"`
answer is honestly a *subset* (it cannot enumerate runtime-registered or
installed providers without executing JS).

## Two surfaces, one shape

The contract is satisfied two ways, for the two readers:

| Reader | Surface | How it's computed | When |
|---|---|---|---|
| **Agent / tooling** | `rwa doc --json` gains `title` + `affordances` | **static** read of the file bytes (kind + frozen zones + h1 + id count) | offline, no JS execution |
| **Human / in-browser agent** | `runtime.describe()` → a "what is this?" chrome panel | **live** introspection of the actual provider registry + state | file open in a browser |

The static path is honest by construction: a container's bootstrap matches its
kind (both baked together by `rwa new`), so kind-derived affordances are true
of the bytes. The live path is zero-drift: it reads the *actual* registered
views, so a third-party view registered at runtime shows up automatically.

## Scope — staged to respect the shared seed

**Phase 1 — agent half (CLI only, non-contended). This iteration.**
- `cli/src/doc.mjs`: `inspectDoc` also returns `title` + `affordances`.
- `cli/bin/rwa.mjs`: `rwa doc --json` payload carries them (additive — plain
  mode untouched, existing fields unchanged, existing tests stay green).
- `cli/tests/doc.test.mjs`: pin the new contract (intent, not just bytes).
- Docs: CLAUDE.md doc-verb line + `cli/README.md`.
- Two tiny pure helpers — `extractTitle(doc)`, `affordancesForKind(kind)` —
  documented as mirroring the seed's kind gating (one small, stable mirror).

**Phase 2 — human half (seed, contended → coordinate a window). Next.**
- `seeds/rewritable.html`: `runtimeDescribe()` introspecting live state;
  exposed as `runtime.describe()`; a dismissible "ⓘ what is this?" affordance
  in the chrome that renders the bundle as prose.
- Spec `rwa-identity/1` in `re-write-able-spec.md` (§5.11 candidate).

Phase 1 stands alone and ships value without touching the hot seed file.

## Why this is on-thesis and stays simple

- **Self-contained**: no new files in the container, no new dependencies. The
  bundle is *derived*, not a stored manifest that could drift from reality.
- **Simple to use**: a human opens the file and it explains itself; an agent
  runs one command and learns what it can do. No schema to learn.
- **Surgical**: Phase 1 is additive fields on an existing verb; Phase 2 is one
  introspection method + one chrome affordance.

## Success criteria

1. `rwa doc --json` on a `document`/`presentation` returns the correct
   provider-bundle (`[]` / one `view`) + `title` + `source:"static"`; all
   existing `doc` tests stay green (additive only).
2. New tests pin: title extraction (h1 present / absent), `staticAffordances`
   per kind matching the validated map (`document`=[], `presentation`=one
   `view` named `presentation`), provider-entry shape `{kind,name,label,
   provenance}`, and that old fields are intact.
3. The static answer provably AGREES with euler's live `runtime.describe()` on
   the same fixture (shared shape; same `presentation` token).
4. Full CLI suite green; no seed bytes touched in Phase 1.
