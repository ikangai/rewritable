# Intelligence carrier — worked example

Reference artifact for [`docs/specs/rwa-intelligence-spec.md`](../../docs/specs/rwa-intelligence-spec.md) (`intelligence/0.2`). It makes the **hybrid carrier** concrete the way `hello.html` anchors the core spec.

## What this is

`concise-editor.html` is a **real `skill-host` rewritable** that *carries* one signed `rwa-agent/1` intelligence — a role tuned to tighten prose. It demonstrates every claim in the spec on the built substrate:

- The signed record lives in the file's **frozen `#rwa-agents` zone** (`<script type="application/rwa-agent+json">…base64…</script>`), written in the exact format the runtime's `buildAgentZone`/`parseAgentZone` expect.
- The document body is a **self-describing card**: what the intelligence does, the role, the *recommended* model, the author-key fingerprint, and the affinity note.
- It carries a structured **`recommended_model` / `recommended_backend`** on the envelope (intelligence/0.2 **I-A**). On activation (Activity panel → *Intelligences* → Activate) the runtime offers to apply it to your session behind a one-line consent — never auto-applied, only `rwa_model`/`rwa_backend`, never a base-URL or the API key. The field rides *outside* the signed `agent`, so it was added without re-signing (the signature still verifies).
- It is **itself a skill-host**, so the role is already installed on it — open the file, activate `concise-editor` from the Skills panel, and ⌘K runs through the role's framing. That is the same overlay a *target* file would get after install.

## It is genuinely signed and verifies live

The embedded record is signed with a throwaway Ed25519 key using the repo's **own** canon (`cli/src/skill-manifest.mjs` → `canonicalAgent` / `agentSigningMessage`, Ed25519 over `sha256(canonicalAgent)`). Only the **public** key + signature are in the file; the private key was ephemeral and never written.

Verified end-to-end (10/10) at generation time:

- `verifyAgentEnvelope` → `{signed:true, verified:true}`; `validateAgentInstall` → `ok`.
- `parseAgentZone` finds exactly one agent, `verified:true`, `kind:'agent'`.
- **Booted in jsdom**: `runtime.agents.list()` shows `concise-editor` verified; `runtime.describe()` surfaces it as a `kind:'agent'` affordance; `runtime.agents.setActive('concise-editor')` succeeds (a tampered/unsigned record would install `verified:false` and be refused at activation — `unverified_agent`).

## Dropping it onto a target (the bridge is built)

The literal **drag-this-carrier-onto-that-file** gesture is now implemented (intelligence/0.2 §5): the target's runtime claims a dropped `.html`, un-escapes its `INLINE_DOC`, extracts the signed `rwa-agent/1` record from the `#rwa-agents` zone, and routes it to the agent-install **consent dialog** — install stays behind that dialog (the trust anchor). Seed functions: `extractAgentEnvelopesFromCarrier` / `classifyInstallText` / `routeInstallFromText` / `handleCarrierDrop` (a capture-phase window drop, size-capped at 32 MB), plus the install picker generalized to accept carriers. Pinned by `tests/intelligence-drop.mjs` (13/13: extract → classify → install-verified → full drop-to-dialog-to-install, dropping *this* carrier). You can also still hand the record to the dialog directly or publish it to the skill index.

## Maintenance

Like `hello.html` / `re-write-able-spec.html`, this carries a full snapshot of the seed bootstrap, so it lags `seeds/rewritable.html` after a seed change. The **signed record stays valid** across seed changes (it depends only on the agent canon, not the surrounding bytes). It is **wired into the regen flow**: run `node tools/regenerate-refs.mjs` after a seed change — it re-applies the `skill-host` kind regions and preserves this file's `DOC_UUID`, `<title>`, and the signed record verbatim (a no-op against the current seed; verified by an empty `git diff`).
