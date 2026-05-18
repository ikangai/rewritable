# re-write-able: actions, skills, and workflows

*A design extension proposing what a re-writeable can do beyond modifying itself.*

*Draft v0.2 — proposes additions to spec v0.10. Resolves the structural issues raised in the v0.1 review (vault scope, cron + commit gate, graph editing protocol, skill library reliability, skill installation as privileged operation) and fills in the missing sections (cost model, failure visibility, concurrency, vault crypto, modify semantics, skill versioning). Open seams listed explicitly in §11; merges into the main spec when those settle.*

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
- A **skill installation flow** that treats install as the privileged moment, with declared and enforced permissions
- A **workflow document type** that renders as a node graph and is edited via a dedicated graph protocol
- A **trigger model** for when execution happens (manual, on open, scheduled)
- A **fork-on-share variant** for documents that carry state and capability

The constraint that does all the work in v0.10 — *one file, no server, no account, no install* — applies to every addition. The phrase "the server is convenience, not custody" (§10) is the north star; anything that violates it is rejected.

---

## 1. The agent realization

A re-writeable with self-modification (v0.10) plus skills plus workflows plus memory in IDB plus the ability to rewrite its own workflow satisfies every working definition of *agent*: it perceives (reads state), decides (LLM call), acts (skills), and remembers (IDB).

This is a recognition, not a redesign. The pieces compose without architectural disruption. What changes is the positioning — and that's a choice, not an architectural requirement. Three positioning paths exist:

**Document-first.** Present the format as documents that can rewrite themselves and (incidentally) carry workflows and skills. Trust model stays simple. Risk: under-sells what's actually here.

**Agent-first.** Present the format as the first portable agent file. Larger claim, larger upside. Risk: invites comparison with platform agents on dimensions the format isn't optimizing for (multi-tenant safety, telemetry, vendor support).

**Document-first now, agent-second later.** Ship the capability quietly. When the community builds genuinely agentic rwa's and shows them off, the agent label arrives by demonstration rather than by announcement. This is how spreadsheets became programming environments and HyperCard became a game engine.

This document specs the architecture. Working position absent contrary evidence: **document-first**. See §10.6.

---

## 2. Skills

### 2.1 What a skill is

A skill is a local capability that a re-writeable can invoke. Each skill carries:

- A **name** — stable identifier (e.g. `publish-to-blog`)
- A **version** — semantic version (`1.2.0`), used for compatibility (§2.5)
- A **description** — a sentence the LLM reads to decide if the skill applies
- An **input schema** — typed fields the skill accepts; each field may be marked `sensitive: true` (§5.4)
- An **output schema** — what the skill returns
- A **permissions manifest** — declared and enforced (§4.2)
- An **implementation** — JavaScript that runs in the runtime context, subject to the permissions manifest
- An optional **vault namespace** — which credential bucket the skill needs (§3)

Two contracts matter. The **interface** (name, version, description, schemas) is what documents see. The **implementation** is local to the user. A document declaring "I want to publish to a blog" matches against any local skill that satisfies the interface, regardless of what the implementation actually talks to (WordPress, Ghost, Mastodon, a static-site git push).

This is the same model as Claude's skill system and macOS "Open With" — the document carries intent; the host provides capability. The architectural consequence is that skills are portable across documents but specific to a user. A workflow shared between two users still works for both of them, even if one routes `publish-to-blog` to WordPress and the other routes it to Ghost.

### 2.2 Where skills live

Skills live in a **runtime-managed IDB store**, `rwa_skill_library`, scoped per-origin. The store is *not* a normal document store — documents do not write to it, only the runtime does, and only through the skill installation flow (§4).

A viewer re-writeable, `skill-library.html`, provides a UI for browsing, editing, and installing skills. The viewer is one possible UI; the actual skill data lives in the IDB store and is always available regardless of whether the viewer is open. A cron-launched workflow accesses the library directly through `runtime.skills.*`; no viewer tab is needed.

The earlier intuition — "the skill library is just another rwa on the bus" — was elegant but practically fragile. Skills only being available when a particular tab is open, race conditions on startup, the user closing the most load-bearing tab on the system — these were real failure modes that the IDB-backed model resolves at the cost of one piece of recursive elegance.

The bus topic `skills:*` is runtime-reserved. Documents cannot publish into it; the runtime is the only writer. The library viewer reads through the API, not the bus.

### 2.3 How skills are invoked

Three invocation paths:

1. **By name, from document JavaScript.** `await runtime.skills.invoke('publish-to-blog', { title, body })`. Direct and programmatic. Used when the document is essentially a script with a UI.
2. **By natural language, through the LLM.** The user presses a new keystroke — current direction: **⌘J** ("do"), distinct from **⌘K** ("edit") — and types intent. The LLM sees the list of available skills and their descriptions, picks one (or chains several), and invokes them. Used when the document is conversational, or when the user prefers intent over invocation.
3. **By graph, from a workflow.** A workflow node is a skill invocation; running the workflow runs the chain. See §5.

Consent is layered (§4.3 has the full model):

- **Installation consent** (high friction, one-time): user reviews the skill's code and permissions before it enters the library.
- **Invocation consent** (per-document or per-session, depending on sensitivity): users approve a document's first use of a sensitive skill; trivial skills (`compute` permission only) may not prompt at all.
- **Workflow manifest consent** (one prompt per workflow): a workflow declares its skill list as a manifest; the user grants the whole set on first run rather than receiving N first-time prompts in a chain.

### 2.4 The trust model

The trust anchor is the **skill installation review** (§4), not the document and not the per-invocation prompt. By the time a skill is in the library, the user has seen its code and approved its permissions. From that point:

- A document arrives saying "I want to publish to a blog" — this is **intent**, not code.
- The runtime matches the intent against locally installed skills.
- The local skill — reviewed, permissioned, and trusted by the user at install time — does the work.
- The document never executes arbitrary capability code; it triggers locally trusted code with parameters that the runtime validates against the skill's input schema.

The bridge from document to skill is `runtime.skills.invoke(...)`, mediated by the runtime. The runtime validates input against the schema, checks the per-invocation consent state, and (if approved) executes the skill in the runtime context with its declared permissions.

The recipient of a shared workflow that wants to "publish to a blog" never receives the publisher's credentials, nor the publisher's choice of blog platform. They receive an intent that resolves against their own skill library, against their own vault namespaces, on their own machine.

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

The runtime resolves at workflow load:

- Required major version present in library, equal or higher minor → use it.
- Required major version present, lower minor → use it, warn if any input field is missing.
- Required major version absent → workflow opens in read-only mode; runtime offers to install or remap.
- Multiple compatible versions in library → user picks at first run, choice persisted per workflow.

Skill authors bump major on breaking input/output schema changes; minor on additive changes; patch on implementation-only changes. Workflows that need a specific patch (e.g. for a bug fix) can pin tighter via optional `min_patch`.

---

## 3. The credential vault

### 3.1 The vault is namespace-scoped

The vault is a separate IndexedDB database, `rwa_vault`. Its access boundary is the **namespace**, not the origin. This decoupling is deliberate: under `file://`, all rwa files share the null origin, so an origin-scoped vault would be readable by every document on the machine — exactly the inverse of what's wanted.

Vault entries are keyed by namespace and field:

```javascript
{ namespace: 'wordpress-personal', field: 'api_token', value: '<encrypted>' }
{ namespace: 'wordpress-personal', field: 'site_url',  value: '<encrypted>' }
{ namespace: 'mastodon-mty',       field: 'token',     value: '<encrypted>' }
```

Skills declare which namespace they need at install time. The user approves the namespace declaration during installation review (§4). Skills cannot read from namespaces they don't hold. Multiple skills that hold the same approved namespace share its credentials — that's the point: install `publish-to-blog`, `fetch-from-blog`, and `comment-on-blog` against the same `wordpress-personal` namespace, and all three use the same token.

A document cannot create a skill with arbitrary namespace access. The installation flow surfaces the requested namespace, and the user explicitly grants it. Granting a new skill access to an existing namespace is its own consent decision ("Allow `comment-on-blog` to use credentials from `wordpress-personal`?").

### 3.2 The vault API

```javascript
runtime.vault = {
  set(namespace, field, value),        // skill-callable only, namespace must match
  get(namespace, field),               // returns null if locked or namespace unauthorized
  has(namespace, field),
  unlock(passphrase),                  // user-triggered; returns Promise<boolean>
  lock(),
  status,                              // 'locked' | 'unlocked' | 'empty'
  namespaces(),                        // skill-callable: returns namespaces this skill is approved for
};
```

A skill can only `get`/`set` against namespaces it is approved for. The runtime enforces this at the API boundary; an unauthorized call returns null and logs a permission denial event (visible in the library viewer).

### 3.3 The vault never travels

The vault has a hard rule that survives every other feature in this extension: **vault contents never leave the machine they were created on, regardless of how the containing document is shared or exported.** Fork-on-share, export, embed, bus publication, library export — the vault is opaque to all of them.

A skill that needs a credential on the recipient's machine triggers the recipient's vault. If the recipient hasn't populated the relevant namespace, the skill surfaces a "vault namespace `<name>` is empty; populate it from the library viewer" message rather than failing silently.

### 3.4 Vault cryptography

- **Key derivation**: Argon2id with a per-vault salt stored alongside the encrypted entries.
- **Encryption**: AES-GCM, per-entry IV, authenticated.
- **Key cache**: derived key held in memory only; cleared on lock, on tab focus loss for >N minutes (current direction: 30), and on tab close.
- **No recovery mechanism**: a forgotten passphrase means a wiped vault. This is intentional. Recovery mechanisms in client-only systems always become attack surfaces.

*Specific Argon2id parameters (memory cost, iterations, parallelism) are deliberately not pinned here. They want a separate review pass against a current threat model rather than a guess in a design doc. The shape is fixed; the numbers are an implementation decision.*

---

## 4. Skill installation and permissions

This section is the load-bearing addition that v0.1 was missing. Skill code, by design, runs with elevated privilege (vault, network, FSA, bus). **The privileged moment is installation, not invocation.** Trust is anchored when the code enters the library, not every time it executes.

### 4.1 The installation flow

Skills are added to the library via the library viewer (`skill-library.html`). Three install sources:

- **Generated by ⌘K in the library viewer.** User describes the skill they want; the LLM generates an implementation.
- **Imported from a shared skill file.** A small `.rwa-skill.json` artifact carrying a single skill's manifest and implementation, exchanged the same way rwa documents are.
- **Edited in place by the user.** Direct authoring in the library viewer's editor.

In all three cases, install requires explicit user action (an "Install" button), not just code generation or import. Until install completes, the skill is a draft.

The install dialog shows:

- The complete skill code, syntax-highlighted, readable.
- The **permissions manifest** (§4.2) the skill declares.
- The **vault namespace** the skill wants (if any), with a note about whether that namespace already exists in the vault.
- The **input/output schemas**.
- A diff against the existing version if installing an update.

The user accepts the entire dialog, or doesn't. No "install with reduced permissions" — if the user doesn't grant a permission, the skill doesn't install. The skill can then be edited (to drop the offending capability) and re-reviewed.

### 4.2 Permission tiers

Each skill declares its capabilities as a manifest. The runtime enforces these at every API boundary; a skill that calls `fetch` to a domain not in its `network:` list fails the call.

| Permission | Declaration | Enforces |
|---|---|---|
| `compute` | Implicit (all skills) | Data manipulation only — no I/O |
| `network:<domains>` | List of origin patterns | `fetch` to those domains only |
| `vault:<namespace>` | Single namespace | Read/write that vault namespace only |
| `fsa:<patterns>` | Glob patterns | FSA operations under matching paths |
| `bus:<topics>` | Topic patterns (read, write, both) | Bus operations on matching topics |
| `idb:<store>` | Single document IDB store | Read/write that store in a single document context |

A skill that wants to `fetch` arbitrary URLs needs `network:*`, and the install dialog surfaces that as a wildcard with a stronger warning. Most legitimate skills are narrowly scoped (`network:api.wordpress.com`, `vault:wordpress-personal`) and the install UI presents this scoping clearly.

### 4.3 The back door is closed

Skills cannot install other skills. The `runtime.skills.install(...)` API is not exposed to skill code at all — only the library viewer (running in the host context with library-edit privilege) can call it. A self-modifying workflow (§6) cannot invoke a skill that adds a new skill, because no such skill can exist. The privilege boundary holds.

Workflows that need new skills surface them as missing-skill errors at load time, prompting the user to install via the viewer. There is no path from running code to "the library now has a new skill" without a user-mediated review.

### 4.4 Sensitivity and consent under load

Per-invocation consent prompting is calibrated by permissions:

- **`compute`-only skills**: no prompt on first invocation. Pure data manipulation; consent is satisfied by install review.
- **Skills with any I/O permission**: prompt on first invocation per document, with "remember for this document" / "remember for this session" / "ask each time" options.
- **Workflows**: declare a `skill_manifest` listing every skill they invoke. On first run, the user reviews and grants the entire manifest once. Subsequent runs (and cron runs) do not prompt — the manifest is the consent record.

This resolves the "10 skills, 10 first-time prompts" failure mode from the v0.1 review without watering down the consent model for one-off invocations.

---

## 5. Workflows

### 5.1 The workflow document type

A workflow re-writeable's primary content is a **directed graph** of skill invocations. The visual representation is the rendered view. Editing the workflow — via ⌘K — modifies the graph through a dedicated protocol (§5.2).

The graph lives in IndexedDB under a runtime-reserved store, `rwa_workflow` (added to the reserved store list in §5.3 of the main spec). Shape:

```javascript
{
  version: '1.0',
  nodes: [
    {
      id: '7k3p2m9q',                  // shares the data-rwa-id namespace (§5.9 main spec)
      type: 'skill',                   // skill | primitive | input | output
      skill: 'fetch-rss',              // when type === 'skill'
      skill_version: { major: 2 },     // version pin (§2.5)
      primitive: 'split',              // when type === 'primitive'
      config: { url: 'https://…' },
      position: { x, y },
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
}
```

Graph size note: each node and edge serializes into `INLINE_DOC` at commit time. A 100-node graph is fine; a 10,000-node graph isn't a workflow, it's a database. The viewer surfaces a soft warning above 100 nodes recommending decomposition into sub-workflows (§8.2).

### 5.2 The graph editing protocol

⌘K on a workflow rwa dispatches `rwa-graph/1`, a protocol parallel to `rwa-edit/1`. The agent receives the graph as structured JSON plus the user's instruction and returns one or more graph operations:

- `graph_add_node({ type, skill?, primitive?, config, position })`
- `graph_remove_node({ id })`
- `graph_modify_node({ id, changes })`
- `graph_add_edge({ from, to, predicate?, kind? })`
- `graph_remove_edge({ from, to })`
- `graph_modify_edge({ from, to, changes })`
- `graph_set_trigger({ trigger })` — see §6 for restrictions

The runtime applies the operations atomically. A failed operation rolls back the entire batch and surfaces the error. The previous graph state is pushed onto `rwa_undo` per v0.10's undo model; ⌘Z walks the graph back.

The graph is not text and is not edited as text. Serializing graphs to text and back through a text-edit protocol was considered and rejected — JSON round-tripping is fragile in LLM output and the failure modes (a missing comma destroying half the graph) are exactly the ones a dedicated protocol prevents.

A document rwa with no `rwa_workflow` store dispatches `rwa-edit/1` as before. A workflow rwa dispatches `rwa-graph/1`. A hybrid rwa (prose + an embedded workflow) dispatches both, scoped to the part of the document the user's instruction targets — current direction is to route by what's in focus, with a fallback to disambiguating prompt.

### 5.3 Execution semantics

Three trigger modes:

1. **Manual.** Open the file, click Run. The file is a viewable, editable artifact; execution is explicit.
2. **On open.** Opening the file executes the workflow. Powerful but security-sensitive — a workflow that fires API calls on open is structurally closer to a virus than to a document. Requires the runtime to surface a clear consent dialog the first time a document opens with `on_open` trigger, with a "open without running" affordance.
3. **External trigger.** A scheduled (cron) or event-driven invocation from outside the browser. The workflow declares its intended trigger; actual scheduling is set up by the user on their OS (§7).

Current direction: ship **manual** first. Add **on open** when the consent UX is solid. **External trigger** is supported by the format from the start but requires the user's own OS-level setup.

Within a run, execution is async and non-blocking. Each node returns a Promise; edges enforce ordering; the runtime walks the graph topologically. The visual representation highlights the currently-running node (or nodes, during a split). Errors halt the affected branch and surface in the visual; an `error`-kind edge on a node redirects failure to a recovery branch.

### 5.4 Concurrency

A workflow can be triggered while a previous run is still in flight (user re-clicks Run; cron fires while the previous run is still working). The runtime extends v0.10's BroadcastChannel-based modify-mutex into a **per-workflow execution mutex**:

- **Default policy: `skip`** — a new trigger while a run is in progress is ignored, with a log entry recording the skip.
- **Optional: `queue`** — new triggers queue up to a per-workflow cap; default cap is 3, after which further triggers are dropped.
- **Optional: `parallel`** — new triggers start in parallel runs. Workflows explicitly opting in must declare their state usage is concurrency-safe (the runtime can't verify this).

Policy is declared in the workflow's metadata and surfaced in the viewer; default is `skip` because it's the safest answer.

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
    id,                                // current run UUID
    started_at,
    triggered_by: 'manual' | 'on_open' | 'cron' | 'on_change',
  },
  history,                             // last N runs, capped at 100
};
```

`runtime.workflow.state` backs onto a reserved IDB store, `rwa_workflow_state`, and survives across runs, commits, and sessions. A workflow that polls an RSS feed writes seen IDs here; a workflow that summarizes a daily inbox writes the last-processed timestamp here.

Run history is structured. Each run logs trigger, start/end timestamps, status, and a per-node entry recording: skill invoked, input (with sensitive fields redacted per the skill's input-schema declarations), output presence (not content for sensitive outputs), duration, error if any. This makes the rwa its own audit log — open the file two months later and see what it has been doing.

Skill input schemas may mark fields as `sensitive: true`. The runtime redacts those fields in run history. Fork-on-share filtering uses the same flag: redacted fields are also excluded from any published variant of the document, even if history export is otherwise enabled (§9).

### 5.6 Failure visibility

A cron-triggered workflow that fails at 3am needs to surface that failure to its user. The runtime writes failure events to a reserved store `rwa_workflow_notifications` (a queue, capped at 100), and:

- Surfaces them in the workflow's visual representation on next open (a badge on the relevant node, the latest failure expanded).
- Optionally emits to the OS notification system, where available (Chromium with the Notifications API + user permission).
- Optionally writes a structured log file to a user-configured FSA path (`~/Documents/rwa-logs/<workflow-name>.log`).

The latter two are opt-in per workflow. "Failure" includes: skill invocation errors, vault-locked errors, missing-skill errors, timeout, and quota-exceeded events from the cost model (§5.7).

### 5.7 Cost model

LLM calls cost money. A self-modifying workflow on cron is a runaway spend risk. The runtime tracks per-workflow token usage and enforces caps:

- **Per-run cap**: maximum tokens per single invocation. Default: 100k. Workflow can declare higher.
- **Per-day cap**: maximum tokens across all runs in a 24-hour window. Default: 500k. Workflow can declare higher; user confirms at install if the declared cap exceeds a configured threshold.
- **Soft warning**: at 80% of either cap, the runtime surfaces a notification. Workflow continues.
- **Hard stop**: at 100% of either cap, the workflow halts (or the offending self-modification step is rejected). Resumes at the next reset boundary.

Token counts are recorded in the run history. The library viewer surfaces aggregate usage per workflow and per skill.

Local-LLM fallback (Ollama, llama.cpp, etc.) is an explicit design goal but not part of v0.2's spec. A workflow that wants local-only execution declares `model: 'local'` and the runtime routes through whatever local endpoint the user has configured. Current direction: defer the configuration surface to v0.3.

---

## 6. Self-modifying workflows

A workflow that modifies its own graph is qualitatively different from one that just runs. It's adaptive: it can change its own approach based on what it has learned. This is the point where the format becomes recognizable as an agent in the strong sense.

The mechanism: the workflow's own ⌘K targets the graph (via `rwa-graph/1`). What's new is that a *running node* can also invoke graph modification programmatically, via `runtime.modify(instruction)`.

### 6.1 `runtime.modify` semantics

```javascript
runtime.modify(instruction, { scope?: 'graph' | 'document' })
```

- Mutually exclusive with user-triggered ⌘K via the same execution mutex. A running node calling `modify` blocks user ⌘K until the call completes; user ⌘K blocks node `modify` calls.
- Surfaces token cost to the user (counts against the per-run and per-day caps in §5.7).
- Returns a Promise that resolves when the modification is applied (or rejects with a structured error).
- Subject to the rate limit in §6.3.

### 6.2 The commit gate is load-bearing across all execution modes

This is the resolution of the v0.1 review's central architectural question: cron has no human to press ⌘S; what persists?

**Scheduled and headless self-modifications are ephemeral by design.** The on-disk file is the authority. At the start of every cron-triggered (or otherwise headless) run, the runtime hydrates the workflow graph from the inline snapshot, exactly as the v0.10 first-open path hydrates a document. Self-modifications during the run mutate the in-memory and in-IDB graph; at run end, the IDB graph is *not* committed back to the file. The next cron run starts again from the on-disk version.

`rwa_workflow_state` (the data store) persists between runs as designed (§5.5). Only the workflow *structure* resets.

This means:

- A cron workflow can adapt within a run (rewrite an edge, swap a node, add a fallback path) and that adaptation affects the rest of the run.
- A cron workflow cannot drift across days. The agent does not gradually become a different agent without a human in the loop.
- The on-disk file is always the source of truth for what the workflow *is*. Reading the file tells you what the agent will do on its next run.
- Determinism: the same on-disk file launched by cron a hundred times produces a hundred runs that all start from the same graph.

In interactive sessions (manual or `on_open` triggers in a normal browser), self-modifications behave the same as v0.10 document edits: IDB persists across the session, but only ⌘S writes to disk. A user can replay, ⌘Z, and ⌘S a self-modified workflow exactly as they would a self-modified document.

This makes the v0.10 commit gate genuinely load-bearing across all execution modes. It's not a UI convention; it's the only path by which an agent's structure changes durably. Every other agent platform eventually accumulates drift; this design refuses the failure mode by construction.

### 6.3 Self-modification rate limits

Two limits, both enforced by the runtime:

- **Per-run cap**: default 1 modification per run. Workflow can declare higher with user confirmation at install.
- **Per-24h cap**: default 10 modifications across all runs in a 24-hour window. Mostly relevant for interactive sessions, since cron self-mods don't persist anyway, but still useful for preventing runaway in-session adaptation.

Both caps surface in the library viewer's per-workflow statistics.

### 6.4 Hard constraints

These survive every other consideration:

- **Triggers cannot be modified by self-modification.** A `manual` workflow cannot, via the LLM, become an `on_open` workflow. Trigger changes go through `graph_set_trigger`, which `runtime.modify` does not authorize — only user ⌘K does.
- **The skill manifest cannot be expanded by self-modification.** A workflow cannot self-modify into using a skill its declared manifest doesn't include. The user-granted manifest from install time is the binding contract; self-modification works within it.
- **The bootstrap is sacrosanct.** Self-modification touches the graph in `rwa_workflow`, never the runtime, the skill implementations, or the inline snapshot's structure. If the graph drifts into nonsense, reload — IDB hydrates from the snapshot.

---

## 7. Scheduling and headless execution

### 7.1 The format is the same

A workflow file is the same file regardless of how it's run. There is no "deploy to production" step. Authoring, testing, and scheduled execution all open the exact same `.html`. Only the *opener* differs.

### 7.2 Three flavors of unattended execution

**A. Open in normal Chrome on a schedule.** `open -a "Google Chrome" workflow.html` from `cron` (Linux/macOS) or the equivalent on Windows Task Scheduler. Runs as the user, inherits logged-in browser state. A browser window appears at the scheduled time. Fine on a dedicated machine; mildly disruptive on a laptop.

**B. Headless Chrome with a persistent profile.** `chrome --headless=new --user-data-dir=/path/to/profile workflow.html`. No window. Profile must be set up once with whatever credentials and vault state the workflow needs. The "real" automation answer; mildly fiddly.

**C. A companion CLI.** Out of scope for this spec, but worth naming: an eventual `rwa run workflow.html` would wrap headless Chrome, handle vault unlocking from environment variables or an OS keychain, and surface logs in a CLI-friendly form. The format makes this possible; the format does not require it.

### 7.3 The vault for unattended runs

A scheduled run cannot prompt for the vault passphrase. Three options:

- **Environment variable.** The passphrase lives in the cron environment. Simple. Plaintext in a config file or shell rc.
- **OS keychain.** The runtime, in headless mode, fetches the passphrase from macOS Keychain / GNOME Keyring / Windows Credential Manager. More secure; requires per-OS integration code.
- **Unattended-mode vault.** A second, less-protected vault holds only credentials the user has explicitly marked as headless-safe. Reduces blast radius; adds a concept users have to understand.

Current direction: ship environment-variable support as the v1 answer (documented as "for trusted machines only") and add keychain integration as the runtime matures.

---

## 8. Composition

### 8.1 Skills + workflows + the bus

The cross-container bus from v0.10 (§5.7 main spec) becomes more powerful with skills and workflows in play. A workflow can read inputs from `runtime.shared.get('source:topic')`, subscribe to bus changes as an event trigger (`trigger: 'on_change:<bus_key>'`), and publish outputs for other workflows to consume.

This is the Unix-pipe model at the rwa scale: small workflows that do one thing, composed by file references and bus topics. Drop two workflow files in the same folder; one writes to `flow-a:results`, the other subscribes — a pipeline assembled by drag-and-drop. No service mesh, no API gateway, no orchestrator.

### 8.2 Workflows referencing other workflows

A workflow node can be another workflow file (referenced by path or URL). The runtime resolves the reference, embeds the sub-workflow's input/output schema, and chains accordingly.

Sub-workflow execution happens in an isolated iframe (§5.8 main spec; sandbox modes apply). Bus access is scoped to a parent-prefixed sub-bus — the sub-workflow sees `<parent_id>/<topic>`, not the parent's full bus. Parent and sub-workflow can communicate by convention through the sub-bus, but the sub-workflow cannot read or write the parent's other bus traffic. This closes the v0.1 review's concern about sub-workflows seeing all parent bus traffic.

---

## 9. Fork-on-share for tools and agents

[Fork-on-share](https://www.ikangai.com/fork-on-share/) works straightforwardly for documents: the file is the seed, the recipient gets a sovereign copy, no write-back to the publisher. For workflows and agents the principle is the same but the seed needs more care.

The publish flow asks the publisher what to include:

- **Always included.** The workflow graph (structure, configuration, manifest), document content, configuration constants. Skill references travel as `(name, major_version)` pairs, not as implementations.
- **Never included.** The vault. Anything in `rwa_vault`. Skill implementations from the local library (the recipient resolves intent against their own library). Run-history fields marked `sensitive: true` per the skill input schemas.
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

Workflows declare required skills by name + major version. If a recipient lacks a required skill at the required major, the workflow opens read-only and the runtime offers to install or remap. A documented **common skill set** ships with the format — e.g. `http-get`, `http-post`, `send-email-smtp`, `save-to-file`, `read-from-rss` — workflows that stick to the standard set are portable; workflows that use exotic skills are recipient-specific. The exact membership of the common set is deferred to v0.3.

### 11.2 What counts as a "skill" vs. a primitive

Primitives are pure (no network, no credentials, no side effects beyond the workflow's own IDB and state store). Skills are everything else. Under this rule `http-get` is a skill (it touches the network); `transform` and `filter` are primitives (they shuffle in-memory data).

The `transform` primitive uses `new Function()` with a restricted globals set — no `fetch`, no `document`, no `runtime.*`, no IDB, no vault. Just data manipulation against the input. `eval` is not used.

### 11.3 Multi-user agents on shared machines

A workflow scheduled via cron on a shared Linux box runs as one user. Whose vault, whose skill library — whichever user's profile cron is running under. Multi-user automation on a shared host is a known unaddressed case; the single-file rule survives by saying "this is one user's tool."

### 11.4 The schedule UI

A workflow that wants to be cron-triggered has to live with a cron job somewhere on the user's OS. Setting up that cron job is the user's problem. A companion `rwa` CLI could declare and install the schedule, but that drifts toward "the format requires a helper to be fully usable," weakening the single-file property. Current direction: keep schedule setup out of the format; document the OS-level commands clearly.

### 11.5 What ships first: workflows or skills

Skills first. They earn their keep in a single-document context (a press release that can post itself) and don't require the visual UI of a graph. Workflows benefit from the skill substrate being in place when they arrive.

### 11.6 The agent label

§1 makes the format something that *is* an agent. Whether to say so on the box, and when, is the strategic question this spec leaves unresolved. It is not an engineering question and the answer doesn't change the architecture. Working position: **document-first**. The architecture is recognizably agentic but the natural audience opens documents, not deploys agents; the agent label invites comparisons (multi-tenancy, vendor support, telemetry) the format intentionally doesn't optimize for; the demonstration path is stronger anyway.

### 11.7 Local-LLM fallback configuration

A workflow declaring `model: 'local'` should route through a user-configured local endpoint. The configuration surface (a runtime settings panel? a well-known location in the library? a `local-llm.html` companion rwa?) is deferred to v0.3.

### 11.8 Vault crypto parameter pinning

§3.4 fixes the shape (Argon2id, AES-GCM, per-entry IV, in-memory key with TTL). Specific Argon2id parameters need a review pass against a current threat model. v0.3 will pin them or explicitly leave them implementation-tunable with a documented range.

### 11.9 Skill share file format

Skills exported individually as `.rwa-skill.json` artifacts (§4.1). The exact JSON envelope, the signature/integrity story (or its deliberate absence), and the install-from-share UX are unspecified. Current direction: a minimal manifest with no signature, treating skill imports the same way email attachments are treated (recipient reviews before accepting), but this needs design.

---

## 12. Invariants (extended)

In addition to the v0.10 invariants:

8. The credential vault (`rwa_vault`) is scoped by user-declared namespaces, not by origin. Skills access only namespaces they were approved for at install time. Vault contents never serialize into any document's inline snapshot or shared variant.
9. Skills are local to the user, not to the document. A document declares intent; the local skill library provides capability. The library lives in a runtime-managed IDB store, not in any individual document.
10. Skill installation is the privileged moment. The runtime requires user review of skill code and permissions before adding a skill to the library. No path exists from running code to "the library now has a new skill" without user-mediated review.
11. Self-modifying workflows cannot grant themselves new skills, cannot change their own trigger, and cannot bypass the commit gate to persist graph changes without explicit user action via ⌘S.
12. Scheduled and headless self-modifications are ephemeral by design. The on-disk file is the authority; cron runs start from the committed graph each time. Workflow state persists; workflow structure resets.
13. The bootstrap continues to be the only immutable shell. Skills, workflows, vault, and their state all live in IDB and are subject to the same byte-identity rules as document state.
14. A workflow file is the same file in authoring, testing, and unattended (cron / headless) execution. Only the opener differs.
15. The server (share host, remote runtime, cron host, sync target) is convenience, not custody. Any feature that requires the server to remain available, trustworthy, or cooperative for the file to keep working is rejected.

---

*Draft v0.2 — resolves the structural issues from the v0.1 review and fills in the missing sections. Builds on spec v0.10. Substantive open questions remain in §11; positioning (§11.6) is working-document-first absent contrary evidence. Reference implementations do not yet exist; this document specifies behavior at the level needed to begin building, not at the level needed to ship. Items remaining for v0.3 are listed in §11; the v0.2-specific items deferred are the exact contents of the common skill set, Argon2id parameter pinning, local-LLM configuration surface, and the skill share file format.*
