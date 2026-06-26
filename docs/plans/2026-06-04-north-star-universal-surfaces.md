# North star — a rewritable, creatable and editable from any surface

**Status:** vision / strategy. Not a build commitment. Author: galois (with Martin), 2026-06-04.

## The one-line north star

> A rewritable's **create / edit / describe / publish** contract is *surface-agnostic*.
> Every surface — CLI, the file itself, a Claude skill, an import, a webpage clone, a
> Telegram bot, a phone call, a publish target — is a **thin adapter onto that one
> contract, never a reimplementation.**

The win of this framing: the roadmap is not "build many products." It is "name the
contract once, then write small adapters." The disparate-looking wishlist collapses to
**four verbs through many doors.**

## The four verbs (the contract)

Everything a surface can do reduces to:

| Verb | What | Wire contract | Canonical impl today |
|---|---|---|---|
| `bootstrap(kind, body?)` | make a fresh rewritable | seed substitution | `cli new`, web `/new`, the skill |
| `import(source) → body` | turn md/docx/pdf/csv/html/**webpage** into a body, then bootstrap | (per-format) | `cli import`, web `/import` |
| `modify(file, instruction\|envelope)` | surgical edit | **`rwa-edit/1`** envelope | the in-file lens (⌘K), `cli edit`, the skill |
| `describe(file)` | what is this / what can be done | **`self-description/1`** | `cli doc --json`, `runtime.describe()` |
| `publish(file) → url` / `export(file)` | get it out | per-origin share / file bytes | web `/publish`, ⌘S |

This contract is **already proven across three independent surfaces** (CLI, in-file lens,
the new Claude skill) driving the same seed + `rwa-edit/1` + `self-description/1`. The
skill-vendoring further proved the core is dependency-free and portable. ~70% of the
north-star elements already exist; the work is mostly *new adapters + naming the contract*.

## The load-bearing tension (and its resolution)

`modify(file)` assumes the caller **holds the bytes**. CLI, lens, and skill all do.
**Telegram and a phone call do not** — you cannot ⌘S a chat. This collides with the
core invariant: *the self-contained file is the durable truth.*

**Resolution.** The file stays canonical. Remote/conversational surfaces operate on a
**hosted projection**, and every change is a logged `rwa-edit` commit, so the real file
can always be regenerated and pulled back down. This preserves offline-file purity *and*
enables edit-at-a-distance.

**Consequence for sequencing.** Edit-at-a-distance requires new infrastructure —
a **writable hosted runtime** (today's publish is read-only snapshots) plus
**identity/auth** (who may edit which hosted rwa). That infra gates *every remote-edit*
surface. Remote **create-and-publish** needs none of it. So: create surfaces are cheap
wins; edit surfaces wait on the hosted-edit foundation.

## Surface inventory & ranking

### Shipped (the contract already speaks these)
CLI (`new/edit/create/import/doc/ls/publish`), the in-file lens, the `authoring-rewritables`
Claude skill, imports (`md·html·csv·txt·docx·pdf`), web (`/new · /import · /publish`,
per-origin shares), skins, `self-description/1`, and the in-progress skill-host layer (v0.8).

### Near — new, **no new infra** (create/publish adapters)
- **Custom publish → ikangai.com.** A `publish` adapter with a different target/template;
  Martin controls the destination. Low effort, high personal value. (Builds on `publish.mjs`.)
- **Webpage → rwa clone**, scoped to **ikangai blog posts first.** `fetch → extract content
  (readability) → optional skin from the page's CSS → bootstrap`. Reuses imports + skins.
  High "wow," bounded *because we control the source markup*. General-web style-cloning is
  hard (coherent skin from messy CSS) — explicitly out of v1; ikangai-first sidesteps it.

### Mid — needs the hosted-edit foundation
- **Writable hosted runtime + identity (publish++).** The keystone for all remote edit.
- **Telegram bot.** The *easy* messaging beachhead (Bot API has no approval friction).
  Phase A: `/new a doc about X` → returns a published link (create-only, no infra).
  Phase B: reply-to-edit a hosted rwa (needs the foundation + auth).

### Far / spike — high effort, high novelty
- **Phone call to the document** ("talk to your document"): Twilio voice + STT + agent +
  TTS over a hosted rwa. Genuinely novel. Sits on top of *all* the hosted-edit infra.
  Do a **timeboxed 1-day spike** to feel the UX; do **not** sequence the roadmap around it.
- **WhatsApp.** Same shape as Telegram but Business-API friction (templates, approval,
  cost). Defer until Telegram validates the messaging pattern.

## Sequenced roadmap

1. **Foundation (cheap, highest leverage).** Write the contract down once as the documented
   **"rewritable operations API"** (`bootstrap/import/modify/describe/publish/export` with the
   `rwa-edit/1` + `self-description/1` wire formats). It exists implicitly across seed/cli/skill;
   making it explicit is the target every adapter aims at. This is the keystone deliverable.
2. **Near (no new infra):** ikangai.com custom publish target → webpage→rwa clone (ikangai blog).
3. **Mid:** writable hosted runtime + identity → Telegram (Phase A create-link, then Phase B edit).
4. **Far / spike:** phone surface on hosted-edit; WhatsApp after Telegram proves the pattern.

## Open questions

- **Auth model for hosted-edit.** Per-rwa edit token? Account-linked? Capability URLs? (Gates Telegram-B / phone.)
- **Where does conversational state live** during a multi-turn edit (chat thread ↔ hosted rwa ↔ canonical file round-trip)?
- **Skin-from-webpage fidelity bar** — what counts as "good enough" for a cloned ikangai post?
- **Phone identity & cost** — who can call, transcription/voice cost ceiling for a spike.

## Relationship to existing work

This is the umbrella over `architecture.html` (the substrate/graph/skill layers), the
`authoring-rewritables` skill, the skinning track, and the v0.8 skill layer. None of those
change; this names the *axis they all serve*: one contract, many surfaces.
