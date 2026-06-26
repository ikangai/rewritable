# Intelligence carrier — worked example

Reference artifact for [`docs/specs/rwa-intelligence-spec.md`](../../docs/specs/rwa-intelligence-spec.md) (`intelligence/0.2`). It makes the **hybrid carrier** concrete the way `hello.html` anchors the core spec.

## What this is

`concise-editor.html` is a **real `skill-host` rewritable** that *carries* one signed `rwa-agent/1` intelligence — a role tuned to tighten prose. It demonstrates every claim in the spec on the built substrate:

- The signed record lives in the file's **frozen `#rwa-agents` zone** (`<script type="application/rwa-agent+json">…base64…</script>`), written in the exact format the runtime's `buildAgentZone`/`parseAgentZone` expect.
- The document body is a **self-describing card**: what the intelligence does, the role, the *recommended* model (a recommendation only — the model never travels in a file), the author-key fingerprint, and the affinity note.
- It is **itself a skill-host**, so the role is already installed on it — open the file, activate `concise-editor` from the Skills panel, and ⌘K runs through the role's framing. That is the same overlay a *target* file would get after install.

## It is genuinely signed and verifies live

The embedded record is signed with a throwaway Ed25519 key using the repo's **own** canon (`cli/src/skill-manifest.mjs` → `canonicalAgent` / `agentSigningMessage`, Ed25519 over `sha256(canonicalAgent)`). Only the **public** key + signature are in the file; the private key was ephemeral and never written.

Verified end-to-end (10/10) at generation time:

- `verifyAgentEnvelope` → `{signed:true, verified:true}`; `validateAgentInstall` → `ok`.
- `parseAgentZone` finds exactly one agent, `verified:true`, `kind:'agent'`.
- **Booted in jsdom**: `runtime.agents.list()` shows `concise-editor` verified; `runtime.describe()` surfaces it as a `kind:'agent'` affordance; `runtime.agents.setActive('concise-editor')` succeeds (a tampered/unsigned record would install `verified:false` and be refused at activation — `unverified_agent`).

## What is *not* shown (honest boundary)

The spec's one forward-design surface — the literal **drag-this-carrier-onto-that-file** gesture that extracts the record and routes it to the install dialog — is **not built**. What *is* built and exercised here: the signed record, the frozen-zone format, boot-load + live verify, `describe()` surfacing, and activation. To install this intelligence into another rewritable today, hand its record to that file's agent-install dialog (or publish it to the skill index); the literal file-drop is the bridge §5 leaves open.

## Maintenance

Like `hello.html` / `re-write-able-spec.html`, this carries a full snapshot of the seed bootstrap, so it lags `seeds/rewritable.html` after a seed change. The **signed record stays valid** across seed changes (it depends only on the agent canon, not the surrounding bytes). It is **wired into the regen flow**: run `node tools/regenerate-refs.mjs` after a seed change — it re-applies the `skill-host` kind regions and preserves this file's `DOC_UUID`, `<title>`, and the signed record verbatim (a no-op against the current seed; verified by an empty `git diff`).
