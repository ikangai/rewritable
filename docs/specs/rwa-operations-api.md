# rwa operations API — the surface-agnostic contract

*v0.1, draft, 2026-06-07. Names the five operations every rewritable
surface speaks — `bootstrap / import / modify / describe / publish` —
fixes the wire-format versions they share, and routes to the spec that
owns each. Short by design: this file is a routing index, not a
re-statement of spec content. Owning specs are normative; this overview
is descriptive.*

---

## Why this exists

A rewritable is reachable from many surfaces — the CLI (`rwa`), the file
itself (the in-page lens), a Claude skill, imports, a webpage clone, the
hosted service, and (planned) messaging/voice. Each looked like a separate
product, so each conversation about "can we add surface X?" restarted from
zero.

It isn't separate products. **Every surface is the same small set of
operations seen through a different door.** Name the operations once and
the roadmap collapses from "build N products" to "write thin adapters onto
one contract." This document names that contract. The north-star framing
that motivates it is `docs/plans/2026-06-04-north-star-universal-surfaces.md`;
this is its standing, code-grounded counterpart.

**The rule for every adapter:** route to the contract below — reuse the
seed bootstrap, the `rwa-edit/1` envelope, the `self-description/1`
projection — **never reimplement** create/edit/describe. An adapter is a
door, not a second implementation.

## The five operations

| Operation | What it does | Wire contract | Owning spec |
|---|---|---|---|
| `bootstrap(kind, body?)` | emit a fresh self-contained container | seed substitution (no version string) | `re-write-able-spec.md` |
| `import(source) → body` | convert md·html·csv·txt·docx·pdf·**webpage** into a body, then bootstrap | per-format (no version string) | `re-write-able-spec.md` |
| `modify(file, instruction\|envelope)` | surgical edit | **`rwa-edit/1`** (+ `rwa-edit-dsl/1`) | `rwa-edit-spec.md`, `rwa-edit-dsl-spec.md` |
| `describe(file)` | report what it is / what can be done | **`self-description/1`** | `docs/specs/rwa-self-description-spec.md` |
| `publish(file) → url` / `export(file)` | get it out (hosted share or file bytes) | per-target (no version string) | `re-write-able-spec.md` §5.9 |

The three load-bearing wire strings — `rwa-edit/1`, `rwa-edit-dsl/1`,
`self-description/1` — are baked verbatim in `seeds/rewritable.html` and
mirrored in the CLI. They are the contract; everything else is an adapter.

## Operations × surfaces (where each door lives)

Each cell is an *entry point onto the same operation*, not a separate
feature. Reuse, don't fork.

| Operation | CLI (`cli/`) | In-file seed (`seeds/rewritable.html`) | Service (`service/`) | Skill (`~/.claude/skills/authoring-rewritables`) |
|---|---|---|---|---|
| bootstrap | `rwa new` (`src/seed.mjs applySeedSubs`) | n/a (already bootstrapped) | `GET /new` (`new.html`) | `new` |
| import | `rwa import`, `rwa clone` (`src/import.mjs`, `src/clone.mjs`) | n/a | `GET /import` (`import.html`, browser-side convert) | — (heavy deps not vendored) |
| modify | `rwa edit` (`src/edit.mjs applyPlan`) | lens ⌘K → `modify()` | n/a (seed lens runs client-side) | `edit` (`--plan`/stdin envelope) |
| describe | `rwa doc [--json]` (`src/doc.mjs`, `src/identity.mjs`) | `runtime.describe()` | n/a | `doc` |
| publish/export | `rwa publish` (ephemeral), `rwa publish-site` (durable scp) | ⌘S file export | `POST /publish` (per-origin share) | — |

The contract is already **proven across independent surfaces** (CLI, the
in-file lens, the skill) all driving the same seed + `rwa-edit/1` +
`self-description/1`. The skill-vendoring further proved the core is
dependency-free and portable. Reference oracles: `tools/self-description.mjs`
(the `self-description/1` referee), `benchmark/oracles/dsl-compiler.mjs`
(the DSL compiler). The CLI ships publish-time mirrors of both
(`cli/src/identity.mjs`, `cli/src/dsl-compiler.mjs`), pinned by test.

## The load-bearing tension (and its resolution)

`modify(file)` and `export(file)` assume the caller **holds the bytes**.
The CLI, the lens, and the skill all do. **Conversational surfaces
(messaging, a phone call) do not** — you cannot ⌘S a chat. This collides
with the core invariant: *the self-contained file is the durable truth.*

**Resolution.** The file stays canonical. Remote/conversational surfaces
operate on a **hosted projection**, and every change is a logged
`rwa-edit` commit, so the canonical file can always be regenerated and
pulled back down. This preserves offline-file purity *and* enables
edit-at-a-distance.

**Consequence for sequencing.** Remote **create-and-publish** needs no new
infrastructure (it is `bootstrap`/`import` + `publish`, which already
exist). Remote **edit** needs a *writable hosted runtime* plus
*identity/auth* — that foundation gates every remote-edit surface. Create
surfaces are cheap; edit surfaces wait on the hosted-edit foundation.

## Cross-surface consistency (what an adapter must preserve)

- **CLI failure surface** is uniform across operations: exit `0` success ·
  `1` usage · `2` file · `3` envelope · `4` agent/publish/transport. Errors
  go to stderr as `code/subcode`; the operation's result goes to stdout.
  Network-bearing operations (`import`'s `clone`, `publish`, `publish-site`)
  are the explicit exceptions to the CLI's offline-first default.
- **Reserved namespaces** (the `rwa_*` IDB stores/keys, `rwa-edit/1` history
  kinds, frozen-zone markers, `data-rwa-id`) are runtime-only — an adapter
  must never emit them as content. See `re-write-able-spec.md` invariants.
- **`describe` is the negotiation surface.** Before an adapter offers an
  action, it should ask `describe(file)` what the container reports it can
  do (kind + affordances + baseline) rather than assume — the
  `declared > live > static` precedence is defined in the self-description
  spec.

## Relationship to the taxonomy

`docs/specs/rwa-product-types.md` answers *"which architectural layer does a
product need?"* (substrate → graph → skill). This document answers the
orthogonal question *"which operations does every surface speak, and where
does each operation's contract live?"* The taxonomy slices by layer; the
operations API slices by verb. A surface adapter consults this file; a
product designer consults the taxonomy.

---

*Spec version 0.1 — initial naming of the five-operation surface-agnostic
contract (`bootstrap / import / modify / describe / publish`), the three
shared wire strings (`rwa-edit/1`, `rwa-edit-dsl/1`, `self-description/1`),
the operations×surfaces map, and the hosted-projection resolution of the
remote-edit tension. Descriptive index over the normative specs; will be
amended when a new surface or a writable hosted runtime lands.*
