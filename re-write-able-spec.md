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

**OPFS is not yet namespaced.** Containers that write to `_rwa/` paths still share the null-origin OPFS namespace; collisions are possible. This is a known gap (§11.5).

Served over HTTP/HTTPS, each file gets a real origin and `rwa_shared` becomes per-host. The composition surface is a local-disk feature; hosting a re-writeable file behind a URL converts it from a composable artifact into a single-document island.

### 5.8 Embedding and Composition

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

---

## 6. The Agent Contract

### 6.1 Modify

There is no separate "build" path. Every modification — including the first one — goes through the same loop: the agent receives the current document and returns a modified document.

The agent's mental model is **document, not application**. The opening of the system prompt frames it that way:

> You are modifying a document. The document may be prose, it may be a tracker, it may be a spreadsheet, it may be all three. Read what is there. Apply the user's instruction to the actual content — its tone if it is prose, its structure if it is data, its behavior if it is interactive.

A document-first prompt produces different default behavior than an app-first prompt: less reflexive interactivity, more attention to prose tone and visual structure when those are what the user is editing. A user editing a press release does not want the agent to add a button bar; a user editing a budget tracker does not want the agent to pad the rows with filler prose.

Concrete rules supplied to the agent:

- Return the complete modified document only — no commentary, no markdown fence
- All CSS inline; JS inline only when the document has interactivity. Prose documents may be JS-free.
- No React, no build steps, no npm
- Use `runtime.db.*` for structured data, `runtime.fs.*` for blobs
- Dark theme palette by default (§8); honor explicit visual instructions over the default
- The first character of the response should begin the modified content directly

The agent receives only the document as context. The bootstrap, loader, runtime, inline snapshot, and undo stack are not visible. There is no `<script id="re-write-able-runtime">` block to preserve, no diff protocol, no full-rewrite fallback — just the document in, the document out.

A diff protocol may return as an automatic optimization for large documents (§11.3). For the current architecture (documents in the 50–100 KB range), full-content responses are simple, robust, and cheap enough.

### 6.2 Model choice

`google/gemini-3-flash-preview` via OpenRouter is the default — fast, cheap, and a context window that comfortably holds any reasonable single-file document plus instructions. For complex structural modifications, `anthropic/claude-sonnet-4` produces more reliable results at higher cost.

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

### 9.2 The Null Origin and Shared Quotas

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

Two tabs of the same file both writing to IndexedDB: last write wins, undo stacks diverge. Two tabs trying to commit via FSA: file corruption is possible.

The runtime acquires a soft lock via `BroadcastChannel` on first modification or commit. Other tabs detect the lock and open in read-only mode with a "take over" affordance. This is a coordination signal, not a hard mutex — the user can override.

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

Current direction: *synchronous from inline snapshot*, with reconciliation only when IDB content differs from the snapshot.

### 11.3 Diff Protocol Reintroduction

For documents over ~200 KB, full-content rewrites get slow and expensive. A SEARCH/REPLACE diff protocol (as in v0.4) reduces cost dramatically but adds failure modes (unmatched blocks, ordering issues). The protocol may return as an automatic upgrade: full-rewrite by default, diff for documents over a size threshold.

### 11.4 ⌘S Semantics

⌘S means "commit" regardless of destination — write-in-place when possible, download otherwise. An alternative is to split: ⌘S for commit, ⌘E for explicit export. The current direction is the unified key, with the runtime choosing destination silently.

### 11.5 The Shape of `runtime.shared.*`

Container isolation by UUID (§5.7) closes a sharp footgun — every container shadowing every other — but pays for it by retracting the cross-container bus that earlier drafts treated as a free composition mechanism. A deliberate composition surface (`runtime.shared.put/get/subscribe` against a single `rwa_shared` database) is the current direction, but several questions remain.

- **Naming.** `<source>:<topic>` is a convention, not a contract. Should the runtime enforce a namespace prefix (e.g. require keys to begin with the writing container's title or UUID)? Without enforcement, two containers can write the same key by accident and one will overwrite the other.
- **Conflict and freshness.** When two containers write the same key concurrently, the last write wins. Some compositions need richer semantics — append-only logs, counters, CRDTs. Where is the line between "shared kv store" and "shared toolkit"?
- **Schema and discovery.** A reader has no way to know which keys exist until a writer publishes one. A schema declaration step (the writer announces `{ key, shape, version }`) would let dashboards enumerate sources, but adds upfront ceremony.
- **OPFS isolation.** Containers still share the null-origin OPFS namespace under `_rwa/`. Should OPFS be namespaced by `DOC_UUID` like IDB, with a parallel `_rwa_shared/` for opt-in sharing? The same logic that motivated IDB isolation applies, but no production document writes binary blobs yet, so the cost of the gap is currently zero.
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

**Word, Excel, PowerPoint** (1980s–) — the office suite proved that a document is something you own, on disk, that you can send. Then the documents moved to the cloud. re-write-able returns the document to a file.

---

## Invariants

These properties are load-bearing — every change to the runtime, bootstrap, or storage model should preserve them.

1. The bootstrap is byte-identical across every open until commit, and a commit only rewrites the `INLINE_DOC` constant — the loader, runtime, and `DOC_UUID` bytes do not change.
2. Each container has a `DOC_UUID` baked into its bootstrap at creation time. The container's IndexedDB database is `rwa_<DOC_UUID>`. Two containers opened from the same origin do not share a private database.
3. The runtime is always loaded from the bootstrap, never from IndexedDB. The agent has no access to it.
4. Reserved IndexedDB stores (`rwa_*`) within `rwa_<DOC_UUID>`, the shared composition database (`rwa_shared`), and OPFS paths (`_rwa/`) are written only by the runtime.
5. Every committed file is self-contained — opens and runs without external dependencies.
6. The inline snapshot is the source of truth on first open. After hydration, IndexedDB is the source of truth until the next commit.
7. Undo history lives in IndexedDB, not in the file. Commits do not carry undo state.

---

*Spec version 0.7 — container isolation pass. Every container now carries a `DOC_UUID` baked into the bootstrap at creation time, and its private IndexedDB lives under `rwa_<DOC_UUID>` instead of the shared `rwa` namespace. This closes a sharp footgun in v0.6: every container opened from `file://` was looking at the same `rwa_doc` and shadowing whichever container last committed. §5.2 grows a fourth bootstrap responsibility (Identity); §5.3 namespaces the IDB row in the storage table; §5.7 is rewritten — the "null origin bus" that v0.6 sold as a feature is replaced by isolation by default plus an opt-in `runtime.shared.*` API against a shared `rwa_shared` database; §9.2 clarifies that containers share quota even when they no longer share state; §11 adds a new open question (§11.5) about the precise shape of the shared composition surface; Invariants gain a per-container UUID rule. Reference implementations (`hello.html`, `re-write-able-spec.html`) ship with fresh UUIDs.*
