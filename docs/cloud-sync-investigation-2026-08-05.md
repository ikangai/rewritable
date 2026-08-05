# Cloud sync vs. in-place saves — what's known, what needs a real account

**Status:** ANALYSIS + a manual protocol. Not resolved — the remaining work needs
iCloud/Dropbox accounts on a real machine, which is why this is written down rather than guessed at.
**Trigger:** [issue #14](https://github.com/ikangai/rewritable/issues/14).

## Why this matters more than its P3 label suggests

The architecture's durability claim is that **the exported `.html` on disk is the only durable
artifact**. The modal place that file lives is `~/Documents` or `~/Desktop`, which on macOS is very
often iCloud Drive. So the environment the whole promise rests on is one that had never been
exercised — zero occurrences of iCloud, Dropbox, OneDrive or Syncthing anywhere in the repository
before this document.

## What the runtime already handles (verified)

Better than the issue assumed. The commit path tracks an FSA state machine
(`seeds/rewritable.html`, search `_fsaState`) with five values, one of which is exactly a sync-shaped
failure:

| state | meaning |
|---|---|
| `unsupported` | no `showSaveFilePicker` (Firefox/Safari) |
| `prompt` | handle exists, not yet granted this session |
| `granted` | writes proceed without reprompting |
| `denied` | user declined |
| **`lost`** | **a write threw `InvalidStateError` — the handle no longer refers to a valid file** |

`lost` is what a sync client causes when it replaces the file underneath a held handle (delete +
recreate rather than in-place modify, which is how several sync clients apply a remote change). The
runtime already degrades to the download path in that case rather than losing the write silently.

Since 2026-08-04 there is a second, independent protection: **boot reconciliation** (#1). If a sync
client restores or updates the file while the browser holds older state, the next open detects it
via the stored `doc_baseline` hash and either adopts the file or asks. That covers the
"sync pulled a newer version down" case at open time.

## What is NOT covered

1. **Mid-session divergence.** Reconciliation runs at boot. If the file changes on disk *while a tab
   is open*, nothing re-checks before the next ⌘S, so the save overwrites the synced change. This is
   the same shape as the multi-tab gap (#6) and has the same non-answer today.
2. **Conflicted copies.** If a sync client writes `document (conflicted copy).html` beside the
   original, that is a new file with the **same `DOC_UUID`** baked in — so opening it shares the
   original's IndexedDB. Two files, one database. Boot reconciliation would see the conflicted copy's
   `INLINE_DOC` as "the file changed" and offer to adopt it, which is *probably* right but has never
   been observed.
3. **Dataless / evicted files.** macOS can evict an iCloud file's contents, leaving a placeholder.
   Whether a stored handle survives materialisation is unknown.
4. **Write amplification against sync.** Every ⌘S rewrites the whole file (the bootstrap is ~630 KB
   before content), so an actively edited container is a large, frequently-changing file for a sync
   client to chew on. Not a correctness issue; possibly a battery and bandwidth one.

## Manual protocol

Automating this is not practical — FSA requires a real user gesture to grant, and headless Chrome
cannot meaningfully hold a persisted handle against a cloud-synced path. So this is the sequence to
run by hand, on a machine signed into the service. About fifteen minutes.

**A. Baseline in-place save.** Put a container in an iCloud-synced folder. Open from `file://`,
grant write access, edit, ⌘S. Confirm the file updates in place and the sync client uploads it
without creating a duplicate.

**B. Remote change while open.** With the tab still open, change the same file from another device
(or the iCloud web UI). Wait for the sync to land locally. Then ⌘S in the still-open tab.
*Expected:* the local write wins and the remote change is lost — this is gap 1 above. Record whether
the handle survived (write succeeded) or the runtime fell to `lost` and downloaded instead.

**C. Reopen after a remote change.** Same as B, but reload the tab before saving.
*Expected:* boot reconciliation detects the changed file and either adopts it or offers the choice.
This is the case that should already work; confirm it does.

**D. Conflicted copy.** Force a conflict (edit on two devices while offline, then reconnect). Open
the conflicted copy.
*Expected:* it shares the original's IndexedDB because `DOC_UUID` is identical. Record what
reconciliation does.

**E. Eviction.** Right-click → "Remove Download" on the container in Finder, then reopen the tab
holding its handle and ⌘S. Record whether the handle survives materialisation.

**F. Repeat A on Dropbox**, which applies remote changes differently from iCloud (Dropbox tends to
replace, iCloud tends to modify in place), so the `lost` path is more likely to fire there.

## What to do with the results

If B and E behave as expected, the honest fix is documentation plus possibly a save-time re-check —
compare the file's current bytes against `doc_baseline` before overwriting, reusing the machinery
#1 already built, which would close gap 1 for both cloud sync *and* multi-tab. If D shows the
shared-database behaviour is confusing, that is an argument for rotating `DOC_UUID` on
conflicted-copy detection, which is a bigger change and should not be designed before it is observed.

No spec for unmeasured problems.

---

*Analysis version 1. Issue #14. Steps A–F need a real machine with cloud accounts.*
