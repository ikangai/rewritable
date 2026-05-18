# re-write-able: actions, skills, and workflows

*A design extension proposing what a re-writeable can do beyond modifying itself.*

*Draft v0.1 — proposes additions to spec v0.10. Intended to be merged into the main spec once the open questions in §10 settle.*

---

## 0. Why this exists

The base spec (v0.10) defines what a re-writeable is: a single `.html` file that renders itself, stores itself in IndexedDB, modifies itself through an embedded agent, and commits itself back to disk. The agent's role is bounded — it edits the document.

This extension proposes the next layer up. The same LLM that rewrites the document can take actions beyond the document — post to a blog, fetch an RSS feed, save to a file, send an email — when given a vocabulary of **skills** and (optionally) a **workflow graph** that orchestrates them. With those additions, a re-writeable can also be:

- A **tool** with action verbs (a document that can post itself to your blog)
- A **workflow** with a visual graph (a Yahoo-Pipes-style flow as a single HTML file)
- An **agent** with skills, memory, workflows, and the ability to rewrite its own workflow

These three are not three different formats. They are the same format with different content. A single rwa can be all of them at once.

The architectural pieces from v0.10 — bootstrap, document, IndexedDB stores, the bus, the LLM connection, the FSA commit flow — carry through unchanged. This extension adds:

- A **skill library** local to each user, holding capabilities and credentials
- A **workflow document type** that renders as a node graph
- A **trigger model** for when execution happens (manual, on open, scheduled)
- A **credential vault** separate from document state
- A **fork-on-share variant** for documents that carry state and capability

The constraint that does all the work in v0.10 — *one file, no server, no account, no install* — applies to every addition. Anything that requires relaxing it is rejected, here as elsewhere. **The server is convenience, not custody** (§9).

---

## 1. The agent realization

A re-writeable with self-modification (v0.10) plus skills plus workflows plus memory in IDB plus the ability to rewrite its own workflow satisfies every working definition of *agent*: it perceives (reads state), decides (LLM call), acts (skills), and remembers (IDB).

This is a recognition, not a redesign. The pieces compose without architectural disruption. What changes is the positioning — and that's a choice, not an architectural requirement. Three positioning paths exist:

**Document-first.** Present the format as documents that can rewrite themselves and (incidentally) carry workflows and skills. Trust model stays simple. Risk: under-sells what's actually here.

**Agent-first.** Present the format as the first portable agent file. Larger claim, larger upside. Risk: invites comparison with platform agents on dimensions the format isn't optimizing for (multi-tenant safety, telemetry, vendor support).

**Document-first now, agent-second later.** Ship the capability quietly. When the community builds genuinely agentic rwa's and shows them off, the agent label arrives by demonstration rather than by announcement. This is how spreadsheets became programming environments and HyperCard became a game engine.

This document specs the architecture. The positioning is a separate decision and is **not** what the spec settles.

---

## 2. Skills

### 2.1 What a skill is

A skill is a local capability that a re-writeable can invoke. Each skill carries:

- A **name** — stable identifier (e.g. `publish-to-blog`)
- A **description** — a sentence the LLM reads to decide if the skill applies
- An **input schema** — typed fields the skill accepts (`{ title, body, tags }`)
- An **output schema** — what the skill returns
- An **implementation** — JavaScript that runs in the browser, with access to fetch, FSA, OPFS, and the credential vault (§3)
- An optional **credential reference** — which vault entry the skill uses

Two contracts matter. The **interface** (name, description, schemas) is what documents see. The **implementation** is local to the user. A document declaring "I want to publish to a blog" matches against any local skill that satisfies the interface, regardless of what the implementation actually talks to (WordPress, Ghost, Mastodon, a static-site git push).

This is the same model as Claude's skill system and macOS "Open With" — the document carries intent; the host provides capability. The architectural consequence is that skills are portable across documents but specific to a user. A workflow file shared between two users still works for both of them, even if one routes `publish-to-blog` to WordPress and the other routes it to Ghost.

### 2.2 Where skills live

Skills live in the user's **skill library**, not in any individual document. The library is itself a re-writeable — `skills.html` — holding the user's complete set of skills as a structured collection. This has several useful properties:

- Skills travel as a single file. Backup, sync (via the user's choice of mechanism), share between machines.
- Skills can be edited the same way documents are. ⌘K to add a skill, describe it, the runtime generates the implementation.
- Skills compose. The library document can group, tag, search, and version them.
- The library is itself testable, viewable, ownable. Recursion of the format on itself.

The library publishes to the cross-container bus (§5.7 in the main spec) under a reserved topic, `skills:registry`. Documents that need a skill subscribe to the registry and resolve skills by name.

*[Verify: this introduces a second sibling rwa as load-bearing infrastructure. Worth deciding whether the skill library is "just another rwa using the bus" or whether the runtime should know about it more directly — e.g. a well-known location on disk, or a runtime API `runtime.skills.library` that handles discovery.]*

### 2.3 How skills are invoked

Three invocation paths:

1. **By name, from document JavaScript.** `await runtime.skills.invoke('publish-to-blog', { title, body })`. Direct and programmatic. Used when the document is essentially a script with a UI.
2. **By natural language, through the LLM.** The user presses a new keystroke — current direction: **⌘J** ("do"), distinct from **⌘K** ("edit") — and types intent. The LLM sees the list of available skills and their descriptions, picks one (or chains several), and invokes them. Used when the document is conversational, or when the user prefers intent over invocation.
3. **By graph, from a workflow.** A workflow node is a skill invocation; running the workflow runs the chain. See §4.

Skills always run with user consent. The runtime surfaces a confirmation prompt the first time a document invokes a given skill, with options to remember the choice for that document, that skill, or that pair. Repeated invocations within a session don't re-prompt. New documents do.

### 2.4 The trust model

Skills are code. They can do anything fetch, FSA, OPFS, and the credential vault can do. Trust is anchored at the skill library, not at the document.

- A document arrives saying "I want to publish to a blog." This is **intent**, not code.
- The runtime matches the intent against locally installed skills.
- The local skill — written, reviewed, and trusted by the user — does the work.
- The document never executes arbitrary capability code; it triggers locally trusted code with parameters.

The document's JavaScript is still scoped by whatever rendering isolation the runtime ends up using (§11.1 in the main spec). Skills run in the host context (the bootstrap's window) because they need the vault and the network. The bridge from document to skill is `runtime.skills.invoke(...)`, which is mediated by the runtime, validates the input schema against the skill's declared shape, and asks the user for consent.

The model is intentionally close to OS-level "Open With." The document declares *what* it wants; the user's environment decides *how* it happens. The recipient of a shared workflow that wants to "publish to a blog" never receives the publisher's credentials, nor the publisher's choice of blog platform — they receive an intent that resolves against their own skill library.

---

## 3. The credential vault

The OpenRouter key sits in `sessionStorage` (§10 in the main spec) — fine for one ephemeral credential. Skills need more: WordPress tokens, Mastodon credentials, GitHub PATs, OAuth refresh tokens, SMTP passwords. These must persist across sessions, must not serialize into any document's inline snapshot, and must not travel when a document is shared or published.

The vault is a separate IndexedDB database, `rwa_vault`, that:

- Lives outside any document's IDB namespace (it's per-origin, like sessionStorage)
- Is encrypted at rest with a passphrase the user sets once per browser
- Is **never** included in any document's inline snapshot during commit
- Is **never** included in any shared, published, or exported variant of a document
- Is accessible only through `runtime.vault.*` and only to skills that declare which entry they need

```javascript
runtime.vault = {
  set(key, value, { encrypted: true }),
  get(key),                            // returns null if locked
  has(key),
  unlock(passphrase),                  // returns Promise<boolean>
  lock(),
  status,                              // 'locked' | 'unlocked' | 'empty'
};
```

The vault has a hard rule that survives every other feature in this extension: **vault contents never leave the machine they were created on, regardless of how the containing document is shared or exported.** Fork-on-share, export, embed, bus publication — the vault is opaque to all of them. A skill that needs a credential on the recipient's machine triggers the recipient's vault, not the publisher's.

*[Verify: passphrase UX. A vault that prompts on every session is annoying; one that auto-unlocks is insecure. The likely answer is "unlock once per session, re-prompt after N hours of inactivity, surface lock/unlock in the runtime status," but this needs UX testing against real workflows. For headless/cron contexts, see §6.3.]*

---

## 4. Workflows

### 4.1 The workflow document type

A workflow re-writeable is a re-writeable whose primary content is a **directed graph** of skill invocations. The visual representation of the graph is the document's main rendered view. Editing the workflow — via ⌘K — modifies the graph in natural language ("add a step that filters out anything from before last Monday"; "split the email node into one for me and one for the team").

The graph lives in IndexedDB under a runtime-reserved store, `rwa_workflow` (added to the reserved store list in §5.3 of the main spec). Shape:

```javascript
{
  nodes: [
    {
      id: '7k3p2m9q',                  // shares the data-rwa-id namespace (§5.9)
      type: 'skill',                   // skill | primitive | input | output
      skill: 'fetch-rss',              // when type === 'skill'
      primitive: 'split',              // when type === 'primitive'
      config: { url: 'https://…' },
      position: { x, y },              // for visual layout
    },
    // …
  ],
  edges: [
    { from: nodeId, to: nodeId, predicate: null | '<expr>' },
  ],
  trigger: 'manual' | 'on_open' | 'cron:<expr>' | 'on_change:<bus_key>',
}
```

The workflow document's HTML renders the graph. Current direction: SVG with draggable nodes, drawn from the IDB state. The runtime exposes graph operations as a small API for rendering, but the source of truth is the IDB store — the graph survives commit/export and round-trips through the inline snapshot the same way any IDB-backed state does (§5.6 main spec).

### 4.2 Workflow primitives

A minimal complete set:

- **Sequence** — `A → B → C`. The natural shape; no explicit primitive needed (it's just two nodes with an edge).
- **Split** — one input fans out to N parallel branches. Each branch runs independently.
- **Merge** — N branches converge to one node. The merge node declares whether it waits for all, any, or a specific subset.
- **Loop** — a branch that returns to an upstream node, with an explicit termination condition.
- **Conditional** — branch by predicate. Realized as an edge attribute (`{ predicate: '<expr>' }`) rather than a node type. An edge with a falsy predicate at evaluation time is skipped.

Five primitives plus skills-as-nodes is sufficient to express any workflow people actually want. n8n's ~30 control nodes are sugar over this set. The LLM, when editing the graph in natural language, has fewer concepts to confuse. Less is more here.

Out of the box, the runtime ships:

- An **input** node type (entry point, parameterized at trigger time)
- An **output** node type (sink — captured into IDB or published to the bus)
- A **transform** primitive (a node taking a JS expression and applying it to its input — useful for shaping data between skills)

Anything else is a skill.

### 4.3 Execution semantics

Three trigger modes:

1. **Manual.** Open the file, click Run. Closest to current rwa semantics. The file is a viewable, editable artifact; execution is explicit.
2. **On open.** Opening the file executes the workflow. Powerful but security-sensitive — a workflow that fires API calls on open is structurally closer to a virus than to a document. Requires the runtime to surface a clear warning the first time a document opens with `on_open` trigger, with a one-click "open without running" affordance.
3. **External trigger.** A scheduled (cron) or event-driven invocation from outside the browser. The workflow declares its intended trigger; actual scheduling is set up by the user on their OS (§6.3).

Current direction: ship **manual** first. Add **on open** when the consent UX is solid. **External trigger** is supported by the format from the start but requires the user's own OS-level setup.

Within a run, execution is async and non-blocking. Each node returns a Promise; edges enforce ordering; the runtime walks the graph topologically. The visual representation highlights the currently-running node (or nodes, during a split). Errors halt the affected branch and surface in the visual; an explicit `error` edge on a node redirects failure to a recovery branch.

### 4.4 State across runs

Workflows triggered repeatedly often need to know what they've seen before. The runtime exposes a per-workflow state store:

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

The state store backs onto a reserved IDB store, `rwa_workflow_state`. It survives across runs, commits, and sessions. A workflow that polls an RSS feed and emails new items writes the seen IDs here; one that summarizes a daily inbox writes the last-processed timestamp here.

Run history is structured: each run logs its trigger, start/end timestamps, status, and a per-node summary. This makes the rwa its own audit log — open the file two months later and see what it has been doing. With self-modification (§5), the undo stack and the run history together become a full behavioral record.

---

## 5. Self-modifying workflows

A workflow that modifies its own graph is qualitatively different from one that just runs. It's adaptive: it can change its own approach based on what it has learned. This is the point where the format becomes recognizable as an agent in the strong sense.

The mechanism is straightforward: the workflow's own ⌘K targets the graph (it's just IDB state, like any other document content). What's new is that a *running node* can also invoke ⌘K programmatically, via `runtime.modify(instruction)`. A node late in the chain might decide "the upstream skill keeps failing — replace it with the fallback" and ask the LLM to rewrite the relevant edges.

This is powerful and dangerous in the same gesture. The safety properties already in v0.10 carry most of the load:

- The **undo stack** is the agent's behavior log. Every self-modification pushes the prior graph onto `rwa_undo`; ⌘Z walks it back.
- The **visual graph** is the readable representation of what the agent has become. Drift shows up as a graph that doesn't match the user's expectations — not "weird behavior in a logfile," but "the picture on screen no longer makes sense."
- The **bootstrap is sacrosanct.** Self-modification touches the graph in `rwa_workflow`, never the runtime or the skill invocations. If the graph drifts into nonsense, reload — IDB hydrates from the last committed snapshot.
- The **commit gate** means drift is not durable until the user accepts it. A workflow can rewrite itself a hundred times in a session, but unless the user ⌘S's, the file on disk is unchanged.

A few stricter constraints, specific to self-modifying workflows, are worth adding:

- **A workflow cannot modify its own trigger via self-modification.** A `manual` workflow cannot, via the LLM, become an `on_open` workflow. Trigger changes require explicit user action through the UI.
- **A workflow cannot grant itself new skills via self-modification.** It can rewire which skills it calls, in what order, with what arguments — but cannot invent or install capability.
- **Self-modification is rate-limited per run.** Default: at most one self-modification per run, with the user able to lift the cap explicitly. Prevents runaway loops where the workflow modifies itself, runs, modifies itself again.

These are floors, not features. They keep self-modification from becoming an autonomy escape hatch.

---

## 6. Scheduling and headless execution

### 6.1 The format is the same

A workflow file is the same file regardless of how it's run. There is no "deploy to production" step. Authoring, testing, and scheduled execution all open the exact same `.html`. Only the *opener* differs.

### 6.2 Three flavors of unattended execution

**A. Open in normal Chrome on a schedule.** `open -a "Google Chrome" workflow.html` from `cron` (or the equivalent on Windows Task Scheduler). Runs as the user, inherits logged-in browser state, uses the local vault. A browser window appears at the scheduled time. Fine on a dedicated machine; mildly disruptive on a laptop.

**B. Headless Chrome with a persistent profile.** `chrome --headless=new --user-data-dir=/path/to/profile workflow.html`. No window. Profile must be set up once with whatever credentials and vault state the workflow needs. The "real" automation answer; mildly fiddly.

**C. A companion CLI.** Out of scope for this spec, but worth naming: an eventual `rwa run workflow.html` would wrap headless Chrome, handle vault unlocking from environment variables or an OS keychain, and surface logs in a CLI-friendly form. The format makes this possible; the format does not require it. *[Verify: whether this CLI lives in the same repo as the spec, a sibling repo, or is left as an exercise for the community.]*

### 6.3 The vault for unattended runs

A scheduled run cannot prompt for the vault passphrase. Three options, each with tradeoffs:

- **Environment variable.** The passphrase lives in the cron environment. Simple. Plaintext in a config file or shell rc.
- **OS keychain.** The runtime, in headless mode, fetches the passphrase from macOS Keychain / GNOME Keyring / Windows Credential Manager. More secure; requires per-OS integration code.
- **Unattended-mode vault.** A second, less-protected vault that holds only credentials the user has explicitly marked as headless-safe. Reduces blast radius; adds a concept users have to understand.

Current direction: ship environment-variable support as the v1 answer (documented as "for trusted machines only"), and add keychain integration as the runtime matures.

---

## 7. Composition

### 7.1 Skills + workflows + the bus

The cross-container bus from v0.10 (§5.7) becomes much more powerful with skills and workflows in play. A workflow can:

- Read inputs from `runtime.shared.get('source:topic')`
- Subscribe to bus changes as an event trigger (`trigger: 'on_change:<bus_key>'`)
- Publish outputs to the bus for other workflows to consume

This is the Unix-pipe model at the rwa scale. Small workflows that do one thing, composed by file references and bus topics. Drop two workflow files in the same folder; one writes to `flow-a:results`, the other subscribes — a pipeline assembled by drag-and-drop. No service mesh, no API gateway, no orchestrator. Two files and the local-disk bus.

### 7.2 Workflows referencing other workflows

A workflow node can be another workflow file (referenced by path or URL). The runtime resolves the reference, embeds the sub-workflow's input/output schema, and chains accordingly. Sub-workflow execution happens in an isolated iframe (§5.8 main spec; sandbox modes apply), so it cannot reach into the parent's IDB except through the bus.

This is the workflow analog of macro/subroutine. Useful for reusable chunks ("the fetch-clean-summarize pipeline I use everywhere") without inlining them into every parent.

---

## 8. Fork-on-share for tools and agents

Fork-on-share (per the [`fork-on-share`](https://www.ikangai.com/fork-on-share/) commitment of the document model) works straightforwardly for documents: the file is the seed, the recipient gets a sovereign copy, no write-back to the publisher. For workflows and agents, the principle is the same but the seed has to be more careful about what travels.

The publish flow asks the publisher what to include:

- **Always included.** The workflow graph, skill references (by name, not by implementation), document content, configuration constants.
- **Never included.** The vault. Anything in `rwa_vault`. Run history entries that captured potentially sensitive parameters.
- **Publisher's choice.** Workflow state (`rwa_workflow_state`) — useful for "preloaded" templates (a workflow that ships with example seen-items already in state), dangerous for credentials that may have been cached in state during a previous run.

The default is conservative: state out, vault out, history out. The recipient receives a fresh agent with the same shape and no inherited memory.

This is critical for the trust model. A workflow that arrives at a recipient must be transparent about what it carries. The publish step is an explicit boundary; the runtime surfaces the contents of the seed before it leaves the publisher's machine. *Fork-on-share for agents preserves the load-bearing claim of the document version — that what arrives is fully owned by whoever opens it — only if no secrets and no inherited state cross the boundary except by explicit publisher choice.*

---

## 9. The "you stay in control" framing

The whole construction earns a single-sentence pitch: **the server is convenience, not custody.**

- A share URL is convenience for getting the file to a recipient; once they ⌘S, it's theirs.
- A remote rwa hosted on the web is convenience for accessing a tool without installing anything; copying it locally makes the remote optional.
- A scheduled cron run is convenience for unattended execution; moving the file to a different machine tomorrow keeps it running.
- A skill library shared between machines is convenience for portability; the skills run locally regardless.

None of these conveniences doubles as a leash. Compare to platform agents — Zapier, n8n SaaS, IFTTT, Custom GPTs, vendor-hosted automations — where convenience and leash are the same thing. You cannot have the tool without the platform's continued cooperation.

The rwa with skills and workflows brings the "documents you own" property of v0.10 to the agent layer. The agent is the file. The file is yours. Email it. Copy it. Fork it. Read its source. Audit its undo stack. The agent has no edges that aren't the file. Every other agent infrastructure today is, in this sense, *rented* — your relationship with your own agent is mediated by a custodian who can change its mind. The rwa form refuses the custodian.

This is not a feature comparison. It is a structural difference. Platform agents and file-agents are different categories of thing.

---

## 10. Open questions

### 10.1 Skill discovery between machines

If skills live in a per-user library, how does a workflow author know which skills the eventual recipient has? Options:

- The workflow declares its required skills by name and version; the recipient's runtime warns about missing ones.
- A documented **common skill set** ships with the format (something like a small core: `http-get`, `http-post`, `send-email-smtp`, `save-to-file`, `read-from-rss`). Workflows that stick to the standard set are portable; workflows that use exotic skills are recipient-specific.
- A skill marketplace / index exists, from which workflows can pull skill definitions on first run. *This conflicts with the "no install" principle and is probably not the right answer.*

Current direction: explicit declaration plus a documented common set.

### 10.2 What counts as a "skill" vs. a primitive

`http-get` could be a skill (lives in the library, user-replaceable) or a primitive (lives in the runtime, universal). Where to draw the line?

A reasonable rule: primitives are *pure* (no network, no credentials, no side effects beyond the workflow's own IDB). Skills are everything else. Under this rule, `http-get` is a skill (it touches the network); `transform` and `filter` are primitives (they shuffle data in-memory).

### 10.3 Multi-user agents on shared machines

A workflow scheduled via cron on a shared Linux box runs as one user. Whose vault does it use? Whose skill library? Current direction: whichever user's profile cron is running under. Multi-user automation on a shared host is a known unaddressed case; the single-file rule survives by saying "this is one user's tool."

### 10.4 The schedule UI

A workflow that wants to be cron-triggered has to live with a cron job somewhere on the user's OS. Setting up that cron job is the user's problem today. Reasonable future work: the workflow file declares its intended schedule, and a companion script (or the future `rwa` CLI) installs it. But this drifts toward "the format requires a helper to be fully usable," which weakens the single-file property. Current direction: keep schedule setup out of the format and document the OS-level commands clearly.

### 10.5 What ships first: workflows or skills

The two extensions are independent. Skills are useful without workflows (a press release that can post itself). Workflows are useful without custom skills (a chain of built-in primitives plus the documented common skill set). Current intuition: **skills first**, since they earn their keep in a single-document context and don't require the more complex visual UI of a graph. Workflows benefit from the skill substrate being in place when they arrive.

### 10.6 The agent label

The architectural realization in §1 makes the format something that *is* an agent. Whether to say so on the box, and when, is the strategic question this spec leaves unresolved. It is not an engineering question and the answer doesn't change the architecture. But the answer changes who the format's audience is, what it gets compared to, and what kind of scrutiny it invites. The spec's job is to keep the option open. The pitch's job is to choose.

---

## 11. Invariants (extended)

In addition to the v0.10 invariants:

8. The credential vault (`rwa_vault`) is per-origin, encrypted at rest, and never serializes into any document's inline snapshot or shared variant.
9. Skills are local to the user, not to the document. A document declares intent; the local skill library provides capability.
10. Self-modifying workflows cannot grant themselves new skills, cannot change their own trigger, and cannot bypass the commit gate to persist changes without user action.
11. The bootstrap continues to be the only immutable shell. Skills, workflows, and their state live in IDB and are subject to the same byte-identity rules as document state.
12. A workflow file is the same file in authoring, testing, and unattended (cron / headless) execution. Only the opener differs.
13. The server (share host, remote runtime, cron host, sync target) is convenience, not custody. Any feature that requires the server to remain available, trustworthy, or cooperative for the file to keep working is rejected.

---

*Draft v0.1 — first complete sketch of the action layer. Builds on spec v0.10. Substantive open questions remain in §10; positioning (§1, §10.6) is unresolved and is explicitly outside the scope of the architecture. Reference implementations do not yet exist; this document specifies behavior at the level needed to begin building, not at the level needed to ship.*

*Items flagged for verification against the working code or against author intent: §2.2 (skill library as sibling rwa vs. runtime-known location), §3 (passphrase UX), §6.2 (CLI repo placement). These are the open seams worth resolving before v0.2.*
