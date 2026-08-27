# The container supplies the job description; the agent brings the tools

*2026-08-27, design. A direction for how a rewritable participates in the Agent
Skills ecosystem — by describing what an external agent should **be** and **do**,
not by executing more itself. Grounded on `rwa-agent/1` and the two-agent frame
(`docs/plans/…` / epic #43). Not built; the open decisions are named at the end.*

---

## Where this came from

Two things in this repository are called "skills", and they are different:

| | `rwa-skill/1` (v0.8/v0.9) | Agent Skills |
|---|---|---|
| payload | `code: "async function run(input, runtime)"` | markdown instructions for a model |
| shape | one signed JSON envelope | a folder: `SKILL.md` + references + scripts |
| trust | Ed25519 over manifest‖code, permission manifest, two tiers | none intrinsic |
| execution | a Web Worker, no main-thread path (Inv 18) | the agent's own tools |
| discovery | `installedSkills` registry | frontmatter `description`, progressively disclosed |

`skills/authoring-rewritables/` in this repo is the second kind. The in-container
layer is the first. No spec has ever claimed the in-container layer follows the
Agent Skills standard, and it does not.

So "install any skill that is out there" cannot mean *convert an Agent Skill into
an `rwa-skill/1`*. Agent Skills carry no signature, no permission manifest and no
I/O schema, and their bundled scripts are usually Python or Node meant for a
shell — not code that survives a Worker with `fetch` removed.

**It can mean something better.** An Agent Skill is mostly *instructions*, and
this repo already has a signed, consent-gated, verification-checked format for
instructions: `rwa-agent/1`. The container carries the job description; the
external agent brings the model, the shell and the filesystem. Under the
two-agent frame that is not a compromise — it is the correct split.

## The mapping

| Agent Skill part | Where it goes | Status |
|---|---|---|
| `name` | `agent.role` | exists, signed |
| `description` (when to use) | `agent.description` | **exists, signed, populated** |
| instructions (the body) | `agent.system_prompt` | exists, signed |
| `references/*.md` | *nothing yet* | **the gap** |
| `scripts/*` | the external agent runs them | **needs a consent story** |

The pleasing part: three of five already exist and are covered by one signature.
`description` was in `canonicalAgent` from the beginning and both authoring paths
populate it — the CLI (`intelligence.mjs`) and the web maker. It simply was not
being surfaced through the read door until this was written down.

## Why this is the rwa thesis, not a detour

A rewritable that carries a role is **a self-contained, signed, portable skill**.
One file, emailed or dropped in a folder; the recipient's agent opens it and knows
what to be. That is the format's existing claim — single file, self-describing,
no server — aimed at the agent ecosystem instead of at documents.

It also inverts the usual problem. Skill distribution normally needs a registry,
a namespace and a trust root. A carrier needs none: the file *is* the unit, the
signature *is* the provenance, and `describe()` *is* the discovery.

## Three tiers, deliberately separated by risk

### Tier 1 — the container describes (safe; nearly done)

`rwa doc --json` reports the container's signed role: `role`, `description`,
`systemPrompt`, verification status. An external agent reads it, decides whether
the role applies (that is what `description` is for), and adopts it.

Nothing executes. Nothing new is trusted beyond what #37 already gates: unsigned
or tampered records never yield their prompt.

Shipped in #37, with `description` added on 2026-08-27 once this document made
clear it was the load-bearing field for *selection* rather than *behaviour*.

### Tier 2 — the container carries references (low risk; needs a canon decision)

Progressive disclosure is most of what makes Agent Skills work at scale: an agent
reads one line, then the body, then a reference only if it needs it. A rewritable
is unusually good at carrying those — it already bundles images as data URIs and
signed records as base64 in frozen zones.

References are markdown. They are read, never run. The risk is prompt injection
into an agent's context, which is the risk the whole provenance mechanism
(`rwa-origin`, the nonce fence) already exists to manage.

**This is where a canon change actually lives** — but a cheap one. `version` is
already *inside* `canonicalAgent`, and every shipped carrier says
`"rwa-agent/1"`, so a v1 and a v2 record already sign structurally different
messages. `canonicalAgent` can branch on `agent.version`: v1 verifies against
today's six fields, byte-unchanged and forever; v2 verifies against seven. No
re-signing, no invalidated carriers, no migration. The extension point was
designed in from the start. (An earlier draft of this document claimed the
opposite; see the open decisions for where the cost actually went.)

### Tier 3 — the container carries scripts (high risk; not designed here)

A signature proves **who wrote this**. It does not prove **this is safe to run**.

Under Tier 1 the worst case is a bad system prompt reaching a model. Under Tier 3
the container hands executable work to an agent holding a shell, a filesystem and
a network — every capability the container itself was deliberately denied by the
worker-scoped CSP and Inv 18. Verified-author must not silently become
trusted-to-execute.

If this is ever built, the consent has to be **human, per-container, per-run** —
not inherited from a signature, and not a checkbox that a carrier can pre-tick.
Nothing in Tier 1 or 2 should be designed in a way that makes Tier 3 feel like a
natural continuation.

## What this means for `invoke` (#38)

It demotes. The container does not need to *run* more; it needs to *say* more.
`runtime.invokeSkill` remains the in-container plugin path (Worker-isolated,
permission-gated) and is a real but separate concern. A headless `rwa run` for
skills, and a programmatic entry for the workflow runner, stay worth doing on
their own merits — but they are no longer the answer to "how does a rewritable
join the skills ecosystem".

## Open decisions

1. **Do references ride the signature?** *Recommendation: yes, via a version
   branch in `canonicalAgent`.* Two things sharpen this since the first draft.
   The migration is **free** (branch on `version`, v1 records untouched) — and
   the security argument is stronger than "unsigned is weaker": `system_prompt`
   is signed precisely so a tamperer cannot rewrite what the model is told, and a
   reference is pulled into context and read as instruction material on the *same
   trust surface*. Unsigned references would therefore be a **bypass of an
   existing wall**, letting an attacker blocked from the prompt put the payload in
   a reference instead.

   Worth recording why the first draft was dangerous as well as wrong: `*.key.json`
   is gitignored, so the carriers' private keys are not in the repo. Had a re-sign
   genuinely been required and those files were gone, the carriers would have had
   to be re-minted with new keypairs — changing `author_pubkey` and `agentId`, so
   the five gallery carriers would become *different identities*.

   **The cost moved to maintenance.** `canonicalAgent` is byte-mirrored into
   `service/public/ai/maker.html` and gated by `maker-parity.test.mjs`. A branch is
   more surface for those copies to drift across, and a canon that silently
   disagrees between signer and verifier is the worst failure available here.
   `maker-parity.test.mjs` must gain a fixture at **each** version — one that only
   exercises v2 would let v1 verification rot silently, which is the exact thing
   the branch exists to prevent.
2. ~~**Where do references live in the container?**~~ **DECIDED (operator,
   2026-08-27): inside the envelope's SIGNED region — `envelope.agent.references`.**
   Not a second frozen zone, which would split one signature across two locations;
   and specifically *not* beside `affinity`/`recommended_model` in the envelope's
   UNSIGNED region, which was the other available reading of "inside the envelope"
   and is the bypass decision (1) argues against. `canonicalAgent` branches on
   `agent.version`: v1 signs six fields, v2 signs seven.

   **A second-order cost this surfaces.** The `#rwa-agents` zone lives *inside*
   `INLINE_DOC`, so carried references count against the container's own document
   budget (`MAX_DOC` 1 MB virtualized, `MAX_DOC_EXPANDED` 10 MB). Agent Skills
   references run to tens of kilobytes each, so a generous carrier can crowd out
   the document it exists to help edit — and it fails late and confusingly, as
   `target_size_exceeded` on an ordinary edit with nothing pointing at the
   references. Wants a per-record cap enforced at authoring/install rather than
   discovered at commit, and `rwa doctor` attributing the bytes.
3. **Does `rwa skill import <SKILL.md dir>` convert, or refuse?** A SKILL.md with
   bundled scripts cannot be fully represented at Tier 2. Import the instruction
   half and report what was dropped, or refuse until Tier 3 exists? *A partial
   import that says exactly what it left behind is more useful than a refusal, as
   long as it never implies the scripts came along.*
4. **Does a carried role compose with an installed one?** The advisor machinery
   (I-E) already merges a primary role with up to three verified advisors. A
   carried skill is shaped like an advisor. Worth checking before inventing a
   second composition model.

---

*Not built beyond Tier 1. The decisions above are genuine forks, not formalities.
Revised 2026-08-27 after checking the canon rather than recalling it: (1) is not
the expensive migration this document first claimed — see #45.*
