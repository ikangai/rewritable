# re-write-able actions, skills, and workflows — v0.7

*The cluster pass: §11.9 provenance and skill share file format, §11.10 permission pattern syntax, §11.12 full Worker-mode design, plus four v0.6.1 carry-overs. Written against the dialog-first working method specified in the v0.7 working-method documents (preamble, addendum, patch r1, patch r2). The dialog comes first; architecture is what makes the dialog's sentences true.*

---

## 0. What this revision delivers

v0.7 closes the three deferred design seams in the action layer:

- **§11.9** — how a skill travels between machines. The `.rwa-skill.json` envelope, source identity, signature optionality, install-count tracking, lookalike detection.
- **§11.10** — what permission patterns can express, and what they cannot. Grammar for each tier with explicit anti-escalation rules.
- **§11.12** — Worker-mode skills, end to end. Spawning, in-Worker globals, host CSP, message-passing contract, pool lifecycle, forced-Worker policy.

It also lands the four v0.6.1 carry-overs:

- Worker pool full lifecycle, including the `pool: false` shutdown contract.
- Idle timeout commitment with concrete defaults.
- Lens lock cross-reference in §5.4.
- Dialog pool-behavior disclosure, designed inside the cluster's drafting cycles.

After v0.7 the action layer is implementable end to end. The remaining open questions (§11.1 common skill set contents, §11.7 local-LLM configuration, §11.8 Argon2id parameter pinning) are independent design passes that don't gate implementation.

This revision is longer than its predecessors in absolute terms. The trajectory of "shorter per feature as the spec gets more precise" doesn't apply here because the cluster is doing three interlocking architectural sections plus a UX surface in coordination. The length is the cost of doing the cluster correctly; the alternative — a shorter v0.7 that produces an unreadable install dialog — is the more expensive outcome.

---

## 1. The install dialog (the design driver)

The working method makes the install dialog a co-constraint on the architecture, not a downstream consumer of it. The architectural commitments in §2 through §5 below are designed to make the dialog's sentences both true and short. This section reproduces the dialog as designed; what follows is the architecture that delivers it.

### 1.1 The primary case: imported `.rwa-skill.json` from downloads

When the user opens an imported skill file in the library viewer, the install dialog renders as follows. (Concrete example: a `publish-to-blog` skill that declares vault and network permissions and was authored by a signed source the user hasn't installed from before.)

---

**Install `publish-to-blog`?**

**What it claims to do:** *"Publishes blog posts to WordPress sites."*

**Author**
Published by **Acme Skills** (`ak-7a92cf...`).
First skill you're installing from this source.

**What it can do on your machine**

- Read and write WordPress credentials (stored under `wordpress-personal`).
- Make network requests to `api.wordpress.com`.

These are the limits the runtime will enforce. Within these limits, the skill's code decides what to do.

⚠ **Combination to review**: This skill can both read your stored credentials and make network requests. A skill with this combination can send credentials to its allowed destination — intentionally or by mistake.

**Notes from the runtime's code review**

- `setTimeout` is called with a string argument (line 47). The runtime's permission manifest does not constrain this; review what's being scheduled.

**How it will run**

*Stronger isolation* (recommended for skills from outside your library).
The skill's author tested only the less-isolated mode. Most skills work either way; some may not.

[Switch to less-isolated mode]

**Memory between uses**

This skill keeps internal state between uses within a browser session. State is discarded when you close the browser.

---

**The runtime shows you what this skill *can* do. It cannot tell you whether it *should* do it.**

Before installing, confirm:

- The skill's stated purpose (*"Publishes blog posts to WordPress sites"*) matches what you want.
- The capabilities listed above are appropriate for that purpose.
- You have reviewed the code, or you trust the author enough to install without reviewing.

[I have reviewed this skill and want to install it] [Cancel]

---

### 1.2 Variant cases

The primary case is the hardest. The variants inherit from it with focused changes.

**⌘K-generated skills (library authoring).** Same dialog structure, with the **Author** section replaced by *"This skill was created by you in the library viewer on [date]."* The execution mode defaults silently to the author's declared mode (no "stronger isolation recommended" recommendation, since the author is the user). The capability scan still runs and renders. The "Before installing" prompts remain — the LLM is the proximate code source even when the user described what to build, and review still applies.

**In-place edits.** Same as ⌘K-generated, with the **Author** section showing *"This skill was previously created by you. You are editing it."* If permissions changed, the dialog renders the expansion the same way Shape C handles it for imports (§1.3 below).

**Updates to installed skills.** Same dialog structure, with an additional **Changes from the installed version** section between **What it can do** and **Notes**:

> **Changes from `publish-to-blog` v1.1.0 (installed Apr 12) to v1.2.0:**
>
> - **Adds network access** to `analytics.tracker.com`.
> - Modifies output schema: adds optional field `tracking_id` to the result.

Capability expansions render as prose, not as JSON diffs. Schema changes render as prose. Adds and removes are explicit, never inferred.

**Mode-mismatch rejection** (a skill declares `execution: 'worker'` against a runtime without Worker support, per §4.1 from v0.6.1). Different surface — not an install dialog but a rejection screen. Renders as:

> **Cannot install `publish-to-blog`**
>
> This skill is built for the runtime's **stronger isolation** mode, which this version of the runtime does not support.
>
> You can:
>
> - Install a runtime version that supports stronger isolation.
> - Edit the skill to use less-isolated mode (review the code first — the author tested only stronger isolation).
>
> [Edit the skill] [Cancel]

**Forced-Worker × `tested_modes` mismatch** (a skill with a permission combination that forces Worker mode but was tested only in default mode, per §4.1). Same rejection-surface shape:

> **Cannot install `publish-to-blog`** *(yet)*
>
> This skill's permission combination — credential access plus network access — requires stronger isolation. The skill's author tested only the less-isolated mode.
>
> You can:
>
> - Edit the skill to declare and test in stronger isolation.
> - Decline to install.
>
> Installing without testing in stronger isolation may produce unexpected behavior.
>
> [Edit the skill] [Cancel]

**Unsigned skill imports.** Same primary dialog with the **Author** section replaced by *"Published by **(unsigned skill file)**. The runtime cannot verify the author or whether the skill has been modified since publishing."* The "first skill from this source" / "you've installed N skills from this source" familiarity signals do not appear for unsigned skills; there is no source identity to count against. Mode pre-selection is still **stronger isolation** for unsigned imports — perhaps especially so.

### 1.3 What the dialog does *not* do

The dialog does not display permission narrowness as a safety signal. The dialog does not endorse the skill's declared purpose. The dialog does not claim defense against the skill misusing its allowed capabilities — that's the Shape B limit (§6 below), and the language *"The runtime shows you what this skill can do. It cannot tell you whether it should do it"* makes the limit explicit.

The dialog does not require comprehension tests, mandatory wait timers, or other friction theater. The closing prompts ask the user to confirm three things; the affirmation button labels the install action as a review. Beyond that, the format's contract is with whoever does the review.

---

## 2. §11.9 — Provenance and the skill share file format

The dialog's **Author** section commits to specific architectural choices: a stable source identity that survives renames, signature optionality with distinct rendering for unsigned skills, install-count tracking against the durable identity, and lookalike detection against names of trusted sources. This section specifies them.

### 2.1 The `.rwa-skill.json` envelope

A skill share file is a JSON document with the following shape:

```json
{
  "format": "rwa-skill/1",
  "skill": {
    "name": "publish-to-blog",
    "version": "1.2.0",
    "description": "Publishes blog posts to WordPress sites.",
    "input_schema": { /* ... per §2.1 of v0.6 */ },
    "output_schema": { /* ... per §2.1 of v0.6 */ },
    "permissions": { /* ... per §11.10 below */ },
    "execution": "default",
    "tested_modes": ["default"],
    "pool": true,
    "vault_namespace": "wordpress-personal",
    "implementation": "/* the skill's JavaScript */"
  },
  "source": {
    "name": "Acme Skills",
    "public_key": "<base64 Ed25519 public key>",
    "metadata": { /* optional, runtime-ignored */ }
  },
  "signature": "<base64 Ed25519 signature over the skill object>"
}
```

The `source` and `signature` fields are optional. When both are present, the runtime verifies the signature against the public key over the canonical encoding of the `skill` object. Successful verification produces a *signed import*. Either field missing or verification failure produces an *unsigned import*.

The runtime does not maintain a registry of trusted sources. There is no central authority. The signature only proves the skill came from whoever holds the matching private key; what that key represents in the world is up to the human reviewer.

### 2.2 Source identity

The durable identifier of a source is its **public key**, not its name. The runtime tracks per-source state (install counts, name history) keyed against the key.

The name is human-readable but technically advisory. Two skills with the same public key are from the same source even if their names differ; two skills with different public keys are from different sources even if their names match. The dialog renders the name prominently because it's what humans read; the runtime's internal accounting uses the key.

Each source's state in the runtime, scoped per-origin in a runtime-reserved IDB store `rwa_sources`:

```javascript
{
  public_key: "<base64>",
  current_name: "Acme Skills",
  name_history: ["Acme Skills"],              // grows on rename
  first_seen: <timestamp>,
  installs_total: 4,
  installs_current: 3,                         // not yet uninstalled
  last_install_at: <timestamp>,
}
```

The dialog's "First skill you're installing from this source" / "You've installed N skills from this source, all still installed" / "You've installed N skills from this source over time, M still installed" come from this record.

When a source's name changes (the same public key appears with a different name), the dialog renders this distinctly: *"Published by **Acme Skills Co.** (formerly Acme Skills, `ak-7a92cf...`)."* Name history is visible because rename-as-attack is part of the threat model — a previously-trusted source might be compromised and renamed to look like a different entity.

### 2.3 Lookalike detection

When a new (previously-unseen) public key arrives with a name that resembles the name of an existing trusted source — a known trusted source being any source with `installs_current > 0` — the runtime surfaces a lookalike warning in the dialog. Resemblance is detected via:

- **Normalized string comparison** (case-folded, whitespace-collapsed) for exact-match.
- **Unicode confusable detection** using the Unicode confusables data (Cyrillic 'а' for Latin 'a', Greek 'ο' for Latin 'o', and so on) — if names match after applying confusable folding, they're flagged.
- **Edit-distance** under a threshold (current direction: edit distance ≤ 2 on names of 8+ characters) to catch near-misspellings.

The dialog renders this as a strong warning at the **Author** section: *"⚠ This source name closely resembles **Acme Skills**, from whom you've installed 3 skills previously. The cryptographic identity is different. This may be a typo by a different author, or it may be an attempt to look like a source you trust."*

Lookalike detection covers the easy half of Shape D (visual confusion against known sources). It does not cover genuine novel-source attacks where the source has no resemblance to a trusted one — those have no signal to act on, and the dialog's "first skill from this source" treatment is the only response.

### 2.4 Canonical encoding for signatures

Signatures cover the JSON canonical encoding (per RFC 8785, JSON Canonicalization Scheme) of the `skill` object. This produces stable signatures across whitespace, key-order, and other syntactic variations.

The runtime does not sign skills it generates. Library-authored skills (⌘K, in-place edits) have no source / signature fields when exported via "save as `.rwa-skill.json`"; the recipient sees them as unsigned imports. Signing requires private key material the runtime doesn't manage; a future skill-signing tool can be a companion utility (out of scope for v0.7).

### 2.5 Why unsigned imports are allowed

Making signatures mandatory would require infrastructure — a signing tool, key management practices, a body of signed skills — that doesn't exist at the time the format is shipping. Mandatory signatures would block useful adoption (peer-to-peer skill sharing, hobbyist authoring) without commensurate security benefit, because a mandatory signature against a key the recipient has no basis to evaluate is no better than no signature.

The dialog handles unsigned imports honestly: they're rendered with weaker provenance language, the source-counting signals are absent, and Worker mode is pre-selected. The recipient knows what they're getting and what they're not. v0.8 can revisit the signing infrastructure once there's a body of skills to sign and a practice for what the keys mean.

---

## 3. §11.10 — Permission pattern syntax

The dialog's **What it can do** section renders permissions in plain English: *"Read and write WordPress credentials,"* *"Make network requests to api.wordpress.com."* For this to be true and short, the underlying patterns must be (a) constrained enough that the runtime can summarize them in one sentence, (b) anti-escalation by construction, and (c) compoundable in named categories rather than as free-form combinations.

This section specifies the grammar for each tier.

### 3.1 Anti-escalation by construction

Every permission pattern in v0.7 is **left-anchored** and **typed** to its tier. Free-form patterns, regex, or unanchored wildcards are not permitted at any tier. The grammar refuses constructs that would let a narrow-looking pattern match unintended targets.

Specifically:

- No left-unanchored wildcards anywhere. `*.wordpress.com` is left-anchored to `*.` matching a single subdomain label, not "anything ending in wordpress.com." `*wordpress.com` is not a valid pattern; it would have matched `evilwordpress.com`.
- No path-level matching on network permissions. `network:` specifies origins (scheme + host + port); paths and query strings are unconstrained by the permission. A skill with `network:api.wordpress.com` can fetch any path on that origin; it cannot fetch from `api.wordpress.org`.
- No cross-tier patterns. `vault:` is exact-string-match only; it cannot use wildcards. The closest to a wildcard is `vault:*`, which means "any vault namespace" and is rendered with the strongest install-time warning.

### 3.2 `network:<pattern>`

**Grammar.** Each `network:` declaration is a list of origin patterns. An origin pattern is:

- An **exact origin**: `https://api.wordpress.com`, `https://api.wordpress.com:8443`. Scheme is required (`http` or `https`); port is optional and defaults to the standard port for the scheme.
- A **single-label wildcard**: `https://*.wordpress.com` matches any direct subdomain (`https://api.wordpress.com`, `https://blog.wordpress.com`) but not deeper subdomains (`https://foo.api.wordpress.com` does not match). The wildcard binds exactly one label.
- A **multi-label wildcard**: `https://**.wordpress.com` matches `wordpress.com` itself plus any depth of subdomains. Rendered with stronger install-time warning than single-label wildcards.
- The **catch-all**: `https://*` (any HTTPS origin) or `*` (any origin including HTTP). Rendered with the strongest install-time warning. Equivalent to declaring "this skill can make network requests to anywhere."

The scheme is part of the match. A skill with `https://api.wordpress.com` cannot use HTTP to the same host.

**Anti-escalation rules:**

- `*` without a scheme prefix is invalid; use `*` only as the explicit catch-all.
- `**` is only valid as a left-anchored multi-label wildcard prefix.
- IP addresses are matched as exact origins; IP wildcards are not supported (no `192.168.*.*`).
- `localhost` and `127.0.0.1` are exact origins like any other; they have no special treatment.

**Dialog rendering:**

- Exact origin → *"Make network requests to `api.wordpress.com`."*
- Single-label wildcard → *"Make network requests to any direct subdomain of `wordpress.com` (such as `api.wordpress.com` or `blog.wordpress.com`)."*
- Multi-label wildcard → *"⚠ Make network requests to `wordpress.com` and any subdomain at any depth. This is broad — review whether the skill needs this much network reach."*
- Catch-all → *"⚠ Make network requests to **any domain on the internet**. The runtime cannot tell you where this skill will send data. Review the code carefully."*

### 3.3 `vault:<namespace>`

**Grammar.** Each `vault:` declaration is a single namespace string. No wildcards within a namespace. No multiple namespaces in one declaration; a skill needing two namespaces declares `vault:` twice.

The special declaration `vault:*` means "any vault namespace" and is reserved for a category of skills (vault administration, backup) that need it. It is rendered with the strongest install-time warning.

Namespace strings are constrained: lowercase ASCII letters, digits, hyphens, underscores. Maximum 64 characters. No leading or trailing hyphens. This keeps namespaces stable across normalization and prevents Unicode confusables in namespace identifiers themselves.

**Anti-escalation rules:**

- No partial wildcards: `vault:wordpress-*` is invalid. A skill that wants two related namespaces declares each.
- The namespace string is matched exactly. `vault:WordPress-Personal` and `vault:wordpress-personal` are different namespaces; case sensitivity is enforced.

**Dialog rendering:**

- Single namespace → *"Read and write credentials stored under `wordpress-personal`."*
- Multiple namespaces → *"Read and write credentials stored under `wordpress-personal` and `mastodon-mty`."*
- `vault:*` → *"⚠ Read and write credentials stored under **any** vault namespace. This skill can access every credential you've stored, regardless of what it claims to do. Use only for vault administration."*

### 3.4 `fsa:<pattern>`

**Grammar.** FSA patterns are anchored glob patterns against a user-declared FSA root. The root is selected during install (the dialog prompts the user to grant FSA access to a directory the skill will operate within); the skill's patterns are relative to the root.

Glob syntax:

- `*` matches any sequence of characters within a single path segment.
- `**` matches any sequence of characters including path separators (multi-segment match).
- Path separators are `/`; the runtime normalizes Windows backslashes before matching.
- Patterns must begin with a path component or `**` — they cannot begin with `*` alone.

**Anti-escalation rules:**

- No leading `*` without a path anchor. `*.md` is invalid; `documents/*.md` or `**/*.md` is valid.
- No path-traversal: patterns containing `..` are rejected at install time.
- Read scope and write scope are separately declared: `fsa:read:documents/**` allows reading anywhere under `documents/`; `fsa:write:documents/blog-drafts/**/*.md` allows writes only to markdown files under `documents/blog-drafts/`.

**Dialog rendering:**

- Read pattern → *"Read files matching `documents/**/*.md` (markdown files anywhere under the `documents` folder you selected)."*
- Write pattern → *"Write files matching `documents/blog-drafts/**/*.md` (markdown files under `documents/blog-drafts/` in the folder you selected)."*
- Combined → both lines shown.
- Broad patterns (e.g. `fsa:write:**/*`) → rendered with stronger warning treatment.

### 3.5 `bus:<topics>:<scope>`

**Grammar.** Bus permissions are `bus:<topic-pattern>:<scope>`, where scope is `read`, `write`, or `both`.

Topic patterns:

- Exact topic: `bus:flow-results:read`.
- Single-label suffix wildcard: `bus:flow-*:read` matches `flow-results`, `flow-status`. The wildcard is a *single segment*; topics with separators (`bus:flow-results:detail`) are different.
- Catch-all: `bus:*:read` is rendered with the strongest warning.

Read and write are explicitly separated. `bus:topic:both` is shorthand for the two declarations.

**Anti-escalation rules:**

- No leading wildcards: `bus:*-results:read` is invalid.
- The reserved namespace `skills:*` (§2.2 of v0.6) cannot be declared by skills under any scope; the runtime is the only writer.

**Dialog rendering:**

- Read scope → *"Read messages from bus topic `flow-results`."*
- Write scope → *"Write messages to bus topic `flow-results`."*
- Both → combined line.
- Wildcards → warning rendering scaled to wildcard breadth.

### 3.6 `idb:<store>`

**Grammar.** A single IDB store name in the running container's IDB. No wildcards. No cross-container access (per §8.2 of v0.6).

**Anti-escalation rules:**

- No wildcards: `idb:my-*` is invalid.
- Store name matches exactly; the runtime-reserved `rwa_*` prefix is forbidden.

**Dialog rendering:**

- *"Read and write the IndexedDB store `recipes`."*

### 3.7 Recognizable combinations

The runtime maintains a curated list of permission combinations that produce emergent risk beyond the sum of the individual permissions. The list inherits §4.1's capability-scan curation pattern: runtime-maintained, grows with attack discovery, surfaces to the install dialog as named callouts.

Initial v0.7 membership:

- **Credential + network exfiltration capability**: any non-trivial `vault:` permission combined with any `network:` permission. Rendered in the dialog as: *"⚠ Combination to review: This skill can both read your stored credentials and make network requests. A skill with this combination can send credentials to its allowed destination — intentionally or by mistake."*
- **Credential + filesystem write capability**: any non-trivial `vault:` permission combined with any `fsa:write:` permission. Rendered as: *"⚠ Combination to review: This skill can both read your stored credentials and write files to your disk. A skill with this combination can store credentials in files where other software could read them."*
- **Filesystem read + network exfiltration capability**: any non-trivial `fsa:read:` permission combined with any `network:` permission. Rendered as: *"⚠ Combination to review: This skill can both read files from your disk and make network requests. A skill with this combination can send file contents to its allowed destination."*

The combinations are not additive permissions — the runtime doesn't grant anything new based on combination. The combinations are *disclosure categories* that surface emergent risk in the dialog. A skill that declares the two underlying permissions is not penalized at install time beyond the disclosure; the user's review takes the disclosure into account.

The combinations also drive the **forced-Worker policy** (§4.3): any combination on this list triggers Worker-mode as the default execution mode regardless of import status.

The list will grow. New combinations are added when attack patterns are identified that exploit emergent risk. The curation lineage is shared with §4.1's capability scan; one maintenance surface, not two.

---

## 4. §11.12 — Worker-mode full design

The dialog's **How it will run** section commits to specific architectural choices about Worker mode: a real isolation boundary the dialog can recommend with confidence, a mode-selection model that's honest about author testing, a pool lifecycle that doesn't surprise users with state retention. This section specifies the design.

### 4.1 The strength of Worker mode (and its limits)

Worker mode provides a stronger isolation boundary than the defense-in-depth proxies of §2.4 of v0.6, but the strength comes from a *combination* of mechanisms, not from Worker-launch alone. v0.7 commits to four mechanisms operating together:

1. **In-Worker shadowing or removal** of capability-bearing globals (§4.2 below).
2. **Host-page Content Security Policy** restricting where Workers can reach at the platform level (§4.3).
3. **Message-channel validation** as the new enforcement boundary, with signed runtime-issued identity tags (§4.4).
4. **No child-Worker creation** — the `Worker` constructor itself is removed inside Worker-mode skills (§4.2).

The dialog's *"stronger isolation"* phrase is true because of all four mechanisms together. None alone would justify it.

### 4.2 In-Worker global handling

When a Worker-mode skill is spawned, the runtime instantiates a Web Worker with a runtime-supplied bootstrap script. The bootstrap, before loading the skill's code, modifies the Worker's global scope:

**Removed entirely** (assigning `undefined` and deleting; calling these throws):

- `importScripts` — Worker-native synchronous fetch+execute. Removed because it bypasses the message-channel boundary.
- `Worker` constructor — no child-Worker creation.
- `SharedWorker`, `ServiceWorkerContainer` — adjacent Worker-creation surfaces.
- `XMLHttpRequest`, `EventSource`, `WebSocket` — replaced via bridge (see below), the raw constructors are removed.
- `indexedDB` (Worker context) — Workers cannot speak to IDB directly; all IDB access goes through bridged calls.
- `eval`, `Function` constructor — string-to-code paths are removed to prevent dynamic code loading. (Skill code that legitimately uses dynamic evaluation has to declare a non-Worker mode; the §4.1 reject-or-confirm path applies.)

**Replaced with bridged proxies** (the original global is removed, a proxy with the same name is installed that forwards through the message channel):

- `fetch` — proxied. Calls go to the runtime via message; the runtime applies the skill's `network:` permission and forwards.
- A new `runtime.vault` — proxied. Read/write/has/namespaces calls go to the runtime.
- A new `runtime.bus` — proxied. Read/write/subscribe calls go to the runtime.
- A new `runtime.skills.invoke` — proxied. Cross-skill invocations go via the runtime.
- A new `runtime.fs` — proxied. FSA operations go via the runtime.

**Untouched** (available with their standard semantics):

- `Date`, `Math`, `JSON`, `Promise`, `Map`, `Set`, console — pure compute and standard data manipulation.
- `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` — usable for scheduling; the in-Worker code can use timers normally. (Note: string-argument forms of `setTimeout`/`setInterval` use `Function` internally, which is removed, so they fail at runtime — the install dialog flags string-argument timers as a capability-scan note regardless of mode.)
- `crypto`, `TextEncoder`/`TextDecoder`, structured cloning — standard.
- The message channel: `self.postMessage`, `self.onmessage`, `self.addEventListener('message', ...)` — these are how the skill talks to the runtime.

Dynamic `import()` is a special case. Static imports in module Workers resolve at load time and the runtime can constrain them via CSP (§4.3). Dynamic imports against URLs the CSP allows succeed; dynamic imports against URLs the CSP denies fail at the platform level. The runtime cannot remove dynamic `import` from the language; it constrains where dynamic `import` can reach via CSP.

### 4.3 Host-page Content Security Policy

The host page (the bootstrap of any rwa that runs Worker-mode skills) declares a Content Security Policy that constrains Worker behavior at the platform level. The CSP includes:

- `script-src 'self' blob:` — the host page's own scripts plus Blob-URL scripts (which is how the runtime loads the Worker bootstrap and the skill code).
- `worker-src 'self' blob:` — Workers can only be loaded from the host or from Blob URLs.
- `connect-src 'self' <union of installed-skill network permissions>` — the host page itself plus exactly the origins declared by installed Worker-mode skills' `network:` permissions. Workers inherit `connect-src` from the host. A Worker-mode skill's `fetch` (or dynamic `import`) to a domain not in the union fails at the browser level before reaching the bridge.
- `frame-src 'none'` — Worker-mode skills cannot create frames. (Default-mode skills can, subject to the §2.4 defense-in-depth proxies.)

The CSP is updated when skills are installed, uninstalled, or have permissions changed. The runtime regenerates the CSP and writes it to the bootstrap's inline policy.

This is the second mechanism behind *"stronger isolation."* Even if a Worker-mode skill found a way to bypass the in-Worker proxy for `fetch`, the CSP's `connect-src` would deny the request at the browser level. The two layers stack.

### 4.4 The message-passing contract

All communication between a Worker-mode skill and the runtime goes through a structured message channel.

**Message shape:**

```javascript
{
  id: "<unique per-message UUID>",
  type: "<message kind>",
  payload: { /* type-specific */ },
  identity_tag: "<runtime-issued opaque token>"
}
```

The `identity_tag` is a random token the runtime generates when it spawns the Worker. The Worker bootstrap receives it once and echoes it on every message. The runtime validates that every incoming message carries the expected tag for that Worker — this is the calling-skill identity mechanism (§2.4 of v0.6) translated to the message channel. The Worker cannot forge a tag for another skill because tags are runtime-generated and per-Worker.

**Message types:**

- `fetch:request` / `fetch:response` — network requests.
- `vault:get`, `vault:set`, `vault:has`, `vault:namespaces` — vault operations.
- `bus:get`, `bus:put`, `bus:subscribe`, `bus:event` — bus operations.
- `skill:invoke` / `skill:result` — cross-skill invocations.
- `fs:read`, `fs:write`, `fs:list`, `fs:del` — FSA operations.
- `invocation:start` / `invocation:result` — the skill's main invocation.
- `shutdown` — the runtime signals the Worker to clean up (used in `pool: false` termination).
- `error` — error propagation in either direction.

**Permission enforcement happens at the runtime side.** A Worker can send `fetch:request` for any URL; the runtime checks the skill's `network:` permission and either forwards the fetch (success) or returns an error message (denied). The Worker cannot bypass the check because the check happens before the runtime initiates the actual `fetch`.

**Error propagation:** errors map to a stable error vocabulary (`permission_denied`, `vault_locked`, `network_unreachable`, `quota_exceeded`, `timeout`, `invalid_argument`, `runtime_error`). Worker-side code receives these as exceptions thrown by the proxied APIs.

**Async semantics:** all proxied calls return Promises that resolve when the runtime's response message arrives. Promise resolution preserves the original API's surface — `fetch` returns a `Response`-shaped object (constructed from the runtime's response data), `runtime.vault.get` returns a string or null, and so on. Worker-side code uses the proxied APIs the same way default-mode code uses the unproxied APIs.

### 4.5 Pool lifecycle (full)

The dialog's **Memory between uses** section commits to specific pool semantics. The full lifecycle:

**Spawn.** Each Worker-mode skill is spawned when first invoked in a session. Spawning creates a Web Worker, runs the runtime bootstrap (which installs the in-Worker globals per §4.2 and the message-channel handlers per §4.4), then runs the skill's code (which typically defines a handler for `invocation:start` messages).

**Invocation.** When the skill is invoked (via `runtime.skills.invoke` or as a workflow node), the runtime sends `invocation:start` with the input payload. The Worker's handler runs, may make proxied calls, eventually returns by posting `invocation:result`. The runtime resolves the calling code's Promise with the result.

**Pooling.** When `pool: true` (default), the Worker is **not terminated** after invocation completes. The runtime keeps a reference and reuses the same Worker for the next invocation of the same skill within the session. Module-level state in the Worker persists across invocations.

When `pool: false`, the runtime sends `shutdown` after `invocation:result`. The Worker has **1.5 seconds** to ack (the bootstrap can do any cleanup it wants in this window — closing handles, flushing buffers). On ack or timeout, the runtime calls `worker.terminate()`. The next invocation spawns a fresh Worker from scratch.

**Idle timeout.** A pooled Worker that hasn't been invoked for **5 minutes** is terminated. The runtime tracks last-invocation timestamps and runs a periodic sweep. This bounds the duration that pooled module state lives in memory.

**Memory pressure.** When the Compute Pressure API is available and reports `serious` or `critical` pressure, the runtime terminates pooled Workers preemptively — oldest-unused first — until pressure subsides or all pools are empty. On platforms without the Compute Pressure API, the runtime falls back to the idle timeout alone.

**Tab close.** All Workers are terminated when the tab closes. Workers do not survive across tab sessions.

**The runtime never attempts to reset a pooled Worker's state.** Module-level closures, timers, subscription handles, and reference graphs persist across pooled invocations. Skills needing fresh state per invocation either initialize inside their handler (the normal pattern) or declare `pool: false` (per-invocation fresh Worker, terminated after each call).

### 4.6 Forced-Worker policy

The recognizable combinations from §3.7 trigger forced-Worker as the install-time default execution mode. The forced cases (v0.7 initial set):

- Any non-trivial `vault:` + any `network:` permission.
- Any non-trivial `vault:` + any `fsa:write:` permission.
- Any non-trivial `fsa:read:` + any `network:` permission.

When a skill with a forced-Worker combination is being installed:

- If the skill declares `execution: 'worker'` and `tested_modes` includes `'worker'`: the dialog proceeds with Worker mode as the recommended default. The user can switch to default mode in the install dialog, with the standard warning.
- If the skill declares `execution: 'default'` and `tested_modes` is `['default']` only: the install is **rejected** with the §1.2 forced-Worker rejection screen. The user can edit the skill to declare `execution: 'worker'` (accepting the untested-in-Worker risk) or decline.
- If the skill declares `execution: 'worker'` but `tested_modes` is `['default']` only (the author declared Worker but tested only default): the dialog warns about the untested-in-Worker risk but allows installation. The author at least intended Worker mode; the test gap is the user's risk to accept.

This generalizes the §4.1 mode-mismatch rule from v0.6.1: rejections happen at the same surface, with the same shape (edit-or-decline), regardless of whether the mismatch is initiated from the manifest side (author declared a mode the runtime doesn't support) or the permission side (the permission combination forces a mode the author didn't declare).

### 4.7 What Worker mode does not defend against

The dialog phrases Worker mode as *"stronger isolation."* The architectural support for that phrase is real (§4.2–4.6) but bounded. Worker mode does not defend against:

- **A skill misusing its declared permissions** (Shape B). A Worker-mode skill with `vault:x + network:y` can still send credentials to the allowed network destination. The cage constrains *what the skill can reach*; it does not constrain *what the skill does with what it can reach*.
- **A skill exploiting bridged-API bugs**. The proxied `fetch`, vault, bus, and FSA APIs are runtime code; bugs in that code can grant capabilities the skill shouldn't have. Worker mode raises the bar for exploitation but does not eliminate the surface.
- **Side-channel leakage**. Worker mode does not isolate timing, memory layout, or other side channels. A skill that wants to leak data through timing patterns can still do so.

These limits are not flaws; they're the boundary of what scope-isolation can deliver. The trust anchor remains install-time review (invariant 10).

---

## 5. Carry-overs from v0.6.1 (folded in)

### 5.1 Worker pool full lifecycle

Covered in §4.5 above. The full spawn / invoke / pool / shutdown / idle-timeout / pressure / tab-close lifecycle is specified. The `pool: false` shutdown contract is the 1.5-second ack window with terminate-on-timeout.

### 5.2 Idle timeout commitment

Covered in §4.5: 5 minutes idle, runtime sweeps periodically. Compute Pressure API tightens this when available; idle alone is the fallback.

### 5.3 Lens lock cross-reference in §5.4

§5.4 of v0.6 specified that "while the user is editing the workflow graph, autonomous-trigger runs are always skipped," with three canonical in-edit states including "a `rwa-graph/1` batch has been dispatched and the runtime has not yet applied it or rolled it back." The v0.6.1 in-edit timeout disambiguation clarified what happens on timeout. This carry-over adds the explicit cross-reference:

The dispatched-batch state assumes the v0.10 main spec's lens behavior: while a `rwa-edit/1` or `rwa-graph/1` batch is in flight, the lens is locked — the user cannot type a new prompt while a previous one is being processed. The in-edit timeout (v0.6.1 §4) preserves the submitted prompt that became the timed-out batch as an unsubmitted draft in the now-unlocked lens; the user can retry or discard.

This makes the in-edit state machine fully specified: lens open and locked (typing accepted only before submission), lens locked (batch in flight), lens unlocked with draft preserved (batch timed out, user can retry), or lens unlocked empty (no batch active). The mutex behavior in §5.4 covers all four states correctly.

### 5.4 Dialog pool-behavior disclosure

Covered in §1.1's **Memory between uses** section. The disclosure is one paragraph in plain English: *"This skill keeps internal state between uses within a browser session. State is discarded when you close the browser."* This is the right level — not hidden (the user sees it), not technical (no mention of "Worker pooling," "module state," or "session affinity"), not aggressive (the disclosure is informative, not alarming).

For `pool: false` skills, the rendering changes: *"This skill is reset between uses (no state preserved between invocations)."* Same plain-English level; the technical distinction is invisible to the user but the operational distinction is named.

The disclosure appears in every install dialog, including library-authored and update cases. Pool behavior is part of what the user is approving.

---

## 6. Attack-shape verification

The working method specifies running each defended attack shape against the design as a fixture. This section confirms the v0.7 design passes its committed fixtures.

### 6.1 Shape A — permission-vs-code mismatch (defended)

**Fixture.** A skill declares `vault:wordpress-personal + network:api.wordpress.com`, but the code uses dynamic property indexing — `globalThis['vault']['get']('mastodon-mty', 'token')` — to read a vault namespace it doesn't have permission for.

**Defense path.** The capability scan (§4.1 of v0.6) flags dynamic property indexing as a pattern that bypasses static analysis of permission usage. The dialog renders this under **Notes from the runtime's code review**:

> *"The skill uses dynamic property indexing (line 23). This pattern can be used to access APIs that aren't constrained by the permission manifest. Review the code."*

**Verification.** The fixture's note is visible at the install dialog's review section. A reviewer who sees the note and reads line 23 finds the unauthorized vault access. The runtime cannot block the install based on the note alone (dynamic indexing has legitimate uses), but the dialog makes the issue legible.

In Worker mode, the bridged `runtime.vault` proxy enforces the namespace check regardless of how it's called — `globalThis['vault']` still resolves to the bridged proxy, which validates the namespace argument against the skill's permission. So in Worker mode, the attack fails at runtime. In default mode, the shadowing has known gaps (§2.4 of v0.6); the trust anchor is the install-time review the scan note enables.

**Result:** Shape A defended. ✓

### 6.2 Shape B — plausible permissions used maliciously (acknowledged outside reach with active constraint)

**Fixture.** A skill declares `vault:wordpress-personal + network:api.wordpress.com`. The code does exactly that — reads the credentials, talks to the WordPress API. Stated purpose: *"Publishes blog posts to WordPress sites."* Actual behavior: creates a backdoor admin account on the WordPress site each time it runs, providing the attacker continued access.

Every architectural check passes. The permissions are used as declared. The capability scan finds nothing notable. The signature verifies. The dialog has no architectural basis for refusing the install.

**Defense path (active constraint).** The dialog must:

a. **Not present permission narrowness as reassurance.** Check the §1.1 dialog: permissions are framed as *"What it can do on your machine"* (capability statement), with the immediate follow-up *"These are the limits the runtime will enforce. Within these limits, the skill's code decides what to do."* (limit-of-enforcement statement). The compound-capability callout names the threat: *"A skill with this combination can send credentials to its allowed destination — intentionally or by mistake."*

b. **Have the purpose-evaluation prompt at the decision point.** Check the §1.1 dialog: immediately before the buttons, *"The runtime shows you what this skill can do. It cannot tell you whether it should do it."* Three confirmation bullets follow, including *"The capabilities listed above are appropriate for that purpose"* — explicitly asking the user to evaluate whether the declared capabilities match the declared purpose.

**Negative-space test (two clauses, per addendum patch r2):**

- **Clause 1 (no implicit defense):** Read the dialog top-to-bottom looking for any sentence that frames permissions as a safety property. None present. The phrase *"Read and write WordPress credentials"* is followed by the limit-of-enforcement statement. The phrase *"Make network requests to api.wordpress.com"* is followed by the same. The compound-capability callout actively names risk. No sentence implies that the declared permissions constrain the skill's behavior beyond what the runtime enforces.
- **Clause 2 (prompt at decision point):** The purpose-evaluation prompt is the last content before the action buttons. Not buried, not in a "more details" expansion, not separated from the Install affirmation by other content.

**Verification.** The fixture's install dialog renders without any language a reasonable reader would interpret as "the runtime is defending you against this skill misusing its access." The user is told, in plain English, that runtime enforcement has a limit and that the user's review is what closes the gap.

**Result:** Shape B acknowledged outside reach. The active constraint holds. The dialog doesn't claim defense it can't deliver. ✓

### 6.3 Shape C — update with quiet capability expansion (defended)

**Fixture.** An installed skill `publish-to-blog` v1.1.0 with permissions `vault:wordpress-personal + network:api.wordpress.com`. The author publishes v1.2.0 which adds `network:analytics.tracker.com` to the permissions. The skill's stated purpose is unchanged.

**Defense path.** The update install dialog includes a **Changes from the installed version** section (§1.2). Capability expansions render as prose:

> *"Adds network access to `analytics.tracker.com`."*

The expansion is rendered with the same warning treatment as a fresh permission would be (it triggers an updated combination-callout if the new permission creates a new recognizable combination, or amplifies an existing one).

**Verification.** The fixture's update dialog presents the new network permission as a prose change, not as a JSON diff. A user reading the dialog sees one explicit sentence about what's new. The runtime does not auto-approve updates with expanded permissions; the same install affirmation is required.

**Result:** Shape C defended. ✓

### 6.4 Shape D — plausible-source forgery (partial defense)

**Fixture (visual-lookalike, defended).** The user has previously installed three skills from source "Acme Skills" with public key `ak-7a92cf...`. A new import arrives from source "Acme Skils" (missing 'l') with public key `ak-bc3e2d...`.

**Defense path.** The runtime's lookalike detection (§2.3) compares "Acme Skils" against the names of known trusted sources via normalized comparison, Unicode confusable folding, and edit-distance. Edit distance of 1 against "Acme Skills" triggers the warning. The dialog's **Author** section renders:

> *"⚠ This source name closely resembles **Acme Skills**, from whom you've installed 3 skills previously. The cryptographic identity is different. This may be a typo by a different author, or it may be an attempt to look like a source you trust."*

**Verification.** The fixture's dialog surfaces the resemblance before any other content. A user who would have approved on name alone has a clear signal that the cryptographic identity differs.

**Fixture (novel-source attack, acknowledged outside reach).** A new import arrives from source "Definitely Not Malicious Inc." with a previously-unseen public key. The name has no resemblance to any trusted source. The signature verifies (it's a real signature; the source is what's malicious). The skill declares plausible permissions and is in fact a Shape B attack.

**Defense path.** The dialog renders *"Published by **Definitely Not Malicious Inc.** (`dnm-9a4f...`). First skill you're installing from this source."* No lookalike warning fires (no resemblance to flag). The Shape B active constraint runs: the limit-of-enforcement language, the purpose-evaluation prompt at the decision point, the affirmation button. The user is invited to evaluate purpose and review the code.

**Verification.** The novel-source attack's dialog gives the user honest information: this is a first encounter, the runtime cannot tell you whether to trust the source, you must evaluate the skill on its own merits.

**Result:** Shape D defended for visual lookalikes; novel-source attacks fall back to Shape B's active constraint, which is the only available defense. The dialog is honest about which is which. ✓ partial, as committed.

### 6.5 Shape E — compound permission risk (defended)

**Fixture.** A skill declares `vault:wordpress-personal + network:api.wordpress.com`. The permissions individually are narrow; the combination is risky.

**Defense path.** §3.7's recognizable-combinations list includes "credential + network exfiltration capability." The runtime's permission scan identifies the combination during install processing. The dialog renders a named callout:

> *"⚠ Combination to review: This skill can both read your stored credentials and make network requests. A skill with this combination can send credentials to its allowed destination — intentionally or by mistake."*

The callout appears as a distinct visual element, not as a third item in the permissions list. The risk is rendered as a category, not as a free-form combination the user has to reason about.

The combination also triggers the forced-Worker policy (§4.6). Worker mode is the install default; the user can override.

**Verification.** The fixture's dialog renders the compound risk explicitly. The Worker-mode default constrains the skill at runtime (insofar as Worker mode's mechanisms can — Shape B caveat). The user sees the category, not the math.

**Result:** Shape E defended. ✓

### 6.6 Vocabulary count

Concepts a non-spec-fluent user must understand to read the §1.1 dialog:

1. Author / source (familiar).
2. Capabilities ("what it can do") (familiar phrasing).
3. Credentials (familiar).
4. Network requests (familiar).
5. Stronger isolation / less-isolated mode (plain-English contrast; the technical Worker/default distinction is not exposed).

Five concepts, all in plain English. The bounded-vocabulary constraint (point 2 of the addendum) is satisfied. Permissions, vault, Worker mode, capability scan, and pool are all rendered without their technical names; the user encounters them as plain phrases.

---

## 7. Updated invariants

The v0.6 invariants extend with two clarifications. No invariants are removed or changed in substance; the additions formalize commitments already implicit in v0.7's design.

**Invariant 16 (added).** Source identity is anchored on a public key, not a name. Per-source state — install counts, name history, first-encounter signals — is keyed against the public key. Names are advisory; the key is durable. Skills exported without a signature are renderable as unsigned imports, with provenance-derived dialog signals (counts, first-encounter, lookalike) suppressed for the source dimension.

**Invariant 17 (added).** Permission patterns at every tier are left-anchored and typed to their tier. No regex, no left-unanchored wildcards, no cross-tier patterns. The grammar refuses by construction the constructs that would allow narrow-looking permissions to match unintended targets. Wildcards at each tier escalate dialog rendering proportional to their breadth.

Invariant 10 from v0.6 (skill installation as the privileged moment and trust anchor) and invariant 12 (self-modifications persist only on manual trigger plus ⌘S) are unchanged. The v0.7 cluster operates within the trust model they define.

---

## 8. What v0.7 does not deliver

The trust anchor (invariant 10) holds only when users do the review the architecture invites. v0.7 commits to three properties that the architecture can deliver:

1. **The substance is available.** Every piece of information a reviewer needs is in the dialog: permissions in plain language, code-review notes from the capability scan, source identity with familiarity signals, compound-risk disclosure, mode selection with author-testing information, pool behavior, capability-expansion diff on updates.

2. **The substance is readable.** The dialog uses a bounded vocabulary of five plain-English concepts. Technical terms (Worker, vault, pool, capability scan) are rendered in user-facing language without exposing their internals. Warning treatments scale proportionally with risk breadth.

3. **The substance is actionable.** The dialog offers three first-class actions: install (via affirmation button), cancel, edit the skill. Rejection surfaces (mode-mismatch, forced-Worker mismatch) offer the same actions in their context. No dead-end paths.

Beyond those three properties, v0.7's reach ends:

- **A user who declines to read the dialog and clicks Install** has stepped outside the trust model the format provides. The architecture cannot force engagement without sliding into friction theater (mandatory wait timers, comprehension quizzes, theatrical complexity) — and friction theater makes the dialog worse for the users who do engage.

- **A skill that misuses its declared permissions** (Shape B) is the architectural ceiling. v0.7's active constraint makes the limit legible; it does not close the gap. The gap is closed only by the human reviewer's evaluation of whether the skill's declared purpose matches what the user wants the capabilities used for.

- **Genuine novel-source attacks** (Shape D, hard half) have no architectural signal to act on. The dialog's first-encounter rendering is the only available response. The reviewer must evaluate the skill on its own merits.

- **Side-channel attacks against Worker-mode skills** are not in v0.7's threat model. Worker mode constrains capabilities, not timing or memory side channels.

These limits are explicit, not implicit. The dialog says so in plain English: *"The runtime shows you what this skill can do. It cannot tell you whether it should do it."*

---

## 9. Deferred to v0.8 and beyond

- **§11.1** — the common skill set's contents. v0.7 establishes the format the bundled skills will travel in (§11.9), the permission grammar they'll declare (§11.10), and the execution model they'll operate under (§11.12). Selecting which 6–8 skills ship with the runtime is its own design pass that benefits from the cluster having landed first.
- **§11.7** — local-LLM fallback configuration. Independent of the cluster. v0.7 doesn't change anything about local-LLM design; the configuration surface lands when an implementation needs it.
- **§11.8** — Argon2id parameter pinning. Wants a threat-model pass independent of any other section.

**Items v0.7 explicitly resolves and that have no carry-over:**

- §11.11 (draft skill UI surface) folds into the §1.2 variant treatment. Drafts are a `status` flag in the library viewer with the same dialog treatment as installed skills, restricted to `compute`-only invocation. No additional UI surface to specify.

After v0.7, the action layer is implementable. The deferred items are real but independent; they refine specific seams without holding back implementation of the rest.

---

*v0.7 — the cluster pass. §11.9 (provenance, share file format, source identity, signature optionality, lookalike detection), §11.10 (permission pattern syntax, anti-escalation by construction, recognizable combinations curated parallel to §4.1), §11.12 (full Worker-mode design including in-Worker globals, host CSP, message-passing contract with runtime-issued identity tags, full pool lifecycle with 1.5s shutdown ack, 5-minute idle timeout, forced-Worker policy, and explicit reach-vs-limit framing). Four v0.6.1 carry-overs folded in. Five attack-shape fixtures (A defended, B acknowledged outside reach with active constraint, C defended, D partial defense, E defended) verified against the design. Two invariants added (16: source identity anchored on key; 17: permission patterns left-anchored and typed). Three carry-overs to v0.8 (§11.1, §11.7, §11.8); §11.11 resolved into v0.7's variant treatment. The action layer is implementable end-to-end after this revision.*