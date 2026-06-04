# rwa-runtime-region-commit/1 — the runtime-owned region commit primitive

*Spec, 2026-06-04, dirac. The last gate for the v0.8 skill-layer MVP
(`docs/specs/re-write-able-actions-spec-v0.8.md` §7 — frozen-zone persistence)
and for skinning-v2 L1 restyle (`docs/plans/2026-06-03-skinning-design.md`).
Builds directly on the R5 write-path
(`docs/plans/2026-05-30-r5-write-path-design.md`, LANDED): the serialized
`nonAgentCommitChain` → reentrant `commitCore` → `actor` passthrough. This spec
adds **one** thing on top of R5: a commit that may legitimately rewrite a region
the agent/lens is forbidden to touch, while proving it changed **nothing else**.*

---

## 0. Why this exists (and why R5 is not enough)

R5 made non-agent writes safe: a lens/edit-surface/skin write rides the
serialized commit queue and lands as one history entry. But every R5 commit
funnels through `applyEdits` / `replaceDocument`, both of which **reject** any
change to a frozen zone:

- marker-form (`<!-- rwa:frozen:begin NAME -->`): `frozenZonesIntact()` (seed
  `:3526`, `:3591`) — inner text must be byte-identical, keyed by name.
- attribute-form (`[data-rwa-frozen]`): `snapshotsEqual(dataRwaFrozenSnapshot…)`
  (seed `:3540`, `:3594`) — each element's `tag\0outerHTML` must be unchanged.

That guard is correct: it is the wall that makes "the agent cannot forge a
skill" true (v0.8 §7: *the runtime is the sole writer of the frozen skill
zone*). But the runtime itself **must** write that zone — on install / update /
uninstall — so that an installed skill survives reload and travels in the
exported file. R5 has no seam for "the runtime, and only the runtime, rewrites
exactly this frozen region." This spec is that seam.

Two consumers need it, and they need **opposite** treatment of the same guard:

| Consumer | Region | Why the agent can't write it | reachability |
|---|---|---|---|
| **skill persistence** (v0.8 §7, shannon) | `<div data-rwa-frozen id="rwa-skills">` | forging a skill = privilege escalation | `'frozen'` |
| **skinning-v2 L1 restyle** (kepler) | `<style data-rwa-skin>` + agent markup | nothing — it's an ordinary editable block | `'edit-reachable'` |

The primitive factors the **shared kernel** out of these two and makes
reachability a **parameter**, not a fork.

---

## 1. The primitive

```
runtimeRegionCommit({ regions, actor, reachability }) → Promise<result>
```

- **`regions`** — a non-empty array of `{ select, build }`:
  - `select(doc) → [start, end] | null` — locates the region's byte range in the
    current LF-canonical doc. `null` means "region absent" (insert mode — see §3).
  - `build(current, doc) → string` — produces the region's **new** bytes
    **deterministically** (no model, no clock, no randomness that affects output;
    `current` is the region's existing bytes or `''` when absent). Determinism is
    load-bearing: the same registry state must yield byte-identical output so the
    frozen snapshot and the export round-trip are stable.
- **`actor`** — the `rwa_hist` attribution string for this commit
  (`'runtime:skill-install'`, `'runtime:skill-uninstall'`, `'skin:NAME'`, …).
  Threaded verbatim through `commitCore`'s `lensMeta.actor` (R5 §9 passthrough).
- **`reachability`** — `'frozen'` | `'edit-reachable'`. Selects how the
  frozen-zone guard is treated for the target regions (§4). Default
  `'edit-reachable'` (the safe, non-privileged case).

Returns the same shape `commitCore` returns (the committed doc), or rejects with
a structured `RwaEditError` (§5).

---

## 2. The shared kernel (always, regardless of reachability)

Every `runtimeRegionCommit` call MUST:

1. **Ride the R5 queue.** Enqueue on `nonAgentCommitChain` exactly as
   `synthesizeAndCommit` does (seed `:3162`) → reentrant `commitCore`. Non-agent
   commits serialize; a commit arriving while an **agent** loop holds
   `modifyMutex` still rejects `concurrent_modify` (R5 admission policy,
   unchanged). The runtime is never a second exclusive writer.
2. **One history entry, one ⌘Z.** The whole region rewrite is a single
   `rwa_hist` record carrying `actor`, and a single `rwa_undo` push. Installing a
   skill is one undo step, not N. (Multiple `regions` in one call ⇒ still one
   commit.)
3. **Byte-deterministic region output.** `build()` is pure over registry state
   (§1). Re-running with the same state is a no-op diff.
4. **Region-only change — THE SHARED INVARIANT.** The committed doc differs from
   the pre-commit doc **only** within the byte ranges named by `regions`. Every
   other byte — every other frozen zone, the whole editable surface, every
   `data-rwa-id` — is identical. This is the test that pins the primitive (§6);
   it holds for both reachability modes and is what makes the privileged-write
   safe: a `'frozen'` commit that bypasses the skill-zone guard cannot, as a
   smuggled side effect, alter any other frozen zone or the document body.

The kernel reuses `commitCore`'s existing post-apply validators verbatim —
parse-validity (`parse_error_post_apply`), reserved-id (`reserved_id_used`),
size (`target_size_exceeded`), tag balance. The **only** thing reachability
changes is the frozen-zone guard.

---

## 3. Region splice & insert mode

`build`'s output replaces `[start, end]` in the doc; the commit is expressed as a
`replace_document` envelope (`{version:'rwa-edit/1', doc:newDoc, reason}`) routed
through the existing `replaceDocument` path (the same path kepler's skin reset
already uses, seed `:3223`) — so all non-frozen validators fire identically. A
region-only splice is preferred over a hand-built full-doc string to keep the
"changes only the target" invariant mechanically obvious.

**Insert mode** (`select → null`): the region does not yet exist. The kernel
inserts `build('', doc)` at the region's **canonical insertion point**, which the
caller supplies as part of the region descriptor (`insertAt(doc) → offset`). For
the skill zone the canonical point is "first child of `<body>`" (or immediately
after `<head>`); for skin it is "first child of `#rwa-doc-mount`" — but the
primitive does not hardcode either; the consumer's region descriptor owns it.
Insert mode still satisfies the region-only invariant: every pre-existing byte is
preserved; only the inserted span is new.

---

## 4. `reachability` — the only fork

### 4.1 `reachability: 'frozen'` (privileged — skill zone)

The target region **is** a frozen zone (the runtime writes it, the agent must
not). The kernel:

1. **Scoped bypass — for the target region's identity only.** Before commit,
   compute the attribute-form snapshot but **exclude the target frozen
   element(s)** from both the before and after sets, matched by a stable identity
   (the region's `id`, e.g. `rwa-skills`). The guard then asserts
   `snapshotsEqual` over **every frozen zone except the target** — so all *other*
   frozen zones (and all marker-form zones, unchanged) are still byte-locked. The
   target element is permitted to differ. (Equivalently for a marker-form target:
   drop the named zone from the `frozenZonesIntact` comparison.) The bypass is
   **per-identity**, never blanket: a `'frozen'` commit naming `rwa-skills` cannot
   also mutate some other `data-rwa-frozen` element — that still fails the guard.
2. **Re-assert post-commit — the region is still frozen + edit-unreachable.**
   After the splice, the new target element MUST (a) still carry its frozen
   marker (`data-rwa-frozen` present, or the marker-form `begin/end` pair intact)
   and (b) be **edit-unreachable**: it lies outside the agent-editable surface —
   i.e. it is itself `data-rwa-frozen` (CLI now enforces this is honoured) and not
   reachable by an `apply_edits` anchor. If either fails, reject
   `region_not_refrozen` (§5) and the commit does not land. This closes the
   obvious attack: a `'frozen'` write that emits a region *without* the frozen
   marker would leave an agent-writable skill zone next boot.
3. **Content well-formedness is the consumer's contract, re-checked by the
   reader.** The primitive does not validate that `build` emitted valid skill
   records — that is `buildSkillZone`'s job, re-verified at boot by
   `parseSkillZone` / `readTrustworthySkills` (v0.8 §8). The primitive guarantees
   *placement + framing*; the consumer guarantees *payload*.

### 4.2 `reachability: 'edit-reachable'` (non-privileged — skin, default)

The target region is an ordinary editable block. **No bypass, no re-assert** —
the standard frozen guard runs unchanged (the region isn't frozen, so it passes
trivially). The value the primitive still adds here is the kernel's region-only
determinism + one-entry/one-undo + actor, and — the point of skinning-v2 —
**composition**: the deterministic region build may be batched with the agent's
L1 markup edits into one commit, so a "restyle + reword" lands atomically as one
undo step. (skinning-v1's `/skin` already rides R5 directly without this
primitive; v2's *compose-with-agent-edits* is what reaches for it.)

This mode is, deliberately, almost nothing beyond R5 — which is correct: an
edit-reachable region needs no special permission. Keeping it in the same
primitive means both consumers point at one contract and the `'frozen'` path is
visibly *the bypass plus a re-lock*, not a separate machine.

---

## 5. Error vocabulary

All `RwaEditError`, surfaced through the same channel as R5 commits:

| code | when |
|---|---|
| `concurrent_modify` | an agent loop holds `modifyMutex` (R5, unchanged) |
| `region_not_found` | `select` returned `null` **and** no `insertAt` given (can't place) |
| `region_overlap` | two `regions` in one call resolve to overlapping ranges |
| `region_escaped` | post-commit, a byte outside the named region(s) changed (the §2.4 invariant failed — a `build` bug; never silently accepted) |
| `region_not_refrozen` | `'frozen'` only: the new target lost its frozen marker or is edit-reachable (§4.1.2) |
| `frozen_zone_corrupted` | a **non-target** frozen zone changed (scoped bypass leaked — should be impossible; defense in depth) |
| `parse_error_post_apply`, `reserved_id_used`, `target_size_exceeded` | inherited from `commitCore` unchanged |

`region_escaped` and `frozen_zone_corrupted` are *assertions*, not expected
outcomes — they fire only on a primitive/consumer bug and MUST fail loud (Rule
12: no silent partial write). The commit is atomic; on any rejection nothing
lands.

---

## 6. The pinning test (the shared invariant, executable)

One characterization test gates the primitive, mirrored for both modes:

> Given a doc with two `data-rwa-frozen` elements `#rwa-skills` and `#other`,
> a marker-form zone `cfg`, and editable prose carrying `data-rwa-id`s:
> `runtimeRegionCommit({ regions:[{select:#rwa-skills, build:…}], actor:'runtime:skill-install', reachability:'frozen' })`
> **(a)** rewrites `#rwa-skills` to the new bytes, **(b)** leaves `#other`, `cfg`,
> the prose, and every `data-rwa-id` **byte-identical**, **(c)** lands as exactly
> one `rwa_hist` record with `actor:'runtime:skill-install'` and one `rwa_undo`
> push, **(d)** ⌘Z restores the prior zone, **(e)** a second identical call is a
> no-op diff (determinism), **(f)** a `build` that drops `data-rwa-frozen`
> rejects `region_not_refrozen` and does not land, **(g)** a `build` that also
> mutates `#other` rejects `region_escaped`/`frozen_zone_corrupted` and does not
> land.

The `'edit-reachable'` variant asserts (a)–(e) on a non-frozen `<style
data-rwa-skin>` region and that a concurrent agent edit to disjoint prose
composes into / serializes with the commit (R5 queue).

`region_escaped` (b/g) is the load-bearing assertion: it is what lets a reviewer
trust that "the runtime writes the skill zone" can never mean "the runtime
quietly rewrote the document."

---

## 7. Seam (where it slots in the seed)

`seeds/rewritable.html`, in the commit machinery (dirac/R5 region), **textually
disjoint** from the skill runtime block (shannon) and the skin block (kepler):

- New `runtimeRegionCommit(opts)` beside `synthesizeAndCommit` (`:3148`). It
  builds the `replace_document` envelope from `regions` (§3), then enqueues on
  `nonAgentCommitChain` → `commitCore`, exactly like `synthesizeAndCommit`.
- `commitCore` / `replaceDocument` gain a **single optional parameter**
  `frozenBypass` (a set of region identities to exclude from the frozen
  snapshot comparison) threaded from `reachability:'frozen'`. When absent
  (the default and every existing caller), behaviour is byte-identical to today —
  this is an **additive** change to the R5 path, no existing test moves.
- The post-commit re-assert (§4.1.2) lives in `runtimeRegionCommit`, not in
  `commitCore` (it is region-semantics, not generic commit).

Consumers (NOT this spec's code — they call the primitive):

- **shannon, v0.8 §7:** `buildSkillZone(installedSkills) → string` (the
  `<div data-rwa-frozen id="rwa-skills">…</div>` with one base64
  `<script type="application/rwa-skill+json">` per record). `runtimeInstallSkill`
  / uninstall / update call `runtimeRegionCommit({ regions:[{select:#rwa-skills,
  build:buildSkillZone, insertAt:…}], actor:'runtime:skill-install',
  reachability:'frozen' })` so the install lands in `currentDoc`/IDB immediately
  (durable across reload) and ⌘S's existing `buildFile(await getDoc())` (`:5137`)
  bakes it with **no change to `commit()`** — the registry-aware step happens at
  install time, not save time. (This is cleaner than v0.8 §7's literal
  "make ⌘S regenerate the zone": writing on install makes the registry durable in
  IDB, survives a reload-before-save, and keeps `commit()` a dumb file-builder.
  v0.8 §7 should be updated to reference this primitive; the observable contract —
  the zone in the exported file — is identical.)
- **kepler, skinning-v2:** the L1 compose path calls
  `runtimeRegionCommit({ regions:[{select:style[data-rwa-skin], build:…}], actor:'skin:NAME', reachability:'edit-reachable' })`,
  optionally batched with the agent's markup edits.

---

## 8. Invariants preserved

- **Invariant 1 (bootstrap byte-identical except `INLINE_DOC`).** The primitive
  only ever changes document bytes inside `INLINE_DOC`; the skill zone lives in
  the document, not the bootstrap. No baked region, no commit-stamp. The CSP
  `<meta>` (v0.8 §7) is a boot-time `<head>` injection, out of this primitive's
  scope.
- **Atomic commit, no undo state in the commit.** Inherited from `commitCore` /
  `commitDoc` unchanged.
- **`rwa_hist.actor` is first-class.** `'runtime:skill-install'` etc. attribute
  the write exactly as `'user:lens'` / `'skin:NAME'` do today.
- **The frozen wall still holds for the agent.** The scoped bypass is reachable
  **only** through `runtimeRegionCommit` with an explicit region identity; the
  agent's `apply_edits` / `replace_document` path has no `frozenBypass` and so
  cannot reach it. The re-assert (§4.1.2) guarantees the zone is handed back to
  the agent-facing guard still frozen.

---

## 9. Scope discipline (Rule 2)

`reachability:'edit-reachable'` is, today, R5 + determinism + composition — the
only **new** machinery this spec adds is the **`'frozen'`** scoped-bypass +
re-assert, because that is the only thing R5 cannot already do. The
`'edit-reachable'` branch is specified (so both consumers share one named
primitive and skinning-v2 has its hook) but is near-trivial in implementation.
Ship the `'frozen'` path now (shannon's increment 7 needs it); the
`'edit-reachable'` compose path lands when skinning-v2 is built, against the same
signature.

---

*Status: **SPEC** (design, not yet implemented). The shared kernel + the
`'frozen'` scoped-bypass/re-assert is the buildable unit; shannon's v0.8 §7
increment 7 is its first consumer (`buildSkillZone`, `reachability:'frozen'`),
kepler's skinning-v2 L1 is the second (`reachability:'edit-reachable'`). Pinned
by the §6 characterization test — chiefly `region_escaped` (the runtime cannot
smuggle a document change behind a skill-zone write). Referenced by
`re-write-able-actions-spec-v0.8.md` §7 and `2026-06-03-skinning-design.md`.*
