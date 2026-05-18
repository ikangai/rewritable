# re-write-able: actions, skills, and workflows

*A design extension proposing what a re-writeable can do beyond modifying itself.*

*Draft v0.3 — proposes additions to spec v0.10. Resolves the headless-detection problem from the v0.2 review by committing to a by-trigger persistence boundary (§6.2, invariant 12), closes the calling-skill-identity gap (§4.2), extends sensitivity to output schemas (§2.1, §5.5, §9), pins sub-workflow nesting (§8.2), and addresses the smaller specification gaps. New deferrals for v0.4 in §11.10 and §11.11. Open seams listed explicitly in §11; merges into the main spec when those settle.*

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
- A **permissions manifest** — declared and enforced (§4.2)
- An **implementation** — JavaScript that runs in the runtime context, subject to the permissions manifest
- An optional **vault namespace** — which credential bucket the skill needs (§3)

Two contracts matter. The **interface** (name, version, description, schemas) is what documents see. The **implementation** is local to the user. A document declaring "I want to publish to a blog" matches against any local skill that satisfies the interface, regardless of what the implementation actually talks to (WordPress, Ghost, Mastodon, a static-site git push).

This is the same model as Claude's skill system and macOS "Open With" — the document carries intent; the host provides capability. The architectural consequence is that skills are portable across documents but specific to a user. A workflow shared between two users still works for both of them, even if one routes `publish-to-blog` to WordPress and the other routes it to Ghost.

### 2.2 Where skills live

Skills live in a **runtime-managed IDB store**, `rwa_skill_library`, scoped per-origin. The store is *not* a normal document store — documents do not write to it, only the runtime does, and only through the skill installation flow (§4).

A viewer re-writeable, `skill-library.html`, provides a UI for browsing, editing, and installing skills. The viewer is one possible UI; the actual skill data lives in the IDB store and is always available regardless of whether the viewer is open. A cron-launched workflow accesses the library directly through `runtime.skills.*`; no viewer tab is needed.

The bus topic `skills:*` is runtime-reserved. Documents cannot publish into it; the runtime is the only writer. The library viewer reads through the API, not the bus.

**Hosted shares and library scope.** The library is per-origin. Local files (the null origin under `file://`) share one library — correct, and the namespace-scoped vault (§3) handles the access control. Hosted shares each get their own origin (e.g. `<short>.rewritable.<host>/`), so a workflow opened from a share URL sees an *empty* library and cannot access the recipient's installed skills. This is the right security behavior: the recipient downloads the file to local disk first, opens it from `file://`, and only then does it have access to their library. The runtime surfaces this transition explicitly when a workflow is opened from a hosted share with required skills it cannot resolve.

### 2.3 How skills are invoked

Three invocation paths:

1. **By name, from document JavaScript.** `await runtime.skills.invoke('publish-to-blog', { title, body })`. Direct and programmatic. Used when the document is essentially a script with a UI.
2. **By natural language, through the LLM.** The user presses a new keystroke — current direction: **⌘J** ("do"), distinct from **⌘K** ("edit") — and types intent. The LLM sees the list of available skills and their descriptions, picks one (or chains several), and invokes them. Used when the document is conversational, or when the user prefers intent over invocation.
3. **By graph, from a workflow.** A workflow node is a skill invocation; running the workflow runs the chain. See §5.

Consent is layered (§4.4 has the full model):

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

**Calling-skill identity.** Permission enforcement (§4.2) requires the runtime to know *which skill* is calling `runtime.vault.get(...)` or `fetch(...)`. JavaScript has no native call-site identity. The runtime resolves this by issuing per-skill bound API surfaces at skill load time: each loaded skill receives its own `runtime.vault`, `runtime.bus`, and `fetch` proxies, closed over its identity and permission manifest. A skill cannot reach the unbound globals because the runtime overrides them in the skill's execution scope. This makes permission boundaries enforceable at every API call without relying on stack inspection.

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

Skills declare which namespace they need at install time. The user approves the namespace declaration during installation review (§4). Skills cannot read from namespaces they don't hold. Multiple skills that hold the same approved namespace share its credentials — that's the point: install `publish-to-blog`, `fetch-from-blog`, and `comment-on-blog` against the same `wordpress-personal` namespace, and all three use the same token.

**Granting access to an existing namespace is its own decision.** When a new skill requests a namespace that already holds credentials, the install dialog (§4.1) lists the skills currently using that namespace ("Skill `comment-on-blog` wants `vault:wordpress-personal`. This namespace already holds credentials used by `publish-to-blog`, `fetch-from-blog`. Granting access lets this skill read those credentials."). The user grants or refuses with full visibility of who else holds the namespace.

A document cannot create a skill with arbitrary namespace access. The installation flow surfaces the requested namespace, and the user explicitly grants it.

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

A skill can only `get`/`set` against namespaces it is approved for. The runtime enforces this via the per-skill bound `runtime.vault` proxy (§2.4 calling-skill identity); an unauthorized call returns null and logs a permission denial event (visible in the library viewer).

### 3.3 The vault never travels

The vault has a hard rule that survives every other feature in this extension: **vault contents never leave the machine they were created on, regardless of how the containing document is shared or exported.** Fork-on-share, export, embed, bus publication, library export — the vault is opaque to all of them.

A skill that needs a credential on the recipient's machine triggers the recipient's vault. If the recipient hasn't populated the relevant namespace, the skill surfaces a "vault namespace `<name>` is empty; populate it from the library viewer" message rather than failing silently.

### 3.4 Vault cryptography

- **Key derivation**: Argon2id with a per-vault salt stored alongside the encrypted entries.
- **Encryption**: AES-GCM, per-entry IV, authenticated.
- **Key cache**: derived key held in memory only; cleared on lock, on tab focus loss for >N minutes (current direction: 30), and on tab close. In headless mode the focus-based lifecycle is moot because there is no UI — see §7.3 for the environment-variable passphrase boundary that takes its place.
- **Lost passphrase recovery**: not built in. A forgotten passphrase wipes the vault contents; credentials must be re-entered from their source systems. This is intentional. Recovery mechanisms in client-only systems become attack surfaces.

*Specific Argon2id parameters (memory cost, iterations, parallelism) are deliberately not pinned here. They want a separate review pass against a current threat model rather than a guess in a design doc. The shape is fixed; the numbers are an implementation decision tracked in §11.8.*

---

## 4. Skill installation and permissions

Skill code, by design, runs with elevated privilege (vault, network, FSA, bus). **The privileged moment is installation, not invocation.** Trust is anchored when the code enters the library, not every time it executes.

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
- A diff against the existing version if installing an update.

The user accepts the entire dialog, or doesn't. No "install with reduced permissions" — if the user doesn't grant a permission, the skill doesn't install. The skill can then be edited (to drop the offending capability) and re-reviewed.

### 4.2 Permission tiers

Each skill declares its capabilities as a manifest. The runtime enforces these at every API boundary via the per-skill bound API proxies (§2.4); a skill that calls `fetch` to a domain not in its `network:` list fails the call.

| Permission | Declaration | Enforces |
|---|---|---|
| `compute` | Implicit (all skills) | Data manipulation only — no I/O |
| `network:<domains>` | List of origin patterns | `fetch` to those domains only |
| `vault:<namespace>` | Single namespace | Read/write that vault namespace only |
| `fsa:<patterns>` | Glob patterns | FSA operations under matching paths |
| `bus:<topics>` | Topic patterns (read, write, both) | Bus operations on matching topics |
| `idb:<store>` | Single document IDB store | Read/write that store in a single document context |

A skill that wants to `fetch` arbitrary URLs needs `network:*`, and the install dialog surfaces that as a wildcard with a stronger warning. Most legitimate skills are narrowly scoped (`network:api.wordpress.com`, `vault:wordpress-personal`) and the install UI presents this scoping clearly.

**Pattern syntax** for each tier (exact hostname vs. wildcard vs. path, glob vs. regex, write-vs-read scoping on bus topics) is security-load-bearing and deferred to v0.4 — see §11.10. v0.3 specifies the *shape* of declarations; the precise grammar is an open seam.

### 4.3 The back door is closed

Skills cannot install other skills. The `runtime.skills.install(...)` API is not exposed to skill code at all — only the library viewer (running in the host context with library-edit privilege) can call it. A self-modifying workflow (§6) cannot invoke a skill that adds a new skill, because no such skill can exist. The privilege boundary holds.

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
  concurrency: 'skip' | 'queue' | 'parallel',   // §5.4
  history_cap: 100,                             // per-workflow tunable; default 100
}
```

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

The graph is not text and is not edited as text. Serializing graphs to text and back through a text-edit protocol was considered and rejected — JSON round-tripping is fragile in LLM output, and the failure modes (a missing comma destroying half the graph) are exactly the ones a dedicated protocol prevents.

A document rwa with no `rwa_workflow` store dispatches `rwa-edit/1` as before. A workflow rwa dispatches `rwa-graph/1`. A hybrid rwa (prose + an embedded workflow) dispatches both, scoped to the part of the document the user's instruction targets — current direction is to route by what's in focus, with a fallback to a disambiguating prompt.

### 5.3 Execution semantics

Three trigger modes:

1. **Manual.** Open the file, click Run. The file is a viewable, editable artifact; execution is explicit.
2. **On open.** Opening the file executes the workflow. Powerful but security-sensitive — requires a clear consent dialog the first time a document opens with `on_open` trigger, with an "open without running" affordance.
3. **External trigger.** A scheduled (cron) or event-driven invocation from outside the browser. The workflow declares its intended trigger; actual scheduling is set up by the user on their OS (§7).

Current direction: ship **manual** first. Add **on open** when the consent UX is solid. **External trigger** is supported by the format from the start but requires the user's own OS-level setup.

**User-clicked Run is always treated as a manual run** regardless of the workflow's declared trigger. A workflow declared with `cron:*` can be schedulable *and* user-runnable; clicking Run in the viewer is a manual run, with the persistence semantics manual runs get (§6.2). The declared trigger is what the system uses to invoke the workflow autonomously; explicit user action is always treated as user action.

Within a run, execution is async and non-blocking. Each node returns a Promise; edges enforce ordering; the runtime walks the graph topologically. The visual representation highlights the currently-running node (or nodes, during a split). Errors halt the affected branch and surface in the visual; an `error`-kind edge on a node redirects failure to a recovery branch.

### 5.4 Concurrency

A workflow can be triggered while a previous run is still in flight (user re-clicks Run; cron fires while the previous run is still working). The runtime extends v0.10's BroadcastChannel-based modify-mutex into a **per-workflow execution mutex**:

- **`skip` (default)** — a new trigger while a run is in progress is ignored, with a log entry recording the skip.
- **`queue`** — new triggers queue up to a per-workflow cap; default cap is 3, after which further triggers are dropped. Queue is FIFO. The library viewer exposes a "cancel queued runs" affordance — a queued run can be removed before it starts, but an in-flight run cannot be cancelled mid-execution (skills have no general cancellation contract).
- **`parallel`** — new triggers start in parallel runs. Workflows opting in must declare their state usage is concurrency-safe (the runtime cannot verify this). Concurrent writes to the same `runtime.workflow.state` key are last-write-wins with no atomicity guarantee — workflows needing atomic state updates should not use `parallel`.

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
  history,                             // last N runs; N = workflow.history_cap (default 100)
};
```

`runtime.workflow.state` backs onto a reserved IDB store, `rwa_workflow_state`, and survives across runs, commits, and sessions. A workflow that polls an RSS feed writes seen IDs here; a workflow that summarizes a daily inbox writes the last-processed timestamp here.

Run history is structured. Each run logs trigger, start/end timestamps, status, and a per-node entry recording: skill invoked, input (with fields marked `sensitive: true` redacted), output presence and any non-sensitive output fields (with `sensitive: true` output fields redacted), duration, error if any. This makes the rwa its own audit log — open the file two months later and see what it has been doing.

Workflow authors can tune `history_cap` per workflow. A cron-every-5-minute workflow might want `history_cap: 500` to retain a useful window; a cron-once-daily workflow is fine with the default. History entries beyond the cap are dropped FIFO.

Skill input *and* output schemas may mark fields as `sensitive: true`. The runtime redacts marked fields in run history. Fork-on-share filtering uses the same flags: redacted fields are also excluded from any published variant of the document, even if history export is otherwise enabled (§9). Sensitivity is declared per field; carry-through from sensitive inputs to outputs was considered and rejected as too magical — skill authors mark output sensitivity explicitly.

### 5.6 Failure visibility

A cron-triggered workflow that fails at 3am needs to surface that failure to its user. The runtime writes failure events to a reserved store `rwa_workflow_notifications` (a queue, capped at 100; FIFO, newest at the top of the list, oldest dropped when capped), and:

- Surfaces them in the workflow's visual representation on next open (a badge on the relevant node, the latest failure expanded).
- Optionally emits to the OS notification system, where available (Chromium with the Notifications API + user permission).
- Optionally writes a structured log file to a user-configured FSA path (`~/Documents/rwa-logs/<workflow-name>.log`).

The latter two are opt-in per workflow. "Failure" includes: skill invocation errors, vault-locked errors, missing-skill errors, timeout, and quota-exceeded events from the cost model (§5.7).

### 5.7 Cost model

LLM calls cost money. A self-modifying workflow on cron is a runaway spend risk. The runtime tracks per-workflow token usage and enforces caps:

- **Token counting**: total tokens (input + output combined, summed across calls in a run). Different models are normalized to a common unit — current direction: count provider-reported tokens as-is; the cost model can be refined when local-LLM fallback (§11.7) lands.
- **Per-run cap**: maximum tokens per single invocation. Default: 100k. Workflow can declare higher.
- **Per-day cap**: maximum tokens across all runs in a 24-hour window. Default: 500k. Workflow can declare higher; user confirms at install if the declared cap exceeds the runtime's installation-confirmation threshold (default: 1,000,000 tokens/day, runtime-configurable).
- **Soft warning**: at 80% of either cap, the runtime surfaces a notification. Workflow continues.
- **Hard stop**: at 100% of either cap, the workflow halts (or the offending self-modification step is rejected). Resumes at the next reset boundary.

Token counts are recorded in the run history. The library viewer surfaces aggregate usage per workflow and per skill.

Local-LLM fallback (Ollama, llama.cpp, etc.) is an explicit design goal but not part of v0.3's spec — see §11.7.

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
- Subject to the rate limits in §6.3.

`scope: 'graph'` targets the workflow graph; `scope: 'document'` targets the document body (the runtime's `rwa-edit/1` protocol). Both target legitimate modification surfaces; *neither* targets the bootstrap, which remains inaccessible to the agent (v0.10 §5.4).

### 6.2 The commit gate, by trigger

This is the resolution of the headless-detection question: invariant 12 needs an enforcement mechanism, and the runtime cannot reliably tell whether a given Chrome launch was a user double-click or `cron` calling `open -a "Google Chrome"`. So the spec does not ask. It asks instead **what triggered the run** — which is declared in the workflow itself and is unambiguous at runtime.

**Self-modifications persist only when the run is initiated by the manual trigger and the user explicitly commits via ⌘S.**

Concretely:

- **Manual trigger.** The user clicks Run in the viewer. Self-modifications during the run land in IDB. The user can ⌘Z (walks the graph back) and ⌘S (persists to disk). Same semantics as a v0.10 document edit.
- **All other triggers (`on_open`, `cron:*`, `on_change:*`).** Self-modifications during the run land in IDB temporarily — the workflow can adapt within the run, and downstream nodes see the adapted graph. *At run end, the graph is reset from the inline snapshot.* The IDB workflow store is rehydrated from disk. ⌘S is not offered during an autonomous run.

Note that user-clicked Run is always treated as a manual run regardless of the workflow's declared trigger (§5.3). The trigger spec is what the system uses for autonomous invocation; explicit user action is always manual.

`rwa_workflow_state` (the data store) persists between runs as designed (§5.5). Only the workflow *structure* resets after a non-manual run.

This means:

- A cron workflow can adapt within a run and that adaptation affects the rest of the run.
- A cron workflow cannot drift across days. The agent does not gradually become a different agent without a human in the loop.
- The on-disk file is always the source of truth for what an autonomous workflow *is*. Reading the file tells you what the agent will do on its next autonomous run.
- Determinism: the same on-disk file launched autonomously a hundred times produces a hundred runs that all start from the same graph.
- A user who *wants* a scheduled adaptation to stick pulls up the workflow manually, clicks Run, lets it adapt, and ⌘S's. They are now in the loop.

Every other agent platform eventually accumulates drift. This design refuses the failure mode by construction, and the boundary is enforceable because triggers are declared rather than detected.

### 6.3 Self-modification rate limits

Two limits, both enforced by the runtime:

- **Per-run cap**: default 1 modification per run. Workflow can declare higher with user confirmation at install. Enforced in-memory during a run.
- **Per-24h cap**: default 10 modifications across all *manual-trigger* runs in a 24-hour window. Persisted in `rwa_workflow_state` under a runtime-reserved key so it survives sessions. Does not apply to non-manual runs, because their modifications don't persist anyway (§6.2) — the bound for autonomous runs is the per-run cap plus the cost model (§5.7).

Both caps surface in the library viewer's per-workflow statistics.

### 6.4 Hard constraints

These survive every other consideration:

- **Triggers cannot be modified by self-modification.** A `manual` workflow cannot, via the LLM, become an `on_open` workflow. Trigger changes go through `graph_set_trigger`, which `runtime.modify` does not authorize — only user ⌘K does.
- **The skill manifest cannot be expanded by self-modification.** A workflow cannot self-modify into using a skill its declared manifest doesn't include. The user-granted manifest from install time is the binding contract; self-modification works within it.
- **The bootstrap is sacrosanct.** Self-modification touches the graph in `rwa_workflow` (or the document body when `scope: 'document'`), never the runtime, the skill implementations, or the inline snapshot's structure. If the graph drifts into nonsense, reload — IDB hydrates from the snapshot.

---

## 7. Scheduling and headless execution

### 7.1 The format is the same

A workflow file is the same file regardless of how it's run. There is no "deploy to production" step. Authoring, testing, and scheduled execution all open the exact same `.html`. Only the *opener* differs. And, importantly, the persistence model is identical across openers (§6.2) — what changes is who initiated the run, which the workflow's trigger declaration already tells the runtime.

### 7.2 Three flavors of unattended execution

**A. Open in normal Chrome on a schedule.** `open -a "Google Chrome" workflow.html` from `cron` (Linux/macOS) or the equivalent on Windows Task Scheduler. Runs as the user, inherits logged-in browser state. A browser window appears at the scheduled time.

**B. Headless Chrome with a persistent profile.** `chrome --headless=new --user-data-dir=/path/to/profile workflow.html`. No window. Profile must be set up once with whatever credentials and vault state the workflow needs.

**C. A companion CLI.** Out of scope for this spec, but worth naming: an eventual `rwa run workflow.html` would wrap headless Chrome, handle vault unlocking from environment variables or an OS keychain, and surface logs in a CLI-friendly form. The format makes this possible; the format does not require it.

In all three flavors, persistence behavior is determined by the trigger, not by which flavor was used. A `cron:*`-triggered run is ephemeral in flavor A (despite Chrome thinking it's a normal session) and ephemeral in flavor B.

### 7.3 The vault for unattended runs

A scheduled run cannot prompt for the vault passphrase. Three options:

- **Environment variable.** The passphrase lives in the cron environment. Simple. Plaintext in a config file or shell rc. In this mode the vault key cache lifecycle (§3.4) is moot — the passphrase is supplied at process start, used for the run, and gone with the process.
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

Sub-workflow execution happens in an isolated iframe (§5.8 main spec; sandbox modes apply). Bus access is scoped to a **parent-prefixed sub-bus**: the sub-workflow sees topics under `<immediate_parent_id>/<topic>`, where `<immediate_parent_id>` is the parent's `DOC_UUID`. The prefix is *not* cumulative across nesting depths — a grandchild sees `<my_parent_id>/<topic>`, where its parent is itself a sub-workflow. Each level provides isolation from its grandparent: the grandchild cannot reach the grandparent's bus, only its immediate parent's sub-bus.

Parent and sub-workflow can communicate by convention through this sub-bus, but the sub-workflow cannot read or write the parent's other bus traffic. This closes the v0.1 review's concern about sub-workflows seeing all parent bus traffic, and makes nesting depth-safe: arbitrary nesting depths preserve per-level isolation.

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

Workflows declare required skills by name + major version. If a recipient lacks a required skill at the required major, the workflow opens read-only and the runtime offers to install or remap. A documented **common skill set** ships with the format — e.g. `http-get`, `http-post`, `send-email-smtp`, `save-to-file`, `read-from-rss` — workflows that stick to the standard set are portable; workflows that use exotic skills are recipient-specific. The exact membership of the common set is deferred.

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

§1 makes the format something that *is* an agent. Whether to say so on the box, and when, is the strategic question this spec leaves unresolved. Working position: **document-first**. The architecture is recognizably agentic but the natural audience opens documents, not deploys agents; the agent label invites comparisons (multi-tenancy, vendor support, telemetry) the format intentionally doesn't optimize for; the demonstration path is stronger anyway.

### 11.7 Local-LLM fallback configuration

A workflow declaring `model: 'local'` should route through a user-configured local endpoint. The configuration surface (a runtime settings panel? a well-known location in the library? a `local-llm.html` companion rwa?) is deferred. Also relevant: how token counting normalizes across providers when a single workflow mixes hosted and local LLM calls.

### 11.8 Vault crypto parameter pinning

§3.4 fixes the shape (Argon2id, AES-GCM, per-entry IV, in-memory key with TTL). Specific Argon2id parameters need a review pass against a current threat model. v0.4 will pin them or explicitly leave them implementation-tunable with a documented range.

### 11.9 Skill share file format

Skills exported individually as `.rwa-skill.json` artifacts (§4.1). The exact JSON envelope, the signature/integrity story (or its deliberate absence), and the install-from-share UX are unspecified. Current direction: a minimal manifest with no signature, treating skill imports the same way email attachments are treated (recipient reviews before accepting), but this needs design.

### 11.10 Permission pattern syntax

Each permission tier in §4.2 names a pattern target but not the pattern language:

- `network:<domains>` — exact hostname only? `*.wordpress.com`-style wildcards? Path components? Port handling? A too-loose syntax enables permission-escalation attacks (a left-unanchored `*.wordpress.com` would match `evil-wordpress.com.attacker.tld`).
- `fsa:<patterns>` — glob syntax? Against user disk, OPFS, or both? Interaction with the reserved `_<DOC_UUID>/` namespace.
- `bus:<topics>` — exact match? Wildcards? Separate read/write scoping?
- `idb:<store>` — current container's IDB only, or cross-container?

These are security-load-bearing. v0.4 specifies the precise grammar for each tier with explicit anti-escalation rules (no left-unanchored wildcards on network domains, mandatory anchoring on FSA path patterns, and so on).

### 11.11 Draft skill UI surface

§4.1 specifies that drafts can be test-invoked from the library viewer with `compute`-only permission. Several specifics are still open: are drafts visible across browser tabs (and if so, is there a tab-mutex on draft editing)? Can a draft test-invocation be cancelled mid-run? How are draft test results surfaced — inline in the viewer, in a separate console, or in the run-history store? v0.4 specifies the draft viewer UX.

---

## 12. Invariants (extended)

In addition to the v0.10 invariants:

8. The credential vault (`rwa_vault`) is scoped by user-declared namespaces, not by origin. Skills access only namespaces they were approved for at install time. Vault contents never serialize into any document's inline snapshot or shared variant.
9. Skills are local to the user, not to the document. A document declares intent; the local skill library provides capability. The library lives in a runtime-managed IDB store, not in any individual document.
10. Skill installation is the privileged moment. The runtime requires user review of skill code and permissions before adding a skill to the library. No path exists from running code to "the library now has a new skill" without user-mediated review. The library API that adds skills is not exposed to skill code.
11. Self-modifying workflows cannot grant themselves new skills, cannot change their own trigger, and cannot bypass the commit gate to persist graph changes without explicit user action via ⌘S.
12. **Self-modifications persist only when the run is initiated by the manual trigger** — user clicks Run in the viewer — *and* the user explicitly commits via ⌘S. All other triggers (`on_open`, `cron:*`, `on_change:*`) produce in-memory graph changes that discard at run end. Workflow state (`rwa_workflow_state`) persists across runs regardless of trigger; only workflow *structure* is bound by this rule. The runtime enforces the rule by inspecting the workflow's declared trigger, not by detecting headless mode.
13. The bootstrap continues to be the only immutable shell. Skills, workflows, vault, and their state all live in IDB and are subject to the same byte-identity rules as document state.
14. A workflow file is the same file in authoring, testing, and unattended (cron / headless) execution. Only the opener differs, and the persistence model is determined by the trigger, not the opener.
15. The server (share host, remote runtime, cron host, sync target) is convenience, not custody. Any feature that requires the server to remain available, trustworthy, or cooperative for the file to keep working is rejected.

---

*Draft v0.3 — resolves the headless-detection problem from the v0.2 review by committing to a by-trigger persistence boundary (§6.2, invariant 12), closes the calling-skill-identity gap (§2.4, §3.2, §4.2), extends sensitivity to output schemas (§2.1, §5.5, §9), pins sub-workflow nesting as per-level isolation (§8.2), and addresses the smaller specification gaps. New deferrals for v0.4: §11.10 (permission pattern syntax) and §11.11 (draft skill UI surface). Carry-over deferrals from v0.2: §11.1 (common skill set contents), §11.7 (local-LLM config), §11.8 (vault crypto parameters), §11.9 (skill share file format). Reference implementations do not yet exist; this document specifies behavior at the level needed to begin building, not at the level needed to ship.*
