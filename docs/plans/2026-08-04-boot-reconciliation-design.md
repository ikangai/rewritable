# Boot reconciliation — the file vs. IndexedDB

**Status:** DESIGN (2026-08-04, agent-16). Nothing built. Closes the design half of
[#1](https://github.com/ikangai/rewritable/issues/1); implementation follows in the same issue.
**Trigger:** blindspot audit finding — a container silently discards external edits to its own file.
**Plan context:** `docs/plans/2026-08-04-blindspot-remediation-plan.md` §4 Phase 1.

## 1. The bug

`seeds/rewritable.html:1189`:

```js
async function getDoc() {
  let d = await idbGet(RWA.DOC);
  if (d == null) { d = INLINE_DOC; await idbPut(RWA.DOC, d); }
  return d;
}
```

`INLINE_DOC` — the document baked into the file's own bytes — is consulted **only** when the IDB
record is literally `null`. Any prior IDB record wins, however stale, with no comparison of any kind.

`DOC_UUID` is baked into the file (`:434`) and names the database (`RWA.DB = 'rwa_'+DOC_UUID`,
`:465`), so editing the file externally does not change its storage identity: the browser reopens
the same database and serves the old content. `git pull`, `git checkout`, an external editor, a
restored backup, or a re-downloaded copy of a file you had opened before all lose their content
silently.

Reproduced in practice: `.dev-diary/2026-05-20-kanban-bootstrap-and-idb-skew.md:9-13`. Named as an
aspiration but never built: `re-write-able-spec.md:557-559`.

## 2. Why the obvious fix is wrong

The tempting one-liner is to compare the two at boot — if `rwa_doc !== INLINE_DOC`, something
diverged, so ask the user.

That is wrong, and the reason is the load-bearing detail of this design. The boot IIFE blesses the
document with stable block ids **and writes the result back to IDB** (`:10350-10356`):

```js
if (!window.__rwaSuppressBlockIds) {
  const idRes = injectMissingBlockIds(doc);
  if (idRes.assigned > 0) { doc = idRes.text; await idbPut(RWA.DOC, doc); }
}
```

Verified: this path does **not** bump the dirty counter. So a container that has been opened once
and never edited legitimately holds `rwa_doc !== INLINE_DOC`. A byte comparison would classify every
such container as diverged and prompt on every fresh open — training users to dismiss the one prompt
that exists to prevent data loss.

> **Prediction outcome** (plan §4, Phase 1). I predicted the "IDB clean" definition would be the
> load-bearing part and most likely to be wrong, and that a stored hash would be needed rather than a
> live comparison. Half right, recorded honestly: a stored hash *is* required, but only for the
> **file** side. For the **dirty** side the answer turned out simpler than predicted — `dirty_count`
> already exists in `rwa_state`, already survives reload, already resets on commit, and already
> excludes runtime self-heals like blessing. The predicted hazard was real; the predicted remedy was
> more elaborate than what the code already offered.

## 3. The design

### 3.1 A baseline record

One new key in the existing `rwa_state` store:

```
rwa_state['doc_baseline'] = { baseHash: <sha-256 hex>, at: <ISO timestamp> }
```

`baseHash` is **sha-256 of `canonLF(body)`** — deliberately the same definition as the hosted
runtime's `baseBodyHash` (`service/lib/hosted.js:185-216`), which hashes
`canonLF(extractInlineDoc(bytes))`. Same granularity (the editable body, not the whole file), same
canonicalization, same algorithm, same name. We are not inventing a second divergence vocabulary;
issue #3's scoping note argued for extending the referee pattern rather than diluting it, and the
same reasoning applies here.

`rwa_state` is the right home: it is in the reserved `rwa_*` set (`:638-648`), and `buildFile` only
ever splices `INLINE_DOC`, so nothing in it can travel in the exported file. It already holds
`user_stores`, `dirty_count`, and `share_conn`.

### 3.2 Written at exactly two moments

The baseline means "the body bytes the file had, the last time this runtime was in sync with it."
There are precisely two such moments:

1. **Hydration** — `getDoc()` found no IDB record and seeded it from `INLINE_DOC`. Record
   `H(canonLF(INLINE_DOC))`.
2. **Successful save** — `buildFile` wrote `escapeTL(canonLF(rwa_doc))` into the file's `INLINE_DOC`
   slot (`:1508-1528`), so the file's body now *is* `canonLF(rwa_doc)`. Record `H(canonLF(rwa_doc))`.

The save hook already exists and was anticipated by the authors. `seeds/rewritable.html:2170-2172`:

```js
// rwaResetOnCommit is a named commit-hook seam: keep separate from
// rwaResetDirtyCount so future commit-only logic (e.g., last_commit_ts) lands here.
async function rwaResetOnCommit()   { await rwaResetDirtyCount(); }
```

Both commit success branches (`:10245` FSA, `:10259` download) call it. That is where the baseline
write belongs.

### 3.3 The decision at boot

```
fileChanged = H(canonLF(INLINE_DOC)) !== baseline.baseHash
idbDirty    = dirty_count > 0
```

| baseline | fileChanged | idbDirty | Action |
|---|---|---|---|
| absent | — | — | **Today's behaviour** — IDB wins. Record a baseline for next time. |
| present | no | — | **IDB wins** (unchanged, the overwhelmingly common path). |
| present | yes | no | **Adopt the file.** The file moved, nothing local is unsaved. |
| present | yes | yes | **Ask.** Genuine divergence — never pick silently. |

The absent-baseline row is the migration path and it matters: every container already in the wild
has no baseline. Falling back to current behaviour means the fix is inert on its first open and
active from the second — correct, because on that first open we genuinely cannot know which side is
stale, and guessing could destroy work.

### 3.4 Where it hooks

A new `reconcileBootDoc()` called from the boot IIFE immediately after `let doc = await getDoc();`
(`:10340`) and **before** the block-id blessing (`:10350`). At that point the database is open,
nothing has rendered, no skills or agents are loaded, and `window.runtime` does not yet exist
(`:10385`).

**`getDoc()` itself is not modified.** It has 17 call sites, all runtime paths — modify, skin, share,
commit — that must not re-reconcile. Reconciliation is a boot event, not a read event.

### 3.5 The guard goes on ⌘S, not on boot

The key realisation: **choosing destroys nothing.** The file is on disk, IDB holds its copy. The
choice only decides which one you continue from. So there is no need to block boot behind a modal.

What must be guarded is the one genuinely destructive act — overwriting the file. So on divergence:

- render normally, from the IDB copy (never lose unsaved work by default)
- show a **persistent** bar, not a toast: *"This file changed outside the browser. You have unsaved
  edits here."* with **Keep my edits** / **Use the file version** / **Show what differs**
- **block commit until resolved.** ⌘S sets a clear status explaining why, instead of writing.

This is the minimum that actually prevents the loss, and it degrades gracefully: a user who ignores
the bar simply cannot overwrite the newer file by accident.

When **Use the file version** is chosen, the superseded IDB document is pushed onto `rwa_undo`
first, so ⌘Z recovers it. Existing machinery, no new concept.

### 3.6 Degrade safe, never crash boot

`crypto.subtle` is unavailable in some contexts, and jsdom lacks it entirely without a shim
(verified). If hashing is unavailable, or anything in reconciliation throws, the runtime **falls
back to today's behaviour** (IDB wins) and records nothing. A boot crash would be strictly worse
than the bug being fixed. Reconciliation is wrapped in its own `try`, separate from the boot IIFE's
catch-all.

Precedent for client-side sha-256: `shareSnapshot()` at `:9259-9263` already does
`crypto.subtle.digest('SHA-256', new TextEncoder().encode(d))`, and it ships.

## 4. Invariant 6 must be restated

Current (`re-write-able-spec.md`, Invariants §6):

> The inline snapshot is the source of truth on first open. After hydration, IndexedDB is the source
> of truth until the next commit.

That sentence is what the bug implements faithfully. It has to narrow — deliberately, per Rule 7,
not by drift:

> The inline snapshot is the source of truth on first open. After hydration, IndexedDB is the source
> of truth for as long as the file's inline snapshot is unchanged. If the snapshot changes underneath
> a container — an external edit, a version-control checkout, a restored backup — the runtime detects
> the divergence at the next open and never silently discards either copy: it adopts the file when
> there is no unsaved local work, and otherwise defers to the user before the next commit.

`§11.3`'s "needs a reconciliation pass when IDB diverges from the snapshot" moves from aspiration to
built, and should cite this document.

## 5. Test plan — `tests/boot-reconcile.mjs`

Follows `tests/hosted-bless-parity.mjs` (pre-boot state injection, post-boot IDB assertions) and
`tests/agents.mjs:42-47` (`beforeParse` injecting Node `webcrypto` + `TextEncoder`, since jsdom
supplies neither).

| # | Scenario | Expected |
|---|---|---|
| A1 | Fresh container, no IDB | hydrates; baseline recorded; `H(INLINE_DOC)` matches |
| A2 | Second open, nothing changed | IDB wins; no bar; baseline unchanged |
| A3 | Never-edited container, blessing rewrote `rwa_doc` | **no** divergence reported (the §2 hazard) |
| B1 | File body changed, `dirty_count === 0` | adopts `INLINE_DOC`; `rwa_doc` updated |
| B2 | File body changed, `dirty_count > 0` | keeps IDB; bar shown; commit blocked |
| B3 | B2 then "Use the file version" | adopts file; prior doc recoverable via `rwa_undo`; commit unblocked |
| B4 | B2 then "Keep my edits" | baseline advances to the new file hash; commit unblocked |
| C1 | No baseline (pre-upgrade container) + changed file | today's behaviour; baseline recorded |
| C2 | `crypto.subtle` absent | boots; today's behaviour; no throw |
| D1 | Save writes the baseline | after commit, baseline === `H(canonLF(rwa_doc))` |
| D2 | `window.__rwaSuppressBlockIds` (hosted shim) | reconciliation inert; hosted parity preserved |

D2 matters: the hosted runtime deliberately suppresses blessing so the client's bytes stay hash-equal
to the server's `baseBodyHash` (`:10345-10350`). Reconciliation must not reintroduce the divergence
that flag exists to prevent — `tests/hosted-bless-parity.mjs` must stay green.

## 6. Non-goals

- **No merge, no diff algorithm.** "Show what differs" can be a later refinement; v1 states *that*
  the file changed, not *how*. The hosted runtime rejects stale writes with a 409 rather than
  merging, and this stays consistent with that.
- **No multi-tab lock.** Two tabs racing is [#6](https://github.com/ikangai/rewritable/issues/6), a
  separate gap with a separate spec section that describes a lock which was never built.
- **No change to `getDoc()`'s 17 runtime call sites.**
- **No CLI mirror.** `cli/src/apply-edits.mjs` mirrors the seed's validator; this is boot behaviour,
  which the CLI does not have. Nothing to mirror.

## 7. Resolved: "Use the file version" clears `dirty_count`

**Decided by the operator, 2026-08-04.** Adopting the file means the local edits are no longer in
`rwa_doc`, so leaving the counter set would have it assert unsaved work that the live document does
not contain. The counter tracks the live document; the undo stack is where displaced work lives.

Consequences to implement:

- `rwaResetDirtyCount()` on adopt, which also clears the commit nudge via the existing
  `rwaSetDirtyCount` path (`:2159-2163`).
- The superseded document still goes onto `rwa_undo` first, so ⌘Z recovers it. Clearing the counter
  must not read as "the work is gone."
- Test **B3** asserts both: `dirty_count === 0` after adopt, **and** the prior document recoverable
  from `rwa_undo`.
- **Keep my edits** (B4) does *not* clear the counter — the edits are still live and still unsaved.
  It advances the baseline only.

---

*Design version 1 — proposed, unbuilt. Issue #1.*
