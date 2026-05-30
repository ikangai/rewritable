# rwa self-description — spec (RFC)

*Status: **RFC v0.2**, ratified-in-progress by the wave (bohr referee, 2026-05-30).
This is the convergence contract for the self-description surface that three
lanes build against in parallel — a runtime **producer** (`runtime.describe()` +
human "What is this?" chrome, euler), a CLI/agent **consumer** (`rwa doc`,
newton), and a **declarer** (the datatable demo, tesla). It defines **one** shape
so producer and consumer cannot fork. v0.2 folds in the wave's review: provider
**objects** (not bare strings, newton), an explicit **`source`** flag (newton +
euler), a separate **`baseline`** block for substrate universals (resolving
euler's "what-can-be-done" need without polluting `affordances`), and `title` /
`blocks` (newton's `rwa-identity/1`). It does **not** restate the affordance
kernel — designed in `docs/plans/2026-05-29-rwa-affordance-skill-kernel-design.md`;
the `view` affordance is already live (`re-write-able-spec.md` §5.10, v0.13);
installed-provider trust is `docs/specs/re-write-able-actions-spec-v0.7.md`. This
spec is the read-time **projection** of those: what a container reports itself
to be.*

---

## 1. Motivation

The thesis of *"a rewritable file should know what it is"* (ikangai) is that a
container's **type is a registered bundle of affordances**, not a static schema —
and that the file should *answer what it is*, to a human and to an agent,
without the reader needing private knowledge of rewritable's internals.

Today that knowledge is scattered: `PRODUCT_KIND` and `DOC_UUID` are baked consts
(read back by `cli/src/doc.mjs`), frozen zones are discoverable by scanning the
body (`findFrozenZones`), and registered affordances live only in the runtime's
`providers` registry (`seeds/rewritable.html:3420`). There is no single, named,
versioned object that says *"this is what I am."* This spec defines that object
and the two surfaces — live (`runtime.describe()`) and static (`rwa doc`) — that
emit it. The immediate need is coordination: a producer and a consumer are being
built at once; without one contract they fork. This is that contract.

## 2. The self-description object

A single JSON object, schema-tagged `self-description/1`. The same shape is
emitted two ways, distinguished by `source`; the two agree on every shared field
(§7).

```json
{
  "rwa": "self-description/1",
  "source": "live",
  "uuid": "f2c1…-36-char",
  "kind": "presentation",
  "title": "Q2 Revenue Review",
  "blocks": 14,
  "affordances": [
    { "kind": "view", "name": "presentation", "label": "Present", "provenance": "first-party" }
  ],
  "frozenZones": [],
  "baseline": {
    "edit": ["lens"],
    "tools": ["apply_dsl_plan", "apply_edits", "replace_document"],
    "export": ["html", "print"],
    "history": ["undo"]
  },
  "activeView": "presentation"
}
```

| Field | Req | Type | Source | Meaning |
|---|---|---|---|---|
| `rwa` | ✓ | `"self-description/1"` | constant | Schema discriminator + version. |
| `source` | ✓ | `"static"` \| `"live"` \| `"declared"` | emitter | Which surface produced this (§3, §3.1). The honest-subset flag: `static` omits live-only state and never claims a runtime-registered provider; `declared` is the author's embedded claim (§3.1). |
| `uuid` | ✓ | string \| null | `DOC_UUID` | Container identity. `null` only for pre-UUID legacy containers. |
| `kind` | ✓ | string | `PRODUCT_KIND` | The product kind. Unknown/absent ⇒ `"document"` (matches `SYSTEM_PROMPTS` resolution). |
| `affordances` | ✓ | Provider[] | kind ⊕ live registry | The **type's** registered providers (§4). `[]` for a base document. Each: `{ kind, name, label?, provenance }` — see below. |
| `frozenZones` | ✓ | string[] | body scan | Author-declared frozen-zone names (`findFrozenZones`). Computed by the reader; never stamped (§5). |
| `baseline` | — | object | substrate constant | Substrate-universal ops, the same for every container (§2.2). The home for "what can be done with me" without polluting `affordances`. |
| `title` | — | string \| null | first `<h1>` / runtime | Human label. `null` if none. |
| `blocks` | — | number | body scan | Count of `data-rwa-id`-addressable blocks — a coarse "how structured" signal (from newton's `rwa-identity/1`). |
| `activeView` | — | string \| null | runtime | **live-only.** The active view provider's name, or `null`. A `static` projection MUST omit it. |

A **Provider** entry is `{ kind, name, label?, provenance }`:

- `kind` ∈ `view` · `edit-surface` · `tool` · `compute` · `hook` — the kernel's
  five provider kinds (design doc §"Provider taxonomy"). **This is the affordance
  token**, not the provider's display name.
- `name` — the provider's stable identifier (e.g. `"presentation"`).
- `label` — optional human label (e.g. `"Present"`).
- `provenance` ∈ `first-party` (ships in the bootstrap) · `installed`
  (third-party skill, v0.7 install path — reserved, §6).

Readers MUST ignore unknown fields. Producers MUST emit every required field.

### 2.1 Affordance tokens are provider *kinds*, not verbs or names

The affordance **token** is the provider `kind` (`view`), never its display
`name` (`presentation`) nor a capability verb (`present`, `export`). Both
projections therefore emit the same token for the same provider: a presentation
reports a `view` provider statically (kind→bundle) *and* live (a `view` provider
is registered), agreeing on `view` by construction. The provider's `name`/`label`
ride along in the object for the human surface; they are not the contract's
identity of the affordance.

### 2.2 Substrate-universal capabilities are not affordances

Every container — regardless of kind — can be edited through the lens, rendered
by the default path, exported on ⌘S, and stepped back through undo (⌘Z; there is
**no redo** — commits carry no undo state, `re-write-able-spec.md` Invariant 7).
These are properties of the *substrate*, true of a base `document` too, so they
are **not** in `affordances` (which is strictly the *type's* added providers — a
`document` is `[]`, which is what keeps the kernel mapping honest). They live in
the optional `baseline` block instead. A "what is this?" surface presents
`baseline` ⊕ `affordances`; an agent learning the file reads both. A producer
MUST NOT report a substrate op as a type affordance, and MUST NOT advertise an
op that does not exist (Rule 12 — e.g. no `redo`).

## 3. Two surfaces, one shape

**Live — `runtime.describe()`** (producer: seed). Returns the object with
`source: "live"`, `affordances` computed from the live `providers` registry,
`activeView`, and live-reflecting `title`/`blocks`. A new member on the
`window.runtime` literal at `seeds/rewritable.html:4081`, beside
`provide`/`setView`/`on`/`status`. Also backs the human **"What is this?"**
disclosure in the runtime chrome.

**Static — `rwa doc`** (consumer: CLI; no JS executed). Returns the object with
`source: "static"`, `affordances` derived from the kind→providers table (§4),
`frozenZones`/`blocks` body-scanned, and **no** `activeView`. The CLI already
returns `{rewritable,uuid,kind,frozenZones,length,doc}`; the self-description is
the minimal superset (+`source`/`affordances`/`baseline`/`title`/`blocks`).
Whether the CLI merges these fields or nests a `self` object is the consumer's
call; the canonical object is defined here.

**Static completeness (honesty — the consumer's load-bearing requirement).** For
a first-party v1 container the static projection is *complete, not lossy*:
`uuid`/`kind` are baked consts, `affordances` is kind-derived (§4),
`frozenZones`/`blocks` are body-scanned, and `baseline` is constant — so `rwa doc`
reports every contract field a browser would, **except** the live-only
`activeView`. The honest caveat a static reader carries is therefore narrow and
explicit, and it is *flagged* (`source: "static"`), not silent: it omits
`activeView`, and every affordance it lists is `first-party` (a file on disk
holds no installed providers — §6). A static reader MUST NOT imply it enumerated
*runtime-registered* providers; under v1 there are none in a file to miss, and
when the installed path lands (§6) the embedded stamp restores static
completeness. So the static answer is an *honest whole* for first-party
containers, flagged by `source`, not a silently-truncated subset.

### 3.1 The `declared` projection + precedence (v1.1)

The kind→providers table (§4) can only *guess* for a custom-affordance file (a
`datatable` the runtime has no first-party provider for). For those, a file may
carry its own answer: an inert `<script type="application/rwa-affordances+json"
id="rwa-affordances">` block holding a `source: "declared"` self-description. It
is read with no JS — the author's claim of what the file is. It may carry the
optional per-affordance detail that makes the claim concrete: an `edit-surface`
adds `{surface, target}`, a `compute` adds `{inputs, output}`, and the top-level
`data` points at the file's data element. `uuid`/`frozenZones` are **optional** in
a declaration (the reader fills them from `DOC_UUID` / the bytes — they are
container facts, not author claims).

**Precedence** (a reader assembling one answer): `declared` (if trustworthy, below)
> `live` (the registry — *verified*, what's actually wired) > `static` (kind-derived
— a *guess*). A live producer that unions registry with a declaration SHOULD mark
each affordance `verified: true` (registry-confirmed) vs absent (author-declared),
so a reader can tell a wired affordance from a claimed one (Rule 12 — don't trade
the kind-guess lie for a declaration-drift lie).

**Edit-unreachability (the trust rule).** A declaration is only trustworthy if it
is **unreachable by the edit path** — otherwise the lens/agent could have drifted
it, and a drifted declaration is worse than none. A declaration is edit-unreachable
iff it lives **outside `INLINE_DOC`** (immutable chrome) **or** carries
**`data-rwa-frozen`** (attribute-form frozen — the lens enforces it today; the CLI
once attribute-form enforcement lands). `frozenZones` is **not** consulted: it is
marker-form only on both surfaces (so it never covers an attribute-form
declaration, and static==live agreement on it holds — SD-04). The oracle reports
the *facts* (`declarationFacts(fileText)` → `{found, inEditableBody, frozenAttr}`);
each reader applies the policy per its own enforcement capability. An edit-reachable
declaration (in the editable body, not frozen) is **advisory** — a reader may
surface it but must not present it as verified.

## 4. Computed, not stamped: the kind→providers table

`affordances` is **derived**, not authored. For first-party containers it is a
pure function of `kind`:

| `kind` | providers (`kind`/`name`/`label`) | Status |
|---|---|---|
| `document` | — (none) | normative (base) |
| `presentation` | `view`/`presentation`/`Present` | normative (live §5.10 provider) |
| `workflow` | — (none; prose + frozen runner) | normative |
| `datatable` | `view`/`grid`, `edit-surface`/`cell`, `tool`/`derive`, `compute`/`recalc` | illustrative / reserved |
| `application` | `view`/`app`, `edit-surface`/`form`, `tool`/`command` | illustrative / reserved |

This table **is** the read-time face of the design doc's *type manifest*. The
runtime cross-checks the live registry against it; a mismatch is a bug (§7,
SD-03). Both producer and consumer MUST share it from one source — home:
`tools/self-description.mjs` (`KIND_PROVIDERS`), mirrored where the seed/CLI need
it, with a "keep in step" comment in the house style (cf. the `UUID_RE` /
`PRODUCT_KIND_RE` mirrors across `seed.mjs` / `doc.mjs` / `rwa.mjs`). The
`presentation` entry mirrors the seed `presentationProvider`
(`name:'presentation'`, `label:'Present'`, `seeds/rewritable.html:3542-3543`) so
static and live emit identical provider objects.

## 5. Placement: why v1 does not stamp into the file

A naive "stamp the manifest into the file on commit" **violates Invariant 1**
(the bootstrap is byte-identical across opens except the `INLINE_DOC` constant —
`re-write-able-spec.md` Invariant 1). A commit-rewritten stamp would have to live
either **inside `INLINE_DOC`** (the agent then sees and can edit it; it pollutes
the body — rejected) or **in a second commit-mutable region** (a real weakening
of Invariant 1 plus a new region the `buildFile`/`escapeTL`/backtick-walk
machinery and its four aligned mirrors must learn — too heavy for the
"stay-dead-simple" boundary).

The resolution follows from §4: for first-party containers the entire
self-description is **container-constant or body-computable** — `uuid`/`kind` are
baked consts, `affordances` is a pure function of `kind`, and
`frozenZones`/`blocks`/`title` are body-scanned (so they cannot go stale, but
also must not be stamped). Therefore **v1 computes; it does not stamp.** No new
baked region, no Invariant-1 question, no staleness.

> **Ruling (independently reached by the producer lane, euler #44):** "stamp on
> commit" is the natural first instinct and it is an Invariant-1 trap. Compute
> `runtime.describe()` live; do not write a manifest into the document body or
> add a second mutable region. The embedded stamp returns only with the installed
> path (§6), and even then is emit-time, not commit-time.

## 6. Provenance, trust, and the installed path (deferred)

`provenance` carries the one distinction the kernel design turns on: first-party
affordances ship in the bootstrap (immutable anchor, agent-invisible, implicit
grants); installed affordances arrive as `.rwa-skill.json` skills through the
v0.7 install dialog, permission grammar, and Worker isolation.

Under v1, a statically-read `.html` can only be `first-party`: installed providers
live in IDB (v0.7 §2.2), not in the file. When the installed path lands, a
container's affordances stop being kind-derivable, and **that** is when an
embedded stamp becomes necessary (a static reader can no longer compute the
answer). At that point the embedded form is `<script
type="application/rwa-manifest+json" id="rwa-manifest">…</script>`, an **inert**
script type placed in runtime chrome **outside** `#rwa-doc-mount`; it carries the
non-kind-derivable installed facts plus `provenance: "installed"`. Thread-affinity
gates trust (design doc §"thread-affinity gates trust"): an installed
`view`/`edit-surface` is un-sandboxable main-thread code, a higher-trust category
than a Worker-isolatable `tool`/`compute`/`hook`. Per-affordance `{kind, name,
thread, provenance}` is the carrier for that distinction. Out of scope for v1.

## 7. Conformance

- **SD-01 (shape).** Both projections validate against §2: required fields
  present; `rwa === "self-description/1"`; `source ∈ {static, live}`; each
  affordance is `{kind ∈ enum, name:non-empty, label?, provenance ∈ enum}`.
- **SD-02 (identity agreement).** `describe().kind === PRODUCT_KIND`;
  `describe().uuid === DOC_UUID`.
- **SD-03 (affordance agreement).** The set of **first-party** affordance kinds
  equals `KIND_PROVIDERS[kind].map(kind)` — i.e. the live registry matches the
  declared bundle. `document`/`workflow` → `[]`; `presentation` → `["view"]`.
  (Installed affordances are extra and do not break agreement.)
- **SD-04 (frozen-zone agreement).** `describe().frozenZones` equals
  `findFrozenZones(body).map(name)` — runtime and CLI compute the same set.
- **SD-05 (no live leakage in static form).** A `source: "static"` object carries
  no `activeView` (and no other live-only field).
- **SD-06 (Invariant 1 held).** Producing `describe()` writes nothing to
  `rwa_doc`, adds no commit-mutable region, emits no manifest into the body.
  Negative test: with a `view` active, the agent-facing source contains no
  manifest/`activeView` substring.
- **SD-07 (no overclaim).** `baseline.history` does not list `redo`; no substrate
  op appears in `affordances`; a `document` reports `affordances: []`.

`tools/self-description.mjs` is the reference: `computeSelfDescription(fileText)`
(static), `validateSelfDescription(obj)` (static or live), and
`checkAffordanceAgreement(obj)`. `--check <file.html>` computes+validates a file;
`--validate <obj.json>` validates a producer's emitted object — so
`runtime.describe()` output and `rwa doc` output are checkable against **one**
implementation. SD-01/03/05/07 are exercisable today; SD-06's negative test
belongs with the §5.10 view tests.

## 8. Worked examples

**document** (static; base prose container):

```json
{ "rwa": "self-description/1", "source": "static", "uuid": "…", "kind": "document",
  "title": "Untitled", "blocks": 0, "affordances": [], "frozenZones": [],
  "baseline": { "edit": ["lens"], "tools": ["apply_dsl_plan","apply_edits","replace_document"],
                "export": ["html","print"], "history": ["undo"] } }
```

**presentation** (live; one `view` affordance, currently active):

```json
{ "rwa": "self-description/1", "source": "live", "uuid": "…", "kind": "presentation",
  "title": "Q2 Review", "blocks": 14,
  "affordances": [ { "kind": "view", "name": "presentation", "label": "Present", "provenance": "first-party" } ],
  "frozenZones": [], "baseline": { "history": ["undo"], "export": ["html","print"] },
  "activeView": "presentation" }
```

**workflow** (static; prose + frozen runner):

```json
{ "rwa": "self-description/1", "source": "static", "uuid": "…", "kind": "workflow",
  "title": "Untitled workflow", "blocks": 6, "affordances": [],
  "frozenZones": ["wf-style", "runner"],
  "baseline": { "edit": ["lens"], "history": ["undo"] } }
```

## 9. Lane responsibilities (this wave)

- **Contract + reference validator (bohr).** This spec + `tools/self-description.mjs`
  (`computeSelfDescription`, `validateSelfDescription`, `checkAffordanceAgreement`,
  `KIND_PROVIDERS`, `SUBSTRATE_BASELINE`, `--check`/`--validate`). No seed/CLI edits.
- **Producer (euler).** `runtime.describe()` on the runtime literal + the human
  "What is this?" chrome. Computes live; does **not** stamp (§5).
- **Consumer (newton).** `rwa doc` surfaces the static projection for agents — the
  minimal superset over today's shape. newton's `rwa-identity/1` design
  (`docs/plans/2026-05-30-rwa-identity-design.md`) is folded in (it contributed
  `title`, `blocks`, the `source` honesty flag, the provider-object form, and the
  human-panel framing) and re-anchored as the consumer's view of this contract —
  one contract, not two.
- **Declarer (tesla).** The datatable demo declares
  `affordances:[view, edit-surface, compute]` — the first multi-affordance
  consumer, and the proof the §4 table extends.

When `describe()` and `rwa doc` disagree, both run through
`node tools/self-description.mjs` — that is the tiebreaker oracle.

## 10. Open items

- **Installed-provider self-description** (§6) — embedded stamp shape, per-affordance
  trust/thread fields. Gated on the v0.7 installed path.
- **`title` source** — static reads the first `<h1>`; live may prefer a runtime
  title. Settle precedence so static and live agree.
- **`baseline` minimalism** — it is substrate-constant; a minimal producer may
  emit a subset or omit it. Decide whether any sub-field is required.
- **CLI integration shape** — merge vs nest in `rwa doc --json` (consumer's call).
- **Schema tag name** — `self-description/1` (held by the referee; `rwa-identity/1`
  was the alternative). Rename is a one-line change if the wave prefers it.

---

*Version 1.1. Adds the `declared` projection (§3.1): the embedded
`#rwa-affordances` block, the declared>live>static precedence, the
edit-unreachability trust rule (keyed on `data-rwa-frozen` / outside-`INLINE_DOC`,
not `frozenZones`), optional per-affordance detail (`surface`/`target` for
edit-surface, `inputs`/`output` for compute), the `data` pointer, `baseline.view`,
and the per-affordance `verified` flag for the registry∪declaration union. The
schema tag stays `self-description/1`; producer/consumer (static/live) are
unchanged and backward-compatible. v0.2 base below.*

*Version 0.2 (RFC). Provider-object `affordances`, explicit `source` flag,
separate `baseline` for substrate universals, `title`/`blocks`; the
computed-not-stamped ruling (Invariant 1); SD-01..07 conformance. Folds in and
supersedes newton's `rwa-identity/1` as the single contract. Routes to
`…kernel-design.md` (kernel), `re-write-able-spec.md` §5.10 (the live `view`
affordance), and `re-write-able-actions-spec-v0.7.md` (installed-provider trust).
v0.1→v0.2: bare-string affordances became provider objects; `source` and
`baseline` added on wave review (newton #43, euler #44). Awaiting final
ratification before any field is treated as frozen.*
