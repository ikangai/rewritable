# Drop-in AI — the UX rework (design)

*2026-07-05. Status: validated design, pre-implementation.*

## Problem

Model selection is the substrate's worst UX moment, and it is the **first** moment. Today a fresh
rewritable answers its first ⌘K with *"no API key — open ⚙ settings"* and auto-opens a developer
form: a 6-option backend dropdown, a password field, a model text input, a base-URL row with a
Test button. Meanwhile the tangible alternative — **drop an AI file onto the document** — is fully
built (`intelligence/0.2`: carrier drop, signed install, model recommendation, all pinned by
tests) but invisible: nothing in the UI advertises it, and the flow it triggers fragments into
3 dialogs / 5 steps ending in a panel named "Activity".

The gap, surface by surface:

| # | Vision | Current state |
|---|---|---|
| 1 | Model selection is tangible: "drop your AI" | ⚙ settings form is the front door |
| 2 | The drop gesture is discoverable | `handleCarrierDrop` built + pinned, zero affordance advertises it |
| 3 | One gesture | drop → install consent → find ⋯→Activity→Intelligences → Activate → model consent |
| 4 | "AI" as the user-facing word | "intelligence", "agent role", "advisor", "Activity" in UI copy |
| 5 | Online gallery of downloadable AIs | none; `examples/intelligence-carrier/` unrouted |
| 6 | Online AI maker | CLI only (`rwa intelligence new`) |
| 7 | Drop it and it *works* | carrier recommends model+backend but can never carry the key (invariant, correct) |

This rework is **UX-only plus two service pages**. No wire format, no crypto, no invariant
changes: the signed `rwa-agent/1` record, the frozen `#rwa-agents` zone, verification gates,
copy-not-link install with I10 update re-affirm, and the sessionStorage-only model/key invariant
all keep their exact semantics.

## Decisions (locked with the author)

1. **Compute story** — the drop flow ends in a **connect step**: the AI names the backend/model it
   wants; if that backend isn't usable, the same dialog asks for the one missing thing (paste an
   OpenRouter key / start-your-local-server guidance). No hosted proxy, no key in the file.
2. **Drop gesture** — **one dialog, full flow**: identity + trust + model + connect in a single
   card with a single "Use this AI" button = install + activate + apply model + store key.
3. **Discoverability** — **AI chip + drop invitation**: a persistent status-bar chip showing the
   active AI, and a drop-invitation card replacing the no-key error path.
4. **Naming** — **"AI" everywhere** in user-facing copy. Specs keep `intelligence` / `rwa-agent/1`
   internally.
5. **Gallery** — **curated static page first** (`/ai`): ~5 repo-committed signed carriers, no
   submissions, no index dependency. The signed marketplace index can back it later.
6. **Maker** — **fully client-side** (`/ai/maker`): WebCrypto Ed25519 keygen + sign in the
   visitor's browser; the private key never leaves the machine. Carrier templating stays
   server-side (`/ai/template.html`).

## §1 Overview — four surfaces

1. **AI chip** (seed) — persistent status-bar identity for the document's AI.
2. **Drop invitation** (seed) — the no-working-backend ⌘K card replacing the auto-opened ⚙ form.
3. **Unified drop dialog** (seed) — "Use this AI?" one-card flow.
4. **AI Gallery + AI Maker** (service) — `/ai` and `/ai/maker`.

The ⚙ settings form survives unchanged as the power-user path — it stops being the front door.

## §2 In-file UX — chip, panel, invitation

**Chip.** In the status bar, left of the `⋯` menu button. States: `◇ AI` (muted, no active AI) /
`◆ <role name>` (active). Subtle `!` suffix + title text when an affinity warning applies. One
small capsule element in the existing status-bar style (system font, gray ramp) — identity, not
chrome noise.

**AI panel** (chip click; same floating-card style as the settings panel):

- **Active AI card**: name, one-line description, author fingerprint, "using \<model\> via
  \<backend\>" from live session state — or "not connected" + a **Connect** button opening the
  same connect step as the drop dialog — plus Deactivate.
- **Advisor AIs**: the existing add/remove advisor controls, relabeled.
- **Installed but inactive**: rows with Activate.
- **Footer**: *"Drop an AI file here — or browse the [AI Gallery]"* (the whole page already
  accepts drops; the zone is a visible target) and a small *"set up manually (⚙)"* link.

The `⋯ → Activity` panel **drops its "Intelligences" section** (history stays). No new `⋯` menu
item — the chip is always visible.

**Drop invitation.** Replaces the `modify()` no-key guard behavior. Card copy: *"This document has
no AI connected. Drop an AI file anywhere on this page, browse the AI Gallery, or set up
manually."* Gallery is a plain link to `https://rewritable.ikangai.com/ai`; "set up manually"
opens ⚙ exactly as today. **AI-aware variant** (the every-new-session case, since model/key are
sessionStorage-only): when an installed AI lacks a connected session — *"\<name\> is ready —
connect a model to run it"* with the one missing field inline.

## §3 The unified drop dialog — "Use this AI?"

One modal card replacing the install-dialog + separate model-offer chain **for the drop path**.
Four zones:

1. **Identity** — name, description, author fingerprint (+ "identified by the key, not the name"
   caveat), ≤200-char instructions preview, vault namespaces (shown only if non-empty), affinity
   note/warning. Verbatim content from today's install dialog — the trust anchor does not thin out.
2. **Model** — *"Wants to use: `<model>` via <backend>."* If the session already has a working,
   different setup: radios — *use recommended* (default) / *keep current*. No recommendation →
   "uses your current model", or falls through to Connect.
3. **Connect** — only when the chosen backend isn't usable now. `openrouter` no key → inline
   password field + *"Your key stays in this browser session — never in the file."* Local
   backends unreachable → the `BACKEND_META` hint + Test button (existing probe). Bridge → hint.
4. **One button** — **"Use this AI"** = install + activate + apply model/backend + store key
   (sessionStorage, same slots ⚙ writes). Disabled until Connect is satisfied. Unverified or
   tampered records: today's behavior exactly — reason shown, **no button**.

Edge cases: multi-envelope carriers keep queued dialogs. Re-drop of an installed role = the v0.9
I10 update path (diff + re-affirm), restyled into this card. The **panel Activate path reuses
zones 2–4** as a slim "Connect this AI" card, so `offerRecommendedModel` folds into one code path.
Cancel = nothing installed, nothing written.

## §4 AI Gallery (`/ai`)

**Routes** (zero-dep `server.js`, read-once-at-startup like other assets):

- `GET /ai` → gallery page from `service/public/ai/index.html`.
- `GET /ai/<name>.html` → carrier download (attachment) from `service/public/ai/carriers/`,
  name allowlisted `[a-z0-9_-]` — no traversal surface.

**Page.** Landing visual language. Hero — *"Drop-in AIs. Download one, drag it onto any
rewritable."* — a 3-step strip (Download → open your rewritable → drop the file on it), the cards,
and a closing CTA *"Make your own → /ai/maker"*. Card: name, one-liner, personality excerpt,
recommended model+backend badge, affinity badge, short author fingerprint, Download.

**Curated set v1 (~5):** Concise Editor (exists), Proofreader (fix-only, never rephrases),
Translator (DE↔EN, tone-preserving), Presentation Coach (affinity: presentation), Playful
Rewriter (personality-as-product demo). Authored via the existing CLI.

**Key custody:** each carrier's `.key.json` stays with the author, offline — **never in the
repo**. Only signed `.html` carriers are committed. `service/public/ai/README.md` records the
regen procedure + fingerprints.

**Landing:** new "AI Gallery" nav/CTA; the existing nav "Gallery" (document demos) is renamed
"Examples" to free the word.

Carriers embed the seed → they join the `tools/regenerate-refs.mjs` discipline (re-sign only when
the *record* changes, not the seed around it).

## §5 AI Maker (`/ai/maker`)

**Fully client-side** (the `/import` ethos: no upload; here, the private key never exists outside
the visitor's browser).

**Form:** AI name (CLI role regex), one-line description, **personality/instructions** textarea
(the `system_prompt` — the heart of the page, with example placeholders), recommended model
(curated datalist) + backend (6-name enum), doc-kind affinity checkboxes. Vault namespaces behind
an "advanced" fold. Live card preview.

**Minting:** WebCrypto Ed25519 `generateKey` + `sign` — the suite the seed already verifies with.
The canon (`canonicalAgent`, `agentSigningMessage`, envelope shape, base64 zone encoding) is
ported from `cli/src/intelligence.mjs` and becomes a **maintained mirror** (CLAUDE.md routing
note) pinned by a **parity test**: one Node test signs the same fixture through the CLI code and
the maker page's extracted JS, compares canon bytes, cross-verifies signatures.

**Carrier assembly, hybrid:** the page fetches `GET /ai/template.html` — the skill-host seed with
fresh `DOC_UUID` and two placeholder markers (card slot, `#rwa-agents` zone slot), built at
startup like `/rewritable.html`. The client injects the rendered card + signed record locally.
Signing client-side; templating server-side where the seed already lives — no `kindOverrides`
port to the browser.

**Output:** `<name>.intelligence.html` (drop-ready; "test it" hint: a carrier is itself a
rewritable — just open it) and `<name>.intelligence.key.json` with the CLI's loud
keep-this-secret copy.

## §6 Naming map, docs, tests, rollout

**Copy map (UI only; specs keep internal terms):**

| Today | Becomes |
|---|---|
| "Intelligences" (Activity panel §) | "AI" (chip panel) |
| "Install agent role X?" | "Use this AI?" |
| "agent role" in dialog copy | "AI" |
| "Add advisor / advisor" | "Add as advisor AI" |
| "no API key — open ⚙ settings" | the drop invitation card |
| Landing nav "Gallery" (demos) | "Examples" |

**Docs:** this design doc; intelligence spec gains a short **§7 "Presentation layer"** (bump to
`intelligence/0.3`) naming the four surfaces — pointers, not restatement; CLAUDE.md routing
updated (chip/dialog seed blocks, gallery, maker mirror). No changes to actions-v0.9, rwa-edit,
or self-description specs.

**Tests:** seed — extend `tests/intelligence-drop.mjs` (one confirm → installed + active + model
applied + key stored), rework `tests/intelligence-model-rec.mjs` (offer folded into
dialog/panel-connect), new `tests/ai-chip.mjs` (chip states, panel, invitation replaces
auto-open-settings). Service — route tests for `/ai`, `/ai/<name>.html`, `/ai/template.html`;
the maker↔CLI signing parity test. Browser-proof pass for the real drag-drop gesture (jsdom
can't do it end-to-end — same discipline as `intelligence-drop`).

**Rollout — four increments, each shippable:**

1. **Seed UX** — chip + panel + unified dialog + drop invitation (the conceptual core).
2. **Gallery** — `/ai` + 4 new curated carriers + landing links.
3. **Maker** — `/ai/template.html` + `/ai/maker` + parity test.
4. **Docs/spec sync** — intelligence/0.3 §7, CLAUDE.md, regenerated refs.

## Future alley (explicitly deferred) — the chip graduates to a persona

A natural progression worth exploring later: the AI chip stops being a *label* and becomes a
*persona* — an AI that accumulates memory and learnings from working in the document, and
eventually gets reachable identity (an email address, a place it can be messaged). The arc is
organic: you start with a generic drop-in AI, you customize it over time, and it becomes *yours* —
at which point exporting it back out as a carrier ("my AI, shaped by this work") is the inverse
of the drop gesture.

**The tension to resolve before building any of it:** persistent memory/learnings and reachable
identity pull against the core invariant that a rewritable is self-contained — everything in the
document/file. Memory in the file bloats and leaks (a shared doc would carry the AI's accumulated
observations); memory outside the file breaks single-file portability; an email address implies a
server-side standing identity, which the substrate deliberately does not have. Possible openings
when the time comes: memory as an explicit, consented, exportable zone (visible like
`#rwa-agents`, prunable, strippable on share); learnings distilled into the signed role's prompt
via re-sign (the carrier update path already exists — I10); identity as an *external* service that
holds nothing but a forwarding address to a capability URL. None of this is designed; this section
exists so the alley isn't lost.

## Non-goals

- No hosted proxy / metered compute (business decision, separate).
- No user submissions to the gallery (moderation/identity — v2, possibly via the signed
  marketplace index).
- No new `PRODUCT_KIND`, no `intelligence/1` wire fork (already rejected in intelligence/0.2 I-C).
- I-B (cross-machine backend config portability) stays recommended-against.
- No change to what a carrier may carry: the key never enters any file.
