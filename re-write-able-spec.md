# re-write-able

*A specification for self-modifying HTML applications*

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

The tools that do let you modify things — code editors, CLIs, build pipelines — require you to already be a developer. Citizen development tools (no-code, low-code) give you drag-and-drop but hide the source and lock you to a platform.

There is no middle ground: a tool that is fully sourceful, fully ownable, fully modifiable, but requires no environment, no install, no server, no account.

A re-writeable file is that middle ground.

---

## 3. The Concept

A re-writeable file is a single `.html` file that:

1. **Renders itself** — open it in any browser, it runs
2. **Stores itself** — its live state lives in `localStorage`, not on a server
3. **Modifies itself** — an embedded agent rewrites the file's own source code on instruction
4. **Exports itself** — the current state can be saved as a new `.html` file at any time
5. **Requires nothing** — no server, no install, no build step, no account

The file is simultaneously a document, a tool, an application, and its own source code.

---

## 4. The Read/Write Web

Tim Berners-Lee's original vision was a read/write web. The browser was meant to be an editor. The web became predominantly read-only — a distribution medium, not a creation medium.

`re-write-able` is a correction at the file level:

| Web as it is | re-write-able |
|---|---|
| You consume apps | You own the source |
| Apps live on servers | The file is the server |
| Changing requires a developer | Changing requires a sentence |
| Deployment is a process | Deployment is sharing a file |
| Open source is a repository | Open source is the file itself |

---

## 5. Architecture

### 5.1 The Seed File

The seed file is the immutable bootstrap. It never changes. It is the equivalent of `gate.py` in a governed self-modification system — the one thing the agent cannot touch.

```
docuapp.html  (seed — you distribute this)
     │
     │  on first open: generate app, inject runtime, store in localStorage
     │  on subsequent opens: load from localStorage → document.write
     ▼
localStorage['docuapp_src']  (live app — the agent rewrites this)
```

The seed file contains:
- A build screen (OpenRouter key + model + description)
- The agent call to generate the initial app
- The `injectRuntime()` function
- A loader: `document.open(); document.write(src); document.close()`

It does not contain the app. It does not get rewritten.

### 5.2 The Runtime Block

Every re-writeable app contains a single `<script id="re-write-able-runtime">` block. This is the self-modification engine. It is injected by the seed after the initial build and preserved verbatim through all subsequent rewrites.

The runtime provides:
- `⌘K` — command palette for modification instructions
- `⌘Z` — undo (pop from undo stack, up to 10 levels)
- `⌘S` — export current state as a standalone `.html` file
- Prompt history (last 15 instructions, stored in `localStorage['da_hist']`)
- Storage health indicator (warns when quota usage exceeds 80%)
- Export nudge (prompts to export after 5 unexported modifications)

The agent system prompt includes: *"Preserve the `<script id="re-write-able-runtime">` block exactly as-is. Never remove or alter it."*

### 5.3 Storage Architecture

The runtime separates storage into two tiers:

#### Runtime tier (localStorage — sync, simple, ≤2 MB)

The runtime's own state lives in localStorage. This is small, synchronous, and works identically across all browsers.

```
localStorage
├── docuapp_src       — current app HTML source (the live running code)
├── docuapp_undo      — undo stack (JSON array, up to 10 previous versions)
├── da_hist           — prompt history (JSON array, last 15)
└── da_storage_warned — flag: storage warning already shown this session
```

A typical app source is 50–100 KB. Ten undo levels cost ~1 MB. The full runtime tier fits comfortably within the ≈5 MB localStorage limit on every browser, including mobile Safari.

#### App data tier (IndexedDB — async, large, ≤50 MB+)

App-generated data — rows, records, images, documents — belongs in IndexedDB, not localStorage. IndexedDB provides hundreds of MB on desktop and ≈50–100 MB per origin on mobile, with async access that won't block the UI.

| What | Where | Why |
|---|---|---|
| App source + undo stack | localStorage | Small, sync reads needed for instant boot |
| Prompt history | localStorage | Tiny, sync |
| App data (rows, records) | IndexedDB | Can grow large, async is fine |
| Binary/media data | IndexedDB | localStorage can't handle blobs efficiently |
| API key | sessionStorage | Cleared on tab close, never persisted |

The build prompt guides the agent to use IndexedDB for app data by default. For trivially small apps (a few KB of settings), localStorage is acceptable — but the agent should prefer IndexedDB for anything that could grow.

**Key namespace rules:**
- `docuapp_src`, `docuapp_undo`, and `da_*` keys in localStorage are reserved by the runtime
- App data in IndexedDB should use a descriptive database name (e.g. `tracker_db`, `recipes_db`)
- Under `file://`, all re-writeable files share the null origin — both localStorage keys and IndexedDB databases are visible to all files

#### Quota awareness

The runtime checks available storage on boot and after each rewrite:

```javascript
if (navigator.storage && navigator.storage.estimate) {
  const { usage, quota } = await navigator.storage.estimate();
  if (usage / quota > 0.8) showStorageWarning();
}
```

On browsers that support it, the runtime requests persistent storage to reduce eviction risk:

```javascript
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist();
}
```

This helps on Chrome (desktop and Android). Safari ignores the request — see §9 for platform-specific behavior.

### 5.4 The Rewrite Loop

```
User: ⌘K → "add a priority column to the tracker"
          │
          ▼
Runtime captures: document.documentElement.outerHTML
          │        (the entire running app, including runtime block)
          ▼
Agent call: system = "modify HTML app, preserve runtime block"
            user   = current outerHTML + "\n\nInstruction: " + prompt
          │
          ▼
Agent returns: complete modified HTML
          │
          ▼
Runtime:  undoStack = JSON.parse(localStorage['docuapp_undo'] || '[]')
          undoStack.push(currentSrc)
          if (undoStack.length > 10) undoStack.shift()   // cap at 10
          localStorage['docuapp_undo'] = JSON.stringify(undoStack)
          localStorage['docuapp_src']  = newSrc
          document.open(); document.write(newSrc); document.close();
          │
          ▼
Browser: re-renders the new app
         the app has modified itself
```

`⌘Z` pops from the undo stack and writes it to `docuapp_src`. Multiple undos walk back through history. Ten levels is ~1 MB for a typical app — well within localStorage limits on all platforms.

The undo stack (`docuapp_undo`) and prompt history (`da_hist`) together form a dialogue log: what the user asked and what the app became at each step. Undo isn't just version control — it's conversation replay. The user can walk backward through the dialogue, see the app as it was after each instruction, and branch forward from any point.

### 5.5 The Null Origin Bus

When HTML files are opened locally via `file://`, all files share the same origin: `null`. This means all re-writeable files opened in the same browser share the same `localStorage` namespace.

This is not a bug. It is a local communication bus:

```
budget.html     → writes  localStorage['budget_data']
tracker.html    → writes  localStorage['tracker_data']
dashboard.html  → reads   localStorage['budget_data'] + localStorage['tracker_data']
                → renders a unified view across both files
```

The `storage` event fires when localStorage changes in another tab. A re-writeable dashboard can subscribe to sibling documents and re-render reactively — with no server, no WebSockets, no protocol.

```javascript
window.addEventListener('storage', e => {
  if (e.key === 'tracker_data') refreshTrackerSection();
});
```

### 5.6 Embedding and Composition

A re-writeable file can embed another re-writeable file inline — not by referencing a file path, but by reading its source from the shared localStorage bus and rendering it via `srcdoc`.

```javascript
// Read a sibling's source from shared null-origin localStorage
const trackerSrc = localStorage.getItem('tracker_src');

// Render a live preview in a sandboxed iframe
const iframe = document.createElement('iframe');
iframe.srcdoc = trackerSrc;
iframe.sandbox = 'allow-scripts';
document.getElementById('embed-zone').appendChild(iframe);
```

This works because:
- Under `file://`, all re-writeable files share the null origin, so their sources are mutually readable in localStorage
- `srcdoc` does not trigger `file://` iframe restrictions (no filesystem path involved)
- The `sandbox` attribute controls what the embedded app can do

#### Embed modes

| Mode | Sandbox value | Behavior |
|---|---|---|
| **Snapshot** | `sandbox=""` | Static render — no JS, pure visual preview |
| **Live view** | `sandbox="allow-scripts"` | App runs JS but cannot access localStorage — fully isolated |
| **Full embed** | `sandbox="allow-scripts allow-same-origin"` | App runs with full localStorage access — can modify its own data and rewrite itself |

**Snapshot** is the "embed like a tweet" model: a frozen visual of another app's current state. Lightweight, safe, no side effects.

**Live view** is a running app in a box. The embedded tracker sorts, filters, and animates — but it can't write to localStorage or affect its siblings. Good for dashboards that compose multiple apps into a single view.

**Full embed** gives the iframe the same capabilities as a standalone tab. The embedded app can modify its own localStorage keys, run its own agent calls, and rewrite itself. Use with care — this is full agency inside a frame.

#### Reactive embedding

Because embeds read from localStorage, they can refresh when the source app changes. A dashboard can subscribe to sibling rewrites and update its embeds in real time:

```javascript
window.addEventListener('storage', e => {
  if (e.key === 'tracker_src') {
    // The tracker was just rewritten in another tab — refresh the embed
    document.getElementById('tracker-embed').srcdoc = e.newValue;
  }
});
```

This extends the null origin bus from data sharing (§5.5) to UI composition. A re-writeable can be a container for other re-writeables — a meta-app that assembles, arranges, and observes its siblings without owning them.

#### Limitations

- **`file://` iframes don't work** — `<iframe src="file:///path/to/app.html">` is blocked by most browsers (Chrome, Firefox). The `srcdoc` approach avoids this entirely by never referencing a file path.
- **Exported files must re-embed manually** — when a dashboard is exported via `⌘S`, the `srcdoc` content is whatever was in localStorage at export time. The exported file contains a frozen snapshot of the embeds, not a live link. On next open, the dashboard should re-read from localStorage to get current sources.
- **Private/incognito** — embeds rely on localStorage. No localStorage, no embedding.

---

## 6. The Agent Contract

### 6.1 Build (initial)

System prompt tells the agent to produce a polished single-file HTML application with:
- All CSS and JS inline
- No React, no build steps
- Dark theme (specified palette)
- Seed data included
- App data stored in localStorage under a descriptive key
- **No self-modification UI** (the runtime is injected by the seed after)

### 6.2 Modify (subsequent)

System prompt tells the agent:
- Return the complete modified HTML file only, no explanation
- Preserve `<script id="re-write-able-runtime">` exactly as-is
- Apply the instruction precisely
- The file must remain fully functional

The agent receives the **entire running app source** as context. This is the complete truth of the current state — HTML structure, CSS, JS logic, data, runtime — in one payload.

### 6.3 Model choice

`anthropic/claude-sonnet-4` via OpenRouter is the default. The full 200k context window can comfortably hold a 50–100kb app source plus instructions. For complex structural modifications, `claude-opus-4` produces more reliable results.

---

## 7. Export and Portability

`⌘S` serializes `document.documentElement.outerHTML` and downloads it as `[title].html`.

The exported file is:
- Complete and standalone — no dependency on the seed file
- Self-modifying — the runtime is embedded, so it can keep rewriting itself
- Portable — open it on any machine with any browser
- Diffable — it's just text, it lives happily in git

A re-writeable file can be shared by email, Slack, USB stick, or GitHub. The recipient opens it in a browser and it runs. They can modify it. They own their copy.

### 7.1 Export as True Persistence

localStorage and IndexedDB are volatile. Browsers can evict data under storage pressure, and iOS Safari does so aggressively after periods of inactivity. The exported `.html` file is the only durable artifact.

The runtime tracks unexported modifications. After 5 rewrites without an export, it surfaces a non-intrusive prompt: *"You have 5 unsaved versions. Press ⌘S to export."* This is not a modal — it's a status bar indicator that respects the user's flow but prevents silent data loss.

For apps with significant user data in IndexedDB, `⌘S` also serializes the app's IndexedDB data as a JSON blob embedded in a `<script type="application/json" id="app-seed-data">` tag within the exported file. On first open, the app checks for this tag, hydrates IndexedDB from it, then removes the tag. This ensures the exported file is truly self-contained.

---

## 8. Design Rules for Generated Apps

Every app generated by re-write-able follows these rules:

**Structure**
- Single HTML file, all CSS and JS inline
- No React, no build steps, no npm
- Libraries from `cdnjs.cloudflare.com` only if genuinely needed

**Visual**
- Dark theme: `#0e0e0f` background, `#161618` surface, `#2d2d34` border
- Text: `#dddde4` primary, `#575766` muted, `#dddde4` on dark
- Accent: `#b8ff57` (green), `#57c8ff` (blue), `#ff5757` (red)
- Fonts: DM Sans (UI), DM Mono (labels/code), Instrument Serif (display)

**Data**
- App data stored in IndexedDB under a descriptive database name (e.g. `tracker_db`)
- For trivially small data (a few KB of settings/preferences), localStorage is acceptable
- Never use `docuapp_src`, `docuapp_undo`, or `da_*` keys in localStorage (reserved by runtime)
- Seed data included so the app is useful on first open
- App must implement a `getExportData()` function that returns its IndexedDB contents as JSON, and a `hydrate(data)` function that restores from it — these are called by the runtime during export/import

**Quality**
- Production-quality: polished, usable, complete
- No placeholder lorem ipsum — real representative data
- Keyboard shortcuts where appropriate

---

## 9. Storage Model — Platform Behavior

### 9.1 Storage Budget

The runtime tier (localStorage) and app data tier (IndexedDB) have different limits and behaviors across platforms:

| Platform | localStorage | IndexedDB | Eviction risk |
|---|---|---|---|
| Chrome (desktop) | ≈10 MB | Up to ≈60% of free disk | Low — data persists until cleared |
| Chrome (Android) | ≈5–10 MB | ≈6–10% of free disk, typically <100 MB | Medium — can shrink quota when device is low on storage |
| Firefox (desktop) | ≈5 MB | ≈2 GB per origin | Low |
| Firefox (Android) | ≈5 MB | ≈50–100 MB after user approval | Medium |
| Safari (macOS) | ≈5 MB | ≈1 GB per origin | Low |
| Safari (iOS) | ≈5 MB | ≈50 MB effective cap | **High — actively evicts after inactivity or under storage pressure** |
| iOS PWA | ≈5 MB | Up to ≈1 GB if space available | Medium — more durable than Safari tabs, still not guaranteed |

### 9.2 The iOS Safari Problem

Safari on iOS is the most hostile environment for re-writeable files. WebKit actively evicts site data — including localStorage and IndexedDB — when the device is low on storage or after a period of inactivity. Private mode provides near-zero quota.

This means: a user builds a tracker on their iPhone, doesn't open it for two weeks, and iOS may silently delete both the app source and its data.

**Mitigations:**
1. **Export is the backup.** The exported `.html` file on disk is immune to browser eviction. The runtime's export nudge (§5.2) is especially important on mobile.
2. **`navigator.storage.persist()`** is requested on boot. Chrome Android honors it. Safari ignores it.
3. **The seed file is always safe.** Even if localStorage is evicted, reopening the seed file triggers a fresh build. The user loses modifications but not the ability to start over.
4. **Private/incognito mode is unsupported.** The spec does not attempt to work in private browsing. The runtime should detect it and show a clear message: *"re-write-able requires normal browsing mode."*

### 9.3 The Null Origin and Shared Quotas

Under `file://`, all re-writeable files share the null origin. This means they share the same localStorage namespace *and* the same IndexedDB namespace. The cross-app communication bus (§5.5) benefits from this, but the shared quota is a constraint.

With the two-tier storage model:
- **localStorage** (~5 MB shared): easily holds runtime state for 10+ apps (each using ~100 KB for source + undo)
- **IndexedDB** (50 MB+ shared): holds app data for multiple apps, but data-heavy apps should be mindful of siblings

The runtime's quota check (§5.3) monitors the shared budget and warns before it's exhausted.

---

## 10. Security Model

**API key**: stored in `sessionStorage` only. Survives reload, cleared on tab close. Never written to the file, never in localStorage, never leaves the browser except in the Authorization header.

**Self-modification**: `document.write` from localStorage is essentially `eval` at document scope. For a personal local tool this is the correct tradeoff — maximum capability, user-owned environment. For shared or hosted deployments, the risk surface is: anyone who can write to the user's localStorage can inject code. This is mitigated by the `file://` origin model (no cross-origin writes) and by the fact that the user controls the key.

**The seed is the anchor**: the seed file cannot be rewritten by the agent (it's never in localStorage). If something goes wrong, reset via the runtime's reset button, or delete `docuapp_src` from DevTools. The seed is always safe.

---

## 11. Citizen Development Model

re-write-able is designed for the person who:
- Has ideas for tools but cannot (or does not want to) write code
- Is suspicious of cloud platforms and wants to own their data
- Understands HTML at a surface level — enough to know it's "just a file"
- Would share a spreadsheet but not deploy an app

The mental model is: *it's like a spreadsheet, but the formula bar can redesign the spreadsheet.*

The deployment model is: *drag it to your desktop. Done.*

The collaboration model is: *send the file. They have everything.*

---

## 12. Webinar Demo Flow

### Narrative arc: "The file that builds itself"

**Act 1 — The seed** (2 min)
- Open `re-write-able.html` in Chrome
- Show the build screen — three fields, nothing else
- Talk about the seed as the immutable anchor

**Act 2 — First build** (3 min)
- Type: `a project tracker with status columns and due dates`
- Hit Build
- The agent writes ~300 lines of HTML into localStorage
- The app loads itself
- Show the running app with seed data

**Act 3 — Self-modification** (5 min)
- Hit ⌘K, type: `add a priority field — high, medium, low`
- The agent receives the entire app source, returns modified HTML
- Watch the app reload with the new field
- Hit ⌘K again: `add a small chart at the top showing status breakdown`
- Repeat: `turn the status columns into a kanban board`

**Act 4 — Undo** (1 min)
- Hit ⌘Z — the kanban disappears, the list view returns
- Hit ⌘Z again — the chart disappears
- The file has memory

**Act 5 — Export** (1 min)
- Hit ⌘S — download `project-tracker.html`
- Open it in a new tab — it runs, it has the runtime, it can keep evolving
- This file can be emailed. It requires nothing.

**Act 6 — The bus** (2 min)
- Open the spec document alongside the tracker
- Show `localStorage` in DevTools — both files' keys visible
- Write a 10-line dashboard that reads both
- The web was supposed to be read/write. This is read/write.

---

## 13. What This Is Not

- **Not a no-code platform** — there is no platform. The file is the platform.
- **Not a cloud app** — nothing is on a server. localStorage is the database.
- **Not an AI coding assistant** — the agent doesn't help you write code. It writes the whole thing.
- **Not a CMS** — there is no content management layer. The source is the content.
- **Not a framework** — there is nothing to install, nothing to configure, nothing to update.

It is a file that writes itself.

---

## 14. Prior Art and Influences

**Clive** (ikangai/clive) — the direct intellectual ancestor. Clive gives an LLM a terminal to inhabit; re-write-able gives it a browser tab. The self-modification pipeline (proposer → reviewer → gate → apply) maps to: agent call → runtime injection → localStorage → document.write.

**Simon Willison's HTML tools** — 150+ single-file HTML applications demonstrating that the format is serious, durable, and production-worthy. re-write-able extends the model: the tools can now build and modify themselves.

**The read/write web** (Berners-Lee, 1999) — the browser was meant to be an editor. WikiWiki, early blogging, Geocities — the web was briefly writable. re-write-able is a local, offline, agent-powered version of that original vision.

**HyperCard** (Atkinson, 1987) — a stack was a program you could read and modify. Every HyperCard user was implicitly a developer. re-write-able is HyperCard for the agent era: the card modifies itself.

---

*Spec version 0.2 — storage model revised with two-tier architecture, multi-level undo, and platform-specific persistence guidance*
