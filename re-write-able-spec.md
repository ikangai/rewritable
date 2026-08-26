# re-write-able

*A specification for self-modifying HTML documents*

---

## 1. The Name

**re** — it does it again. The agent loop, self-modification, iteration over time.  
**write** — not read. Not consume. Author. The read/write web, finally delivered.  
**able** — a property of the file itself. Not a permission the OS grants you. Something it *is*.

`re-write-able` is both a description and a manifesto. A re-writeable file is one that participates in its own creation.

---

## 2. The Problem

The web became read-only for most people.

You consume apps. Someone else made them, deployed them, owns them. You have no access to the source. You can't change them. You certainly can't ask them to change themselves.

Office suites used to ship documents — `.doc`, `.xls`, `.ppt`. Files you owned, on disk, sharable by email. They moved to the cloud and you stopped owning the document.

The tools that do let you modify things — code editors, CLIs, build pipelines — require you to already be a developer. Citizen development tools (no-code, low-code) give you drag-and-drop but hide the source and lock you to a platform.

There is no middle ground: a document that is fully sourceful, fully ownable, fully modifiable, but requires no environment, no install, no server, no account.

A re-writeable file is that middle ground.

---

## 3. The Concept

A re-writeable file is a single `.html` file that:

1. **Renders itself** — open it in any browser, it runs
2. **Stores itself** — its working state lives in IndexedDB; the file itself is the durable record
3. **Modifies itself** — an embedded agent rewrites the document on instruction
4. **Commits itself** — the current state is written back into the file, in place when the browser supports it, as a download otherwise
5. **Requires nothing** — no server, no install, no build step, no account

The user-authored content is a **document** — sometimes pure prose, sometimes a tracker, sometimes a spreadsheet, often all three at once. Interactivity is a property a document may or may not have, not a definition. Word, Excel, and PowerPoint each picked one mode and made the others awkward; HTML can do all three in the same file. `re-write-able` returns the document to the form factor that made office suites work in the first place: a file you own, on disk, that you can send.

The runtime is software. The document is the artifact.

---

## 4. The Read/Write Web

Tim Berners-Lee's original vision was a read/write web. The browser was meant to be an editor. The web became predominantly read-only — a distribution medium, not a creation medium.

`re-write-able` is a correction at the file level:

| Web as it is | re-write-able |
|---|---|
| You consume apps | You own the document |
| Documents live in the cloud | Documents live in a file |
| The format is proprietary | The format is HTML |
| Changing requires a developer | Changing requires a sentence |
| Deployment is a process | Deployment is sharing a file |
| Open source is a repository | Open source is the file itself |

HTML can do everything Word, Excel, and PowerPoint did — and it can do all three in the same document. `re-write-able` makes the document writable again, on disk, by the person who owns it.

---

## 5. Architecture

### 5.1 Container, Bootstrap, and Document

Three terms anchor the rest of the spec:

- **Container** — the `.html` file as a whole. The thing you open, share, attach to email, drop on a desktop.
- **Bootstrap** — the immutable shell inside the container: a loader, a runtime, and an inline snapshot of the document. The bootstrap is byte-identical across every open until a commit, and a commit only rewrites the snapshot — the loader and runtime bytes do not change.
- **Document** — the user-authored part: HTML, CSS, optional JS, and structured data. Mutable. Lives in IndexedDB at runtime; lives as a frozen snapshot inside the bootstrap at rest.

```
container (the .html file on disk)
└── bootstrap (immutable shell — never modified except by commit)
    ├── loader        (hydrate IndexedDB on first open, render the document on every open)
    ├── runtime       (⌘K, ⌘Z, ⌘S, agent wrapper, status UI, storage API)
    └── const INLINE_DOC = `…`   (frozen snapshot — first-open seed and commit target)
```

The bootstrap is to a re-writeable file what `gate.py` is to a governed self-modification system: the one thing the agent cannot touch. The agent receives only the document; the bootstrap, loader, runtime, and inline snapshot are not visible to it. There is no "preserve this script block verbatim" instruction — the runtime is structurally inaccessible, not contractually protected.

### 5.2 The Bootstrap

The bootstrap holds four responsibilities.

**Identity.** A per-container UUID, generated once at creation time and baked into the bootstrap as a top-level constant (`DOC_UUID`). The runtime uses it to namespace IndexedDB (§5.3) so containers opened from the same null origin do not collide. The UUID is part of the immutable bootstrap: every commit rewrites only the `INLINE_DOC` literal, so `DOC_UUID` is byte-identical pre- and post-commit and the container keeps the same database across its entire lifetime. UUID generation happens outside the runtime — at the moment a new container is created (e.g. by a Claude skill that scaffolds the file from a template).

**Loader.** On every open, hydrates IndexedDB from the inline snapshot if IndexedDB is empty, then renders the document. The first-open path and every-other-open path are the same code path; the only difference is whether IndexedDB starts empty.

**Runtime.** Provides the self-modification surface and a small API for the document:

- `⌘K` — modification prompt
- `⌘Z` — undo (pop from the IDB undo stack, up to 10 levels)
- `⌘S` — commit (write the bootstrap back to disk with an updated inline snapshot, in place when possible)
- Storage adapters: `runtime.db.*` (IndexedDB), `runtime.fs.*` (OPFS)
- Agent invocation: `runtime.modify(instruction)`
- Status UI: storage health, FSA permission status, dirty/clean indicator, commit nudge

The full runtime API surface is in §7.

**Inline snapshot.** A JavaScript template literal containing a serialized payload — the rendered HTML/CSS/JS plus the contents of all IndexedDB stores and OPFS paths the document uses. The snapshot is the source of truth on first open; IndexedDB takes over after hydration; on commit, IndexedDB and OPFS are serialized back into the snapshot. One snapshot, one round-trip, one source of truth at any given moment.

This replaces two structures from the prior architecture: the `<script id="re-write-able-runtime">` block inside the document, and the `<script type="application/json" id="app-seed-data">` blob for IndexedDB hydration. Both are gone. The runtime is no longer in the document, no longer in localStorage, and no longer in the agent's context window.

### 5.3 Storage Model

Four tiers, each chosen for what it does best.

| Tier | Holds | Sync? | Browser support | Mutated when |
|---|---|---|---|---|
| **IndexedDB** | Per-container database `rwa_<DOC_UUID>` holding `rwa_doc`, `rwa_undo`, `rwa_hist`, `rwa_fsa`, plus document-defined stores | Async | All | Every ⌘K, ⌘Z, and document write |
| **OPFS** | Binary blobs — images, attachments, large or streamable content | Async (sync handles inside Web Workers) | All modern | Document-driven |
| **sessionStorage** | OpenRouter API key | Sync | All | On submit; cleared on tab close |
| **Filesystem** | The container itself (bootstrap with current inline snapshot) | n/a | Chromium write-in-place via FSA; download elsewhere | On commit (⌘S) |

LocalStorage is not part of the architecture. Everything that previously lived there moves to IndexedDB. The benefit: one tier for all working state, larger quota, no split between source storage and data storage. The cost: async loading. For a 50–100 KB document the load is imperceptible; for larger documents the loader can render synchronously from the inline snapshot first and reconcile with IndexedDB after (§11.2).

#### Reserved namespaces

The runtime owns these — generated documents must not touch them.

- IndexedDB databases: each container claims `rwa_<DOC_UUID>` (its own private DB, isolated from other containers — see §5.7). The shared composition database `rwa_shared`, if used, is also runtime-owned.
- IndexedDB stores within `rwa_<DOC_UUID>`: `rwa_doc`, `rwa_undo`, `rwa_hist`, `rwa_fsa`, and any future store named `rwa_*`.
- OPFS paths: anything under `_rwa/`.
- HTML element id: `#rwa-doc-mount` (the render target).
- HTML attribute `data-rwa-id`: runtime-assigned stable identifier on anchorable blocks (§5.9). Documents must not invent or modify these values; the runtime backfills any block produced without one and the agent contract requires verbatim preservation (§6.1).

Each container's OPFS is namespaced by `_<DOC_UUID>/`. The `runtime.fs.*` API auto-prefixes paths so documents see a private root. The legacy `_rwa/` reservation is still honored for any direct OPFS access that bypasses the runtime API.

**OPFS is unavailable under `file://` origins in Chromium.** `navigator.storage.getDirectory()` throws `SecurityError` ("certain files are unsafe for access within a Web application") when the document is opened directly from disk, even though IDB works fine in the same context. `runtime.fs.*` translates this into a clear error directing the document author to host the container via HTTP (e.g. `node service/server.js`). Containers that need blob storage on disk must currently fall back to storing Blob values in IDB via `runtime.db.*`; a future revision may move that fallback into `runtime.fs.*` itself.

The document interacts with reserved storage only through the runtime API. The runtime is the only writer of reserved stores.

#### Quota awareness

The runtime checks available storage on boot and after each rewrite and surfaces a warning above 80% usage. On browsers that support it, persistent storage is requested:

```javascript
if (navigator.storage?.persist) navigator.storage.persist();
```

Chrome (desktop and Android) honors this; Safari does not (§9.1).

### 5.4 The Rewrite Loop

```
user presses ⌘K, types instruction
  → runtime reads rwa_doc from IndexedDB
  → agent call: system prompt + document + instruction
                (no bootstrap, no runtime, no inline snapshot in the prompt)
  → push prior rwa_doc onto rwa_undo (cap 10)
  → write returned document to rwa_doc
  → loader re-renders
```

The agent receives only the document. The bootstrap, loader, runtime, and inline snapshot are not in the prompt, and the agent cannot modify them because they are not visible. This eliminates the prior architecture's "preserve the runtime block verbatim" instruction — a fragile contract that depended on the model not drifting on the most repetition-prone part of the prompt.

A side benefit: the prompt is smaller. The runtime overhead (~10–15 KB) is no longer charged on every modification, and smaller, cheaper models become viable defaults.

`⌘Z` pops `rwa_undo` and writes it to `rwa_doc`. Multiple undos walk back through history. Together, `rwa_undo` and `rwa_hist` form a dialogue log: what the user asked and what the document became at each step. Undo isn't just version control — it's conversation replay.

### 5.5 First Open and Hydration

```
open container.html
  → bootstrap runs
  → loader checks IndexedDB for rwa_doc
  → empty? hydrate: copy INLINE_DOC into rwa_doc, replay any data stores it carries
  → render document
  → runtime attaches event listeners
```

There is no build form, no description prompt, no agent call on first open. The file is a document the moment it is opened. If you want a particular initial state, ship the file with that state baked into the inline snapshot. If you want a blank slate, ship a snapshot of a blank slate.

The build flow from the prior architecture (open seed → enter description → agent generates document) is no longer privileged. A separate "starter" container can perform the build flow as an ordinary modification and then commit, but the act of building is just the first ⌘K.

### 5.6 Commit and Export

`⌘S` has one semantics — *commit* — and two implementations depending on browser capability.

**Chromium with a persisted FSA handle (commit-in-place):**

```
serialize current rwa_doc + all document-defined IDB stores + relevant OPFS contents
  → rewrite the INLINE_DOC constant inside the bootstrap
  → handle.createWritable() → write whole .html → close
  → status: clean
```

**All others (export-as-new-file):**

```
same serialization
  → trigger download of new .html with updated INLINE_DOC
  → user manually attaches/saves
  → status: clean since last export
```

Other than the destination, the two implementations are byte-identical: the same bootstrap, the same updated inline snapshot, the same self-contained file. The exported file opens and runs without external dependencies, and can keep rewriting itself.

The runtime persists the FSA handle in IndexedDB (handles are structured-cloneable in modern Chromium) and reuses it for subsequent commits. If the permission lapses, the runtime falls back silently to download mode and surfaces a "regrant write access" affordance. The full FSA permission contract is in §10.1.

**Undo state stays local.** `rwa_undo` and `rwa_hist` are not serialized into the inline snapshot. A committed file is a clean state, not a state plus its history. A recipient of a shared file starts with a fresh undo stack; the sender's history stays on the sender's machine.

The runtime tracks dirty state — number of modifications since last commit — and surfaces a status indicator. After 5 uncommitted modifications it nudges: *"You have 5 uncommitted changes. ⌘S to commit."* This is critical because the inline snapshot is the only thing that travels: a recipient who opens an uncommitted file gets the snapshot from the previous commit, not the current IndexedDB state.

### 5.7 Container Isolation and the Null Origin

Under `file://`, every container shares the same origin — `null`. Without further structure, they would share IndexedDB. Earlier drafts of this spec framed that as a feature: a free communication bus between documents on the same disk. In practice it makes containers shadow each other. Open `tracker.html`; its `rwa_doc` lands in the shared `rwa` database. Then open `notes.html`; the loader finds an `rwa_doc` already in IndexedDB and renders it instead of hydrating its own snapshot. Every container becomes a window into whichever container last wrote to the shared database.

**Isolation by default.** Each container's IndexedDB lives in a database named after its UUID: `rwa_<DOC_UUID>` (§5.2, §5.3). Two containers opened from the same origin do not see each other's `rwa_doc` because they are looking at different databases. The null origin is no longer the bus; the UUID is the boundary.

**Composition is opt-in.** A document that wants to publish to or read from other containers does so through a shared database, `rwa_shared`, accessed via the runtime:

```javascript
runtime.shared.put('tracker:tasks', tasks);
const tasks = await runtime.shared.get('tracker:tasks');
runtime.shared.subscribe('tracker:tasks', refreshTrackerSection);
```

`rwa_shared` has a single store keyed by string. Naming convention: `<source>:<topic>`. The bus that previously existed by accident — every container's private state visible to every other container — becomes an explicit, namespaced API. The architectural intent is preserved; the failure mode (containers shadowing each other) is gone.

The detailed shape of `runtime.shared.*` — naming rules, conflict resolution between writers, schema declarations — is deferred to §11.5.

**No free change event.** IndexedDB does not fire `storage` events. Use `BroadcastChannel` for cross-container pub/sub. The runtime's `shared.subscribe` wraps a `BroadcastChannel` keyed by the shared-store name.

**Async reads.** Every cross-container read is a Promise. Embedders should render a skeleton first and hydrate when the transaction resolves.

Each container's OPFS lives under `_<DOC_UUID>/` and is exposed to the document through `runtime.fs.*`, which auto-prefixes paths. Documents see a clean private root; the on-disk OPFS keeps containers isolated the same way IDB does. Direct OPFS access bypassing the runtime API still shares the null-origin namespace — opt-in to isolation by going through `runtime.fs.*`.

Served over HTTP/HTTPS, each file gets a real origin and `rwa_shared` becomes per-host. The composition surface is a local-disk feature; hosting a re-writeable file behind a URL converts it from a composable artifact into a single-document island.

### 5.8 Embedding and Composition

> **Status: NOT BUILT.** Nothing in this section is implemented. There is no `srcdoc` rendering and
> no `runtime.read()` — that method does not exist on the runtime API (§7), and neither identifier
> appears anywhere in the seed, the CLI, or the service. The code sample below, the three-mode
> sandbox table, and the dashboard-embedding-siblings example are all design intent that was written
> in the present tense. Retained as a design sketch; do not build against it. Cross-container
> composition that *does* ship is `runtime.bus` (BroadcastChannel message passing) — not shared
> storage and not embedding. See `docs/spec-fiction-audit-2026-08-05.md`.

A re-writeable can embed another re-writeable inline. Because the container lives on disk, the embedder reads the sibling's container file via FSA (or, in browsers without FSA, asks the user to attach it) and renders it via `srcdoc`:

```javascript
const trackerContainer = await runtime.read('tracker.html');
const iframe = document.createElement('iframe');
iframe.srcdoc = trackerContainer;
iframe.sandbox = 'allow-scripts allow-same-origin';
host.appendChild(iframe);
```

`srcdoc` is required — `<iframe src="file://…">` is blocked by Chrome and Firefox. The `sandbox` attribute controls what the embedded document can do.

| Mode | Sandbox value | Behavior |
|---|---|---|
| **Snapshot** | `sandbox=""` | Static render — no JS, pure visual preview |
| **Live view** | `sandbox="allow-scripts"` | Document runs JS but cannot access IndexedDB or OPFS — fully isolated |
| **Full embed** | `sandbox="allow-scripts allow-same-origin"` | Document has full storage access — can self-modify |

A dashboard can embed multiple siblings live and refresh them when their stores change (via `BroadcastChannel`). On export, the dashboard's inline snapshot can include either the embedded documents' last-known state (frozen embeds) or just references to them (live embeds that re-read on next open).

### 5.9 Stable block identifiers and web fragment addressing

On disk a container's identity is its file path; on the web it is its URL. A URL also carries a fragment, and for the web edition of a re-writeable that fragment is load-bearing: it names a block inside the document. So `https://you.com/notes.html#7k3p2m9q` means "the block I called `7k3p2m9q` inside `notes.html`," and it goes on meaning that even after the block's surrounding prose has been re-written fifty times.

To make this real, the runtime maintains a stable identifier on every anchorable block (`p`, `h1`–`h6`, `blockquote`, `li`, `figure`, `pre`, `aside`, `table`, `td`). The attribute is `data-rwa-id`. The value is opaque — 8 characters of lower-base32 from `crypto.getRandomValues`, e.g. `data-rwa-id="7k3p2m9q"`.

`table` and `td` were added in spec 0.11 (2026-05-19) so the workflow product's parallel-block container and its cells get stable identifiers without needing the agent to inject them by hand. The change is additive — existing documents without ids on tables / cells get them backfilled on the next commit.

**Lifecycle.**

1. **Backfill on first encounter.** On bootstrap, after `getDoc()`, the runtime walks the document text and assigns a fresh ID to every anchorable block that lacks one. If any were assigned, the runtime persists the augmented text into `rwa_doc` immediately. The same backfill runs at every commit — agent-introduced blocks get IDs before the document hits IDB.
2. **Frozen zones are skipped.** Marker-form frozen zones (`rwa:frozen:begin/end`) and `data-rwa-frozen` elements are byte-invariant. Injecting an attribute inside one would break the frozen-zone integrity check. The walk skips them entirely.
3. **Preserved across edits.** IDs are part of the canonical document text. They round-trip through `apply_edits`, `apply_dsl_plan`, `replace_document`, undo, and commit/export. The agent contract (§6.1) instructs the agent to preserve them verbatim and never invent new ones.

**URL fragment resolution.** On load and on `hashchange`, the runtime resolves `location.hash` against either a literal `id=` attribute (author-supplied) or a `data-rwa-id` value (runtime-assigned). On hit it scrolls the target into view and pulses it with a brief background-color fade so the location is obvious after the scroll.

**What this enables.** A re-writeable on the web becomes a node in the read/write web (§4). Other documents — yours or anyone's — can link into specific blocks, embed a sanitized snapshot of one, or annotate one in a separate file linked back. The original is never mutated by external linkage; the linker's commentary lives in the linker's container. This is the Berners-Lee model carried into a single-file format: identity is a URL, fragments are stable, composition happens by referencing rather than by editing each other's source.

**Why this is runtime-managed, not author-managed.** A human author can pick clear `id=` values for top-level headings, and those keep working (the runtime resolves either form). But every paragraph and list item must also be addressable, and asking authors to invent identifiers for every block is not realistic. The runtime takes ownership of the namespace so addressability is free. Documents that need readable IDs on specific elements should keep using the standard `id=` attribute alongside `data-rwa-id`.

**Out of scope (for now).** Cross-document transclusion (`<rwa-include src=...>`), overlay/commentary metadata (`<meta name="rwa-overlay">`), and sandboxed-iframe hosting wrappers are designed against this floor but live in a later spec revision. See `docs/plans/2026-05-15-web-hardening-design.md` for the longer arc.

### 5.10 Render modes and view providers

§5.4 renders the document as it is stored: the loader writes `rwa_doc` into `#rwa-doc-mount` and re-renders after every modification. A **render mode** lets a document be *displayed* differently from how it is *stored* — the same headings and paragraphs drawn as a presentation deck, the same list drawn as a board — without changing the stored text, the agent's view of it, or any bootstrap byte (Invariant 1). This section specifies the contract; the first render mode (`presentation`) and the registration surface land in a follow-on revision (see the version note).

**The registration surface.** A render mode is supplied by a *provider*, registered on the runtime:

```
const off = runtime.provide('view', spec);   // register; returns an unregister closure
runtime.setView('presentation');             // activate a render mode by name
runtime.setView(null);                        // return to the default render path (§5.4)
```

`view` is the one provider kind this revision specifies — a display-only render mode. Other kinds (`edit-surface`, `compute`) are deferred (below). For first-party providers — those shipped inside the bootstrap, and therefore covered by Invariant 3 (the agent never sees them) — the runtime holds a single nullable slot per kind; a persisted registry for installed third-party providers is deferred.

**The `view` spec.** A `view` declares one required slot and one optional slot:

- `render(doc) → html` — **required, pure, synchronous.** Takes the stored document text and returns the HTML to mount.
- `mounted(m, ctx)` — **optional, impure.** Runs after the mount's `innerHTML` is set and after the runtime's post-render pass (`renderDoc`, rwa-edit-spec.md §11). Owns transient UI state — the active slide index, an `.active` class — which must not live in the document and is re-established here on every render, since §5.4 re-renders on each modification.
- `reveal(m, el)` — **optional, impure.** Called by URL-fragment resolution (§5.9) before it scrolls, when a render mode may have hidden the target block (presentation hides inactive slides with `display:none`). The view makes the region containing `el` visible — e.g. activates the slide that owns it — so the scroll lands. This is the mechanism by which clause 3's "fragment resolution continues to work" holds for a hiding view.

**The render contract.** `render` is one-way and display-only; its output is mounted and discarded.

1. *Output is never read back.* The returned HTML is written to `#rwa-doc-mount` and never serialized into `rwa_doc`, never committed, never sent to IndexedDB. The stored document stays the source of truth (Invariant 6); commits operate on the stored text (§5.6), so `data-rwa-id` and frozen zones survive because the mounted value never participates in a commit — not because the render output carries them through.
2. *The agent-facing source is the stored text, never the mounted value.* The document the agent receives (§5.4, §6.1) is derived from `rwa_doc`, never from `render`'s output. A render mode is therefore invisible to the agent by construction (Invariant 9): the agent never sees a deck's `<section>` wrappers or any rearrangement, even while a `view` is active.
3. *`data-rwa-id`-bearing blocks stay present and identified.* `render` must not strip `data-rwa-id` (§5.9) and must keep every id-bearing block present in the mounted DOM — it may hide a block with CSS but must not omit it, so URL-fragment resolution (§5.9, which resolves `location.hash` against the live DOM) and any runtime state keyed by stable id continue to work.
4. *No reserved ids or markers.* `render` output must not contain reserved runtime ids (`#rwa-doc-mount`, `#rwa-lens`, `#rwa-runtime`, any `#rwa-*`) or frozen-zone markers (§5.3, rwa-edit-spec.md §7) — a duplicate `#rwa-lens` silently breaks lens identity resolution. The runtime validates output at `provide`/`setView` time and throws.
5. *First-party output carries no `<script>`.* The render path re-executes `<script>` in mounted HTML as main-thread code (rwa-edit-spec.md §11); a display transform is HTML and CSS, not code. The runtime asserts their absence in first-party `render` output and fails loud.

**Activation and the lens.** `setView` mutates the render path and must not race the rewrite loop. It refuses while a modification holds the modify mutex (rwa-edit-spec.md §5.5), rejecting with status rather than queueing. On activation it releases any held lens anchor, returning the lens to its default docked state (rwa-lens-spec.md §5.2), so a stale anchor cannot resolve against the newly mounted DOM. The lens's anchored-edit path (rwa-lens-spec.md §5.5, which maps a click to a source range via the source-position map) is available only when no render mode is active; suspending the click listener alone is insufficient, because a stale anchor can re-enter that path against rearranged DOM.

**Trust and thread affinity.** A `view` needs the DOM, so `render`/`mounted` run on the main thread and cannot be Worker-isolated. Because the render path writes via `innerHTML` and re-executes any `<script>` it contains on the main thread with no Content Security Policy, a render mode is a path to arbitrary main-thread code — it can reach `runtime.db`, `runtime.fs`, and the `sessionStorage` API key. For first-party providers (bootstrap-resident, author-trusted) this is acceptable. A third-party provider supplying a `view` is therefore inherently un-sandboxable and a higher-trust category than a Worker-isolatable kind; this composes with the security model of §10, and the eventual install surface must disclose "can run arbitrary code on the page," not the softer "renders its own UI."

**Deferred.** This revision specifies only the `view` kind and only its first-party path. The `edit-surface` and `compute` kinds (direct human cell editing, reactive recompute), the installed/third-party provider path (the install surface, permission declaration, persistence), and the write-path ordering that non-agent writers need (flushing uncommitted edits before an agent modify acquires the mutex — not enforceable at the current `modify()` structure) are out of scope here and tracked in `docs/plans/2026-05-29-rwa-affordance-skill-kernel-design.md`.

### 5.11 Connected share

A container can be **connected to a stable share URL**. The chrome's ↗ panel offers three gestures, each one explicit and each mapping to exactly one HTTP request against a share service:

- **Create share link** — `POST /share` with the full current file bytes (the `buildFile` output — exactly the ⌘S artifact, §5.6). The service responds `{short, url, token}`: a stable short code, the public URL, and an **update token** returned exactly once.
- **Publish this version** — `POST /share/<short>` with fresh file bytes under `Authorization: Bearer <token>`. The URL is stable; its content becomes the new version.
- **Stop sharing** — `DELETE /share/<short>` under the same Bearer.

**The link shows a published version, not live edits.** This is the framing decision the affordance exists for (`docs/plans/2026-06-11-save-affordance-framings.md` §7c): the local file plus its working state stay canonical, and sharing is the explicit act of posting a version to a reference others can hold. The panel shows freshness — the SHA-256 of the document at last publish against the current document — as "the link shows this version" / "behind your latest edits." The gap between local state and the published version is visible and *expected*, unlike the invisible IDB-vs-file gap it replaces.

**The connection record is machine-local.** `{short, url, token, publishedHash, publishedAt}` lives in `rwa_state` under the key `share_conn` (a reserved store — Invariant 4). The token is a bearer capability: it must never appear in the chrome DOM, and it cannot reach the exported file because a commit only rewrites `INLINE_DOC` (Invariant 1). Moving the file to another machine moves the document, not the update capability.

**Every publish rotates `DOC_UUID`, server-side.** A receiver who once opened an earlier version of a share holds per-UUID IndexedDB state for it (§5.3); if a later version carried the same UUID, their stale local state would silently shadow the update on open (§5.7's isolation, inverted into a trap). Fresh-UUID-per-publish makes every fetched version a distinct container.

**Lifetime is durable-while-active.** A connected share lives until explicitly unshared, with a long-inactivity backstop (90 days without an update or a view in the reference service). An update attempt against a dead or revoked share clears the local record and surfaces "this link can no longer be updated" — the honest state is *not connected*, never a stale claim.

**Network posture.** Nothing fires at boot, on edit, or on ⌘S — that part holds unconditionally, and it is the property that matters. The stronger claim this sentence used to make, that the three share gestures are the *only* network the runtime performs outside the agent backends, is no longer true: the skill marketplace (`runtime.discoverSkills` / `runtime.fetchSkillFromIndex`, actions v0.9 I6) also reaches the network. Both are explicitly user-triggered, so a container still touches the network only when the user asks it to — but "only the share gestures" undercounts the surfaces. The service base defaults to the reference deployment and is overridable per-session (`sessionStorage` `rwa_share_base`) for dev or self-hosted services.

---

## 6. The Agent Contract

### 6.1 Modify

There is no separate "build" path. Every modification — including the first one — goes through the same loop: the agent receives the current document and returns a modified document.

The agent's mental model is **document, not application**. The opening of the system prompt frames it that way:

> You are modifying a document. The document may be prose, it may be a tracker, it may be a spreadsheet, it may be all three. Read what is there. Apply the user's instruction to the actual content — its tone if it is prose, its structure if it is data, its behavior if it is interactive.

A document-first prompt produces different default behavior than an app-first prompt: less reflexive interactivity, more attention to prose tone and visual structure when those are what the user is editing. A user editing a press release does not want the agent to add a button bar; a user editing a budget tracker does not want the agent to pad the rows with filler prose.

**Substantial content as input.** When the user pastes a long block — a structured outline, a markdown document, a list of items, a multi-section piece — they want that content rendered into the document, not summarized into a paraphrase. The system prompt is explicit about this: every paragraph, every section, every list item, every example is preserved. No condensing, no ellipsis, no omission for brevity. If the input has 100 items, the output has 100. This rule resolves the ambiguity in the word "instruction": with a small directive ("make it darker") the agent transforms the existing content; with a large paste, the agent treats the input as the new content of the document.

Concrete rules supplied to the agent:

- Return the complete modified document only — no commentary, no markdown fence
- Preserve substantial user-provided content verbatim — never abbreviate or summarize a paste
- Preserve `data-rwa-id` attributes verbatim (§5.9). The runtime assigns these to anchorable blocks; they are the stable name a URL fragment resolves to. Copy them through when editing the surrounding text of a block; never invent new values.
- All CSS inline; JS inline only when the document has interactivity. Prose documents may be JS-free.
- No React, no build steps, no npm
- Use `runtime.db.*` for structured data, `runtime.fs.*` for blobs
- Dark theme palette by default (§8); honor explicit visual instructions over the default
- The first character of the response should begin the modified content directly

**Output budget.** The runtime requests `max_tokens: 32000` from OpenRouter. This is a hard ceiling on the response size — chosen large enough to hold a typical 20–40 KB document fully rendered with markup, small enough that mainstream models accept it without complaint. If the model's native cap is lower, OpenRouter passes through whatever the provider supports.

The agent receives only the document as context. The bootstrap, loader, runtime, inline snapshot, and undo stack are not visible. There is no `<script id="re-write-able-runtime">` block to preserve, no diff protocol, no full-rewrite fallback — just the document in, the document out.

A diff protocol may return as an automatic optimization for large documents (§11.3). For the current architecture (documents in the 50–100 KB range), full-content responses are simple, robust, and cheap enough.

### 6.2 Model choice

`google/gemini-3.5-flash` via OpenRouter is the default (`RWA.MODEL` in the seed; `gemini-3-flash-preview` was the earlier default and now survives only as one suggestion in the settings datalist) — fast, cheap, and a context window that comfortably holds any reasonable single-file document plus instructions. For complex structural modifications, `anthropic/claude-sonnet-4` produces more reliable results at higher cost.

The model is configurable per file. The runtime passes the configured model to OpenRouter; users can swap providers (direct Anthropic, OpenAI, self-hosted) by replacing the agent invocation in the runtime's settings.

---

## 7. Runtime API

The document interacts with the runtime through a small surface exposed on the global `runtime` object.

```javascript
runtime.db = {                      // private — scoped to rwa_<DOC_UUID>
  get(store, key),
  put(store, key, value),
  del(store, key),
  all(store),                       // iterate
  open(store, { autoIncrement }),   // declare document store (rejects rwa_*)
  subscribe(store, callback),       // BroadcastChannel-backed
};

runtime.shared = {                  // opt-in — scoped to rwa_shared (§5.7)
  get(key),                         // key prefixed with <DOC_UUID>: by default
  put(key, value),
  del(key),
  list(prefix),
  subscribe(key, callback),
};

runtime.fs = {
  read(path),                       // returns Blob
  write(path, blob),
  del(path),
  list(prefix),                     // rejects _rwa/
};

runtime.id;                         // string — the container's DOC_UUID
runtime.describe();                 // self-description/1 — what this container is + can do (docs/specs/rwa-self-description-spec.md)
runtime.modify(instruction);        // ⌘K programmatic equivalent
runtime.commit();                   // ⌘S programmatic equivalent
runtime.undo();                     // ⌘Z programmatic equivalent

runtime.status = {                  // observable
  dirty: boolean,                   // unexported changes?
  fsa: 'granted' | 'prompt' | 'denied' | 'unsupported' | 'lost',
  storage: { usage, quota },
};

runtime.on('commit', cb);
runtime.on('modify', cb);
runtime.on('status', cb);
```

The document is free to use IndexedDB and OPFS directly without going through the runtime, but the API does the bookkeeping (cross-tab sync, status tracking, reserved-name protection).

A pure-prose document may not call this API at all. The runtime is still loaded — ⌘K, ⌘Z, ⌘S still work — but the document itself can be a single `<article>` and a stylesheet.

---

## 8. Design Rules for Documents

**Structure**

- Single self-contained document; CSS inline; JS inline only when the document has interactivity
- No React, no build steps, no npm
- Libraries from `cdnjs.cloudflare.com` only when the document genuinely needs them (a chart, a map, a code editor — not for static prose)
- Fonts from Google Fonts (DM Sans, DM Mono, Instrument Serif) — for true offline operation, the agent may inline them as base64

**Visual**

- Dark theme: `#0e0e0f` background, `#161618` surface, `#2d2d34` border
- Text: `#dddde4` primary, `#575766` muted
- Accent: `#b8ff57` (green), `#57c8ff` (blue), `#ff5757` (red)
- Fonts: DM Sans (UI), DM Mono (labels/code), Instrument Serif (display)

**Data**

- Structured data in IndexedDB via `runtime.db.*` (when the document has structured data)
- Binary blobs in OPFS via `runtime.fs.*` (when the document has blobs)
- Pure-prose documents need neither tier
- Never use store names starting with `rwa_` (reserved)
- Never write to `_rwa/` paths in OPFS (reserved)
- Seed data baked into the inline snapshot so the document is useful on first open

**Quality**

- Production-quality: polished, usable, complete
- For prose: well-typed, real representative copy — never lorem ipsum
- For data: real representative records — never lorem ipsum
- For interactive: keyboard shortcuts where appropriate
- No export/import hooks needed — the runtime serializes the full IDB and OPFS surface during commit and hydrates them on first open from the inline snapshot

---

## 9. Platform Behavior

| Platform | IndexedDB | OPFS | FSA write-in-place | Eviction risk |
|---|---|---|---|---|
| Chrome (desktop) | Up to ≈60% of free disk | Yes | Yes (with permission) | Low |
| Chrome (Android) | ≈6–10% of free disk | Yes | No | Medium |
| Firefox (desktop) | ≈2 GB per origin | Yes | No | Low |
| Safari (macOS) | ≈1 GB per origin | Yes | No | Low |
| Safari (iOS) | ≈50 MB | Yes | No | **High — actively evicts after inactivity or under storage pressure** |
| iOS PWA | Up to ≈1 GB | Yes | No | Medium |

### 9.1 The iOS Safari Problem

WebKit on iOS actively evicts site data — IndexedDB and OPFS — when the device is low on storage or after a period of inactivity. Private mode provides near-zero quota.

A user authors a tracker on their iPhone, doesn't open it for two weeks, and iOS may silently delete its working state.

**Mitigations:**

1. **The committed file is the only durable artifact.** The inline snapshot is always recoverable on open. The runtime's commit nudge is especially important on mobile.
2. **`navigator.storage.persist()`** is requested on boot. Chrome Android honors it. Safari ignores it.
3. **Private/incognito mode is unsupported.** The runtime detects it and shows a clear message: *"re-write-able requires normal browsing mode."*

### 9.2 Capability Rot — Self-Containment in Time

Self-containment holds in **space**: the bytes render, store, undo, export, and print in any browser, offline, with no server, no build step, and no network fetch of any kind. That property has no expiry date, and nothing in this spec may weaken it.

Self-containment does **not** hold in time for *modification*. `modify()` is deliberately not self-contained: a container recommends a model and never carries one (`docs/specs/rwa-intelligence-spec.md`), so the rewrite loop depends on something outside the file remaining reachable and remaining shaped the way it is today. Naming that plainly is the point of this section — it was an unstated assumption until 2026-08-26.

The position is:

1. **Rendering is the promise; modification is the feature.** A container whose backends have all disappeared is a document that still opens, still renders, still exports, and still prints. It stops being able to rewrite *itself*, and stays fully editable by hand and by any external tool. Degradation, not failure.
2. **The wire contract is the hedge, not any one vendor.** Four of the five backends speak the OpenAI-compatible `/v1/chat/completions` shape, two of those run entirely on the user's own machine (Ollama, LM Studio), and base URLs are user-overridable. Surviving the loss of any single provider — including all hosted ones — requires no change to a container that has already shipped.
3. **`rwa upgrade` is the migration path for everything else.** It re-bootstraps an existing container onto a current seed while preserving `DOC_UUID`, the document body verbatim, kind, title, provenance, and every signed record. A protocol change that a shipped container cannot absorb is absorbed by re-bootstrapping it, and refuses to write unless the preserved regions round-trip byte-for-byte.

What this rules out: a container that *requires* a specific vendor, a hosted endpoint baked into the file, or an API key stored in the artifact. All three are already forbidden elsewhere in this spec; this section records **why** those prohibitions are load-bearing rather than stylistic.

### 9.3 The Null Origin and Shared Quotas

Under `file://`, all re-writeable files share the same origin and therefore the same storage quota — even though their IndexedDB databases are now isolated by `DOC_UUID` (§5.7). Per-container isolation prevents state collisions, not quota collisions. Many open containers add up to one shared budget. The runtime monitors usage and warns before exhaustion. Eviction under pressure can drop a container's private database without warning, which is why the inline snapshot in the file on disk remains the only durable artifact (§5.6).

---

## 10. Security and Permissions

**API key**: stored in `sessionStorage` only. Survives reload, cleared on tab close. Never written to the file, never in IndexedDB, never leaves the browser except in the Authorization header.

**Self-modification**: rendering the document from IndexedDB is essentially `eval` at document scope. For a personal local tool this is the correct tradeoff — maximum capability, user-owned environment. For shared or hosted deployments, the risk surface is: anyone who can write to the user's IndexedDB can inject code. This is mitigated by the `file://` origin model (no cross-origin writes).

**The bootstrap is the anchor**: it is never in IndexedDB and never modified by the agent. If something goes wrong, reload the file — the inline snapshot is the last known good state, and the runtime can be reset by clearing IndexedDB.

### 10.1 FSA Permission Lifecycle

The runtime's contract for the File System Access API:

| State | Trigger | Behavior |
|---|---|---|
| `unsupported` | Browser is not Chromium | Commit always exports; ⌘S triggers a download |
| `prompt` | First commit on a new session | Browser prompts; on grant, persist handle to IDB |
| `granted` | Handle is persisted and verified | Commit-in-place; no further prompts unless revoked |
| `denied` | User denied or revoked | Fall back to download mode; surface "regrant write access" affordance |
| `lost` | Handle exists in IDB but is no longer valid (file moved/deleted) | Show "reattach to file" affordance |

Permission is verified on each commit; the runtime never assumes a prior grant is still valid.

### 10.2 Storage Exhaustion

Quota errors during write must not corrupt `rwa_doc`. The contract:

```
agent returns
  → runtime attempts write to rwa_doc
  → write fails (QuotaExceededError)
  → restore rwa_doc from rwa_undo[top]
  → show error
  → preserve rwa_undo and rwa_hist
```

If headroom is still needed, the runtime sheds the oldest undo entry first. `rwa_doc` is never lost.

### 10.3 Multi-Tab Concurrency

**Status: DETECTION BUILT (2026-08-26); COORDINATION NOT BUILT.** This section once described a `BroadcastChannel` soft lock in the present tense — other tabs detecting it and opening read-only with a "take over" affordance — and no such mechanism existed. v0.17 replaced that fiction with an honest "there is no detection and no warning". Half of that is now also out of date, in the better direction: the loss is no longer silent. The lock still does not exist.

**What actually happens today.** Two tabs of the same file share one `DOC_UUID` and therefore one IndexedDB. There is no *coordination* between them:

- Both read `rwa_doc` at boot and hold independent in-memory documents.
- Both write on commit — last write still wins.
- Undo stacks diverge: each tab pushes onto `rwa_undo` without seeing the other's frames, so ⌘Z in one tab can restore a state the other never had.
- Both may hold an FSA handle to the same file. Two ⌘S operations can interleave, and the later one overwrites the earlier.

**What is detected.** Every write to `rwa_doc` — an agent commit, a hosted commit, an undo, adopting the file version — broadcasts a content hash on a per-container channel keyed by `DOC_UUID`. A tab whose hash no longer matches raises a persistent bar naming what happened and offering reload. A tab that never received the message (frozen, throttled, or on a runtime without `BroadcastChannel`) re-checks against IndexedDB when it returns to the foreground, so the signal degrades to *noticed later* rather than to nothing. The comparison is on content, not events: an undo that restores exactly what the other tab is already showing stays quiet, because the two sides agree.

Delivery between two `file://` tabs was verified rather than assumed (2026-08-26) — `file://` pages are opaque origins, and the pre-existing `runtime.db` fan-out that already used `BroadcastChannel` and called itself cross-tab had never been checked across tabs.

**What is still not built.** Nothing serialises the two tabs. The runtime warns; it does not arbitrate, and it does not merge. The window between the warning and the overwrite belongs to the user.

**Practical guidance.** Editing the same container in two tabs is now visible rather than silent, but the second tab's commit still wins. On seeing the bar, reload — the losing tab's work remains recoverable only from its own undo stack until it is closed.

**If coordination is built.** `BroadcastChannel` is the wrong primitive for a *lock* on its own — it provides no atomicity and no leader election, so two tabs opening within milliseconds can both claim one and neither observe the other. That is precisely why it is used here for notification only. The Web Locks API (`navigator.locks.request`) is designed for the arbitration half and releases automatically when a tab dies. Whether Web Locks is available under `file://` requires verification rather than assumption — it is gated on secure-context rules that treat local files inconsistently across browsers.

---

## 11. Open Questions

The following are intentional open issues — load-bearing design decisions still being weighed. Each has a current direction but is not yet pinned.

### 11.1 Rendering Isolation

The runtime renders the document into the bootstrap page. Three options, each with cost.

- **innerHTML** — simplest. Document CSS and global JS can collide with the bootstrap's. The runtime must keep its own DOM and styles aggressively scoped.
- **iframe srcdoc** — full isolation. The runtime API must cross the frame boundary via `postMessage`, complicating synchronous calls and Promise ergonomics.
- **Shadow DOM for runtime UI, light DOM for the document** — runtime UI is isolated, the document gets a clean page. Doesn't fully isolate scripts.

Current direction: *innerHTML for the document, shadow DOM for runtime UI*.

### 11.2 First-Render Strategy

IndexedDB load is async. Three strategies for the gap between bootstrap parse and document render.

- **Blank** — render nothing until IDB resolves. Briefly empty page.
- **Splash** — render a runtime splash, swap on hydration.
- **Synchronous from inline snapshot, reconcile after** — fastest perceived render, but needs a reconciliation pass when IDB diverges from the snapshot (which it does between commits).

Current direction: *synchronous from inline snapshot*, with a reconciliation pass at boot.

**Built** (2026-08-04; `docs/plans/2026-08-04-boot-reconciliation-design.md`, pinned by `tests/boot-reconcile.mjs`). Note the earlier wording here — "reconciliation only when IDB content differs from the snapshot" — described a comparison that does not work, and the implementation deliberately does not do it. The runtime blesses every document with stable `data-rwa-id` attributes at boot and writes the result back, so `rwa_doc` legitimately differs from the snapshot on any container that has merely been *opened*; a content comparison would report divergence on every fresh open.

What is built instead: `rwa_state['doc_baseline'] = { baseHash, at }` records the hash of the file's body as of the last moment the runtime was in sync with it — hydration, or a successful commit. `baseHash` is sha-256 of `canonLF(body)`, the same definition the hosted runtime uses for `baseBodyHash` (§5.12). At boot the runtime compares a fresh hash of the inline snapshot against that baseline, and consults the existing `dirty_count` for unsaved work:

| baseline | snapshot changed | unsaved edits | Behaviour |
|---|---|---|---|
| absent | — | — | IndexedDB wins; a baseline is recorded for next open |
| present | no | — | IndexedDB wins |
| present | yes | no | the file is adopted |
| present | yes | yes | the user is asked; commit is blocked until resolved |

The guard sits on commit, not on boot: choosing destroys nothing (the file is on disk, IndexedDB holds its copy), so the container renders normally and only ⌘S is withheld until the conflict is resolved. Adopting the file pushes the superseded document onto `rwa_undo` first, so ⌘Z recovers it. A container with no baseline — every container created before this shipped — keeps the previous behaviour on its first open, because at that point neither side can be shown to be stale.

### 11.3 Diff Protocol Reintroduction

For documents over ~200 KB, full-content rewrites get slow and expensive. A SEARCH/REPLACE diff protocol (as in v0.4) reduces cost dramatically but adds failure modes (unmatched blocks, ordering issues). The protocol may return as an automatic upgrade: full-rewrite by default, diff for documents over a size threshold.

### 11.4 ⌘S Semantics

⌘S means "commit" regardless of destination — write-in-place when possible, download otherwise. An alternative is to split: ⌘S for commit, ⌘E for explicit export. The current direction is the unified key, with the runtime choosing destination silently.

### 11.5 The Shape of `runtime.shared.*`

Container isolation by UUID (§5.7) closes a sharp footgun — every container shadowing every other — but pays for it by retracting the cross-container bus that earlier drafts treated as a free composition mechanism. A deliberate composition surface (`runtime.shared.put/get/subscribe` against a single `rwa_shared` database) is the current direction, but several questions remain.

- **Naming.** `<source>:<topic>` is a convention, not a contract. Should the runtime enforce a namespace prefix (e.g. require keys to begin with the writing container's title or UUID)? Without enforcement, two containers can write the same key by accident and one will overwrite the other.
- **Conflict and freshness.** When two containers write the same key concurrently, the last write wins. Some compositions need richer semantics — append-only logs, counters, CRDTs. Where is the line between "shared kv store" and "shared toolkit"?
- **Schema and discovery.** A reader has no way to know which keys exist until a writer publishes one. A schema declaration step (the writer announces `{ key, shape, version }`) would let dashboards enumerate sources, but adds upfront ceremony.
- **OPFS isolation** is closed as of spec v0.10: `runtime.fs.*` namespaces paths under `_<DOC_UUID>/` automatically. (Direct OPFS access bypassing the runtime API is still shared — the API is the isolation boundary. The bootstrap shape is unchanged from 0.9; only the runtime API surface is added.)
- **Same-host sharing.** Over HTTP, `rwa_shared` is per-origin and works for documents on the same host. Two re-writeables hosted on different domains cannot compose. Whether to bridge them (postMessage between iframes? a small relay?) is a separate question from the local-disk case and may not be worth solving until someone needs it.

Current direction: ship `runtime.shared.put/get/subscribe` as a thin layer over `rwa_shared`, prefix keys with `<DOC_UUID>:` by default to prevent accidental collisions, and let documents opt out of the prefix when they want to publish under a stable name.

---

## 12. Citizen Development Model

re-write-able is designed for the person who:

- Has ideas for documents and tools but cannot (or does not want to) write code
- Is suspicious of cloud platforms and wants to own their files
- Understands HTML at a surface level — enough to know it's "just a file"
- Would share a spreadsheet but not deploy an app

The mental model is: *it's like a Word document, but the document can rewrite itself.*

The deployment model is: *drag it to your desktop. Done.*

The collaboration model is: *send the file. They have everything.*

---

## 13. Webinar Demo Flow

### Narrative arc: "The file that builds itself"

**Act 1 — The container** (2 min)

- Open `tracker.html` in Chrome — the document is just there, no build screen, no agent call, no waiting
- Open `letter.html` next to it — same architecture, different content type. A pure-prose document; no JS in the document at all
- Show the bootstrap in the source: loader, runtime, `INLINE_DOC` constant
- Talk about the bootstrap as the immutable shell, the document as the artifact

**Act 2 — Self-modification** (5 min)

- On the tracker: hit ⌘K, type `add a priority field — high, medium, low`
  - The agent receives only the document (not the runtime), returns a modified document
  - Watch the document reload with the new field
- On the letter: hit ⌘K, type `tighten the second paragraph and pull the bullet list into a callout`
  - Same loop — different content type, identical mechanics, prose-aware response
- Back on the tracker: `turn the status columns into a kanban board`

**Act 3 — Undo** (1 min)

- Hit ⌘Z — the kanban returns to a list
- Hit ⌘Z again — the priority field disappears
- The file has memory

**Act 4 — Commit** (2 min)

- Hit ⌘S — on Chromium, the file rewrites itself in place; elsewhere, a new download
- Show the diff in the file: only the `INLINE_DOC` constant changed
- The bootstrap is byte-identical from one open to the next
- This file can be emailed. It requires nothing.

**Act 5 — The bus** (2 min)

- Open a dashboard alongside the tracker and the letter
- Show IndexedDB in DevTools — each document has its own `rwa_<DOC_UUID>` database; the tracker and the letter publish to a shared `rwa_shared` database via `runtime.shared.put`
- The dashboard reads from `rwa_shared` and renders a unified view across both
- The web was supposed to be read/write. This is read/write.

---

## 14. What This Is Not

- **Not a no-code platform** — there is no platform. The file is the platform.
- **Not a cloud app** — nothing is on a server. IndexedDB is the database.
- **Not just for apps** — a re-writeable file can be a press release, a tax return, a wedding invitation, a budget. Interactivity is a property a document may have, not a definition of one.
- **Not an AI coding assistant** — the agent doesn't help you write code. It edits the document.
- **Not a CMS** — there is no content management layer. The document is the content.
- **Not a framework** — there is nothing to install, nothing to configure, nothing to update.

It is a file that writes itself.

---

## 15. Prior Art and Influences

**Clive** (ikangai/clive) — the direct intellectual ancestor. Clive gives an LLM a terminal to inhabit; re-write-able gives it a browser tab. The self-modification pipeline (proposer → reviewer → gate → apply) maps to: agent call → runtime → IndexedDB → render. The bootstrap plays the role of `gate.py`: the immutable thing the agent cannot touch.

**Simon Willison's HTML tools** — 150+ single-file HTML applications demonstrating that the format is serious, durable, and production-worthy. re-write-able extends the model: the documents can now author and modify themselves.

**The read/write web** (Berners-Lee, 1999) — the browser was meant to be an editor. WikiWiki, early blogging, Geocities — the web was briefly writable. re-write-able is a local, offline, agent-powered version of that original vision.

**HyperCard** (Atkinson, 1987) — a stack was a program you could read and modify. Every HyperCard user was implicitly a developer. re-write-able is HyperCard for the agent era: the card modifies itself.

**TiddlyWiki** (Buckingham Shuttleworth, 2004) — the closest prior art by construction, and the one this spec omitted longest. A single self-contained HTML file that renders its own content, is edited in the browser, saves itself back to disk, and is passed around as a file. That is this format's entire physical description, twenty years earlier. Three things it solved that are live problems here rather than settled ones:

- **The static-linking cost.** Every container carries its own runtime, so a fix after a file ships never reaches it (§Invariants 1, 2a). TiddlyWiki's answer is an upgrade wizard that re-bootstraps an existing wiki onto a newer core, preserving content — the exact shape of the unbuilt `rwa upgrade`. It is also twenty years of evidence about how well that answer works in practice, which is worth more than a fresh design.
- **Saving as a pluggable concern.** Its "savers" abstraction survived the whole arc of browser history — `file://` restrictions, plugin deprecations, the arrival of the File System Access API — by never assuming one mechanism. This runtime's FSA-or-download split is the same problem answered once.
- **Plugin trust and distribution.** A plugin ecosystem inside a single-file format, with the install-time review problem that the skill and intelligence layers meet again here.

The genuine novelty is narrower than "a self-modifying file", and clearer for the comparison: **a document that rewrites itself in response to a sentence of English.** TiddlyWiki users author changes; here the model authors them, under a validating apply pipeline the document cannot bypass. Naming the ancestor sharpens the claim rather than diluting it.

**Word, Excel, PowerPoint** (1980s–) — the office suite proved that a document is something you own, on disk, that you can send. Then the documents moved to the cloud. re-write-able returns the document to a file.

---

## Invariants

These properties are load-bearing — every change to the runtime, bootstrap, or storage model should preserve them.

1. The bootstrap is byte-identical across every open until commit, and a commit only rewrites the `INLINE_DOC` constant — the loader, runtime, and `DOC_UUID` bytes do not change.
2. Each container has a `DOC_UUID` baked into its bootstrap at creation time. The container's IndexedDB database is `rwa_<DOC_UUID>`. Two containers opened from the same origin do not share a private database.
2a. Each container records the bootstrap it was born from, in two `<meta>` tags that ride the immutable region and therefore never change for that container. `rwa-bootstrap` is the **semantic compatibility generation** — bumped rarely and deliberately, meaning the container contract changed. `rwa-seed` is the **derived identity**: the first 12 hex of a sha-256 over the seed bytes the container was emitted from, stamped at emission. The two answer different questions. A version alone cannot identify a runtime: `rwa-bootstrap` sat at `0.9` across 163 seed commits spanning images, skinning, the skill layer, drop-in AI and boot reconciliation, so every container in that window claims the same version. `rwa-seed` is what an upgrade path reads to know exactly which bootstrap a file carries.
3. The runtime is always loaded from the bootstrap, never from IndexedDB. The agent has no access to it.
4. Reserved IndexedDB stores (`rwa_*`) within `rwa_<DOC_UUID>`, the shared composition database (`rwa_shared`), and OPFS paths (`_rwa/`) are written only by the runtime.
5. Every committed file is self-contained — opens and runs without external dependencies.
6. The inline snapshot is the source of truth on first open. After hydration, IndexedDB is the source of truth **for as long as the file's inline snapshot is unchanged**. If the snapshot changes underneath a container — an external edit, a version-control checkout, a restored backup — the runtime detects the divergence at the next open and never silently discards either copy: it adopts the file when there is no unsaved local work, and otherwise defers to the user before the next commit (§11.2).
7. Undo history lives in IndexedDB, not in the file. Commits do not carry undo state.
8. A render mode's output (§5.10) is display-only: it is written to `#rwa-doc-mount` and never read back into `rwa_doc`, never committed, never persisted. The stored document remains the source of truth.
9. The document the agent receives is derived from the stored document text, never from a render mode's mounted output. Render modes are invisible to the agent.

---

*Spec version 0.18 — the perception pass (epic #29, from the 2026-08-26 core-assumption audit). Three sections change, none of them a wire-format change. **§9.2 (new) names capability rot**: self-containment holds in space — the bytes render, store, export and print in any browser, offline, forever — but NOT in time for modification, because `modify()` deliberately depends on a model the container recommends and never carries. The position is recorded rather than left as an unstated assumption: rendering is the promise and modification is the feature (a container with no reachable backend degrades to a document that still opens and is still editable by hand); the OpenAI-compatible wire shape plus two local backends is the hedge, not any one vendor; and `rwa upgrade` is the migration path for anything a shipped container cannot absorb. The old §9.2 becomes §9.3. **§10.3 is corrected again, in the better direction**: v0.17 replaced a fiction ("a BroadcastChannel soft lock exists") with an honest "there is no detection and no warning", and detection now exists. Every write to `rwa_doc` broadcasts a content hash on a per-container channel; a stale tab raises a persistent bar and, if it never received the message, re-checks against IndexedDB on foreground. Delivery between two `file://` tabs was verified, not assumed — `file://` pages are opaque origins, and the pre-existing `runtime.db` fan-out that already used BroadcastChannel and called itself cross-tab had never been checked across tabs. Coordination is still NOT built: the runtime warns, it does not arbitrate or merge, and v0.17's guidance that Web Locks (not BroadcastChannel alone) is the right primitive for the arbitration half stands unchanged — which is exactly why BroadcastChannel is used here for notification only. Also shipped in this pass, without spec-surface change: a post-render layout probe (deterministic, advisory, silent where there is no layout engine), a document size meter against the edit budget measured on the virtualized form, complete failure-hint coverage for the retry loop, `<meta name="rwa-origin">` provenance for network-fetched content, and `rwa doctor`. Verified: root 57 files / 1690 assertions, CLI 613, service 108/108, conformance 86/86, browser lane 14/14 + print lane 21/21.*

*Spec version 0.17 — §10.3 corrected; no behaviour change. The section described a `BroadcastChannel` soft lock in the present tense — other tabs detecting it and opening read-only with a "take over" affordance — and no such mechanism has ever existed in the runtime (`navigator.locks` and any lock channel are absent from the seed; the only `BroadcastChannel` uses are `runtime.db` pub/sub and `runtime.bus`). A design intent had been written as shipped behaviour. §10.3 now states what actually happens (shared `DOC_UUID` means one IndexedDB, last write wins, undo stacks diverge, two FSA saves can interleave and silently overwrite), why the §11.2 boot reconciliation does not cover it (it compares the file against IndexedDB at open time and cannot see a second tab), practical guidance (do not edit the same container in two tabs — there is no detection and no warning), and what to reach for if it is ever built (Web Locks, not `BroadcastChannel` alone, which offers neither atomicity nor leader election — subject to verifying secure-context availability under `file://`). Every other multi-tab statement in the repository was already honest, including `rwa-edit-spec.md` §"single-tab concurrency" and the user-facing `service/public/build-skill.md`; the canonical spec was the sole outlier. Filed and closed as [#6](https://github.com/ikangai/rewritable/issues/6); the class of defect is tracked by [#7](https://github.com/ikangai/rewritable/issues/7).*

*Spec version 0.16 — boot reconciliation. **Invariant 6 narrows.** It previously read "after hydration, IndexedDB is the source of truth until the next commit", and the runtime implemented that faithfully: `getDoc()` consulted the inline snapshot only when the IndexedDB record was literally absent, so a container silently discarded its own file's content whenever that file changed underneath it — a `git pull`, a version-control checkout, an external editor, a restored backup. IndexedDB now wins only while the snapshot is unchanged. §11.2 specifies the mechanism: a `doc_baseline` record in `rwa_state` holding sha-256 of `canonLF(body)` — the same definition the hosted runtime uses for `baseBodyHash`, deliberately one divergence vocabulary rather than two — written at the two moments the runtime is known to be in sync with the file (hydration, and a successful commit), and compared against a fresh hash of the snapshot at every boot. Divergence is classified against the existing `dirty_count`, never against `rwa_doc`: the runtime blesses every document with `data-rwa-id` at boot and writes the result back, so a content comparison would report divergence on every fresh open. The guard sits on **commit, not boot** — choosing destroys nothing, since the file is on disk and IndexedDB holds its copy, so the container renders normally and only ⌘S is withheld until the conflict is resolved. Adopting the file pushes the superseded document onto `rwa_undo` first (⌘Z recovers it) and clears `dirty_count`; keeping local edits advances the baseline only. Containers created before this ship carry no baseline and keep the previous behaviour on their first open, because at that point neither side can be shown to be stale. Degrades to previous behaviour if `crypto.subtle` is unavailable, and stays inert under the hosted shim's `__rwaSuppressBlockIds`. Verified: `tests/boot-reconcile.mjs` 43/0, `tests/hosted-bless-parity.mjs` 7/0, full seed suite 45 files / 1440 assertions, conformance 86/86. References regenerated. Design: `docs/plans/2026-08-04-boot-reconciliation-design.md`. Closes [#1](https://github.com/ikangai/rewritable/issues/1).*

*Spec version 0.15 — connected share. §5.11 (new) specifies the ↗ chrome affordance: a container connects to a stable share URL by POSTing its full file bytes to a share service (`POST /share` → `{short, url, token}`), re-publishes versions to the same URL under the Bearer update token, and unshares with DELETE. The connection record (`share_conn`, with the token) lives in `rwa_state` — machine-local by construction: Invariant 1 keeps it out of the exported file, Invariant 4 keeps it runtime-only. The link shows a published **version**, not live edits (the local-first framing, `docs/plans/2026-06-11-save-affordance-framings.md` §7c); the panel surfaces freshness via the published-hash. Every publish rotates `DOC_UUID` server-side so a receiver's stale per-UUID IDB can never shadow an update (§5.7). Shares are durable while active (90-day inactivity backstop). These gestures are the only non-agent network the runtime performs — nothing fires at boot or on ⌘S, so offline-first holds. Service: the `/share` route family beside `POST /publish` (unchanged) in `service/server.js`. Verified: `tests/share.mjs` 36/0, `service/tests/share.test.mjs` 8/0, full seed suite + conformance green. References regenerated.*

*Spec version 0.14 — self-description. §7 gains `runtime.describe()`, the live projection of the `self-description/1` contract (`docs/specs/rwa-self-description-spec.md`): the answer to "what is this container, and what can be done with it?" — `kind`, the registered affordance providers (from the live `view`/§5.10 registry, zero-drift), author-declared `frozenZones`, `title`, addressable-block count, and a `baseline` of substrate-universal ops. The static counterpart is `rwa doc --json` (computed from the file bytes by `tools/self-description.mjs`, the shared referee oracle); the two projections agree on every shared field by construction (`source:'live'` vs `'static'`). Honest by construction: it reports only affordances actually present (a base `document` is `[]`; `history` is undo-only — there is no redo, Invariant 7). The change is **additive** — a new query method plus a chrome "ⓘ what is this?" disclosure; no commit-stamp (that would break Invariant 1, so the description is computed live, never written into the file), no `modify`/`commit`/`buildFile` change, bootstrap byte-unchanged (meta tag stays `rwa-bootstrap` 0.9). Verified: `tests/identity.mjs` 42/0 (validates `describe()` against the oracle + live⇔static cross-projection + SD-06 no-leakage), full seed suite + conformance 79/79 green.*

*Spec version 0.13 — render-mode implemented. The §5.10 contract from 0.12 is now live in the seed: `runtime.provide('view', spec)` / `runtime.setView(name|null)`, the C2 render seam in `renderDoc` (output mount-only; `setSourceMap` stays on the stored text — Invariants 8–9 hold), the `setView` guards (modify-mutex refusal, `releaseAnchor` on activate, anchored-modify gated on no active view), and the first-party `presentation` provider (wrap-in-place `<section class="rwa-slide">` on `h1`/`h2`, `mounted` slide restore, `reveal` fragment hook, nav chrome, present/print CSS). §5.10 gains the optional `reveal(m, el)` slot. `rwa new --kind presentation` emits a prose deck. The change is inert for `document`/`workflow` containers (the view subsystem is gated on `PRODUCT_KIND === 'presentation'`; the default render path is byte-identical). Verified: conformance 77/77 (incl. VIEW-01..05), e2e 291, lens 246, view 17. References regenerated against the new seed. `edit-surface` / `compute` / installed third-party path / non-agent write-path ordering remain deferred.*

*Spec version 0.12 — render-mode / view-provider contract. §5.10 (new) specifies render modes: a document can be displayed differently from how it is stored via a `view` provider registered on `runtime.provide` / `runtime.setView`, with a pure `render(doc) → html` slot, an optional `mounted` hook, and a contract that keeps the stored text the source of truth and the agent's view of it untouched (Invariants 8–9, new). This revision is **contract-only**: the bootstrap is byte-unchanged, no `view` ships in the seed, and references are not regenerated. The first render mode (`presentation`) and the `runtime.provide` / `setView` surface implement this contract in a follow-on revision. The contract was grounded in a standalone prototype, not yet in the runtime; the `edit-surface` / `compute` kinds, the installed third-party path, and the non-agent write-path ordering remain deferred (`docs/plans/2026-05-29-rwa-affordance-skill-kernel-design.md`).*

*Spec version 0.11 — anchorable-tags extended. `table` and `td` join the anchorable list so the workflow product's parallel blocks and cells (per `docs/specs/rwa-workflow-spec.md`) get `data-rwa-id` backfilled automatically. The change is purely additive — existing containers gain ids on their tables on the next commit; no behavior changes for documents that don't use tables. Reference implementations regenerated.*

*Spec version 0.10 — public runtime API pass. §7 grows from a sketch into a contract: `runtime.id`, `runtime.db.{get,put,del,all,open,subscribe}`, `runtime.fs.{read,write,del,list}`, `runtime.modify/commit/undo`, the observable `runtime.status`, and `runtime.on('commit'|'modify'|'status', cb)` are all wired through the seed and exercised by the test harness. The bootstrap shape is unchanged from 0.9 — the runtime API is additive — so the meta tag remains `rwa-bootstrap` 0.9 while the spec versions to 0.10. OPFS gains per-container namespacing: each container's blobs live under `_<DOC_UUID>/`, `runtime.fs.*` auto-prefixes paths, and §5.7's "OPFS is not yet namespaced" gap is closed (§5.3, §5.7, §11.5 updated). `runtime.shared.*` remains the one piece of §7 deferred — the open questions in §11.5 (naming, conflict resolution, schema/discovery, cross-host bridging) are unchanged and still gate that surface. No changes to the storage model invariants, container UUIDs, or bootstrap byte-identity rules from v0.7/v0.8/v0.9. Reference implementations regenerated against the seed.*

*Spec version 0.9 — web-citizen pass. §5.3 reserves `data-rwa-id` as a runtime-managed HTML attribute; §5.9 (new) describes its lifecycle and the URL-fragment scroll behavior the bootstrap now ships. The runtime backfills `data-rwa-id` on every anchorable block (`p`, `h1`–`h6`, `blockquote`, `li`, `figure`, `pre`, `aside`) at bootstrap and at every commit, skipping frozen zones. §6.1 (and the seed's `SYSTEM_PROMPT`) instructs the agent to preserve these values verbatim and never invent new ones. The container's identity on the web is now a URL plus a stable fragment; a link like `notes.html#7k3p2m9q` continues to resolve to the same block after the surrounding text gets rewritten any number of times. No changes to the storage model, container UUIDs, or bootstrap invariants from v0.7/v0.8. Reference implementations regenerated against the bootstrap-0.9 seed.*

*Spec version 0.8 — agent-fidelity pass. §6.1 grows two new pieces. First, an explicit "substantial content as input" rule: when the user pastes a multi-section document or a long list as their ⌘K instruction, the agent must render it as the new content rather than summarize it. The previous wording — "apply the user's instruction to the actual content" — was ambiguous, and Flash-tier models reliably read it as a cue to compress. The new rule pins the behavior: 100 items in, 100 items out. Second, an "output budget" subsection documents the runtime's `max_tokens: 32000` request, large enough to hold a typical 20–40 KB document without truncation. Reference implementations (`hello.html`, `re-write-able-spec.html`, `seeds/rewritable.html`) match. No structural changes; the storage model, container UUIDs, and bootstrap invariants from v0.7 are unchanged.*

*Spec version 0.7 — container isolation pass. Every container now carries a `DOC_UUID` baked into the bootstrap at creation time, and its private IndexedDB lives under `rwa_<DOC_UUID>` instead of the shared `rwa` namespace. This closes a sharp footgun in v0.6: every container opened from `file://` was looking at the same `rwa_doc` and shadowing whichever container last committed. §5.2 grows a fourth bootstrap responsibility (Identity); §5.3 namespaces the IDB row in the storage table; §5.7 is rewritten — the "null origin bus" that v0.6 sold as a feature is replaced by isolation by default plus an opt-in `runtime.shared.*` API against a shared `rwa_shared` database; §9.2 clarifies that containers share quota even when they no longer share state; §11 adds a new open question (§11.5) about the precise shape of the shared composition surface; Invariants gain a per-container UUID rule. Reference implementations (`hello.html`, `re-write-able-spec.html`) ship with fresh UUIDs.*
