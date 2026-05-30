# rwa self-description — spec (RFC)

*Status: **RFC v0.1**, pending wave ratification (bohr, 2026-05-30). This is the
convergence contract for the self-description surface that three lanes are
building against in parallel — runtime producer (`runtime.describe()` +
human "What is this?"), CLI/agent consumer (`rwa doc`), and a declaring
consumer (the datatable demo). It defines **one** shape so producer and
consumer cannot fork. It does **not** restate the affordance kernel — that is
designed in `docs/plans/2026-05-29-rwa-affordance-skill-kernel-design.md`; the
`view` affordance is already live (`re-write-able-spec.md` §5.10, v0.13); the
installed-provider trust model is `docs/specs/re-write-able-actions-spec-v0.7.md`.
This spec is the read-time **projection** of those: what a container reports
itself to be.*

---

## 1. Motivation

The thesis of *"a rewritable file should know what it is"* (ikangai) is that a
container's **type is a registered bundle of affordances**, not a static schema —
and that the file should be able to *answer what it is*, to a human and to an
agent, without the reader needing private knowledge of rewritable's internals.

Today a container's identity is recoverable but scattered: `PRODUCT_KIND` and
`DOC_UUID` are baked consts (read back by `cli/src/doc.mjs`), frozen zones are
discoverable by scanning the body (`findFrozenZones`), and the registered
affordances live only in the runtime's `providers` registry
(`seeds/rewritable.html:3420`, `const providers = { view: null }`). There is no
single, named, versioned object that says *"this is what I am."* This spec
defines that object and the two surfaces that expose it.

The immediate need is coordination: a runtime producer and a CLI consumer are
being built at the same time. Without one contract they will fork the shape.
This is that contract.

## 2. The self-description object

A single JSON object, schema-tagged `self-description/1` (versioned like
`rwa-edit/1`, `rwa-graph/1`). Required fields are the minimal identity-and-type
core; everything else is optional and additive.

```json
{
  "rwa": "self-description/1",
  "uuid": "f2c1…-36-char",
  "kind": "presentation",
  "affordances": ["view"],
  "provenance": "first-party",
  "frozenZones": ["wf-style", "runner"]
}
```

| Field | Req | Type | Source | Meaning |
|---|---|---|---|---|
| `rwa` | ✓ | `"self-description/1"` | constant | Schema discriminator + version. |
| `uuid` | ✓ | string \| null | `DOC_UUID` const | Container identity. `null` only for pre-UUID legacy containers. |
| `kind` | ✓ | string | `PRODUCT_KIND` const | The product kind. Unknown/absent ⇒ `"document"` (matches `SYSTEM_PROMPTS` resolution). |
| `affordances` | ✓ | string[] | kind ⊕ live registry | The provider kinds this container offers (§4). `[]` for a base document. Enum: `view`, `edit-surface`, `tool`, `compute`, `hook`. |
| `provenance` | ✓ | `"first-party"` \| `"installed"` | runtime | Whether affordances ship in the bootstrap (`first-party`) or were installed as third-party skills (`installed`, reserved — §6). |
| `frozenZones` | ✓ | string[] | body scan | Author-declared frozen-zone names (`findFrozenZones`). Computed by the reader; never stamped (§5). |
| `tools` | — | string[] | live registry | Names of **affordance-contributed** agent operations. The three substrate edit tools (`apply_dsl_plan`/`apply_edits`/`replace_document`) are universal and **not** listed — they are the substrate, not the type. |
| `stores` | — | string[] | declared | Document-defined IDB stores (non-`rwa_` names) the container uses. |
| `blocks` | — | number | body scan | Count of `data-rwa-id`-addressable blocks — a coarse "how structured" signal (folds in newton's `rwa-identity/1`). |
| `title` | — | string | body | Human label, if the container has one. |
| `live` | — | object | runtime only | Volatile state present **only** in the runtime projection (§3): `{ dirty, view, fsa, storage }`. Absent from any static/embedded form. |

Readers MUST ignore unknown fields. Producers MUST emit every required field.

**Affordance tokens are provider *kinds*, not provider *names* or verbs.** The
`affordances` array carries the kernel's five provider kinds
(`view`/`edit-surface`/`tool`/`compute`/`hook` — design doc §"Provider
taxonomy"), never a provider's display name (`"presentation"`) nor a capability
verb (`"present"`, `"export"`). Both projections (§3) therefore emit the **same
token** for the same provider: a presentation reports `["view"]` statically
(kind→bundle) *and* live (a `view` provider is registered), agreeing on `view`
by construction. *(This settles the producer's "which token?" question: the
token is the kind `view`, not the provider's name `presentation` — the name, if
surfaced at all, is the optional per-affordance form of §6.)* A richer
per-affordance object (`{kind, name, thread, provenance}`) is the optional
installed-path extension (§6), not v1.

**Substrate-universal capabilities are not affordances.** Every container —
regardless of kind — can be edited through the lens, rendered by the default
path, exported on ⌘S, and stepped back through undo (⌘Z; there is **no redo** —
commits carry no undo state, `re-write-able-spec.md` Invariant 7). These are
properties of the *substrate*, true of a base `document` too, so they are **not**
listed in `affordances` (which is strictly the *type's* added providers — a
`document` is `[]`). A human "what is this?" surface may of course *display*
these universals; they are simply not part of the machine contract's affordance
set, and a type must not be reported as contributing them (Rule 12 — do not
overclaim; e.g. do not advertise a `redo` that does not exist).

## 3. Two surfaces, one shape

The same object is exposed two ways. They agree on every field they share (§7).

**Runtime projection — `runtime.describe()`** (producer: seed). Returns the live
object: required core + `tools`/`stores` from the live registries + a `live`
block (dirty flag, active view name or `null`, FSA/storage status). New member
on the `window.runtime` literal at `seeds/rewritable.html:4081`, beside
`provide`/`setView`/`on`/`status`. It computes `affordances` from the live
`providers` registry unioned with the kind's declared bundle (§4). This is also
what backs a human-facing **"What is this?"** disclosure in the runtime chrome.

**Static projection — `rwa doc`** (consumer: CLI; no JS executed). The CLI
already returns `{rewritable, uuid, kind, frozenZones, length, doc}`. The
self-description is the **minimal superset**: add `affordances` (from the
kind→affordances table, §4) and `provenance` (`"first-party"` — no installed
providers can exist in a statically-read file under v1, §6). It carries **no**
`live` block. Whether the CLI merges these two fields into its flat shape or
nests a `self` object is the consumer's call; the canonical object is defined
here.

**Static completeness (honesty — the consumer's load-bearing requirement).** For
a first-party v1 container the static projection is *complete, not lossy*:
`uuid`/`kind`/`provenance` are baked consts, `affordances` is kind-derived (§4),
and `frozenZones`/`blocks` are body-scanned — so `rwa doc` reports every contract
field a browser would, **except** the volatile `live` block. The one honest
caveat a static reader carries is therefore narrow and explicit: it omits `live`,
and its `provenance` is `"first-party"` by construction (a file on disk holds no
installed providers — §6). A static reader MUST NOT imply it has enumerated
*runtime-registered* providers; under v1 there are none in a file to miss, and
when the installed path lands (§6) the embedded stamp is what restores static
completeness. So the static answer is an *honest whole* for first-party
containers, not a silently-truncated subset.

## 4. Computed, not stamped: the kind→affordances table

`affordances` is **derived**, not authored. For first-party containers it is a
pure function of `kind`:

| `kind` | `affordances` | Status |
|---|---|---|
| `document` | `[]` | normative (base; no providers) |
| `presentation` | `["view"]` | normative (live: §5.10 presentation provider) |
| `workflow` | `[]` | normative (prose + frozen runner; no registered provider) |
| `datatable` | `["view","edit-surface","tool","compute"]` | illustrative / reserved |
| `application` | `["view","edit-surface","tool"]` | illustrative / reserved |

This table **is** the read-time face of the design doc's *type manifest*
(`…kernel-design.md` §"The type manifest"). The runtime cross-checks it against
the live `providers` registry; a mismatch is a bug (§7). Both producer and
consumer MUST share this table from a single source — proposed home:
`tools/self-description.mjs` (`KIND_AFFORDANCES`), mirrored where the CLI needs
it, with a "keep in step" comment in the house style (cf. the `UUID_RE` /
`PRODUCT_KIND_RE` mirrors across `seed.mjs`, `doc.mjs`, `rwa.mjs`).

## 5. Placement: why v1 does not stamp into the file

A naive "stamp the manifest into the file on commit" **violates Invariant 1**
(the bootstrap is byte-identical across opens except the `INLINE_DOC` constant —
`re-write-able-spec.md` Invariant 1). A commit-rewritten stamp would have to
live either:

- **inside `INLINE_DOC`** → the agent sees it as document content and can edit
  it; it pollutes the editable body. Rejected.
- **in a second commit-mutable region** → a real weakening of Invariant 1 and a
  new region the `buildFile`/`escapeTL`/backtick-walk machinery and its four
  aligned mirrors must all learn. Too heavy for the "stay dead-simple" boundary.

The resolution follows from §4: for first-party containers the entire
self-description is **container-constant or body-computable** —

- `uuid`, `kind`, `provenance` are baked consts, fixed for the container's life;
- `affordances` is a pure function of `kind` (constant);
- `frozenZones` is the one field that can change across commits, and it is
  **computed by scanning the body** (the CLI already does this) — so it must
  **not** be stamped, or it goes stale.

Therefore **v1 computes; it does not stamp.** No new baked region, no
Invariant-1 question, no staleness. An optional emit-time embedded form is
defined for forward-compatibility (§6) but is **not** part of v1's required
surface and MUST carry only container-constant fields.

> **Note to the producer lane:** this is the load-bearing ruling of this RFC.
> "Stamp on commit" is the natural first instinct and it is an Invariant-1 trap.
> Compute `runtime.describe()` live; do not write a manifest into the document
> body or add a second mutable region.

## 6. Provenance, trust, and the installed path (deferred)

`provenance` exists to carry the one distinction the kernel design turns on:
first-party affordances ship in the bootstrap (immutable anchor, agent-invisible,
implicit grants); installed affordances arrive as `.rwa-skill.json` skills
through the v0.7 install dialog, permission grammar, and Worker isolation.

Under v1, a statically-read `.html` can only be `first-party`: installed
providers live in IDB (v0.7 §2.2), not in the file, so a file on disk has none.
When the installed path lands, a container's affordances stop being
kind-derivable, and **that** is when an embedded stamp becomes necessary (a
static reader can no longer compute the answer). At that point:

- the embedded form is `<script type="application/rwa-manifest+json"
  id="rwa-manifest">…</script>`, an **inert** (non-executing) script type, placed
  in runtime chrome **outside** `#rwa-doc-mount` so the agent never sees it as
  document content;
- it carries the installed-affordance facts that are not kind-derivable, plus
  `provenance: "installed"`;
- thread-affinity gates trust (design doc §"thread-affinity gates trust"): an
  installed `view`/`edit-surface` is un-sandboxable main-thread code and a
  higher-trust category than a Worker-isolatable `tool`/`compute`/`hook`. The
  self-description SHOULD expose enough for a reader to see that distinction
  (e.g. per-affordance `{kind, thread, provenance}` once installed providers
  exist). Out of scope for v1.

## 7. Conformance

A conforming implementation satisfies:

- **SD-01 (shape).** `runtime.describe()` and the CLI static projection both
  validate against §2: every required field present, `rwa === "self-description/1"`,
  `affordances ⊆` the enum, `provenance ∈ {first-party, installed}`.
- **SD-02 (kind agreement).** `describe().kind === PRODUCT_KIND`;
  `describe().uuid === DOC_UUID`.
- **SD-03 (affordance agreement).** `describe().affordances`, as a set, equals
  `KIND_AFFORDANCES[kind]` for a first-party container — i.e. the live
  `providers` registry matches the declared bundle. For `document`/`workflow`
  this is `[]`; for `presentation` it is `["view"]`.
- **SD-04 (frozen-zone agreement).** `describe().frozenZones` equals
  `findFrozenZones(body).map(z => z.name)` — the runtime and the CLI compute the
  same set from the same body.
- **SD-05 (no live leakage in static form).** The CLI static projection contains
  no `live` block.
- **SD-06 (Invariant 1 held).** Producing `describe()` writes nothing to
  `rwa_doc`, adds no commit-mutable region, and emits no manifest into the
  document body. (Negative test: with a `view` active, the agent-facing source
  still contains no manifest/`live` substrings.)

`tools/self-description.mjs` provides the reference static computer
(`computeSelfDescription(fileText)`) and `validateSelfDescription(obj)` so the
CLI consumer and the runtime producer can both check their output against one
implementation. SD-01..05 are exercisable today; SD-06's negative test belongs
with the §5.10 view tests.

## 8. Worked examples

**document** (base prose container):

```json
{ "rwa": "self-description/1", "uuid": "…", "kind": "document",
  "affordances": [], "provenance": "first-party", "frozenZones": [] }
```

**presentation** (live `view` affordance):

```json
{ "rwa": "self-description/1", "uuid": "…", "kind": "presentation",
  "affordances": ["view"], "provenance": "first-party", "frozenZones": [] }
```

**workflow** (prose + frozen runner; runtime projection with `live`):

```json
{ "rwa": "self-description/1", "uuid": "…", "kind": "workflow",
  "affordances": [], "provenance": "first-party",
  "frozenZones": ["wf-style", "runner"],
  "live": { "dirty": false, "view": null, "fsa": "none", "storage": "default" } }
```

## 9. Lane responsibilities (this wave)

The contract partitions cleanly so the four lanes converge instead of forking:

- **Contract + reference validator (bohr).** This spec + `tools/self-description.mjs`
  (`computeSelfDescription`, `validateSelfDescription`, `KIND_AFFORDANCES`, a
  `--check <file>` CLI). No seed/CLI edits.
- **Producer (euler).** `runtime.describe()` on the runtime literal + the human
  "What is this?" disclosure. Computes live; does **not** stamp (§5).
- **Consumer (newton).** `rwa doc` surfaces the static projection for agents —
  the minimal superset over today's `{rewritable,uuid,kind,frozenZones,length,doc}`.
  newton's `rwa-identity/1` design (`docs/plans/2026-05-30-rwa-identity-design.md`)
  is folded into this contract (it contributed `title`, `blocks`, and the
  human-panel framing) and is re-anchored as the consumer's view of it — one
  contract, not two.
- **Declarer (tesla).** The datatable demo's affordances (`view`+`edit-surface`
  +`compute`) are the first non-trivial `affordances` array — the first real
  consumer of the contract, and the proof that the table in §4 extends.

## 10. Open items

- **Installed-provider self-description** (§6) — embedded stamp shape, per-affordance
  trust/thread fields. Gated on the v0.7 installed path landing.
- **`tools` / `stores` enumeration** — exact runtime sources; `stores` may need a
  declared-not-computed escape hatch (a static reader cannot enumerate IDB).
- **`live` block fields** — settle the exact set against `runtime.status`.
- **CLI integration shape** — merge vs nest in `rwa doc --json` (consumer's call).

---

*Version 0.1 (RFC). Defines the `self-description/1` object, its runtime and
static projections, the computed-not-stamped ruling (Invariant 1), and SD-01..06
conformance. Referee rulings folded in (2026-05-30): affordance tokens are
provider *kinds* not verbs/names; substrate-universals (undo/export — and there
is no redo) are not affordances; the static projection is an honest *whole* for
first-party containers; the commit-stamp stays deferred (Invariant 1).
Supersedes newton's `rwa-identity/1` as the single contract; routes to
`…kernel-design.md` (kernel),
`re-write-able-spec.md` §5.10 (the live `view` affordance), and
`re-write-able-actions-spec-v0.7.md` (installed-provider trust). Awaiting wave
ratification before any field is treated as frozen.*
