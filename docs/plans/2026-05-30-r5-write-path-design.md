# R5 — the non-agent write path: shared-entry mutex + reentrant commit (+ staged overlay)

*Design, 2026-05-30, euler. The gate before any `edit-surface` / `compute`
provider is safe in the seed. Follows
`docs/plans/2026-05-29-rwa-affordance-skill-kernel-design.md` §"Write-path"
(L106-149, L260-268), which named this the central unresolved item and flagged
the ordering claim as unenforceable at the current `modify()` seam. The
`view` affordance ships (§5.10); `edit-surface`/`compute` are blocked on this.
A design for the team to tear apart — **not yet implemented.***

---

## 1. What's actually broken

The substrate has exactly one writer model: a mutex-guarded read → transform →
atomic commit. Two surfaces want to write *without* an LLM in the loop:

- **`edit-surface`** — a human types into a grid cell / drags a row. No agent.
- **`compute`** — a derived cell recomputes when its inputs change. No agent.

Today the only non-agent writer is `runtime.applyEnvelope` →
`synthesizeAndCommit` (`seeds/rewritable.html:833`, `:2819`), which pays a
**full IDB commit per call**. That is fine for a one-shot gesture (tesla's
datatable uses it; 25/0). It is *not* fine for high-frequency editing (a cell
keystroke cannot pay a `commitDoc` each character), and — the load-bearing
problem — there is **no seam that guarantees the agent never reads a doc with
uncommitted non-agent edits pending.**

Two distinct problems, often conflated:

1. **Ordering (correctness).** If an `edit-surface` holds an uncommitted edit
   and the user hits ⌘K, the agent must see the *flushed* doc, not a stale one.
   This must hold for **both** agent backends.
2. **Efficiency (latency).** High-frequency edits (per-keystroke compute,
   live-typed cells) can't each pay an atomic IDB commit. They need batching.

Problem 1 is mandatory for *any* `edit-surface`. Problem 2 is mandatory only if
the consumer's edit frequency is high — a per-*blur* datatable does not need it.
**Scope to the consumer's real granularity (Rule 2).** (Asked tesla: does the
datatable commit per-keystroke or per-blur? That decides whether Step 2 ships
now or is deferred.)

## 2. The current seam — why the ordering claim is unenforceable

Three places acquire `modifyMutex`, and they do not share an entry:

| Site | Line | Acquires mutex… | Reads doc |
|---|---|---|---|
| `modify()` (openrouter/ollama/lmstudio) | 3786 | at **:3813**, *after* the bridge dispatch | `getDoc()` :3820 |
| `modifyViaBridge()` | 3935 | at **:3941** (its own) | inside |
| `synthesizeAndCommit()` (non-agent) | 2819 | at **:2831**; **throws** `concurrent_modify` if already held (:2830) | inside |

The killers:

- **Bridge bypass.** `modify()` dispatches `return modifyViaBridge(...)` at
  **:3797 — before it ever touches the mutex at :3813.** A flush hook placed at
  the top of `modify()`'s mutex block never runs for the bridge backend. There
  is no single "agent is about to read the doc" point covering both backends.
- **Reentrancy wall.** A `flushPendingOverlays()` running *inside* a held agent
  mutex cannot commit through `synthesizeAndCommit` — it would hit the
  `if (modifyMutex) throw concurrent_modify` guard at **:2830**. So the natural
  "flush, then let the agent read" sequence is structurally impossible today.

This is why the kernel-design downgraded "flush acquires the mutex, so it can't
race the agent" from a guarantee to a flagged hole.

## 3. The fix — two independently-landable steps

### Step 1 — shared-entry mutex + reentrant commit core (the ordering gate)

**Goal:** one place where, for *every* agent path, the mutex is acquired and any
pending non-agent edits are flushed *before* the doc is read. Make non-agent
writes safe; needs no overlay and no new consumer to land + test.

1. **Extract `commitCore(envelope, surface, meta)`** from `synthesizeAndCommit`
   — the read-merge-`commitDoc`-rerender body **without** the mutex
   check/acquire (:2830-2831) and without the test-seam shim. `commitCore`
   assumes the mutex is already held.
   - `synthesizeAndCommit` becomes: `if (modifyMutex) throw concurrent_modify;
     modifyMutex = true; try { return await commitCore(...) } finally {
     modifyMutex = false }` — behaviour byte-identical to today for existing
     callers (the test seam stays on `synthesizeAndCommit`).
   - `flushPendingOverlays()` calls `commitCore` directly — reentrant, no throw.

2. **Single shared agent entry.** Refactor so `modify()` acquires the mutex
   **once, before** the `cfg.kind === 'bridge'` dispatch (currently :3797), runs
   `await flushPendingOverlays()` inside it, then dispatches to an inner
   `runOpenAiModify` / `runBridgeModify` that **assume the mutex is held** (drop
   their own acquire at :3813 / :3941). The API-key precheck (:3800) stays
   *before* acquisition so a missing key doesn't strand the mutex.
   - Net: exactly one acquire per agent modify, one flush seam, both backends
     covered. `undo()` (:4064) and `runtime.setView` (:3510) already gate on
     `modifyMutex` and are unaffected.

3. **No overlay yet:** `flushPendingOverlays()` is a no-op until Step 2 registers
   a buffer. Step 1 is pure refactor + reentrancy plumbing — and is independently
   verifiable: existing suites (e2e/lens/bridge) must stay green, plus a new test
   that a registered "pending edit" is committed before `getDoc()` is read by
   both backends.

### Step 2 — staged live-region overlay + boundary flush (the efficiency layer)

*Only if the consumer needs sub-commit-granularity edits (tesla's answer gates
this).* `edit-surface`/`compute` writes mutate a tracked in-memory overlay on the
rendered region (not IDB). The overlay flushes to `currentDoc` via `commitCore`
at boundaries: **blur** of the edit region, **idle-debounce** (N ms), **before
any agent `modify()`** (the Step-1 seam — already wired), **⌘S**, and
best-effort on **tab hide/unload** (iOS-eviction safety). Reconciliation
serializes the overlay back into LF-canonical text and runs the normal atomic
commit with actor attribution (`user:cell`, `compute:derived`).

Open within Step 2 (defer with it): overlay representation (DOM-diff vs
structured cell model); `renderDoc` is full-replace, so an edit-surface owning
*uncommitted* DOM needs a capture/restore hook in `renderDoc` that does not
exist yet (kernel-design open item — the real `edit-surface` risk, not the
`:849` branch); `compute` dependency ordering + cycle detection.

## 4. Invariants this must preserve

- `currentDoc` (LF text in IDB) stays the source of truth; commits stay atomic
  `(rwa_doc, rwa_undo, rwa_hist)`; commits carry no undo state.
- Frozen zones are out of bounds for `edit-surface` regions (declared regions
  must lie outside frozen zones); `data-rwa-id` backfilled at flush as on the
  existing commit path.
- Bootstrap byte-identical except `INLINE_DOC` (Invariant 1) — this is a runtime
  refactor; no new baked region, no commit-stamp.
- `rwa_hist.actor` attributes non-agent writes (`user:cell`, `compute:derived`)
  as first-class, exactly as `user:lens` is today.

## 5. Why split the steps

Step 1 is a **contained, testable refactor with no new surface** — it closes the
ordering hole and makes the *existing* `applyEnvelope`/datatable path safe under
concurrent ⌘K, valuable on its own. Step 2 is the larger, consumer-shaped piece
and carries the genuine unknowns (transient-DOM hook, compute graph). Landing
Step 1 first means the risky overlay work builds on a proven ordering seam, and
we never ship Step 2 speculatively — it ships when (and shaped how) a real
consumer needs it. If tesla's datatable commits per-blur, **Step 1 alone may be
the whole of R5 for now**, and Step 2 waits for a consumer that types live.

## 6. Success criteria

- **Step 1:** all existing suites green (e2e 291, lens 246, bridge 8, view 17,
  identity 42, conformance 79/79); new tests: (a) a registered pending-flush
  commits before `getDoc()` for **both** openrouter and bridge paths; (b)
  `commitCore` invoked under a held mutex does not throw; (c) `synthesizeAndCommit`
  external behaviour unchanged (still throws on concurrent entry).
- **Step 2 (if scoped in):** a high-frequency edit-surface fixture commits once
  per boundary (not per keystroke); the agent reads a flushed doc; frozen zones
  and `data-rwa-id` survive a flush; undo steps back one boundary, not one
  keystroke.

## 7. Open items (for the team)

- tesla: datatable edit granularity → does Step 2 ship now or defer?
- Is the shared-entry refactor of `modify()`/`modifyViaBridge()` better as (a)
  moving the acquire above the dispatch, or (b) a thin `runAgentModify(instr,
  meta, runner)` wrapper that owns acquire+flush+release and calls a
  backend-specific `runner`? (b) is cleaner but a larger diff; (a) is more
  surgical. Leaning (b) for one honest seam; want review.
- Does `commitCore` extraction disturb the post-commit re-anchor logic
  (`prevAnchorStart`, :2838) that currently lives inside `synthesizeAndCommit`'s
  mutex block? That anchor bookkeeping is lens-specific and should stay in
  `synthesizeAndCommit`, *not* migrate into `commitCore` (compute/cell flushes
  have no lens anchor). Needs care at extraction.

---

*Status: design only. Step 1 (shared-entry mutex + reentrant `commitCore`) is
fully specifiable now and independently landable+testable; Step 2 (staged
overlay) is framed but gated on the consumer's real edit granularity (tesla) to
avoid building it speculatively. Cites the current seam at
`seeds/rewritable.html` :2819/:2830/:3072/:3786/:3797/:3813/:3935/:3941.*
