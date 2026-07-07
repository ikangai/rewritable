# Intelligence chip — Datasheet + Card treatments & advisory-only editing (design)

The chip is the user-facing face of a droppable AI (a signed `rwa-agent/1`). The shipped
drop-in-AI work (`docs/plans/2026-07-05-drop-in-ai-ux-design.md`, `intelligence/0.3` §7) defined
*where* the chip lives — status-bar chip, AI panel, unified drop dialog, `/ai` gallery + maker.
This doc adds the two things that work left open: **how the chip looks** (two deliberate visual
treatments — *Datasheet* and *Card*) and **how you edit it with a prompt** (an **advisory-only**
editing contract). It is design only; no seed/service code changes yet.

Visual companion: `demo/intelligence-chip-directions.html` (the four-direction lookbook; the two
treatments below are directions 02 and 01, re-cut for advisory-only editing).

## Problem

A droppable AI is an awkward object: it is **structured** like a form (prompt, engine,
credentials, signature), it must be **editable** like a rewritable, and it must be **browsable** in
a gallery. Three sub-problems the shipped UX did not resolve:

1. **Editing vs. trust.** Trust is an Ed25519 signature over the canonical agent, and
   `system_prompt` is *inside* the signed fields — so "edit the AI's personality with a prompt"
   invalidates the signature by definition. The drop-in-AI flow sets the model at drop-time and
   never revisits editing; "edit like a rwa" was never specified.
2. **One name, four surfaces.** "The chip" is a cold gallery listing, the carrier's own page, the
   drop/consent dialog, and a one-line in-app status button. They have opposite constraints
   (lavish-and-stateless vs. sober-and-live). A single visual identity can't serve all of them
   equally.
3. **Trust is the key, not the name.** A gorgeous name-forward card teaches a spoofable model
   (`concise-editor` is a handle, not a brand; two authors can ship it). Signed ≠ vetted.

## Decisions (locked with the author)

1. **Editing model = advisory-only (B).** In-app, the **signed** fields (`role`, `description`,
   `system_prompt`, `vault_namespace_set`) are **frozen** — the signature is never silently
   mutated. Only the **advisory** fields (`recommended_model` / `recommended_backend`, `affinity`)
   are prompt-editable, because they ride *outside* the signature. A prompt that targets the
   personality is **declined + redirected to the Maker** ("make your own copy"). No overlay tier
   (model D), no in-app re-signing (model C lives at the authoring surface). Trade-offs: see the
   editing-model analysis in chat / this doc's §3.
2. **Surface = both.** The cold `/ai` gallery listing **and** the live in-app chip. Editing governs
   **only** the in-app chip; the gallery is pre-install and stateless, so it never edits.
3. **Two treatments, developed together.** *Datasheet* (blueprint manifest) and *Card* (holographic
   collectible) are built as a **presentation layer over one shared chip-model + one B contract** —
   they differ in CSS/markup only. Recommended composition in §6.
4. **Trust is key-forward.** Every treatment leads the trust cue with the **author fingerprint**,
   not the role name; the verified state is signature-verifies-against-`author_pubkey`, and the
   "identified by the key, not the name" caveat from the drop dialog is preserved.
5. **Spec first.** This document. No `seeds/rewritable.html` or `service/` edits until the operator
   picks a composition (§6) and green-lights an increment (§8).

## §1 Scope & relation to the 2026-07-05 drop-in-AI design

This doc **does not redefine** the chip/panel/dialog/gallery/maker surfaces — it re-skins two of
them and adds an editing gesture:

| Surface (owner: 2026-07-05 doc) | This doc changes |
|---|---|
| AI chip (`renderAiChip`) | visual treatment; adds a live-state read |
| AI panel (`renderAiPanel`) | visual treatment; **adds the B-editing prompt input** |
| Drop/consent dialog (`showAgentInstallDialog`), invite (`showAiInvite`) | adopt the in-app treatment (light) |
| `/ai` gallery (`service/public/ai/index.html`) | `.ai-card` treatment |
| Maker `buildCard` / CLI / carriers | treatment parity only if the carrier's own page must match (§7) |

Everything in the drop-in-AI "Non-goals" (hosted proxy, key-in-file) stays a non-goal here.

## §2 The shared chip model (real `rwa-agent/1` fields) & state machine

Both treatments render the same fields — no invented data (esp. **no per-persona skills array**;
that remains an open question, §Open):

| Field | Signed? | Shown as |
|---|---|---|
| `role` | ✓ | the handle (mono) — **not** the trust anchor |
| `description` | ✓ | one-line tagline |
| `system_prompt` | ✓ | ≤200-char preview in-app; full only on the carrier's own page |
| `recommended_model` + `recommended_backend` | ✗ advisory | `model · backend` badge — **editable** |
| `affinity` | ✗ advisory | "best for: <kind>" / "any kind" — **editable** |
| `vault_namespace_set` | ✓ | "reaches: <ns>" / "no credentials" |
| `signature` → `verified` | ✓ | shield + 16-char fingerprint — **the trust anchor** |
| connect state | session-only | in-app only; `not connected` / `using <backend>` / `using <model> via <backend>` |

**State machine (the states the lookbook under-designed — both treatments must render all of
them):**

- `empty` — no AI (`◇ AI`). Gallery: n/a. The conversion state.
- `installed · verified · not-connected` — the every-new-session default (model/key are
  session-only). Needs the Connect affordance.
- `installed · verified · connected` — full live state (`using <model> via <backend>`).
- `advisor` — verified, layered (existing I-E blend controls; vault-blocked).
- `unverified / tampered` — no activate, no edit; trust-fail cue (matte / REJECT / dark LED).
- `update-available` — re-drop of an installed role → the v0.9 I10 diff + re-affirm.

Gallery (cold) can only ever render `verified` vs `unverified` and the advisory badges — **no
connection state, no live model**. In-app renders the full machine.

## §3 The advisory-only editing contract (B) — the novel core

The chip gains a **chip-scoped prompt input** in the AI panel (distinct target from the
document lens). Its behaviour:

1. **Deterministic intent match first (Rule 5 — code answers routing).** A small allowlist of
   advisory-edit intents is recognised by pattern, no model call:
   - model/backend: *"use gemini", "run on sonnet", "switch to openrouter"* → validate
     (`backend` against the enum; `model` as an id string) → apply to **sessionStorage**
     (`rwa_model` / `rwa_backend`) via the **existing I-A `applyRecommendation` path** (enum-checked,
     never base-URL/key), with a one-line confirm. Session-only, signature untouched.
   - affinity hint: *"best for decks"* → local advisory hint (kind enum).
2. **Everything else declines + redirects.** Any instruction touching personality / role /
   description / vault, or any free-form behavioural ask, returns the decline:
   > *"<role>'s instructions are signed by its author — I keep them as written. I can change its
   > model or affinity, or you can make your own copy in the AI Maker →"*
   The redirect opens `/ai/maker` (model C — re-author under **your** key). Deep-prefilling the
   Maker with the existing record ("fork this") is an enhancement (§Open), not v1.
3. **Never breaks the signature.** No path in this contract writes a signed field. Vault reach is
   structurally unreachable (matches the built `_agVaultAllowed` = active-record-only guarantee).

This is deliberately conservative: no model is needed to *route* the edit (model-assisted
classification of ambiguous instructions is a later option, §Open). It says "no" to personality
edits by design — the honest cost of B, and why §6 assigns the treatments carefully.

## §4 Treatment A — The Datasheet (advisory-only's natural home)

Blueprint manifest: monospace, hairline rules, labelled fields, punch-card registration. **Signed
fields render in ink; advisory fields in cyan** — the color *is* the editability legend. Trust =
a checksum-style `SIG <fingerprint> · verified` line + an `✓ AUTHENTIC` / `✕ REJECT` stamp.

- **Why it fits B best:** editing = typing at a command line that simply refuses to write ink.
  `set model gemini` ✓ (cyan); `set prompt "…"` → `E_SIGNED_FIELD · write rejected · fork in Maker`.
  The refusal is legible, not a dead end.
- **Trust-legible + a11y-safe:** the ✓/✕ *text* stamp survives grayscale (no color-only trust);
  fingerprint is first-class.
- **Risk:** cold; less seductive to a first-time browser. Precision + the red REJECT carry it.

## §5 Treatment B — The Card (the gallery seducer)

Dark holographic collectible: foil edge = verified signature made physical (unsigned = matte, can't
be "played"), capability as real "stats" (engine / affinity / reach — never invented numbers),
`system_prompt` as flavour text with a **`🔒 voice signed · frozen`** cue.

- **Under B:** "retune" edits only the advisory stats (engine/affinity); the flavour text is locked
  with a redirect to the Maker. Retune succeeds visibly for `use gemini` (foil intact, session-only).
- **Why it fits the gallery:** a binder of foil cards is genuinely fun to browse and turns the
  otherwise-boring shield into the most eye-catching thing on the card.
- **Risks:** (a) gamified stats can read unserious for a writing tool — mitigated by keeping stats
  real + copy plain; (b) foil-vs-matte is a **color-only** trust cue → must be paired with the
  text "signed / unsigned" label for a11y (guardrail §9).

## §6 Surface-by-surface mapping + the composition question

Because the two surfaces have opposite jobs, "develop both" has a clean home:

**Composition A (recommended) — Card in the gallery, Datasheet in-app.**
The cold `/ai` gallery *seduces* a first-time browser (Card); the in-app chip is *sober
infrastructure* that gets out of the way of the user's document and reads as trustworthy
(Datasheet). This directly resolves Problem #2 — each treatment plays to its surface's constraint
— and B's "edit = configure" story lands hardest on the in-app Datasheet.

**Composition B — one treatment everywhere.** Pick Datasheet or Card system-wide for a single
identity. Simpler brand, but forces one treatment to do both jobs.

Either way, both treatments are fully specified; a `data-treatment` switch lets the operator A/B
before committing. Per-surface detail:

- **Gallery card** (`service/public/ai/index.html` `.ai-card`): treatment CSS + markup. Stateless —
  advisory badges + fingerprint + Download only. No connect LED, no live model.
- **In-app chip** (`renderAiChip`): must stay **one line**. Datasheet = `[◆] <role>` mono bracket;
  Card = foil pill. `◇ AI` empty state in both.
- **In-app panel** (`renderAiPanel`): treatment for the rows + the full state machine (§2) + the
  **new B-editing prompt input** (§3). Reuses existing Connect / Activate / Deactivate / advisor
  controls.
- **Consent dialog + invite** (`showAgentInstallDialog` / `showAiInvite`): adopt the **in-app**
  treatment (light restyle; content/trust anchor unchanged from the shipped dialog).

## §7 The 5-site consistency tax (scope, not a change yet)

A card redesign is not one file. Whatever ships must stay coherent across:

1. `seeds/rewritable.html` — `renderAiChip` / `renderAiPanel` (+ the new edit input) / dialog / invite.
2. `service/public/ai/index.html` — the gallery `.ai-card`.
3. `service/public/ai/maker.html` — `buildCard` (the carrier's own rendered page), **only if** it
   must match the new treatment. Its canon is byte-identical to the CLI and **parity-gated by
   `service/tests/maker-parity.test.mjs`** — a change here means changing the CLI in lockstep.
4. `cli/src/intelligence.mjs` + `cli/src/skill-manifest.mjs` — the CLI mirror of `buildCard`.
5. `service/public/ai/carriers/*.intelligence.html` (×5) — regenerated via
   `tools/regenerate-refs.mjs` (re-sign **only** if a record changes, never for a seed/skin change).

The `.ai-card` (gallery) and the chip/panel (seed) are the *cheap* sites — they carry no signed
canon. `buildCard` is the *expensive* one (parity test). **Recommendation:** treat the carrier's
own page (`buildCard`) as out-of-scope for v1 — restyle only the gallery listing + in-app surfaces,
leaving the carrier's self-rendered page on the current card. That keeps the parity test and the
CLI untouched.

## §8 Increments (build order + success criteria)

- **Inc 0** — this design doc. ✅
- **Inc 1 — shared model + B contract (deterministic).** A seed intent-classifier for the chip
  edit input: advisory allowlist honored, everything else declined + redirect. *Success:*
  `tests/chip-edit.mjs` — `use gemini` applies to sessionStorage; `make it gentler`, role/vault
  edits all decline with the Maker redirect; **no test can make it write a signed field.**
- **Inc 2 — in-app chip + panel (Datasheet, per Composition A).** `renderAiChip`/`renderAiPanel`
  treatment + the full state machine (§2) + the edit input wired to Inc 1. *Success:* all six
  states render; browser-proof a real `use gemini` edit + a real personality decline.
- **Inc 3 — gallery Card treatment.** `.ai-card` restyle in `index.html`, both `verified` and
  `unverified` states, color-only trust paired with text (§9). *Success:* gallery renders the 5
  real carriers + one unsigned example; no live-state leakage.
- **Inc 4 — dialog + invite adopt the in-app treatment.** Light restyle of
  `showAgentInstallDialog`/`showAiInvite`; trust anchor + gates byte-unchanged. *Success:* drop
  suite (`tests/intelligence-drop.mjs`) + `tests/ai-chip.mjs` stay green.
- **Inc 5 — regen + docs + pick default.** Regenerate refs/carriers (record-preserving), update
  `service/public/ai/README.md`, operator picks Composition A vs B as the default.

## §9 Accessibility, i18n & trust-legibility guardrails (non-negotiable)

- **No color-only trust or state.** Foil/matte and LED green/amber/red must always be paired with a
  text label (`signed` / `unsigned`, `connected` / `not connected`). The Datasheet's ✓/✕ text stamp
  is the reference.
- **i18n.** Role/description/preview must survive non-Latin + long German compounds (the
  `translator` persona is DE↔EN) — no fixed-width truncation that clips meaning; mono role fields
  wrap or ellipsise with a title.
- **Key-forward trust.** Fingerprint is first-class; the role name is never presented as a vouched
  brand. Keep the "identified by the key, not the name" caveat.
- **Semantics.** The chip is a button (role/label); the panel edit input is a labelled field; focus
  states visible; `prefers-reduced-motion` respected (foil sheen / LED pulse are decorative).

## Non-goals (explicitly deferred)

- **Overlay editing (model D)** and **in-app re-signing (model C)** — C is reachable only via the
  Maker/CLI redirect; no private-key signing in the document runtime (same leak class as the API
  key).
- **A per-persona skills array** — not in the data model today; still an open product question.
- **Restyling the carrier's own `buildCard` page** in v1 (parity-test + CLI cost; §7).
- **Persona-graduation** (a chip that "remembers") — deferred in the drop-in-AI doc; unchanged here.
- **Model-assisted intent classification** for the edit input — v1 is deterministic-only.

## Open questions

1. **Composition** — A (Card gallery / Datasheet in-app, recommended) vs. B (one treatment
   everywhere)? Decide after Inc 2+3 make both visible in-context.
2. **"Fork in Maker" prefill** — does the redirect deep-prefill the Maker with the existing record,
   or start blank? (Enhancement; affects Inc 1's redirect target.)
3. **Skills array** — add a real per-persona capability list to `rwa-agent/1`, or is
   model + affinity + vault enough? (Would change §2 and the signed canon — a separate spec.)
4. **Edit-input placement** — inline in the AI panel (recommended) vs. a chip-scoped mini-lens.
