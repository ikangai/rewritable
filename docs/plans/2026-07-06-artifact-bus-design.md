# The typed artifact drop bus — `rwa-artifact/1` (v1 design)

*2026-07-06. Status: validated design, pre-implementation. Follows the "drop your AI"
rework (`docs/plans/2026-07-05-drop-in-ai-ux-design.md`), which shipped the first fully
realized droppable and merged to main (`4af75ba`).*

## The idea, reframed

"Drop your AI" proved a gesture: drag a file onto a rewritable and it augments the
document. The tempting generalization is **"drop anything."** That framing is a trap — it
implies a uniform pipeline where there is none. Different artifacts have fundamentally
different *integration semantics* (a PDF becomes content; an AI becomes behavior; a skin
layers over the doc), and each needs its own trust model. The uniform *gesture* is real;
the uniform *implementation* is a mirage.

The version worth building is a **typed artifact model**: a small, closed set of artifact
**classes**, each declaring its integration semantics and trust model, with the gesture and
the consent scaffold unified — and each rewritable declaring, via `self-description/1`,
which classes it accepts. That turns an infinite, invisible drop surface into a legible
per-document contract, and it solves the discoverability problem the AI drop hit (nothing
advertised that you *could* drop). This is not a plugin-anything hook. It is a type system.

The substrate is already ~60% there: `handleCarrierDrop` → `classifyInstallText` →
`routeInstallFromText` is already a typed drop router; image ingest already sniffs
`file.type`; `self-description/1` already reports what a container is. v1 **unifies what
exists** and adds one new class to test whether adding a class is easy — the whole thesis.

## Decisions (locked with the author)

1. **Type source — hybrid (declared + sniff fallback).** rwa-native artifacts (AI/skill
   carriers, and future skin/kind artifacts) carry a lightweight class tag the runtime
   reads first; raw content (images, PDFs, CSV) that cannot self-declare is sniffed by
   `file.type`/extension. One classifier, two lookup strategies. Extensible without forcing
   raw files through a wrapping step.
2. **`accepts` teeth — advisory default, author opt-in strict.** By default an unlisted
   class still works but the consent shell shows a soft note; an author sets a doc-level
   `strict` to actually refuse unlisted classes. Mirrors the AI kind-affinity
   decision — never lock an author out of their own document unless they declared the lock.
3. **Consent scaffold — shared shell, per-class body.** One modal shell (overlay, title,
   provenance row, cancel/confirm, in-flight lock, escaping — the hard-won "Use this AI"
   scaffolding) that each class fills with its own preview body + confirm semantics.
   Silent-commit classes (image today) skip the modal but still flow through the dispatcher.
4. **v1 class set — install + ingest + skin-as-compose.** Unify the two existing drops
   (pure refactor, no new capability) AND wire skin as the first NEW class. Spans three of
   the four integration semantics; skin-drop is the thin new capability that tests
   extensibility. If skin-drop fights the bus, that is the cheap signal the model does not
   hold.

## §1 The model

An *artifact* is anything droppable onto a rewritable. Each has a **class** with fixed
**integration semantics** — a small, closed set:

| Class | Semantics | v1 members | Trust model |
|---|---|---|---|
| `install` | becomes *behavior* | AI, skill carriers | signature + consent + sandbox |
| `ingest` | becomes document *content* | image | sanitize + size caps |
| `compose` | *layers over* the doc, reversibly | skin | injection-scrub |
| `transform` | changes the rwa's *kind* | — *(deferred)* | — |

Class resolves from a declared tag when present, else a sniff. The set is closed; adding a
member is a deliberate design act, not an open extension point.

## §2 Classifier + dispatcher

One `classifyArtifact(input)` replaces the two-handler capture-phase dance, returning
`{class, semantics, payload, source: 'declared' | 'sniffed'}`. Resolution order:

- **(a) declared** — parse an `rwa-artifact/1` tag / an existing carrier record
  (`extractAgentEnvelopesFromCarrier` / `classifyInstallText`) / a skin-artifact marker;
- **(b) sniff** — `file.type` / extension → image / pdf / csv.

A single capture-phase `window` `drop` handler classifies, checks `accepts` (§3), then
routes by `semantics` to the class handler. Today's *implicit* carrier-before-image
priority (capture-phase carrier claim, non-carrier falls through to the mount's image drop)
becomes **one explicit ordering in one place** — removing the fragile two-listener dance.

## §3 The `accepts` declaration

An author declares, in the edit-unreachable `#rwa-affordances` zone, which classes the
document welcomes: **`accepts: [<class-name>, ...]`** — an array of class-name strings — plus
an **optional doc-level `strict`** boolean (default `false`). The dispatcher reads it via
`resolveAccepts()`, applying the same edit-unreachable safeguard as `readTrustworthyDeclaration`
(a drifted/forged declaration is ignored — treated as no declaration), and consults it before
routing every real class.

- **No declaration (or no `accepts` key)** → accepts every built-in class, advisory.
- **A declared `accepts`** narrows: dropping an unlisted class still works but a soft
  *"this document doesn't usually take &lt;class&gt;"* status note is shown; when the doc is
  `strict:true` an unlisted class is refused with a clear reason and no side effect.

Advisory by default — an author who wants a locked-down document opts into `strict` explicitly.
The declaration is *legible*: a receiver (or a composing rwa, later) can ask a file what it
accepts before dropping.

> **As-built (AB5):** `strict` is a single **doc-level** boolean, not the per-entry
> `[{class, strict?}]` this section first sketched — per-entry strictness was muddy for no real
> gain. The gate **enforces** at drop time regardless; *reporting* `accepts` back through the
> `self-description/1` contract is deferred (see "As-built deviations" below).

## §4 The consent shell

Extract the "Use this AI" modal's reusable scaffolding into
`showArtifactConsent({ title, provenanceRow, body, confirmLabel, onConfirm })`:

- **install** → the full AI/skill card (signature, author fingerprint, vault, model,
  connect) — the current `showAgentInstallDialog` body.
- **ingest** → an image thumbnail preview.
- **compose** → a skin swatch / before-after preview.

Silent classes pass `silent: true` to skip the modal but still flow through the dispatcher
+ `accepts` check + actor attribution (today's image drop is silent). The shell is where the
trust-UX lives *once* — the in-flight lock, the escaping, the disabled-until-ready gating —
so the next class author cannot reintroduce the bugs the AI increment fixed.

## §5 v1 scope + integration

Three classes across three semantics, all riding existing commit paths + actors:

- **install** — `routeInstallFromText` becomes the class handler (behavior unchanged).
- **ingest** — `ingestImageFile` becomes the class handler (silent, unchanged).
- **compose** — **skin becomes a new droppable**: a dropped skin artifact (a minimal
  declared `rwa-artifact/1` carrying a skin recipe/theme, or a skin file from the future
  skin gallery) routes to the existing `applySkinL1` compose-then-commit (one ⌘Z, actor
  `skin:NAME`).

Install/ingest are pure refactor. Skin-drop is the thin new capability that validates the
type model against a third integration semantics.

## §6 Errors + security

Each class keeps its own trust model; the bus routes to them, never weakens them:

- `install` — signature + `_agValidateInstall` gates + capability narrowing (unchanged).
- `ingest` — image decode/downscale + size caps (unchanged).
- `compose` — the skin injection-scrub (hex/enum whitelist, fail-loud reject of
  url/@import/script tags) (unchanged).

An unclassifiable drop → a clear "not a recognized artifact" status (today's `kind:'none'`).
The only hard block is a `strict`-refusal of an unlisted class. No new external surface; the bus
is client-side only; the single-file invariant is intact.

## §7 Testing

New `tests/artifact-bus.mjs`:

- classifier resolution — declared vs sniff for each class; precedence on an ambiguous
  `.html` (carrier vs plain document vs skin);
- dispatch-by-semantics — each class reaches the right handler;
- `accepts` — advisory note on unlisted, `strict` refusal, frozen refusal, no-declaration
  accepts-all;
- the shared shell — in-flight lock, cancel inert (reusing the `ai-chip` / `intelligence-drop`
  patterns);
- skin-drop end-to-end (one commit, `skin:NAME` actor).

Existing image (`image-assets.mjs`) and carrier (`intelligence-drop.mjs`) drop tests must
stay green — the install/ingest refactor is behavior-preserving.

## §8 Explicitly deferred (the cliffs)

- **rwa-onto-rwa compose — the prize.** Where artifact-centric becomes a network effect
  (every rwa is both a document and a droppable). Needs its own design: *what does merging
  two rwas mean?* Composition semantics are the least understood; deferring keeps this a
  unification exercise, not an open research project. Aligned with the north-star
  universal-surfaces direction.
- **The `transform` class** (drop a kind change: doc → deck).
- **Anything that breaks single-file** — external datasets, live services, knowledge bases.
  This is the persona-graduation cliff (`docs/plans/2026-07-05-drop-in-ai-ux-design.md`,
  Future alley); do not relitigate it inside this concept.
- **A full `rwa-artifact/1` wire spec.** v1 uses only the minimal declared class tag.
  Formalize a spec only once ≥2 native non-carrier classes exist to generalize over.

## Non-goals

- No "drop anything." A curated, closed class set — each member earns its place with a trust
  model.
- No new server surface, no npm deps, no break to the single-file invariant.
- No weakening of any class's existing trust model — the bus routes to them.

## As-built deviations

Two pieces of the design sketch were deferred once the classifier/dispatcher/`accepts` gate
landed clean (all seed-only, pinned by `tests/artifact-bus.mjs`):

1. **The shared consent shell (§4) — DEFERRED.** In v1 only `install` is modal (the existing
   `showAgentInstallDialog`); `ingest` and `compose` commit silently, as they already did.
   With a single modal consumer, extracting `showArtifactConsent(...)` is a speculative
   abstraction (Rule 2) — extract it when a **second** modal class arrives (e.g. a skin
   preview / a `transform` confirm), which is when the shared trust-UX actually pays off.
2. **Self-description reporting of `accepts` (§3) — DEFERRED to a fast-follow.** The gate
   enforces at drop time via `resolveAccepts()` regardless, but threading `accepts` through
   the 4-site `self-description/1` contract (spec + `tools/self-description.mjs` oracle +
   `cli/src/identity.mjs` mirror + seed `runtimeDescribe`, with the `identity.test.mjs`
   deep-equal pins) is the heaviest part and is not required for the bus to work. So
   `rwa doc --json` / `runtime.describe()` do not yet report what a document accepts.

3. **`accepts` gates the DROP gesture (inbound artifacts), not every entry point — by
   design, with one install follow-up.** `resolveAccepts()` is consulted inside
   `dispatchArtifact`, which both drop handlers funnel through. Deliberate *self-authoring*
   gestures on the user's own document are exempt and should stay so — image paste, the
   file-picker image insert, the `/skin` lens, the ✦ gallery — they add content/style to
   your own doc, they are not inbound artifacts. **The one seam to close in a fast-follow:**
   the install **file-picker** (`runtimePromptInstall` → `routeInstallFromText`, the
   skill-host "Install skill…" button) reaches the install handler *without* passing through
   `dispatchArtifact`, so a *picked* AI/skill skips the `accepts` gate a *dropped* one is
   subject to. It is advisory-grade (install still runs full signature-verify + consent; the
   bus never weakens a class's trust model), so it does not block v1 — but routing the picker
   through the bus (or explicitly exempting it) is a considered change: it would make the
   picker an artifact-picker (a picked skin-`.html` would then compose) and would let a
   self-contradictory `strict`-no-install skill-host refuse its own picker. Tracked as the
   accepts-parity follow-up; also collapses the drop-vs-pick "unrecognized" status message.

Also still deferred per §8: rwa-onto-rwa compose (the prize), the `transform` class, and a
full `rwa-artifact/1` wire spec.
