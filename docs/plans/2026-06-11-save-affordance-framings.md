# The ⌘S tension — framings and affordances for "saving" a rewritable

Status: analysis / brainstorm output, 2026-06-11. No code changes. Companion to
spec §5.6 (commit), §10.1 (FSA lifecycle), §11.4 (⌘S semantics — already an open
question in the spec).

## 1. The tension, precisely

Edits land in per-container IndexedDB and survive reopening the same file on the
same machine. ⌘S rebuilds the container and writes it out — in place via FSA on
Chromium after a one-time pick, as a *downloaded copy* everywhere else. Users
read ⌘S as the universal "save" gesture and expect **the file that is open in
the browser to update**. Instead they get either a bewildering "Save As… —
replace?" dialog (first ⌘S on Chromium) or a second file in their Downloads
folder (Firefox/Safari/iOS). The mental model breaks at exactly the keystroke
users trust most.

Two properties make this worse than it looks:

- **The lie is asymmetric in time.** The UI only distinguishes the two outcomes
  *after* the keystroke (`✓ committed` vs `✓ exported`). Nothing before ⌘S
  tells the user which world they're in.
- **The same-UUID property masks the problem locally and detonates it
  remotely.** A downloaded copy carries the same `DOC_UUID`, so opening the
  *stale* original on the same machine still shows the latest state (IDB
  rescues it). The user learns "it doesn't matter which copy I open" — then
  emails the stale original, and the recipient gets the pre-download snapshot.

## 2. "Is there a way?" — the technical reality, exhaustively

No browser grants a page write access to its own backing file. That is a
deliberate platform decision (a self-modifying-file primitive is a security
nightmare), not a gap that will close. Everything below is the complete option
space as of mid-2026:

| Mechanism | Verdict |
|---|---|
| **FSA `showSaveFilePicker` (Chromium)** | Works — already shipped. One explicit pick, handle persists in IDB, subsequent ⌘S writes in place. The first pick is irreducible; it's the consent gesture. Chrome 122+ "Allow on every visit" persistent permissions can make later *sessions* silent too (behavior on `file://` origins should be probed, not assumed). |
| **Drag the file onto its own page** | `DataTransferItem.getAsFileSystemHandle()` yields a writable handle in Chromium. An alternative *linking gesture* — "introduce the file to itself" — arguably more legible than a save dialog. Worth a real-browser probe on `file://`. |
| **Firefox / Safari FSA** | Structurally absent. Both ship OPFS only; Mozilla's vendor position on picker-based FSA is negative, WebKit has no signal. Download is the only write path, indefinitely. |
| **iOS Safari** | Worse than download: blob downloads are second-class. But **Web Share Level 2** (`navigator.share({files})`) IS supported — share sheet → "Save to Files" / AirDrop. A genuinely better save affordance on iOS than `<a download>`. |
| **PWA file handlers / `launchQueue`** | Requires an installed PWA; inapplicable to a bare self-contained file. |
| **The bridge (`web_cli_bridge`)** | A localhost helper that already shells out for the agent could also write the rebuilt bytes to disk — in-place save on *any* browser, for the (developer) subset already running it. Scope expansion, but no new trust boundary. |
| **Hosted projection (`/r/`)** | Already built. Moves the canon server-side; "save" becomes real everywhere because the server owns the bytes. The answer for people who value it-just-saves over file-ness. |
| **Browser extension / native companion** | Possible, against the no-install ethos. Not pursued. |

So: **partially yes, on Chromium, via one consentful gesture; structurally no
elsewhere.** The design consequence is that the UX cannot eliminate the gesture
— it must make the gesture *legible*, and must stop pretending the
non-Chromium path is "saving".

## 3. Vocabulary audit — the current chrome disagrees with itself

| Surface | Current copy | Frame implied |
|---|---|---|
| Status-bar button | `⌘S` | none (keystroke as label) |
| Post-save status | `✓ committed` / `✓ exported` | git / export |
| Dirty nudge | "You have N **uncommitted** changes. ⌘S to **commit**." | git |
| Info panel (ⓘ) | "**Save** — ⌘S writes your changes back into this file" | save-in-place (false on FF/Safari and on first Chromium ⌘S) |
| Spec | "commit", "export" | git |
| `_fsaState` | tracked (`unsupported/prompt/granted/denied/lost`) but **never surfaced as chrome** | — |

Three vocabularies coexist and the only honest one (`✓ exported`) appears only
after the fact. The spec's promised "regrant write access" affordance (§10.1)
has no visible UI today.

## 4. Candidate framings

**F1 — "Save" (status quo).** Keep the universal verb, hide the model.
Produces exactly the surprise we're analyzing. Reject.

**F2 — Git commit.** IDB = working tree, file = repository. Already the spec's
internal language and the nudge's. Honest about the two-place model, but (a)
jargon for the non-developer audience rewritables target, and (b) over-promises:
a git repo carries history; the file deliberately carries none (undo stays
local, §5.6). Keep as *spec-internal* language; don't lead with it in chrome.

**F3 — Checkpoint / snapshot.** The file is the save-game. Frequent,
low-ceremony, encouraged. Matches the platform reality that the exported file
is **the only durable artifact** (iOS eviction): you want users checkpointing
*often*, which is exactly the connotation "checkpoint" carries and "publish"
doesn't. Honest that the file is a moment-in-time artifact that travels.

**F4 — Export / publish.** Frames the file as occasional output of the "real"
thing in the browser. Correct *locally* for the download fallback (that is
literally an export), but wrong as the primary frame: it makes disk-sync feel
ceremonial and optional, which fights the eviction reality. Also collides with
the ecosystem's existing publish verbs (`rwa publish`, `publish-site`, `/r/`
hosting) that mean *share with others*. Use the word only for the download
path; never for the linked path.

**F5 — Link / sync.** Two places — the browser's working state and the file on
disk — with a visible *link state* between them. This is the framing under
which FSA's one-time pick stops being a bug and becomes the obvious setup step:
"**Link this file once; after that, ⌘S keeps it in sync.**" Unlinked is a
legitimate, visible state ("browser-only — changes live in this browser until
you download a copy"). Freshness becomes a gauge, not a nag.

**Where the user's instinct lands.** "⌘S is closer to sharing/publishing/git
commit/checkpointing than saving" — agree on *checkpoint*, half-agree on
*commit* (right structure, wrong audience), disagree on *publish/share* for the
local write: sharing already has its own verbs here, and the file-write must be
framed as routine hygiene, not occasion. The synthesis: **F5 for the
mechanics, F3 for the rhythm.** The chip says whether you're linked; the verb
says you're checkpointing the file that travels.

## 5. Affordance approaches (composable, roughly ordered by leverage)

**A. Surface the link state — the missing chrome.** A status-bar chip driven by
the already-tracked `_fsaState`:
`⛓ linked — saves in place` / `not linked — ⌘S downloads a copy` /
`browser-only (this browser can't write files)` / `link lost — relink`.
This single change converts every later surprise into a confirmation, gives
§10.1's "regrant" affordance a home (`denied`/`lost` → chip becomes the relink
button), and costs nothing architecturally: the state machine exists; only the
pixels are missing.

**B. First-save interstitial (Chromium, `prompt` state).** Before the first
picker, one small card: *"This file can save itself in place. In the next
dialog, pick this same file — **name.html** — and replace it. You'll only do
this once."* The picker stops being a non-sequitur; the OS "replace?" prompt
becomes the expected confirmation. Optionally offer the drag-gesture
alternative: "or drop the file onto this page to link it."

**C. Honest verbs per destination, decided *before* the keystroke.**
Keep ⌘S as the one key (spec §11.4's unified-key choice is right — splitting
⌘S/⌘E exports an implementation detail into muscle memory). But:
linked → `✓ saved to file`; unlinked-Chromium → button affordance reads "link &
save"; no-FSA → the affordance reads **"Download updated copy"** and the
post-save toast says where it went and what to do: *"Replace the old file with
this one — it's the copy that travels."* Fix the info-panel line (seed :6142) to
be state-conditional; align the nudge copy with the chosen verbs.

**D. Freshness gauge instead of (or beneath) the nag.** The dirty count already
persists in IDB. Render it as passive, always-true state — *"file on disk: 3
edits behind"* — clicking it saves. This teaches the two-place model
continuously instead of interrupting at threshold 5, and it directly defuses
the same-UUID trap (§1): the user can always see that the *file* is behind even
though the *tab* looks current.

**E. iOS/mobile: Web Share instead of blob download.** In download mode on
iOS (and Android), offer `navigator.share({files: [new File([text], RWA.FILE,
{type: 'text/html'})]})` → native sheet → Save to Files / AirDrop. Closer to
user expectation than a download, and it strengthens the only durable escape
hatch on the platform with the worst eviction behavior. Feature-detect with
`navigator.canShare({files})`; fall back to the `<a download>` path.

**F. The "it just saves" ladder (docs/positioning, not seed code).** For users
for whom the linked-Chromium story isn't enough: (1) link via FSA — local,
no install; (2) bridge write-back — any browser, localhost helper, developer
audience; (3) `rwa host` → `/r/` — any browser, no helper, server owns the
bytes. One sentence in README/onboarding: *"The file is the canonical artifact;
pick the projection whose save semantics you want."*

**G. Anti-affordances — considered and rejected.**
- *Timestamped/versioned download names* (`doc-v2.html`): creates file litter,
  breaks the "replace the old one" instinct, and the same-UUID property already
  de-risks opening an older copy locally. Keep the stable `RWA.FILE` name.
- *⌘E export split* (§11.4 alternative): two keys to explain instead of one
  state to display. The chip (A) is strictly better information.
- *Auto-download on every commit*: turns the Downloads folder into a versioned
  graveyard; punishes the most diligent users.

## 6. Recommended synthesis

1. Adopt **link/sync** as the mechanical frame and **checkpoint** as the rhythm
   verb; retire "Save" from chrome copy except in the honest linked state.
2. Ship the **state chip (A)** first — it is the keystone: smallest change,
   makes `_fsaState` visible, hosts the relink affordance, and turns B/C/D into
   refinements of an already-legible model.
3. Add the **first-save interstitial (B)** and **state-conditional copy (C)**
   in the same pass (they're the same few strings).
4. **Web Share on iOS (E)** as an independent follow-up — it serves the
   eviction story, not just the framing story.
5. Probe in a real browser: Chrome persistent permissions on `file://`
   handles, and `getAsFileSystemHandle()` from a drop on a `file://` page.
6. Spec impact when implemented: §5.6 (commit copy), §10.1 (chip = the regrant
   affordance), §11.4 (resolve the open question: unified key, state made
   visible instead of destination made silent — i.e. revise "the runtime
   choosing destination silently" to "the runtime *displaying* destination
   continuously").

## 7. Sharing — the half the checkpoint framing doesn't solve (added after review)

The checkpoint framing settles the *local* story — and more cleanly than it
first appears: after "download checkpoint" you do **not** need to switch to the
new file. The open file is only a boot vector; the working state is IDB, keyed
by `DOC_UUID`, which survives commits. On the same machine, opening v1 or v2
shows the identical latest state (`getDoc()`, seed :902 — IDB wins whenever it
exists). A checkpoint is a portable artifact, not a new working copy;
divergence after a checkpoint isn't merely acceptable, it's the designed
relationship.

Sharing is where the model breaks, in **two distinct ways**:

**7a. Sender-side staleness.** People share files from Finder/Mail/Slack — an
act the page cannot observe or intercept (no web API fires on "user is
attaching this file"). If they haven't checkpointed, the receiver gets the last
checkpoint, not what the sender sees. Expectation violated: "the changes are in
the file."

**7b. Receiver-side inversion (sharper, previously undocumented).** Boot
hydration is IDB-wins: `INLINE_DOC` seeds only an empty database. A receiver
who once opened v1 of a shared file has IDB under that `DOC_UUID`. When the
sender later shares v2 (same UUID — commits never change it), the receiver
opens v2 and sees **their stale v1 state**; the new bytes are silently ignored.
Re-sharing an updated file to a previous recipient *does not deliver the
update*. The service already knows about this class of bug — `POST /publish`
substitutes a fresh `DOC_UUID` before storing — but direct file shares keep the
UUID. (Related prior art: the hosted-edit baseHash/divergence work,
`.dev-diary/2026-06-07-hosted-edit-foundation-bless-divergence.md`.)

Only three levers exist; they compose:

**Lever 1 — make the file never stale: write-through on the linked path.**
On Chromium with a linked FSA handle, auto-write the file after every
commit-worthy change (modify, undo, inline edit — debounced). The file on disk
is then always current; share-from-Finder just works; the user's original
expectation — "the file open in the browser is updated" — becomes literally
true on this path. The freshness gauge flips to a steady "✓ all changes in
file" (cloud-doc grammar). Costs and edges: at most one permission re-prompt
per session (none with Chrome persistent permissions); half-finished states
land in the file (matches what users already expect of files — Word/Pages
autosave); undo stays local, so the "clean state, no history" commit invariant
is untouched; a lost handle degrades visibly back to the "N edits behind"
gauge. ⌘S remains as the explicit checkpoint for the unlinked world and as
"flush now" on the linked one. **This dissolves 7a where the platform allows
it, rather than mitigating it.**

**Lever 2 — move the share gesture inside the document.** Where write-through
is impossible (Firefox/Safari/iOS, unlinked), the on-disk file is structurally
allowed to be stale — so the only always-correct share is one that builds
current bytes *at share time*. An in-chrome **Share** affordance:
- `navigator.share({files: [...]})` with freshly built bytes → native sheet
  (Mail, AirDrop, Messages, Save to Files). Feature-detect `canShare({files})`.
- Fallback: "Download current copy" (the checkpoint verb, aimed at attaching).
- Optional: "Get link" → the existing `POST /publish` (24h share at its own
  origin) — which *also* sidesteps 7b, since publish stamps a fresh UUID.
The teaching line: **"Share from the document, not from the folder."** Same
grammar as Figma/Google Docs — the share affordance lives on the artifact.

**Lever 3 — keep the truth on screen at the moments that matter.** The
freshness gauge (§5D) is the continuous form. The threshold nudge can be
re-aimed at the actual risk: *"Sharing this file? ⌘S first — the copy on disk
is 3 edits behind."* Optionally, surface "file last written: <time>" in the ⓘ
panel so the sender sees how old the shareable artifact is (requires persisting
a last-commit timestamp — minor machinery, e.g. `rwa_state`, shown live only;
baking it into the file would need a spot inside `INLINE_DOC`).

**7b needs its own fix.** Options, weakest to strongest:
- *Route around it*: prefer link-shares (`/publish`) for repeat sharing — fresh
  UUID per share, already shipped.
- *Detect divergence at boot*: persist the hash of the last INLINE_DOC this
  browser has seen (at seed-time and at every commit, in `rwa_state`). On boot,
  if the opened file's INLINE_DOC hash matches neither that record nor the
  current IDB doc, the snapshot is *foreign* — same container lineage, content
  this browser never produced. Surface a reconcile choice instead of silently
  preferring IDB: "This file contains a different version than your local
  edits — Use file version / Keep mine." This is the honest fix; it is also a
  real feature (snapshot-divergence detection) and should ride the same
  conceptual rails as the hosted runtime's baseHash work.
- *Out of scope*: real merge. Two diverged INLINE_DOCs are a sync problem; a
  file format without a server should offer a choice, not a CRDT.

### 7c. Local-first + connected URL — the proposed framing (2026-06-11 review)

The framing that ties §4 and §7 together: **local-first**. The file and its
browser working state are the canon; the network is explicit, per-gesture,
opt-in. Three artifacts, three gestures, each visible:

| Artifact | Gesture | Lives | Lag is… |
|---|---|---|---|
| Working state | every edit (automatic) | this browser's IDB | n/a (always current) |
| Checkpoint | ⌘S | the file on disk | visible (freshness gauge, §5D) |
| Shared version | **Share / Update share** | a URL | visible & *expected* (a posted version) |

A container can be **connected to a URL**: the first Share publishes current
bytes to `<short>.rewritable.ikangai.com` (the existing `/publish` machinery —
own origin, fresh `DOC_UUID`) and stores a connection record machine-locally
(`rwa_state`: short code, update token, published hash, timestamp). Every
subsequent "Update share" re-publishes current bytes **to the same URL**. The
receiver always gets the latest *published* version, as a full forkable
rewritable; because each publish stamps a fresh UUID, the receiver-side
inversion (7b) cannot occur on this path at all.

**Why this is clearer than fixing the file-share.** It replaces an invisible,
implicit gap (IDB vs file bytes — the one nobody can see) with a visible,
explicit one (local checkpoint vs published version — the one everybody
already understands). Nobody expects a *posted* artifact to self-update; "I
shared a version at a link, and I can push a new version to it" is the mental
model of posting a PDF, not the false promise of a live Google Doc. The
residual gap — the URL can lag local state — is accepted *by design* and shown
in chrome ("share: updated 2h ago · 2 checkpoints behind").

**The one naming hazard.** A bare "Share" button invites live-doc
expectations. The copy must say *version/snapshot*: "Anyone with the link sees
**this version**. Update it anytime." If the button implies live-ness, the
whole clarity win evaporates.

**v1 decisions (proposed).** Explicit update only — never auto-publish
(checkpointing must remain a local, offline act; publishing is outward-facing
and consent-bearing). An opt-in "publish on checkpoint" toggle can come later.
The connection record is machine-local in v1 (moving machines orphans the
update capability — acceptable, document it; the in-file/vault question is
deferred). Receiver gets a file, not an account: fork-by-default, no
collaboration pretension.

**Service deltas required.** (1) Stable share identity + update token —
re-publish to an existing short code (the `/r/` rotate-token machinery is
precedent); (2) TTL policy — **decided 2026-06-11: durable while active**. A
connected share lives until explicitly unshared, with a long inactivity expiry
(~90 days since last update/view) as the cleanup backstop; the hourly 24h sweep
keeps applying to legacy one-shot publishes. Implies the share record
distinguishes connected from ephemeral shares and the sweep consults
last-activity, not created-at; (3) optionally a cheap HEAD/describe probe so
the chrome can show what version is live.

**The full ladder** (each step explicit opt-in, canon stays as local as the
user wants): local file (canon) → checkpoint (disk) → **connected share**
(published snapshot at a stable URL) → hosted live `/r/` (canon moves
server-side, live writable projection). The operations API already names
`publish` as one of the five verbs; this gives the verb a stable-identity
variant and, for the first time, a chrome surface inside the seed.

**Synthesis update (extends §6):** the chip/gauge/interstitial story (§5–6)
remains the foundation. On top of it: (1) the **connected share (7c)** is the
primary sharing answer — explicit, always-current-at-publish-time, immune to
7b, and legible because both of its artifacts are visible; (2) write-through
auto-save on the linked path remains worth doing for the *file* story on
Chromium (the naive Finder-share becomes correct there), but it is now a
refinement, not the keystone; (3) the boot divergence check is still the
necessary companion wherever raw files are re-shared (email/AirDrop will not
disappear), or 7b quietly undermines the file path.

## 8. One-paragraph version

The web will never let a file save itself; Chromium lets a user *deputize* it
once, and everywhere else the file can only be re-downloaded. So stop selling
⌘S as "save" and stop hiding the machinery: show a persistent linked/unlinked
chip (the state machine already exists in `_fsaState`), explain the one-time
pick the moment before it happens, call the fallback what it is — "download the
updated copy that travels" — and show how many edits the file on disk is
behind. ⌘S stays one key; what changes is that the user can always see which of
the two honest things it will do. For sharing, go local-first and explicit:
connect the container to a stable URL and let Share/Update-share publish the
current bytes as a *version* at that link (the existing `/publish` machinery,
made durable and re-targetable) — the invisible IDB-vs-file gap becomes a
visible, expected published-version gap. Write-through on the linked Chromium
file remains a worthwhile refinement, and a boot-time divergence check is still
needed so a re-shared raw file is never silently masked by the receiver's
older local state.
