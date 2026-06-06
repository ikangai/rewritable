# Skinning rewritables — a style-library design

**Status:** v1 (theme-only) + **v2 (always-on L1 content-aware restyle) BUILT & on main** as of 2026-06-06 — impl plan `docs/plans/2026-06-06-skinning-v2-impl-plan.md`. v2 shipped the **compose-then-commit primitive** (`applyEdits {noCommit}` + `modify(instr,lensMeta,{compose})` → run the agent no-commit, splice the deterministic theme block, commit theme + `sk-*` wrappers as ONE `replace_document`, one ⌘Z), `applySkinL1` + seed-only `RWA_SKIN_RECIPES` for the 5 presets, the `sk-*` theme CSS, and the ✦ gallery + `/skin` wiring; pinned by `tests/skin-compose.mjs` + conformance SKIN-01/02/03. NOTE the implementation chose **Path A** (build the composed doc, commit via `replace_document`) over this doc's placeholder/`edit_batch` sketch, and does NOT use `runtimeRegionCommit`. Deferred: deterministic re-skin de-skin (best-effort today — a non-compliant model can leave orphan `sk-*` wrappers), CLI L1, v3 vision/`/skin like <image>`, the full 12-preset library, and `activeSkin` in self-description. Original design date: 2026-06-03. Author: kepler (7-agent design fan-out + adversarial critique; v2 built + adversarially reviewed 2026-06-06).

## Problem

Free-form lens editing ("type what you want, the document rewrites itself") is rewritable's most powerful surface and its most overwhelming one. A blank prompt in front of an open-ended document is a cold start: most people don't want infinite possibility, they want *a good-looking default they can pick from a shelf*. The pattern they already know from every other tool is a **library of named looks** ("Notion-clean", "Terminal", "Newspaper") plus the escape hatch everyone reaches for — **"just make it look like *this*"**, where "this" is a screenshot they drop in. This document designs that: a **skin** system that turns the overwhelming blank canvas into a one-click shelf of looks, without leaving the single-file, offline-first, no-server world that makes a rewritable a rewritable.

## The approach in one paragraph

A **skin** is a `(theme block + restyle recipe)` applied through the **existing rwa-edit/1 loop** — skinning *is* an edit, so it inherits undo (⌘Z), `rwa_hist`, frozen-zone safety, and exact-splice for free, and the whole skin lands as **one commit** that one ⌘Z reverts. The theme is **one `<style data-rwa-skin="NAME">` block** that lives *inside `INLINE_DOC`*, so it commits with the document and ships in the exported file — no runtime state, survives sharing. Two layers: **L0** is a deterministic CSS theme (palette, type, density, radii, shadows) that needs no model; **L1** is an always-on, content-aware markup restyle where the model adds class hooks and light wrappers so the theme *lands* with real visual impact. Users reach it two ways: a **built-in preset gallery** (thumbnail swatches in the runtime chrome, one click to apply) and **lens commands** (`/skin NAME`, `/skin like <image>`, `/skin reset`). The "make it look like this" path takes a **screenshot**, extracts a *validated token set* with a vision-capable backend (never copying remote CSS, fonts, or images — self-containment is preserved), and feeds it into the *same* apply path as a named preset. The CLI mirrors all of it (`rwa skin <file> NAME`, `rwa new --skin NAME`), and `self-description/1` reports the applied skin as an `activeSkin` attribute.

## Design decisions (locked)

These forks were decided with the product owner before the design fan-out; the body builds on them and does not relitigate them. Where the adversarial critique found an internal contradiction in *how* to realize a locked decision, the **Resolved** note records the single answer chosen.

| Fork | Decision | Notes |
|---|---|---|
| **What a skin changes** | **Theme + content-aware restyle.** A skin may rewrite markup (add class hooks / light wrappers), not just swap CSS. | The "wow" axis. See *Always-on restyle*. |
| **Restyle depth** | **Always full restyle**, maximum visual impact. | Safety is ⌘Z + single-block reset + history, not a "preview/opt-in" gate. |
| **"Make it look like X" input** | **Screenshot / image.** URL scraping **deferred**. | Image keeps the file self-contained; URL breaks offline-first + adds a fetch/exfil surface. |
| **Surface** | **Built-in preset gallery + lens commands.** | Gallery is the primary, discoverable door for the non-power-user. |
| **Scoping model** *(Resolved — was a 3-way contradiction)* | Tokens + element rules are declared on **`#rwa-doc-mount`** — **not** `:root`, **not** a per-`<article>` class. | Keeps the runtime chrome on the frozen `:root` palette: a dark skin re-tints the *document*, never the light lens/settings UI. One model, propagated everywhere. |
| **Hook namespace** *(Resolved — was 3 spellings)* | L1 class hooks use the **`sk-`** prefix (`.sk-card`, `.sk-hero`, `.sk-stat`). | Maximally distinct from the reserved `rwa-*` / `data-rwa-*` namespace; de-skin is a clean `sk-*` strip. |
| **First-skin commit path** *(Resolved — the central trap)* | The seed bakes an **empty `<style data-rwa-skin="">` placeholder** into every kind's `INLINE_DOC`, so the `<style>` count never changes and every skin / re-skin / reset is a surgical content-only `apply_edits` swap. | Avoids `structural_shape_changed`. A **dirac-owned seed dependency** (see *Coordination*). Fallback if unavailable: `replace_document` up front (weaker audit). |

## Skin model & token contract

A skin is a theme block plus a restyle recipe applied through the existing rwa-edit/1 loop. This section specifies the theme block — its token vocabulary, its exact shape and placement, where it wins and where it must not, and the honest boundary between what the block alone achieves (L0) and what requires the markup pass (L1).

### The `data-rwa-skin` block — shape, placement, and why it wins

**Exactly one** block per document, the **first child of `INLINE_DOC`** (before `<article>`/content), present from creation as an empty placeholder:

```html
<!-- unskinned (baked into every kind's INLINE_DOC by the seed): -->
<style data-rwa-skin=""></style>

<!-- after applying a skin (a content-only swap of the same block): -->
<style data-rwa-skin="editorial-serif">
#rwa-doc-mount{
  /* token overrides are declared HERE, not on :root — so the runtime chrome
     (which reads the tokens off the frozen :root) keeps its light palette. */
  --accent:#c2410c; --accent-strong:#9a3412; --accent-weak:#ffedd5; --on-accent:#fff;
  --gray-50:#fbf7f0; --gray-100:#f5efe4; --gray-200:#e7ddcb; --gray-900:#2a2118;
  --font-display:Georgia,'Iowan Old Style','Palatino Linotype',serif;
  --measure:680px; --radius:16px; --radius-sm:8px; --density:1.05;
  --shadow-card:0 1px 2px rgba(42,33,24,.06),0 8px 24px rgba(42,33,24,.08);
}
/* baseline element re-rules — real #rwa-doc-mount selectors (specificity 1,0,1)
   beat the seed's :where(#rwa-doc-mount …) baseline (specificity 0,0,1). */
#rwa-doc-mount article{max-width:var(--measure);}
#rwa-doc-mount h1,#rwa-doc-mount h2,#rwa-doc-mount h3{font-family:var(--font-display);}
#rwa-doc-mount blockquote{border-left-color:var(--accent);}
/* sk- hooks the L1 pass attaches (defined in the same block, so removing the
   block removes the styling and any leftover class="sk-card" is inert). */
.sk-card{background:var(--surface-2);border:1px solid var(--rule);border-radius:var(--radius);box-shadow:var(--shadow-card);}
.sk-eyebrow{font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint);}
.sk-stat b{font-family:var(--font-display);font-size:var(--text-2xl);color:var(--accent);}
</style>
```

`NAME` is the skin identity — the single anchor the lens, the gallery, reset, and self-description all key on. **Re-skin** = swap the whole block (one `apply_edits` `(find,replace)` pair, `<style>` count unchanged). **Reset** = swap back to the empty placeholder. **First skin** = swap the empty placeholder for a populated one. All three are content-only edits that pass the structural-shape guard — *because the placeholder is always present* (the locked first-skin resolution).

**Why the two scoping mechanisms differ.** Element re-rules (`#rwa-doc-mount h1`) win on **specificity** over the seed's specificity-0 `:where()` baseline, regardless of source order. Token overrides win by being declared on **`#rwa-doc-mount`** (a real selector on the document subtree) rather than `:root`: custom properties inherit, so the document subtree resolves the skin's `--accent`, while the runtime chrome — which lives outside `#rwa-doc-mount` and reads `--accent` off the frozen `:root` — is **untouched**. This is the resolution to the chrome-tinting contradiction: a skin themes the *document*, never the chrome.

**What a skin cannot (and must not) override:** the seed's `!important` print rules (`@media print` forces single-column full-measure — so editorial "columned measure" and drop-caps are screen-only by design; print falls back to the seed's print stylesheet); the runtime chrome layout (`#rwa-lens`, `#rwa-set`, …); and any **frozen zone** (marker-form or `data-rwa-frozen`, including the workflow kind's `wf-style`/runner). A skin must never emit `!important` to fight the print rules.

### Token vocabulary

A skin sets CSS custom properties that **extend** the seed ramp (it redefines the *same names* — `--gray-50…900`, `--green/--yellow/--red/--blue`, `--accent`, `--radius/--radius-sm`, `--font-ui/--font-mono` — so every legacy alias keeps resolving). The v1 contract is intentionally **lean** (the critique flagged the original ~70-token vocabulary as over-built and divergent from what presets actually use): a skin needs the **ramp re-point** plus ~6 knobs — heading font (`--font-display`), accent (`--accent` + `--on-accent`), measure (`--measure`), radius (`--radius`), density (`--density`), one shadow tier (`--shadow-card`). Semantic surface aliases (`--surface-2`, `--rule`, `--ink`, `--ink-soft`, `--ink-faint`) let hooks stop reaching into raw ramp stops. The **full** vocabulary below (type scale, weight/leading/tracking ladders, motion, shadow tiers) is documented as a *future* surface — presets may set element rules directly rather than thread every token, and v1 does not require them.

<details><summary>Full future token vocabulary (documented, not required for v1)</summary>

- **Palette ramp (neutral):** `--white`, `--gray-50 … --gray-900` (re-point to the skin's neutral hue; a dark skin inverts so 50≈near-black, 900≈near-white).
- **Palette (semantic + accent):** `--green/--yellow/--red/--blue`, `--accent`, `--accent-strong`, `--accent-weak`, `--on-accent`, `--link`. Surface aliases: `--surface-1/2/3`, `--ink`, `--ink-soft`, `--ink-faint`, `--rule`.
- **Type (system stacks only — no web fonts):** `--font-ui`, `--font-mono`, `--font-display`; scale `--text-xs … --text-4xl`; weights `--weight-normal/medium/semibold/bold`; rhythm `--leading-tight/normal/loose`, `--tracking-tight/wide`, `--measure`.
- **Density / spacing:** `--density` (multiplier), `--space-1 … --space-8`, `--section-gap`, `--card-pad`.
- **Radii:** `--radius`, `--radius-sm`, `--radius-md`, `--radius-pill`, `--radius-none`.
- **Borders / shadows / motion:** `--border-width/-color/-style`; `--shadow-none/sm/md/lg/card/focus`; `--motion-fast/base/slow`, `--ease`, `--motion-scale` (0 ⇒ honor reduced-motion). Skins must wrap nontrivial animation in `@media (prefers-reduced-motion: reduce)`.

</details>

### L0 vs L1 — the honest boundary

- **L0 (theme block alone, no markup change):** re-tint the document; reset type (family/scale/weight/leading/measure/display face); set density, radii, borders, shadows; re-rule every standard prose element (`h1–h6, p, a, blockquote, code, pre, table, hr, li`) because the baseline targets are known tags. Deterministic, fully reversible, "swap one block." **Genuinely strong on prose-shaped documents** — but a `--theme-only` or `rwa new --skin` document shows *only* this half until the model runs.
- **L1 (content-aware markup pass):** promote a heading+byline into a **card**; turn a row of numbers into **stat tiles**; add eyebrows, ledes, pull-quotes, callouts, tag chips — *new semantic roles* not inferable from generic tags. L1 attaches `sk-*` hook classes (and sometimes a wrapper) where the content warrants it. **L1 wrappers are additive-only and 1:1-invertible** (wrap a contiguous run, never merge or move existing blocks) — a hard invariant so de-skin is always a clean strip and `data-rwa-id`s are never renumbered.

**The maximum-impact promise is met only on the model (L1) path.** Theme-only is palette/type/density (still strong on prose); the dramatic restructure requires L1. The design states this plainly rather than implying every apply is dramatic.

## The preset library

The library is the shelf of named looks. Below are **12 worked presets across two families** — each with concrete palette/type/radii values, system fonts only, an L1 restyle recipe, and a pure-CSS thumbnail concept. They are the substance of the deliverable: the *values* (hexes, type stacks, radii, density) are authoritative and near-shippable.

> **Normalization note (read before implementing).** These preset blocks were authored *before* the scoping/hook resolutions above were finalized, so their CSS uses a mix of scoping styles (some scope to `:root`, some to a `.rwa-skin-NAME` class, some to `#rwa-doc-mount`) and the older `rwa-skin-` hook prefix. **The canonical model is the one in *Skin model & token contract* above:** tokens on `#rwa-doc-mount`, element rules `#rwa-doc-mount tag`, hooks `sk-*`. Treat each preset's **palette/type/radii/shadow/density values and its restyle recipe as authoritative**, and its **selector scoping + hook prefix as illustrative — to be normalized to the canonical model at implementation.** v1 ships **3** of these (recommended: `notion-clean`, `linear-dark`, `editorial-serif`), normalized; the rest are the v2/v3 library.

### Preset Library — Professional / Clean Family

These six skins live inside `INLINE_DOC` as a single `<style data-rwa-skin="NAME">` block placed at the top of the document `<article>` (or just inside `#rwa-doc-mount`). Each block opens by overriding the frozen `:root` ramp via the document cascade (document `<style>` beats the seed's specificity-0 `:where()` baseline), then restyles the baseline elements scoped under the skin class. The model adds `class="rwa-skin-<name>"` to the document's outermost editable container (typically `<article>` — never a frozen zone) so the skin class is the scope root; this keeps a hard "reset" trivial (delete the one `<style>` block + strip the one class). Every value below is concrete and system-font-only; the only graphics are inline data-URI SVGs measured in bytes.

**Shared mechanics for all six**
- Scope root: `.rwa-skin-<name>` is added to `<article>`. All selectors below are written `#rwa-doc-mount .rwa-skin-NAME …` so they out-specify the seed's `:where()` (0,0,1) baseline without `!important`.
- The L0 block redeclares ramp vars *and* writes element rules, because the seed baseline binds `var(--gray-N)` directly — overriding the vars alone shifts the whole substrate chrome, so each skin instead overrides at the element level under its own scope, leaving the runtime chrome (`#rwa-set`, `#rwa-pal`, `#rwa-lens`) on the global ramp untouched.
- `data-rwa-id` attributes on existing blocks are preserved verbatim by the restyle (the model only adds classes/wrappers; it never rewrites an id). New wrappers the model introduces carry **no** `data-rwa-id` (ids are runtime-assigned at the next commit's backfill).
- Self-description: the block's `data-rwa-skin="NAME"` is read into `self-description/1` as `activeSkin` (declared projection).

---

#### notion-clean
- **id:** `notion-clean`
- **label:** Notion Clean
- **vibe:** Airy default-doc calm — generous whitespace, hairline rules, a quiet gray-blue accent.
- **evokes:** A Notion page or Linear doc: roomy left-aligned text, subtle block hover affordances, soft dividers.

```html
<style data-rwa-skin="notion-clean">
#rwa-doc-mount .rwa-skin-notion-clean{
  --nc-ink:#37352f; --nc-soft:#6b6b6b; --nc-faint:#9b9a97; --nc-line:#ededec;
  --nc-bg:#ffffff; --nc-tint:#f7f6f3; --nc-accent:#2383e2; --nc-quote:#eb5757;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  color:var(--nc-ink); line-height:1.7;
}
#rwa-doc-mount .rwa-skin-notion-clean article{max-width:740px;margin:72px auto;padding:0 40px;}
#rwa-doc-mount .rwa-skin-notion-clean h1{font-size:2.5rem;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin:1.4em 0 .3em;color:var(--nc-ink);}
#rwa-doc-mount .rwa-skin-notion-clean h2{font-size:1.5rem;font-weight:600;letter-spacing:-.01em;margin:2em 0 .3em;color:var(--nc-ink);}
#rwa-doc-mount .rwa-skin-notion-clean h3{font-size:1.2rem;font-weight:600;margin:1.6em 0 .25em;color:var(--nc-ink);}
#rwa-doc-mount .rwa-skin-notion-clean h4,#rwa-doc-mount .rwa-skin-notion-clean h5,#rwa-doc-mount .rwa-skin-notion-clean h6{font-weight:600;color:var(--nc-soft);margin:1.3em 0 .2em;}
#rwa-doc-mount .rwa-skin-notion-clean p{font-size:1rem;color:var(--nc-ink);margin:0 0 .9em;}
#rwa-doc-mount .rwa-skin-notion-clean a{color:var(--nc-ink);text-decoration:underline;text-decoration-color:var(--nc-faint);text-underline-offset:3px;}
#rwa-doc-mount .rwa-skin-notion-clean a:hover{text-decoration-color:var(--nc-accent);color:var(--nc-accent);}
#rwa-doc-mount .rwa-skin-notion-clean ul,#rwa-doc-mount .rwa-skin-notion-clean ol{margin:0 0 .9em;padding-left:1.6em;color:var(--nc-ink);}
#rwa-doc-mount .rwa-skin-notion-clean li{margin:.25em 0;}
#rwa-doc-mount .rwa-skin-notion-clean blockquote{margin:1.2em 0;padding:.2em 0 .2em 1em;border-left:3px solid var(--nc-ink);color:var(--nc-soft);font-style:normal;}
#rwa-doc-mount .rwa-skin-notion-clean hr{border:0;border-top:1px solid var(--nc-line);margin:2.4em 0;}
#rwa-doc-mount .rwa-skin-notion-clean code{font-family:'SF Mono',Menlo,Monaco,ui-monospace,monospace;font-size:.85em;background:var(--nc-tint);color:#eb5757;padding:.15em .4em;border-radius:4px;}
#rwa-doc-mount .rwa-skin-notion-clean pre{background:var(--nc-tint);border:1px solid var(--nc-line);border-radius:8px;padding:16px 18px;}
#rwa-doc-mount .rwa-skin-notion-clean table{font-size:.95em;}
#rwa-doc-mount .rwa-skin-notion-clean th,#rwa-doc-mount .rwa-skin-notion-clean td{border-bottom:1px solid var(--nc-line);padding:.55em .8em;}
#rwa-doc-mount .rwa-skin-notion-clean th{background:var(--nc-tint);color:var(--nc-soft);font-weight:600;}
/* L1 hooks */
#rwa-doc-mount .rwa-skin-notion-clean .rwa-skin-callout{display:flex;gap:.6em;background:var(--nc-tint);border-radius:6px;padding:14px 16px;margin:1.2em 0;color:var(--nc-ink);}
#rwa-doc-mount .rwa-skin-notion-clean .rwa-skin-callout::before{content:"💡";flex:0 0 auto;}
#rwa-doc-mount .rwa-skin-notion-clean .rwa-skin-eyebrow{font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--nc-faint);margin-bottom:.4em;}
</style>
```

- **L1 restyle recipe:**
  - Add `class="rwa-skin-notion-clean"` to `<article>`.
  - Promote the *first short single-line paragraph that reads as a dek/subtitle* immediately under the H1 to an `.rwa-skin-eyebrow` line above the H1 (move it, don't duplicate); if no dek exists, leave H1 alone.
  - Convert any paragraph that begins with "Note:", "Tip:", "Important:" (or a single 💡-leading line) into `<div class="rwa-skin-callout">…</div>`.
  - Leave list/table structure as-is — this skin's impact is in spacing and the callouts, not heavy restructuring.
- **Thumbnail swatch (64×48):** white card, one bold dark bar (H1) top-left, two thin gray text-lines, and a small `#f7f6f3` rounded callout rectangle bottom. Inline SVG:
  `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='48'><rect width='64' height='48' fill='%23fff'/><rect x='8' y='8' width='30' height='6' rx='2' fill='%2337352f'/><rect x='8' y='20' width='44' height='3' fill='%23c9c8c4'/><rect x='8' y='27' width='38' height='3' fill='%23c9c8c4'/><rect x='8' y='36' width='48' height='8' rx='2' fill='%23f7f6f3'/></svg>`

---

#### stripe-docs
- **id:** `stripe-docs`
- **label:** Stripe Docs
- **vibe:** Crisp API-documentation polish — indigo accent, card-wrapped headings, mono-tagged code.
- **evokes:** stripe.com/docs and modern dev portals: violet-indigo links, soft elevation, tidy tables with tinted headers.

```html
<style data-rwa-skin="stripe-docs">
#rwa-doc-mount .rwa-skin-stripe-docs{
  --sd-ink:#1a1f36; --sd-soft:#3c4257; --sd-faint:#697386; --sd-line:#e3e8ee;
  --sd-bg:#ffffff; --sd-tint:#f6f9fc; --sd-accent:#635bff; --sd-accent-2:#0073e6;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  color:var(--sd-ink); line-height:1.65;
}
#rwa-doc-mount .rwa-skin-stripe-docs article{max-width:760px;margin:64px auto;padding:0 36px;}
#rwa-doc-mount .rwa-skin-stripe-docs h1{font-size:2.3rem;font-weight:700;letter-spacing:-.02em;line-height:1.15;color:var(--sd-ink);margin:1.4em 0 .4em;}
#rwa-doc-mount .rwa-skin-stripe-docs h2{font-size:1.45rem;font-weight:600;color:var(--sd-ink);margin:2em 0 .4em;padding-bottom:.3em;border-bottom:1px solid var(--sd-line);}
#rwa-doc-mount .rwa-skin-stripe-docs h3{font-size:1.15rem;font-weight:600;color:var(--sd-soft);margin:1.6em 0 .3em;}
#rwa-doc-mount .rwa-skin-stripe-docs p{color:var(--sd-soft);margin:0 0 1em;}
#rwa-doc-mount .rwa-skin-stripe-docs a{color:var(--sd-accent);text-decoration:none;font-weight:500;}
#rwa-doc-mount .rwa-skin-stripe-docs a:hover{color:var(--sd-accent-2);text-decoration:underline;text-underline-offset:2px;}
#rwa-doc-mount .rwa-skin-stripe-docs ul,#rwa-doc-mount .rwa-skin-stripe-docs ol{color:var(--sd-soft);padding-left:1.5em;margin:0 0 1em;}
#rwa-doc-mount .rwa-skin-stripe-docs li{margin:.3em 0;}
#rwa-doc-mount .rwa-skin-stripe-docs blockquote{margin:1.2em 0;padding:12px 16px;background:var(--sd-tint);border-left:3px solid var(--sd-accent);border-radius:0 6px 6px 0;color:var(--sd-soft);font-style:normal;}
#rwa-doc-mount .rwa-skin-stripe-docs hr{border:0;border-top:1px solid var(--sd-line);margin:2.2em 0;}
#rwa-doc-mount .rwa-skin-stripe-docs code{font-family:'SF Mono',Menlo,Monaco,ui-monospace,monospace;font-size:.85em;background:var(--sd-tint);color:var(--sd-accent);border:1px solid var(--sd-line);padding:.1em .4em;border-radius:5px;}
#rwa-doc-mount .rwa-skin-stripe-docs pre{background:#0a2540;color:#f6f9fc;border:0;border-radius:10px;padding:18px 20px;box-shadow:0 2px 6px rgba(10,37,64,.18);}
#rwa-doc-mount .rwa-skin-stripe-docs pre code{background:transparent;border:0;color:inherit;}
#rwa-doc-mount .rwa-skin-stripe-docs table{font-size:.92em;border:1px solid var(--sd-line);border-radius:8px;overflow:hidden;}
#rwa-doc-mount .rwa-skin-stripe-docs th{background:var(--sd-tint);color:var(--sd-faint);font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:.78rem;border-bottom:1px solid var(--sd-line);padding:.55em .85em;}
#rwa-doc-mount .rwa-skin-stripe-docs td{border-bottom:1px solid var(--sd-line);padding:.55em .85em;color:var(--sd-soft);}
/* L1 hooks */
#rwa-doc-mount .rwa-skin-stripe-docs .rwa-skin-hero{background:linear-gradient(180deg,var(--sd-tint),#fff);border:1px solid var(--sd-line);border-radius:12px;padding:28px 32px;margin:0 0 2em;box-shadow:0 1px 3px rgba(26,31,54,.06);}
#rwa-doc-mount .rwa-skin-stripe-docs .rwa-skin-hero h1{margin:0 0 .2em;}
#rwa-doc-mount .rwa-skin-stripe-docs .rwa-skin-pill{display:inline-block;font-size:.72rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--sd-accent);background:#efeefe;padding:.25em .7em;border-radius:100px;margin-bottom:.8em;}
</style>
```

- **L1 restyle recipe:**
  - Add `class="rwa-skin-stripe-docs"` to `<article>`.
  - Wrap the leading H1 plus its immediately-following dek paragraph in `<div class="rwa-skin-hero">…</div>`. If a one-word category/kicker precedes the H1, render it as `<span class="rwa-skin-pill">…</span>` at the top of the hero.
  - Leave H2 section rules to the border-bottom (no wrapper needed); the underline gives the "docs section" feel automatically.
  - Code blocks become the dark `#0a2540` Stripe terminal — no markup change needed, the `pre` rule does it.
- **Thumbnail swatch (64×48):** white doc with a tinted hero box at top (gradient), an indigo pill dot, then a dark navy code strip near the bottom:
  `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='48'><rect width='64' height='48' fill='%23fff'/><rect x='6' y='5' width='52' height='16' rx='3' fill='%23f6f9fc' stroke='%23e3e8ee'/><rect x='10' y='9' width='6' height='3' rx='1.5' fill='%23635bff'/><rect x='10' y='14' width='28' height='3' rx='1' fill='%231a1f36'/><rect x='6' y='25' width='40' height='3' fill='%23c7d0db'/><rect x='6' y='34' width='52' height='10' rx='3' fill='%230a2540'/></svg>`

---

#### linear-dark
- **id:** `linear-dark`
- **label:** Linear Dark
- **vibe:** Low-glare graphite UI — near-black canvas, cool desaturated text, electric-violet accent.
- **evokes:** The Linear app / Vercel dashboards: dark surfaces, 1px translucent borders, precise mono labels.

```html
<style data-rwa-skin="linear-dark">
#rwa-doc-mount .rwa-skin-linear-dark{
  --ld-bg:#08090d; --ld-surf:#101117; --ld-line:#23252f;
  --ld-ink:#e9eaee; --ld-soft:#a0a3ad; --ld-faint:#6a6d78;
  --ld-accent:#7c6cff; --ld-accent-2:#5e6ad2;
  background:var(--ld-bg); color:var(--ld-ink);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  line-height:1.65; border-radius:12px;
}
/* paint the page canvas so margins aren't white around the dark article */
#rwa-doc-mount:has(.rwa-skin-linear-dark){background:#08090d;}
#rwa-doc-mount .rwa-skin-linear-dark article{max-width:720px;margin:56px auto;padding:0 36px;}
#rwa-doc-mount .rwa-skin-linear-dark h1{font-size:2.2rem;font-weight:600;letter-spacing:-.025em;line-height:1.15;color:#fff;margin:1.3em 0 .35em;}
#rwa-doc-mount .rwa-skin-linear-dark h2{font-size:1.4rem;font-weight:600;letter-spacing:-.01em;color:var(--ld-ink);margin:2em 0 .35em;}
#rwa-doc-mount .rwa-skin-linear-dark h3{font-size:1.12rem;font-weight:600;color:var(--ld-soft);margin:1.6em 0 .3em;}
#rwa-doc-mount .rwa-skin-linear-dark h4,#rwa-doc-mount .rwa-skin-linear-dark h5,#rwa-doc-mount .rwa-skin-linear-dark h6{font-family:'SF Mono',Menlo,monospace;font-size:.78rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ld-faint);margin:1.4em 0 .3em;}
#rwa-doc-mount .rwa-skin-linear-dark p{color:var(--ld-soft);margin:0 0 1em;}
#rwa-doc-mount .rwa-skin-linear-dark a{color:var(--ld-accent);text-decoration:none;}
#rwa-doc-mount .rwa-skin-linear-dark a:hover{color:#9b8eff;text-decoration:underline;text-underline-offset:3px;}
#rwa-doc-mount .rwa-skin-linear-dark ul,#rwa-doc-mount .rwa-skin-linear-dark ol{color:var(--ld-soft);padding-left:1.5em;margin:0 0 1em;}
#rwa-doc-mount .rwa-skin-linear-dark li{margin:.3em 0;}
#rwa-doc-mount .rwa-skin-linear-dark li::marker{color:var(--ld-faint);}
#rwa-doc-mount .rwa-skin-linear-dark blockquote{margin:1.2em 0;padding:.4em 0 .4em 1em;border-left:2px solid var(--ld-accent);color:var(--ld-soft);font-style:normal;}
#rwa-doc-mount .rwa-skin-linear-dark hr{border:0;border-top:1px solid var(--ld-line);margin:2.2em 0;}
#rwa-doc-mount .rwa-skin-linear-dark code{font-family:'SF Mono',Menlo,monospace;font-size:.85em;background:var(--ld-surf);color:#c9c4ff;border:1px solid var(--ld-line);padding:.12em .4em;border-radius:5px;}
#rwa-doc-mount .rwa-skin-linear-dark pre{background:var(--ld-surf);border:1px solid var(--ld-line);border-radius:10px;padding:16px 18px;color:var(--ld-ink);}
#rwa-doc-mount .rwa-skin-linear-dark pre code{background:transparent;border:0;color:inherit;}
#rwa-doc-mount .rwa-skin-linear-dark table{font-size:.92em;}
#rwa-doc-mount .rwa-skin-linear-dark th{background:var(--ld-surf);color:var(--ld-soft);font-weight:600;border-bottom:1px solid var(--ld-line);padding:.55em .8em;}
#rwa-doc-mount .rwa-skin-linear-dark td{border-bottom:1px solid var(--ld-line);padding:.55em .8em;color:var(--ld-soft);}
/* L1 hooks */
#rwa-doc-mount .rwa-skin-linear-dark .rwa-skin-stat-row{display:flex;gap:12px;flex-wrap:wrap;margin:1.4em 0;}
#rwa-doc-mount .rwa-skin-linear-dark .rwa-skin-stat{flex:1 1 120px;background:var(--ld-surf);border:1px solid var(--ld-line);border-radius:10px;padding:14px 16px;}
#rwa-doc-mount .rwa-skin-linear-dark .rwa-skin-stat b{display:block;font-size:1.5rem;color:#fff;font-weight:600;letter-spacing:-.02em;}
#rwa-doc-mount .rwa-skin-linear-dark .rwa-skin-stat span{font-family:'SF Mono',Menlo,monospace;font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;color:var(--ld-faint);}
#rwa-doc-mount .rwa-skin-linear-dark .rwa-skin-eyebrow{font-family:'SF Mono',Menlo,monospace;font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ld-accent);margin-bottom:.5em;}
</style>
```

- **L1 restyle recipe:**
  - Add `class="rwa-skin-linear-dark"` to `<article>`.
  - If a single short kicker/category line precedes or opens the doc, render it as `<div class="rwa-skin-eyebrow">…</div>`.
  - Detect a *run of "label: number" or short metric lines* (e.g. a paragraph or list of 2–4 figures like "MRR $48k", "Churn 1.2%") and convert each into `<div class="rwa-skin-stat"><b>$48k</b><span>MRR</span></div>` grouped in one `<div class="rwa-skin-stat-row">`. This is the "row of numbers → stat tiles" maximum-impact move.
  - This skin inverts the whole canvas — note the `#rwa-doc-mount:has(.rwa-skin-linear-dark)` rule paints the surrounding margin dark so there's no white frame.
- **Thumbnail swatch (64×48):** near-black field, white H1 bar, violet eyebrow tick, and a row of two darker surface tiles (stats):
  `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='48'><rect width='64' height='48' fill='%2308090d'/><rect x='8' y='7' width='10' height='3' rx='1' fill='%237c6cff'/><rect x='8' y='13' width='32' height='6' rx='2' fill='%23ffffff'/><rect x='8' y='25' width='40' height='3' fill='%23a0a3ad'/><rect x='8' y='33' width='22' height='10' rx='2' fill='%23101117' stroke='%2323252f'/><rect x='34' y='33' width='22' height='10' rx='2' fill='%23101117' stroke='%2323252f'/></svg>`

---

#### editorial-serif
- **id:** `editorial-serif`
- **label:** Editorial Serif
- **vibe:** Longform magazine gravitas — Georgia serif body, drop-cap opener, warm paper tone, red kicker.
- **evokes:** The New Yorker / a print feature: large serif headline, small-caps byline, columned measure, classic rules.

```html
<style data-rwa-skin="editorial-serif">
#rwa-doc-mount .rwa-skin-editorial-serif{
  --es-paper:#fbfaf7; --es-ink:#1c1a17; --es-soft:#4a463f; --es-faint:#857f74;
  --es-line:#e0dbd0; --es-accent:#9a1b1b; --es-rule:#c8c0b2;
  font-family:Georgia,Cambria,'Times New Roman',Times,serif;
  color:var(--es-ink); line-height:1.7;
}
#rwa-doc-mount:has(.rwa-skin-editorial-serif){background:#fbfaf7;}
#rwa-doc-mount .rwa-skin-editorial-serif article{max-width:680px;margin:80px auto;padding:0 36px;background:var(--es-paper);}
#rwa-doc-mount .rwa-skin-editorial-serif h1{font-size:3rem;font-weight:700;line-height:1.08;letter-spacing:-.01em;color:var(--es-ink);margin:.3em 0 .35em;}
#rwa-doc-mount .rwa-skin-editorial-serif h2{font-size:1.7rem;font-weight:700;color:var(--es-ink);margin:2em 0 .4em;line-height:1.2;}
#rwa-doc-mount .rwa-skin-editorial-serif h3{font-size:1.3rem;font-weight:700;font-style:italic;color:var(--es-soft);margin:1.6em 0 .3em;}
#rwa-doc-mount .rwa-skin-editorial-serif p{font-size:1.12rem;color:var(--es-ink);margin:0 0 1.1em;hyphens:auto;}
#rwa-doc-mount .rwa-skin-editorial-serif a{color:var(--es-accent);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px;}
#rwa-doc-mount .rwa-skin-editorial-serif a:hover{text-decoration-thickness:2px;}
#rwa-doc-mount .rwa-skin-editorial-serif ul,#rwa-doc-mount .rwa-skin-editorial-serif ol{color:var(--es-ink);padding-left:1.4em;margin:0 0 1.1em;}
#rwa-doc-mount .rwa-skin-editorial-serif li{margin:.35em 0;}
#rwa-doc-mount .rwa-skin-editorial-serif blockquote{margin:1.5em 0;padding:0 1.2em;border-left:0;border-top:1px solid var(--es-rule);border-bottom:1px solid var(--es-rule);font-size:1.45rem;line-height:1.4;font-style:italic;color:var(--es-soft);text-align:center;padding-top:.8em;padding-bottom:.8em;}
#rwa-doc-mount .rwa-skin-editorial-serif hr{border:0;border-top:1px solid var(--es-rule);margin:2.4em auto;width:120px;}
#rwa-doc-mount .rwa-skin-editorial-serif code{font-family:'SF Mono',Menlo,monospace;font-size:.85em;background:#f1ede4;color:var(--es-accent);padding:.1em .35em;border-radius:3px;}
#rwa-doc-mount .rwa-skin-editorial-serif pre{font-family:'SF Mono',Menlo,monospace;background:#f1ede4;border:1px solid var(--es-line);border-radius:4px;padding:14px 16px;font-size:.85rem;}
#rwa-doc-mount .rwa-skin-editorial-serif table{font-size:.98em;}
#rwa-doc-mount .rwa-skin-editorial-serif th{font-family:Georgia,serif;font-variant:small-caps;letter-spacing:.04em;color:var(--es-soft);border-bottom:2px solid var(--es-ink);background:transparent;padding:.5em .7em;}
#rwa-doc-mount .rwa-skin-editorial-serif td{border-bottom:1px solid var(--es-line);padding:.5em .7em;}
/* L1 hooks */
#rwa-doc-mount .rwa-skin-editorial-serif .rwa-skin-kicker{font-family:-apple-system,'Segoe UI',sans-serif;font-size:.8rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--es-accent);margin-bottom:.6em;}
#rwa-doc-mount .rwa-skin-editorial-serif .rwa-skin-byline{font-style:italic;color:var(--es-faint);font-size:1rem;margin:-.2em 0 1.6em;}
#rwa-doc-mount .rwa-skin-editorial-serif .rwa-skin-lede > p:first-of-type::first-letter{float:left;font-size:3.6em;line-height:.78;font-weight:700;padding:.05em .12em 0 0;color:var(--es-ink);}
</style>
```

- **L1 restyle recipe:**
  - Add `class="rwa-skin-editorial-serif"` to `<article>`.
  - If a category/section word precedes the title, render as `<div class="rwa-skin-kicker">…</div>` above the H1.
  - Identify a byline/dateline line ("By …", a date, "5 min read") under the H1 and wrap as `<p class="rwa-skin-byline">…</p>`.
  - Wrap the *first body section* (everything from the first post-headline paragraph up to the first H2) in `<div class="rwa-skin-lede">…</div>` so the drop-cap lands only on the opening paragraph.
  - Center the first standalone single-sentence emphatic paragraph as a pull-quote by re-tagging it `<blockquote>` (uses the magazine top/bottom rule).
- **Thumbnail swatch (64×48):** warm paper, red kicker tick, tall serif headline bar, a centered short rule, justified text lines:
  `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='48'><rect width='64' height='48' fill='%23fbfaf7'/><rect x='8' y='6' width='14' height='3' fill='%239a1b1b'/><rect x='8' y='12' width='40' height='7' rx='1' fill='%231c1a17'/><rect x='8' y='24' width='6' height='9' fill='%231c1a17'/><rect x='16' y='25' width='40' height='2.5' fill='%23857f74'/><rect x='16' y='30' width='40' height='2.5' fill='%23857f74'/><rect x='24' y='40' width='16' height='1.5' fill='%23c8c0b2'/></svg>`

---

#### corporate-memo
- **id:** `corporate-memo`
- **label:** Corporate Memo
- **vibe:** Letterhead authority — navy rule, structured header block, conservative type, formal tables.
- **evokes:** A consultancy report / official memorandum: top rule line, "MEMO" header grid, restrained navy accent, businesslike density.

```html
<style data-rwa-skin="corporate-memo">
#rwa-doc-mount .rwa-skin-corporate-memo{
  --cm-ink:#1b2330; --cm-soft:#414b5a; --cm-faint:#73808f; --cm-line:#d6dce4;
  --cm-navy:#16335c; --cm-accent:#1d4e89; --cm-tint:#f3f6fa;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  color:var(--cm-ink); line-height:1.55;
}
#rwa-doc-mount .rwa-skin-corporate-memo article{max-width:740px;margin:56px auto;padding:0 40px;border-top:4px solid var(--cm-navy);}
#rwa-doc-mount .rwa-skin-corporate-memo h1{font-size:1.9rem;font-weight:700;letter-spacing:-.01em;color:var(--cm-navy);margin:.8em 0 .4em;}
#rwa-doc-mount .rwa-skin-corporate-memo h2{font-size:1.3rem;font-weight:700;color:var(--cm-ink);margin:1.8em 0 .4em;padding-bottom:.2em;border-bottom:2px solid var(--cm-navy);}
#rwa-doc-mount .rwa-skin-corporate-memo h3{font-size:1.05rem;font-weight:700;color:var(--cm-accent);margin:1.5em 0 .3em;text-transform:uppercase;letter-spacing:.03em;}
#rwa-doc-mount .rwa-skin-corporate-memo p{color:var(--cm-soft);margin:0 0 .85em;}
#rwa-doc-mount .rwa-skin-corporate-memo a{color:var(--cm-accent);text-decoration:underline;text-underline-offset:2px;}
#rwa-doc-mount .rwa-skin-corporate-memo ul,#rwa-doc-mount .rwa-skin-corporate-memo ol{color:var(--cm-soft);padding-left:1.5em;margin:0 0 .85em;}
#rwa-doc-mount .rwa-skin-corporate-memo li{margin:.25em 0;}
#rwa-doc-mount .rwa-skin-corporate-memo blockquote{margin:1.1em 0;padding:10px 16px;background:var(--cm-tint);border-left:4px solid var(--cm-navy);color:var(--cm-soft);font-style:normal;}
#rwa-doc-mount .rwa-skin-corporate-memo hr{border:0;border-top:1px solid var(--cm-line);margin:1.8em 0;}
#rwa-doc-mount .rwa-skin-corporate-memo code{font-family:'SF Mono',Menlo,monospace;font-size:.85em;background:var(--cm-tint);color:var(--cm-accent);border:1px solid var(--cm-line);padding:.1em .35em;border-radius:3px;}
#rwa-doc-mount .rwa-skin-corporate-memo pre{background:var(--cm-tint);border:1px solid var(--cm-line);border-radius:4px;padding:14px 16px;font-size:.85rem;}
#rwa-doc-mount .rwa-skin-corporate-memo table{font-size:.9em;border:1px solid var(--cm-line);}
#rwa-doc-mount .rwa-skin-corporate-memo th{background:var(--cm-navy);color:#fff;font-weight:600;letter-spacing:.02em;border-bottom:0;padding:.5em .8em;}
#rwa-doc-mount .rwa-skin-corporate-memo td{border-bottom:1px solid var(--cm-line);padding:.5em .8em;color:var(--cm-soft);}
#rwa-doc-mount .rwa-skin-corporate-memo tbody tr:nth-child(even){background:var(--cm-tint);}
/* L1 hooks */
#rwa-doc-mount .rwa-skin-corporate-memo .rwa-skin-memohead{display:grid;grid-template-columns:auto 1fr;gap:.2em 1.2em;margin:0 0 1.6em;padding:0 0 1.2em;border-bottom:1px solid var(--cm-line);}
#rwa-doc-mount .rwa-skin-corporate-memo .rwa-skin-memohead dt{font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cm-faint);align-self:center;}
#rwa-doc-mount .rwa-skin-corporate-memo .rwa-skin-memohead dd{color:var(--cm-ink);font-weight:500;margin:0;}
#rwa-doc-mount .rwa-skin-corporate-memo .rwa-skin-classif{font-size:.72rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--cm-navy);margin-bottom:.4em;}
</style>
```

- **L1 restyle recipe:**
  - Add `class="rwa-skin-corporate-memo"` to `<article>`.
  - If the document opens with TO/FROM/DATE/RE-style lines (or any 2–4 short "Label: value" header rows), convert them into a `<dl class="rwa-skin-memohead">` with `<dt>`/`<dd>` pairs above the H1. If no such lines exist, synthesize nothing — leave the head off.
  - Render any leading "CONFIDENTIAL", "DRAFT", "INTERNAL" line as `<div class="rwa-skin-classif">…</div>`.
  - Tables get the navy header + zebra automatically; no markup change needed.
  - Keep prose density high (line-height 1.55) — this skin reads as businesslike, not airy.
- **Thumbnail swatch (64×48):** white sheet with a thick navy top rule, a small two-row header grid, an H1 bar, and a navy-headed mini table:
  `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='48'><rect width='64' height='48' fill='%23fff'/><rect x='0' y='0' width='64' height='3' fill='%2316335c'/><rect x='8' y='8' width='12' height='2.5' fill='%2373808f'/><rect x='24' y='8' width='24' height='2.5' fill='%231b2330'/><rect x='8' y='14' width='12' height='2.5' fill='%2373808f'/><rect x='24' y='14' width='20' height='2.5' fill='%231b2330'/><rect x='8' y='22' width='34' height='5' rx='1' fill='%2316335c'/><rect x='8' y='33' width='48' height='5' fill='%2316335c'/><rect x='8' y='38' width='48' height='5' fill='%23f3f6fa'/></svg>`

---

#### swiss-grid
- **id:** `swiss-grid`
- **label:** Swiss Grid
- **vibe:** International Typographic rigor — flush-left Helvetica-stack, tight leading, hard black rules, a single red flag.
- **evokes:** Müller-Brockmann / Massimo Vignelli: bold lowercase-feel headlines, asymmetric grid, generous negative space, one accent color.

```html
<style data-rwa-skin="swiss-grid">
#rwa-doc-mount .rwa-skin-swiss-grid{
  --sw-ink:#111111; --sw-soft:#444444; --sw-faint:#8a8a8a; --sw-line:#111111;
  --sw-hair:#dcdcdc; --sw-accent:#e8412c; --sw-paper:#ffffff;
  font-family:'Helvetica Neue',Helvetica,Arial,-apple-system,sans-serif;
  color:var(--sw-ink); line-height:1.45; -webkit-font-smoothing:antialiased;
}
#rwa-doc-mount .rwa-skin-swiss-grid article{max-width:780px;margin:64px auto;padding:0 40px;}
#rwa-doc-mount .rwa-skin-swiss-grid h1{font-size:3.4rem;font-weight:700;letter-spacing:-.03em;line-height:1.02;color:var(--sw-ink);margin:.2em 0 .5em;}
#rwa-doc-mount .rwa-skin-swiss-grid h2{font-size:1.35rem;font-weight:700;letter-spacing:-.01em;color:var(--sw-ink);margin:2.2em 0 .5em;padding-top:.5em;border-top:2px solid var(--sw-line);}
#rwa-doc-mount .rwa-skin-swiss-grid h3{font-size:1.05rem;font-weight:700;color:var(--sw-ink);margin:1.5em 0 .3em;}
#rwa-doc-mount .rwa-skin-swiss-grid h4,#rwa-doc-mount .rwa-skin-swiss-grid h5,#rwa-doc-mount .rwa-skin-swiss-grid h6{font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--sw-faint);margin:1.4em 0 .3em;}
#rwa-doc-mount .rwa-skin-swiss-grid p{font-size:1rem;color:var(--sw-soft);margin:0 0 1em;max-width:62ch;}
#rwa-doc-mount .rwa-skin-swiss-grid a{color:var(--sw-ink);text-decoration:none;border-bottom:2px solid var(--sw-accent);}
#rwa-doc-mount .rwa-skin-swiss-grid a:hover{color:var(--sw-accent);}
#rwa-doc-mount .rwa-skin-swiss-grid ul,#rwa-doc-mount .rwa-skin-swiss-grid ol{color:var(--sw-soft);padding-left:1.3em;margin:0 0 1em;}
#rwa-doc-mount .rwa-skin-swiss-grid ul{list-style:none;padding-left:0;}
#rwa-doc-mount .rwa-skin-swiss-grid ul > li{position:relative;padding-left:1.3em;}
#rwa-doc-mount .rwa-skin-swiss-grid ul > li::before{content:"";position:absolute;left:0;top:.62em;width:.6em;height:2px;background:var(--sw-accent);}
#rwa-doc-mount .rwa-skin-swiss-grid li{margin:.3em 0;}
#rwa-doc-mount .rwa-skin-swiss-grid blockquote{margin:1.4em 0;padding:0 0 0 1.2em;border-left:3px solid var(--sw-accent);font-style:normal;font-size:1.25rem;font-weight:500;line-height:1.3;color:var(--sw-ink);}
#rwa-doc-mount .rwa-skin-swiss-grid hr{border:0;border-top:2px solid var(--sw-line);margin:2.4em 0;}
#rwa-doc-mount .rwa-skin-swiss-grid code{font-family:'SF Mono',Menlo,monospace;font-size:.85em;background:var(--sw-paper);color:var(--sw-accent);border:1px solid var(--sw-hair);padding:.1em .35em;border-radius:0;}
#rwa-doc-mount .rwa-skin-swiss-grid pre{background:var(--sw-paper);border:2px solid var(--sw-line);border-radius:0;padding:16px 18px;font-size:.85rem;}
#rwa-doc-mount .rwa-skin-swiss-grid table{font-size:.92em;}
#rwa-doc-mount .rwa-skin-swiss-grid th{border-top:2px solid var(--sw-line);border-bottom:2px solid var(--sw-line);background:transparent;color:var(--sw-ink);font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:.74rem;padding:.5em .7em;}
#rwa-doc-mount .rwa-skin-swiss-grid td{border-bottom:1px solid var(--sw-hair);padding:.5em .7em;color:var(--sw-soft);}
/* L1 hooks */
#rwa-doc-mount .rwa-skin-swiss-grid .rwa-skin-index{display:grid;grid-template-columns:2.5rem 1fr;gap:.1em 1rem;margin:0 0 2em;}
#rwa-doc-mount .rwa-skin-swiss-grid .rwa-skin-index dt{font-weight:700;color:var(--sw-accent);font-variant-numeric:tabular-nums;}
#rwa-doc-mount .rwa-skin-swiss-grid .rwa-skin-index dd{margin:0;color:var(--sw-ink);font-weight:500;}
#rwa-doc-mount .rwa-skin-swiss-grid .rwa-skin-eyebrow{font-size:.78rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);margin-bottom:1em;}
</style>
```

- **L1 restyle recipe:**
  - Add `class="rwa-skin-swiss-grid"` to `<article>`.
  - Render any opening category/section word as `<div class="rwa-skin-eyebrow">…</div>` above the giant H1 (one accent line is the whole Swiss signal).
  - If the document contains a top-level table-of-contents-like list or a numbered sequence of section titles, render it as a `<dl class="rwa-skin-index">` with zero-padded numbers in `<dt>` (01, 02, 03) and titles in `<dd>` — the asymmetric number column is the grid move.
  - Keep prose to the `62ch` measure (already enforced) and let H2 top-rules do the sectioning; do not add boxes — Swiss is rules + space, not cards.
- **Thumbnail swatch (64×48):** white field, red eyebrow tick top, a very large black headline block, a hard black rule, two columns of text with a red list dash:
  `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='48'><rect width='64' height='48' fill='%23fff'/><rect x='6' y='5' width='10' height='2.5' fill='%23e8412c'/><rect x='6' y='10' width='44' height='12' fill='%23111'/><rect x='6' y='27' width='52' height='2' fill='%23111'/><rect x='6' y='34' width='3' height='2' fill='%23e8412c'/><rect x='11' y='34' width='20' height='2' fill='%23444'/><rect x='6' y='39' width='3' height='2' fill='%23e8412c'/><rect x='11' y='39' width='24' height='2' fill='%23444'/></svg>`

---

#### Cross-skin integration notes (for the gallery + apply layer)

- **Reset contract:** every block is exactly one `<style data-rwa-skin="NAME">…</style>` plus one `class="rwa-skin-NAME"` on `<article>`, plus the optional wrappers/classes the recipe introduced. `/skin reset` = remove the `<style data-rwa-skin>` block + strip `rwa-skin-*` classes; wrappers can stay harmlessly (they have no styling without the block) or be unwrapped for cleanliness. Because it is one rwa-edit/1 commit, a single Cmd-Z reverts the entire skin including the L1 restructure.
- **`activeSkin` for self-description/1:** the declared-projection reader extracts the value of the *first* `data-rwa-skin` attribute in the editable body. If absent → `activeSkin:null`. This is a pure declared field (author/skin-controlled), so it follows `declared > static` precedence and never overrides container facts (uuid/frozenZones/blocks).
- **Reserved-attribute interplay:** `data-rwa-skin` must be added to the reserved-namespace list *alongside but distinct from* `data-rwa-frozen` and `data-rwa-id`. The apply-edits reserved-substring guard currently blocks any `find`/`replace` literally mentioning `data-rwa-frozen`; the guard must NOT be widened to a `data-rwa-` prefix match, or the restyle could never write `data-rwa-skin`. Keep the guard a literal `data-rwa-frozen` (and `data-rwa-id`) check; `data-rwa-skin` is explicitly writable by the model during a restyle. The skin `<style>` block itself is *not* a frozen zone (it must remain re-editable so re-skinning can replace it).
- **Dark-skin canvas trick:** `linear-dark` and `editorial-serif` use `#rwa-doc-mount:has(.rwa-skin-NAME){background:…}` to paint the area around the article. This stays inside `#rwa-doc-mount` and never touches `body`/runtime chrome, so the lens/settings/palette chrome keeps the global light ramp and stays legible. (`:has()` is supported in all current evergreen browsers; the seed already relies on modern CSS, so this is consistent with the platform baseline.)
- **System-font compliance:** all six use only system stacks — UI sans (`-apple-system…`), the seed mono (`'SF Mono',Menlo,…`), platform serif (`Georgia,Cambria,…`), and the platform Helvetica/Arial stack. Zero `@font-face`, zero web fonts, zero CDN. The only embedded graphics are the inline data-URI SVG thumbnails (each well under 1 KB), used by the gallery chrome — not injected into the document.
- **Gallery thumbnails live in frozen runtime chrome, not the document.** Each swatch SVG above is the gallery preview (rendered in the runtime-chrome picker next to the label/vibe); they are byte-frozen runtime assets, never written into `INLINE_DOC`. Applying a skin writes only the `<style>` block + classes.


### Preset Library — Expressive / Retro / Playful Family

Six named skins for the `expressive` family. Each is a self-contained `<style data-rwa-skin="NAME">` block that lives at the top of `INLINE_DOC`, overrides the frozen specificity-0 baseline via real-specificity selectors scoped to `#rwa-doc-mount`, and uses only system fonts + inline SVG/data-URIs. No web fonts, no CDN, no network.

#### Conventions shared by every skin in this family

These hold for all six and are stated once to keep each block readable:

- **One block, one identity.** The `<style data-rwa-skin="NAME">` block is the *entire* L0 theme. Re-skinning = `apply_edits` replaces this block; reset = delete it. The `data-rwa-skin` attribute value is the canonical skin name and is the single thing self-description/1 reads for `activeSkin`.
- **Scoping & specificity.** Every rule is prefixed `#rwa-doc-mount …` (specificity ≥ 1-0-0). That always beats the seed baseline's `:where(#rwa-doc-mount) …` (specificity 0-0-0) without `!important`, so themes layer cleanly and predictably.
- **Variable strategy.** Each block re-declares the ramp/semantic vars on `#rwa-doc-mount` (not `:root`, which is frozen and edit-unreachable). Because the baseline element rules read `var(--gray-900)` etc., *re-pointing the variables alone* recolors most of the document even before the explicit element rules land — a cheap, robust base layer. We then add element rules for the parts that need real structural restyle.
- **L1 class-hook namespace.** The restyle recipe uses the prefix `sk-` for all class hooks and wrapper elements (`.sk-hero`, `.sk-stat`, `.sk-card`, …). This is distinct from `rwa-*` (reserved runtime) and `data-rwa-*` (reserved attributes), so the restyle never collides with reserved namespaces, and `data-rwa-id` / `data-rwa-frozen` attributes on existing blocks are preserved verbatim (the model only *adds* `class="sk-…"` and *wraps*, never rewrites those attributes).
- **Reserved-substring guard.** None of these CSS blocks or recipes contain the literal `data-rwa-frozen`, so the apply-edits reserved-substring guard never trips on a skin write. (Targeting frozen content is out of scope by invariant anyway.)
- **Thumbnail swatch.** Each skin ships a pure-CSS-or-inline-SVG swatch (~`64×44`) for the gallery picker — no raster images.

---

#### 1. terminal-mono

- **Label:** Terminal
- **Vibe:** Green-on-black phosphor CRT; a document that looks like it's being printed to a TTY. Calm, hacker-serious, slightly nostalgic.
- **Inspiration:** VT220 / `xterm` green phosphor, classic `man` pages, the "computer terminal" aesthetic without the gimmick of fake scanlines being mandatory (offered as an optional accent, kept subtle).

```html
<style data-rwa-skin="terminal-mono">
#rwa-doc-mount{
  --gray-50:#0c0f0c;--gray-100:#101410;--gray-200:#1b241b;--gray-300:#2c3b2c;
  --gray-400:#4f7a4f;--gray-500:#6fae6f;--gray-600:#86cd86;--gray-700:#9ee69e;
  --gray-800:#b6f5b6;--gray-900:#d6ffd6;--white:#080a08;
  --green:#39ff14;--yellow:#e8e84a;--red:#ff5f56;--blue:#5fd7ff;
  --radius:0px;--radius-sm:0px;
  background:#080a08;color:#9ee69e;
  font-family:var(--font-mono);
  font-size:15px;line-height:1.55;
  -webkit-font-smoothing:none;
}
#rwa-doc-mount article{max-width:74ch;margin:40px auto;padding:0 28px;}
#rwa-doc-mount h1,#rwa-doc-mount h2,#rwa-doc-mount h3,
#rwa-doc-mount h4,#rwa-doc-mount h5,#rwa-doc-mount h6{
  font-family:var(--font-mono);font-weight:700;letter-spacing:0;
  color:#d6ffd6;text-transform:none;
}
#rwa-doc-mount h1{font-size:1.7rem;}
#rwa-doc-mount h1::before{content:"# ";color:#4f7a4f;}
#rwa-doc-mount h2{font-size:1.35rem;}
#rwa-doc-mount h2::before{content:"## ";color:#4f7a4f;}
#rwa-doc-mount h3::before{content:"### ";color:#4f7a4f;}
#rwa-doc-mount p{color:#9ee69e;}
#rwa-doc-mount a{color:#5fd7ff;text-decoration:underline;text-underline-offset:3px;}
#rwa-doc-mount a:hover{background:#5fd7ff;color:#080a08;text-decoration:none;}
#rwa-doc-mount ul,#rwa-doc-mount ol{padding-left:2ch;}
#rwa-doc-mount ul li{list-style:none;}
#rwa-doc-mount ul li::before{content:"› ";color:#39ff14;margin-left:-2ch;}
#rwa-doc-mount blockquote{
  border-left:0;padding:.4em 1ch;color:#86cd86;font-style:normal;
  background:#101410;border:1px solid #2c3b2c;
}
#rwa-doc-mount blockquote::before{content:"┃ ";color:#4f7a4f;}
#rwa-doc-mount hr{border-top:1px dashed #2c3b2c;}
#rwa-doc-mount code{background:#101410;color:#39ff14;border-radius:0;padding:.05em .4ch;}
#rwa-doc-mount pre{
  background:#0c0f0c;border:1px solid #2c3b2c;border-radius:0;color:#9ee69e;
  box-shadow:inset 0 0 0 1px #101410;
}
#rwa-doc-mount table{font-size:.95em;}
#rwa-doc-mount th,#rwa-doc-mount td{border-bottom:1px solid #2c3b2c;}
#rwa-doc-mount th{
  background:#101410;color:#39ff14;text-transform:uppercase;
  letter-spacing:.08em;font-weight:700;
}
/* L1 hooks */
#rwa-doc-mount .sk-hero{
  border:1px solid #2c3b2c;padding:14px 16px;margin-bottom:28px;background:#0c0f0c;
}
#rwa-doc-mount .sk-hero::before{
  content:"$ cat ";color:#4f7a4f;font-size:.85rem;display:block;margin-bottom:6px;
}
#rwa-doc-mount .sk-hero h1{margin:0;}
#rwa-doc-mount .sk-byline{color:#6fae6f;font-size:.85rem;}
#rwa-doc-mount .sk-stat-row{display:flex;gap:1px;flex-wrap:wrap;background:#2c3b2c;
  border:1px solid #2c3b2c;margin:1.4em 0;}
#rwa-doc-mount .sk-stat{flex:1 1 120px;background:#0c0f0c;padding:12px 14px;}
#rwa-doc-mount .sk-stat-num{font-size:1.6rem;font-weight:700;color:#39ff14;display:block;}
#rwa-doc-mount .sk-stat-label{font-size:.7rem;text-transform:uppercase;
  letter-spacing:.1em;color:#6fae6f;}
#rwa-doc-mount .sk-blink{animation:sk-term-blink 1.06s steps(1) infinite;}
@keyframes sk-term-blink{50%{opacity:0;}}
@media (prefers-reduced-motion:reduce){#rwa-doc-mount .sk-blink{animation:none;}}
</style>
```

- **L1 restyle recipe:**
  - Wrap the leading `<h1>` (+ any immediately-following byline/subtitle `<p>`) in `<div class="sk-hero">…</div>`; tag the byline paragraph `class="sk-byline"`. Produces the `$ cat` prompt header.
  - Detect a contiguous run of "metric" lines (a paragraph or list where items are *number + short label*, e.g. "42 commits", "98% uptime"): wrap in `<div class="sk-stat-row">`, each metric becoming `<div class="sk-stat"><span class="sk-stat-num">42</span><span class="sk-stat-label">commits</span></div>`.
  - Append `<span class="sk-blink">▋</span>` after the final paragraph (a terminal cursor) for character.
  - Headings, lists, code, tables need no structural change — variable re-pointing + element rules carry them.
- **Thumbnail swatch:** Black tile, three short green monospace bars, one bright `--green` cursor block.
  ```html
  <svg viewBox="0 0 64 44" width="64" height="44" role="img" aria-label="Terminal skin">
    <rect width="64" height="44" fill="#080a08"/>
    <rect x="8" y="11" width="30" height="3" fill="#9ee69e"/>
    <rect x="8" y="20" width="40" height="3" fill="#9ee69e"/>
    <rect x="8" y="29" width="22" height="3" fill="#39ff14"/>
    <rect x="34" y="28" width="6" height="5" fill="#39ff14"/>
  </svg>
  ```

---

#### 2. brutalist

- **Label:** Brutalist
- **Vibe:** Raw HTML energy — thick black borders, hard offset shadows, a single hot accent, zero rounding, deliberately "unstyled-but-styled." Confident and loud.
- **Inspiration:** Web brutalism (Brutalist Websites, early-2020s portfolio sites), Swiss-grid-gone-feral, the "neobrutalism" UI trend (hard `box-shadow` offsets, primary-color blocks).

```html
<style data-rwa-skin="brutalist">
#rwa-doc-mount{
  --gray-50:#ffffff;--gray-100:#f2f0eb;--gray-200:#000000;--gray-300:#000000;
  --gray-400:#000000;--gray-500:#333333;--gray-600:#1a1a1a;--gray-700:#000000;
  --gray-800:#000000;--gray-900:#000000;--white:#ffffff;
  --green:#00b86b;--yellow:#ffd400;--red:#ff3b30;--blue:#0040ff;
  --radius:0px;--radius-sm:0px;
  --sk-accent:#ffd400;
  background:#f2f0eb;color:#000;
  font-family:var(--font-ui);line-height:1.5;
}
#rwa-doc-mount article{max-width:760px;margin:48px auto;padding:0 28px;}
#rwa-doc-mount h1,#rwa-doc-mount h2,#rwa-doc-mount h3{
  font-weight:900;letter-spacing:-.02em;color:#000;line-height:1.05;
}
#rwa-doc-mount h1{font-size:3rem;text-transform:uppercase;
  background:var(--sk-accent);display:inline-block;padding:.1em .25em;
  box-shadow:6px 6px 0 #000;border:3px solid #000;}
#rwa-doc-mount h2{font-size:1.8rem;text-transform:uppercase;
  border-bottom:4px solid #000;padding-bottom:.15em;}
#rwa-doc-mount h3{font-size:1.3rem;}
#rwa-doc-mount p{color:#000;}
#rwa-doc-mount a{color:#0040ff;text-decoration:underline;text-decoration-thickness:2px;
  text-underline-offset:2px;font-weight:700;}
#rwa-doc-mount a:hover{background:#0040ff;color:#fff;text-decoration:none;}
#rwa-doc-mount ul li::marker{content:"■  ";color:#000;}
#rwa-doc-mount blockquote{
  border-left:0;border:3px solid #000;background:#fff;
  box-shadow:5px 5px 0 #000;padding:14px 18px;font-style:normal;font-weight:600;
  color:#000;margin:1.4em 0;
}
#rwa-doc-mount hr{border-top:4px solid #000;}
#rwa-doc-mount code{background:var(--sk-accent);color:#000;border:1.5px solid #000;
  border-radius:0;font-weight:700;}
#rwa-doc-mount pre{background:#fff;border:3px solid #000;border-radius:0;
  box-shadow:6px 6px 0 #000;color:#000;}
#rwa-doc-mount table{border:3px solid #000;}
#rwa-doc-mount th,#rwa-doc-mount td{border:2px solid #000;}
#rwa-doc-mount th{background:var(--sk-accent);color:#000;text-transform:uppercase;
  font-weight:900;letter-spacing:.02em;}
/* L1 hooks */
#rwa-doc-mount .sk-hero{border:4px solid #000;background:#fff;
  box-shadow:10px 10px 0 #000;padding:24px;margin-bottom:36px;}
#rwa-doc-mount .sk-hero h1{box-shadow:none;border:0;background:transparent;
  display:block;padding:0;}
#rwa-doc-mount .sk-byline{font-weight:800;text-transform:uppercase;
  letter-spacing:.04em;font-size:.85rem;margin-top:.4em;}
#rwa-doc-mount .sk-stat-row{display:flex;gap:14px;flex-wrap:wrap;margin:1.6em 0;}
#rwa-doc-mount .sk-stat{flex:1 1 130px;border:3px solid #000;background:#fff;
  box-shadow:5px 5px 0 #000;padding:16px;}
#rwa-doc-mount .sk-stat:nth-child(3n+1){background:var(--sk-accent);}
#rwa-doc-mount .sk-stat-num{font-size:2.2rem;font-weight:900;display:block;
  line-height:1;}
#rwa-doc-mount .sk-stat-label{text-transform:uppercase;font-weight:800;
  font-size:.72rem;letter-spacing:.06em;}
#rwa-doc-mount .sk-card{border:3px solid #000;background:#fff;
  box-shadow:6px 6px 0 #000;padding:18px;margin:1.4em 0;}
</style>
```

- **L1 restyle recipe:**
  - Wrap the title cluster (`<h1>` + byline `<p>`) in `<div class="sk-hero">`; byline gets `class="sk-byline"`.
  - Metric runs → `.sk-stat-row` of `.sk-stat` blocks (every third tile flips to the yellow accent for rhythm).
  - Any standalone callout/aside paragraph or a `<section>` that reads as a discrete unit → wrap in `<div class="sk-card">` for the offset-shadow box treatment.
  - Lists, headings, tables, code carry on element rules alone.
- **Thumbnail swatch:** Off-white tile, a yellow title bar with hard black offset shadow, a black underline rule, two black-bordered blocks.
  ```html
  <svg viewBox="0 0 64 44" width="64" height="44" role="img" aria-label="Brutalist skin">
    <rect width="64" height="44" fill="#f2f0eb"/>
    <rect x="9" y="9" width="30" height="9" fill="#ffd400" stroke="#000" stroke-width="2"/>
    <rect x="12" y="12" width="30" height="9" fill="#ffd400" stroke="#000" stroke-width="2" opacity="0"/>
    <rect x="40" y="11" width="0" height="0"/>
    <rect x="9" y="25" width="46" height="3" fill="#000"/>
    <rect x="9" y="32" width="20" height="7" fill="#fff" stroke="#000" stroke-width="2"/>
    <rect x="34" y="32" width="20" height="7" fill="#000"/>
  </svg>
  ```

---

#### 3. receipt-invoice

- **Label:** Receipt
- **Vibe:** Thermal-printer receipt / point-of-sale slip — narrow column, dotted tear lines, monospace totals, a perforated top edge. Charming for invoices, orders, changelogs, expense notes.
- **Inspiration:** Thermal POS receipts, paper invoices, dot-matrix printouts; the "your order" slip aesthetic.

```html
<style data-rwa-skin="receipt-invoice">
#rwa-doc-mount{
  --gray-50:#ffffff;--gray-100:#f7f5ef;--gray-200:#d8d2c4;--gray-300:#bcb4a2;
  --gray-400:#8a8474;--gray-500:#5f5a4d;--gray-600:#403c33;--gray-700:#2b2820;
  --gray-800:#1c1a15;--gray-900:#15130f;--white:#fbfaf5;
  --green:#2f7d4f;--yellow:#b8860b;--red:#b3261e;--blue:#2b4a8a;
  --radius:0px;--radius-sm:0px;
  background:#e7e3d8;color:#15130f;
  font-family:var(--font-mono);font-size:13.5px;line-height:1.55;
}
#rwa-doc-mount article{
  max-width:420px;margin:36px auto;padding:28px 30px 36px;
  background:#fbfaf5;color:#15130f;
  border:1px solid #d8d2c4;
  box-shadow:0 2px 12px rgba(0,0,0,.10);
  /* perforated top + bottom edges via repeating radial mask, pure CSS */
  -webkit-mask:
    radial-gradient(6px at 6px 0,transparent 5px,#000 6px) repeat-x 0 0/12px 6px,
    linear-gradient(#000,#000) no-repeat 0 6px/100% calc(100% - 12px),
    radial-gradient(6px at 6px 100%,transparent 5px,#000 6px) repeat-x 0 100%/12px 6px;
          mask:
    radial-gradient(6px at 6px 0,transparent 5px,#000 6px) repeat-x 0 0/12px 6px,
    linear-gradient(#000,#000) no-repeat 0 6px/100% calc(100% - 12px),
    radial-gradient(6px at 6px 100%,transparent 5px,#000 6px) repeat-x 0 100%/12px 6px;
}
#rwa-doc-mount h1,#rwa-doc-mount h2,#rwa-doc-mount h3{
  font-family:var(--font-mono);font-weight:700;text-align:center;
  text-transform:uppercase;letter-spacing:.12em;color:#15130f;
}
#rwa-doc-mount h1{font-size:1.25rem;margin:.2em 0 .6em;}
#rwa-doc-mount h1::after{content:"";display:block;border-top:2px dashed #bcb4a2;
  margin-top:.6em;}
#rwa-doc-mount h2{font-size:1rem;letter-spacing:.16em;text-align:left;
  border-bottom:1px dashed #bcb4a2;padding-bottom:.3em;}
#rwa-doc-mount h3{font-size:.92rem;text-align:left;}
#rwa-doc-mount p{color:#2b2820;}
#rwa-doc-mount a{color:#2b4a8a;}
#rwa-doc-mount ul,#rwa-doc-mount ol{padding-left:1.4em;}
#rwa-doc-mount hr{border-top:2px dashed #bcb4a2;margin:1.4em 0;}
#rwa-doc-mount blockquote{border-left:0;border:1px dashed #bcb4a2;padding:.6em .8em;
  font-style:normal;color:#403c33;}
#rwa-doc-mount code{background:#f7f5ef;border:1px solid #d8d2c4;color:#15130f;}
#rwa-doc-mount pre{background:#f7f5ef;border:1px dashed #bcb4a2;color:#15130f;}
#rwa-doc-mount table{font-size:.92em;}
#rwa-doc-mount th,#rwa-doc-mount td{border-bottom:1px dotted #bcb4a2;padding:.35em .4em;}
#rwa-doc-mount th{background:transparent;text-transform:uppercase;letter-spacing:.08em;
  color:#403c33;border-bottom:2px dashed #bcb4a2;}
#rwa-doc-mount td:last-child,#rwa-doc-mount th:last-child{text-align:right;
  font-variant-numeric:tabular-nums;}
/* L1 hooks */
#rwa-doc-mount .sk-hero{text-align:center;margin-bottom:1em;}
#rwa-doc-mount .sk-byline{text-align:center;font-size:.8rem;color:#5f5a4d;
  letter-spacing:.08em;}
#rwa-doc-mount .sk-line{display:flex;justify-content:space-between;gap:1em;
  border-bottom:1px dotted #bcb4a2;padding:.3em 0;font-variant-numeric:tabular-nums;}
#rwa-doc-mount .sk-line .sk-amt{font-weight:700;}
#rwa-doc-mount .sk-total{display:flex;justify-content:space-between;
  border-top:2px dashed #15130f;border-bottom:2px dashed #15130f;
  padding:.5em 0;margin-top:.6em;font-weight:700;text-transform:uppercase;
  letter-spacing:.06em;font-size:1.05rem;}
#rwa-doc-mount .sk-stamp{text-align:center;margin-top:1.4em;color:#2f7d4f;
  border:2px solid #2f7d4f;display:inline-block;padding:.2em .6em;
  transform:rotate(-7deg);font-weight:700;text-transform:uppercase;
  letter-spacing:.1em;border-radius:4px;}
#rwa-doc-mount .sk-foot{text-align:center;font-size:.78rem;color:#5f5a4d;
  margin-top:1.6em;letter-spacing:.1em;}
</style>
```

- **L1 restyle recipe:**
  - Center the title cluster in `<div class="sk-hero">`; byline → `class="sk-byline"`.
  - **Line-item conversion** (the high-impact move): any "label … value" pair — list items, table rows, or paragraphs shaped like `Item — $value` — render as `<div class="sk-line"><span>Coffee</span><span class="sk-amt">$3.50</span></div>`. A row that reads as a *total/sum* becomes `<div class="sk-total"><span>Total</span><span>$42.00</span></div>`.
  - Optional `<div class="sk-stamp">PAID</div>` / `APPROVED` if the content implies a status.
  - Append a centered `<div class="sk-foot">— thank you —</div>` (or the doc's natural sign-off) as the receipt footer.
- **Thumbnail swatch:** Cream slip with a perforated/scalloped top edge, two dotted line-item rows, a bold dashed total bar.
  ```html
  <svg viewBox="0 0 64 44" width="64" height="44" role="img" aria-label="Receipt skin">
    <rect width="64" height="44" fill="#e7e3d8"/>
    <path d="M16 7 q3 0 3 3 q0 -3 3 -3 q3 0 3 3 q0 -3 3 -3 q3 0 3 3 q0 -3 3 -3 q3 0 3 3 q0 -3 3 -3 q3 0 3 3 q0 -3 3 -3 V37 H16 Z" fill="#fbfaf5" stroke="#d8d2c4"/>
    <rect x="22" y="12" width="20" height="2.4" fill="#15130f"/>
    <line x1="20" y1="20" x2="44" y2="20" stroke="#bcb4a2" stroke-width="1.2" stroke-dasharray="1.5 1.5"/>
    <line x1="20" y1="25" x2="44" y2="25" stroke="#bcb4a2" stroke-width="1.2" stroke-dasharray="1.5 1.5"/>
    <line x1="20" y1="31" x2="44" y2="31" stroke="#15130f" stroke-width="1.6" stroke-dasharray="3 2"/>
  </svg>
  ```

*(Note for the integrating agent: the `mask` perforation on `article` degrades gracefully — browsers without CSS mask support simply show a plain bordered slip, no breakage. Listed here so it isn't mistaken for a defect.)*

---

#### 4. newspaper

- **Label:** Newspaper
- **Vibe:** Broadsheet front page — serif body, a heavy masthead rule, drop-cap lede, multi-column flow, hairline column dividers. Authoritative, editorial, print-room.
- **Inspiration:** The New York Times / Le Monde front pages, classic broadsheet typography, the "old-print" editorial look. **Serif requirement met via system serif stack** (Georgia / Times) — no web font.

```html
<style data-rwa-skin="newspaper">
#rwa-doc-mount{
  --gray-50:#f4f1ea;--gray-100:#ece8de;--gray-200:#d6cfbf;--gray-300:#b8af9b;
  --gray-400:#8c8472;--gray-500:#5f5849;--gray-600:#403a2f;--gray-700:#2a261d;
  --gray-800:#1c1913;--gray-900:#15120c;--white:#faf7f0;
  --green:#2f6b3f;--yellow:#9a7b1e;--red:#9b2118;--blue:#1f3f7a;
  --radius:0px;--radius-sm:0px;
  --sk-serif:Georgia,'Times New Roman',Times,'Iowan Old Style',serif;
  background:#e9e4d8;color:#15120c;
  font-family:var(--sk-serif);font-size:16px;line-height:1.5;
}
#rwa-doc-mount article{max-width:760px;margin:40px auto;padding:32px 36px;
  background:#faf7f0;border:1px solid #d6cfbf;}
#rwa-doc-mount h1,#rwa-doc-mount h2,#rwa-doc-mount h3,
#rwa-doc-mount h4{font-family:var(--sk-serif);color:#15120c;font-weight:700;}
#rwa-doc-mount h1{font-size:2.8rem;line-height:1.04;letter-spacing:-.01em;
  text-align:center;font-weight:800;margin:.1em 0 .3em;}
#rwa-doc-mount h2{font-size:1.5rem;line-height:1.15;
  border-bottom:1px solid #15120c;padding-bottom:.2em;font-weight:700;}
#rwa-doc-mount h3{font-size:1.15rem;font-style:italic;font-weight:700;}
#rwa-doc-mount p{color:#1c1913;text-align:justify;hyphens:auto;}
#rwa-doc-mount a{color:#1f3f7a;text-decoration-thickness:1px;}
#rwa-doc-mount blockquote{border-left:0;border-top:2px solid #15120c;
  border-bottom:2px solid #15120c;padding:.6em 1em;font-style:italic;
  text-align:center;font-size:1.15rem;color:#2a261d;margin:1.4em auto;max-width:90%;}
#rwa-doc-mount hr{border-top:1px solid #15120c;}
#rwa-doc-mount ul,#rwa-doc-mount ol{color:#1c1913;}
#rwa-doc-mount code{font-family:var(--font-mono);background:#ece8de;color:#15120c;}
#rwa-doc-mount pre{font-family:var(--font-mono);background:#ece8de;
  border:1px solid #d6cfbf;color:#15120c;}
#rwa-doc-mount table{font-size:.95em;}
#rwa-doc-mount th,#rwa-doc-mount td{border-bottom:1px solid #b8af9b;}
#rwa-doc-mount th{background:transparent;border-bottom:2px solid #15120c;
  text-transform:uppercase;letter-spacing:.06em;font-family:var(--sk-serif);}
/* L1 hooks */
#rwa-doc-mount .sk-masthead{text-align:center;border-top:4px solid #15120c;
  border-bottom:1px solid #15120c;padding:6px 0;margin-bottom:8px;
  font-size:.72rem;letter-spacing:.34em;text-transform:uppercase;font-weight:700;
  display:flex;justify-content:space-between;align-items:center;}
#rwa-doc-mount .sk-hero{border-bottom:3px double #15120c;padding-bottom:1em;
  margin-bottom:1.2em;}
#rwa-doc-mount .sk-byline{text-align:center;font-style:italic;font-size:.85rem;
  letter-spacing:.04em;color:#5f5849;text-transform:uppercase;}
#rwa-doc-mount .sk-lede{font-size:1.08rem;}
#rwa-doc-mount .sk-lede::first-letter{font-size:3.4em;line-height:.8;float:left;
  padding:.05em .08em 0 0;font-weight:800;color:#15120c;}
#rwa-doc-mount .sk-columns{column-count:2;column-gap:32px;column-rule:1px solid #b8af9b;}
#rwa-doc-mount .sk-columns p{margin:0 0 .8em;}
#rwa-doc-mount .sk-pull{font-size:1.5rem;font-style:italic;font-weight:700;
  line-height:1.2;border-top:2px solid #15120c;border-bottom:2px solid #15120c;
  padding:.5em 0;margin:1em 0;text-align:center;color:#15120c;}
@media (max-width:560px){#rwa-doc-mount .sk-columns{column-count:1;}}
</style>
```

- **L1 restyle recipe:**
  - Insert `<div class="sk-masthead"><span>Vol. I</span><span>The Daily</span><span>{date}</span></div>` above the title (using the doc's own title for the center label if present, generic otherwise).
  - Wrap title + byline in `<div class="sk-hero">`; byline → `class="sk-byline"`; the first body `<p>` → `class="sk-lede"` for the drop-cap.
  - Wrap the *bulk* of body paragraphs (after the lede) in `<div class="sk-columns">` for two-column flow. **Constraint:** never pull a heading, table, `<pre>`, or any block carrying `data-rwa-id` *structure* into a column wrapper in a way that reorders ids — wrap a contiguous run of plain `<p>` only, preserving each `data-rwa-id` verbatim on its element.
  - Promote one striking sentence/quote to a `<p class="sk-pull">…</p>` pull-quote (or convert an existing `<blockquote>`).
- **Thumbnail swatch:** Cream tile, heavy black masthead rule on top, a centered serif headline bar, two text columns split by a hairline.
  ```html
  <svg viewBox="0 0 64 44" width="64" height="44" role="img" aria-label="Newspaper skin">
    <rect width="64" height="44" fill="#faf7f0"/>
    <rect x="6" y="6" width="52" height="3" fill="#15120c"/>
    <rect x="18" y="13" width="28" height="4" fill="#15120c"/>
    <line x1="32" y1="22" x2="32" y2="38" stroke="#b8af9b" stroke-width="1"/>
    <g fill="#5f5849"><rect x="9" y="23" width="19" height="1.6"/><rect x="9" y="27" width="19" height="1.6"/><rect x="9" y="31" width="19" height="1.6"/><rect x="9" y="35" width="14" height="1.6"/>
    <rect x="36" y="23" width="19" height="1.6"/><rect x="36" y="27" width="19" height="1.6"/><rect x="36" y="31" width="19" height="1.6"/><rect x="36" y="35" width="12" height="1.6"/></g>
  </svg>
  ```

---

#### 5. retro-mac-system

- **Label:** System 6
- **Vibe:** Classic Macintosh System 6/7 desktop — pinstriped title bars, chunky 1px black window chrome, Chicago-style bold UI, the cozy beige of a Mac SE. Playful, nostalgic, GUI-as-document.
- **Inspiration:** Mac OS System 6/7, the original Finder windows, "frutiger aero predecessor" 1-bit GUI, classic dialog boxes. (No Chicago web font — system UI bold stack only, which reads correctly as a chunky GUI label.)

```html
<style data-rwa-skin="retro-mac-system">
#rwa-doc-mount{
  --gray-50:#ffffff;--gray-100:#e8e8e8;--gray-200:#bfbfbf;--gray-300:#999999;
  --gray-400:#7a7a7a;--gray-500:#555555;--gray-600:#3a3a3a;--gray-700:#222222;
  --gray-800:#111111;--gray-900:#000000;--white:#ffffff;
  --green:#008000;--yellow:#c0a000;--red:#cc0000;--blue:#000080;
  --radius:0px;--radius-sm:0px;
  --sk-chrome:#dcdcdc;
  /* desktop dither, pure CSS checker pattern */
  background:#bfbfbf;
  background-image:
    linear-gradient(45deg,#a8a8a8 25%,transparent 25%,transparent 75%,#a8a8a8 75%),
    linear-gradient(45deg,#a8a8a8 25%,transparent 25%,transparent 75%,#a8a8a8 75%);
  background-size:4px 4px;background-position:0 0,2px 2px;
  color:#000;font-family:var(--font-ui);font-size:14px;line-height:1.45;
}
#rwa-doc-mount article{
  max-width:680px;margin:44px auto;background:#fff;
  border:2px solid #000;box-shadow:3px 3px 0 #000;
  padding:0 0 24px;
}
/* fake window title bar with pinstripes */
#rwa-doc-mount article::before{
  content:"";display:block;height:20px;border-bottom:2px solid #000;
  background:repeating-linear-gradient(#000,#000 1px,#fff 1px,#fff 2px);
  margin-bottom:20px;
}
#rwa-doc-mount h1,#rwa-doc-mount h2,#rwa-doc-mount h3{
  font-family:var(--font-ui);font-weight:700;color:#000;letter-spacing:0;
}
#rwa-doc-mount article{padding-left:24px;padding-right:24px;}
#rwa-doc-mount h1{font-size:1.7rem;}
#rwa-doc-mount h2{font-size:1.3rem;border-bottom:2px solid #000;
  padding-bottom:.15em;}
#rwa-doc-mount h3{font-size:1.1rem;}
#rwa-doc-mount p{color:#000;}
#rwa-doc-mount a{color:#000080;text-decoration:underline;}
#rwa-doc-mount a:hover{background:#000080;color:#fff;text-decoration:none;}
#rwa-doc-mount ul li::marker{content:"◆  ";}
#rwa-doc-mount blockquote{border-left:0;border:2px solid #000;background:#e8e8e8;
  padding:10px 14px;font-style:normal;box-shadow:2px 2px 0 #000;color:#000;}
#rwa-doc-mount hr{border-top:2px solid #000;}
#rwa-doc-mount code{background:#e8e8e8;border:1px solid #000;color:#000;}
#rwa-doc-mount pre{background:#fff;border:2px solid #000;box-shadow:2px 2px 0 #000;
  color:#000;}
#rwa-doc-mount table{border:2px solid #000;}
#rwa-doc-mount th,#rwa-doc-mount td{border:1px solid #000;}
#rwa-doc-mount th{background:repeating-linear-gradient(#000,#000 1px,#fff 1px,#fff 2px);
  color:#000;font-weight:700;text-shadow:0 0 2px #fff,0 0 2px #fff;}
/* L1 hooks */
#rwa-doc-mount .sk-hero{border:2px solid #000;background:#dcdcdc;
  box-shadow:2px 2px 0 #000;margin-bottom:24px;}
#rwa-doc-mount .sk-titlebar{height:18px;border-bottom:2px solid #000;
  background:repeating-linear-gradient(#000,#000 1px,#fff 1px,#fff 2px);
  position:relative;}
#rwa-doc-mount .sk-titlebar::before{content:"";position:absolute;left:6px;top:3px;
  width:11px;height:11px;background:#fff;border:1.5px solid #000;}
#rwa-doc-mount .sk-hero h1{margin:10px 14px;background:#dcdcdc;display:inline-block;
  padding:0 6px;}
#rwa-doc-mount .sk-byline{margin:0 14px 12px;font-size:.82rem;color:#222;}
#rwa-doc-mount .sk-stat-row{display:flex;gap:12px;flex-wrap:wrap;margin:1.4em 0;}
#rwa-doc-mount .sk-stat{flex:1 1 120px;border:2px solid #000;background:#fff;
  box-shadow:2px 2px 0 #000;padding:12px;}
#rwa-doc-mount .sk-stat-num{font-size:1.8rem;font-weight:700;display:block;line-height:1;}
#rwa-doc-mount .sk-stat-label{font-size:.72rem;color:#222;}
#rwa-doc-mount .sk-card{border:2px solid #000;background:#fff;box-shadow:2px 2px 0 #000;
  padding:14px;margin:1.4em 0;}
@media (prefers-reduced-motion:no-preference){}
</style>
```

- **L1 restyle recipe:**
  - Wrap title cluster in `<div class="sk-hero"><div class="sk-titlebar"></div><h1>…</h1><p class="sk-byline">…</p></div>` — produces a draggable-looking window header with a close box.
  - Metric runs → `.sk-stat-row` of `.sk-stat` tiles.
  - Discrete sections/asides → `<div class="sk-card">` (a nested "window").
  - The `article::before` pinstripe bar already frames the whole document as one System window; lists/tables/code carried by element rules.
- **Thumbnail swatch:** Beige dithered desktop with a small white window: pinstriped title bar + tiny close box, two short content lines.
  ```html
  <svg viewBox="0 0 64 44" width="64" height="44" role="img" aria-label="System 6 skin">
    <rect width="64" height="44" fill="#bfbfbf"/>
    <rect width="64" height="44" fill="#a8a8a8" opacity=".4"/>
    <rect x="12" y="9" width="40" height="28" fill="#fff" stroke="#000" stroke-width="2"/>
    <rect x="12" y="9" width="40" height="6" fill="#fff" stroke="#000" stroke-width="2"/>
    <g stroke="#000" stroke-width="1"><line x1="12" y1="10.5" x2="52" y2="10.5"/><line x1="12" y1="12.5" x2="52" y2="12.5"/></g>
    <rect x="15" y="10" width="4" height="4" fill="#fff" stroke="#000" stroke-width="1"/>
    <rect x="17" y="20" width="30" height="2.4" fill="#000"/>
    <rect x="17" y="26" width="22" height="2.4" fill="#555"/>
    <rect x="17" y="31" width="26" height="2.4" fill="#555"/>
  </svg>
  ```

---

#### 6. whiteboard-sketch

- **Label:** Whiteboard
- **Vibe:** Hand-drawn marker-on-whiteboard / notebook doodle — wobbly borders, highlighter swipes, sticky-note callouts, dashed "drawn" rules. Loose, friendly, brainstorm energy.
- **Inspiration:** Excalidraw, tldraw, sticky-note retros, marker-and-whiteboard standups. (Hand-drawn *look* without a hand-drawn web font — achieved with subtle rotation, irregular border-radii, and inline-SVG marker textures; body stays in the system UI stack for legibility.)

```html
<style data-rwa-skin="whiteboard-sketch">
#rwa-doc-mount{
  --gray-50:#ffffff;--gray-100:#f3f4f6;--gray-200:#e2e4e8;--gray-300:#c5c8cf;
  --gray-400:#9aa0ab;--gray-500:#6b7280;--gray-600:#454b54;--gray-700:#2f343b;
  --gray-800:#23262c;--gray-900:#1b1d22;--white:#ffffff;
  --green:#1f9d55;--yellow:#f7d046;--red:#e8453c;--blue:#3b6ef0;
  --radius:14px;--radius-sm:8px;
  --sk-ink:#1b1d22;--sk-hi:#fff59d;--sk-note:#fff7b2;
  background:#f7f7f4;color:#1b1d22;
  font-family:var(--font-ui);font-size:16px;line-height:1.6;
}
#rwa-doc-mount article{max-width:720px;margin:48px auto;padding:8px 36px 40px;
  background:#fff;border:2.5px solid #1b1d22;
  border-radius:255px 18px 225px 18px/18px 225px 18px 255px;
  box-shadow:3px 4px 0 rgba(27,29,34,.12);}
#rwa-doc-mount h1,#rwa-doc-mount h2,#rwa-doc-mount h3{
  font-family:var(--font-ui);font-weight:800;color:#1b1d22;letter-spacing:-.01em;}
#rwa-doc-mount h1{font-size:2.3rem;display:inline;line-height:1.7;
  background:linear-gradient(transparent 58%,var(--sk-hi) 58%,var(--sk-hi) 92%,transparent 92%);
  box-decoration-break:clone;-webkit-box-decoration-break:clone;padding:0 .1em;}
#rwa-doc-mount h2{font-size:1.55rem;display:inline-block;}
#rwa-doc-mount h2::after{content:"";display:block;height:6px;margin-top:2px;
  background:no-repeat center/100% 6px
   url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 6'%3E%3Cpath d='M1 4 Q30 1 60 3.5 T119 2.5' fill='none' stroke='%231b1d22' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E");}
#rwa-doc-mount h3{font-size:1.2rem;}
#rwa-doc-mount p{color:#2f343b;}
#rwa-doc-mount a{color:#3b6ef0;text-decoration:none;
  background:linear-gradient(transparent 80%,#cdd9ff 80%);padding:0 1px;}
#rwa-doc-mount a:hover{background:#cdd9ff;}
#rwa-doc-mount ul li{list-style:none;position:relative;}
#rwa-doc-mount ul li::before{content:"";position:absolute;left:-1.3em;top:.5em;
  width:8px;height:8px;background:#3b6ef0;
  border-radius:46% 54% 50% 50%/55% 50% 50% 45%;}
#rwa-doc-mount blockquote{border-left:0;background:var(--sk-note);color:#1b1d22;
  font-style:normal;padding:14px 18px;border-radius:6px;
  transform:rotate(-1.4deg);box-shadow:2px 3px 6px rgba(27,29,34,.15);
  border:1px solid rgba(27,29,34,.12);}
#rwa-doc-mount hr{border:0;height:6px;background:no-repeat center/100% 6px
   url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 6'%3E%3Cpath d='M1 3 Q50 0 100 4 T199 2' fill='none' stroke='%231b1d22' stroke-width='2'/%3E%3C/svg%3E");
  margin:2em 0;}
#rwa-doc-mount code{background:#fff59d;color:#1b1d22;border-radius:4px;}
#rwa-doc-mount pre{background:#fffef7;border:2px dashed #1b1d22;border-radius:10px;
  color:#1b1d22;}
#rwa-doc-mount table{border:0;}
#rwa-doc-mount th,#rwa-doc-mount td{border:0;border-bottom:2px dashed #c5c8cf;}
#rwa-doc-mount th{background:transparent;font-weight:800;
  border-bottom:2.5px solid #1b1d22;}
/* L1 hooks */
#rwa-doc-mount .sk-hero{margin-bottom:1.6em;}
#rwa-doc-mount .sk-byline{display:inline-block;background:#cdd9ff;padding:2px 10px;
  border-radius:12px;font-size:.85rem;transform:rotate(-1deg);margin-top:.6em;}
#rwa-doc-mount .sk-note{background:var(--sk-note);border-radius:6px;padding:16px 18px;
  box-shadow:2px 4px 8px rgba(27,29,34,.16);transform:rotate(1.2deg);margin:1.5em 0;
  border:1px solid rgba(27,29,34,.12);}
#rwa-doc-mount .sk-note:nth-of-type(even){transform:rotate(-1.6deg);
  background:#cfe8d2;}
#rwa-doc-mount .sk-stat-row{display:flex;gap:16px;flex-wrap:wrap;margin:1.6em 0;}
#rwa-doc-mount .sk-stat{flex:1 1 130px;background:#fff;border:2.5px solid #1b1d22;
  border-radius:18px 240px 18px 240px/240px 18px 240px 18px;padding:16px 18px;
  box-shadow:2px 3px 0 rgba(27,29,34,.10);}
#rwa-doc-mount .sk-stat-num{font-size:2rem;font-weight:800;display:block;line-height:1;
  color:#3b6ef0;}
#rwa-doc-mount .sk-stat-label{font-size:.78rem;color:#454b54;}
#rwa-doc-mount .sk-circle{display:inline;background:none;
  box-shadow:inset 0 0 0 2px #e8453c;border-radius:50%;padding:.05em .3em;
  -webkit-box-decoration-break:clone;box-decoration-break:clone;}
@media (prefers-reduced-motion:reduce){
  #rwa-doc-mount blockquote,#rwa-doc-mount .sk-note,#rwa-doc-mount .sk-byline{transform:none;}}
</style>
```

- **L1 restyle recipe:**
  - Wrap title cluster in `<div class="sk-hero">`; the `<h1>` highlighter sweep lands automatically; byline → `class="sk-byline"` (tilted tag pill).
  - Promote asides/callouts/`<blockquote>`-like emphasis paragraphs to `<div class="sk-note">` sticky notes (alternating tilt + color via `:nth-of-type`).
  - Metric runs → `.sk-stat-row` of wobbly-border `.sk-stat` tiles.
  - Wrap a key term or two in `<span class="sk-circle">…</span>` for a hand-circled emphasis (use sparingly — one per section max).
  - Lists get hand-drawn bullets, `<hr>`/`<h2>` underlines get the SVG marker stroke automatically.
- **Thumbnail swatch:** White card with a wobbly rounded border, a yellow highlighter swipe under a title bar, a tilted yellow sticky note.
  ```html
  <svg viewBox="0 0 64 44" width="64" height="44" role="img" aria-label="Whiteboard skin">
    <rect width="64" height="44" fill="#f7f7f4"/>
    <path d="M8 8 Q32 5 56 8 Q58 22 56 36 Q32 39 8 36 Q6 22 8 8 Z" fill="#fff" stroke="#1b1d22" stroke-width="2"/>
    <rect x="13" y="13" width="24" height="5" fill="#fff59d"/>
    <rect x="13" y="13.5" width="20" height="3" fill="#1b1d22"/>
    <path d="M13 24 Q24 22 36 24" fill="none" stroke="#1b1d22" stroke-width="1.6"/>
    <g transform="rotate(8 46 28)"><rect x="38" y="22" width="14" height="12" fill="#fff7b2" stroke="#1b1d22" stroke-opacity=".2"/></g>
  </svg>
  ```

---

#### Family-level integration notes (for the agent assembling the gallery + lens + self-description wiring)

These are not relitigations of the validated decisions — they are the concrete hooks this family expects from the shared chrome/spec layer.

1. **`activeSkin` read.** Self-description/1's declared `activeSkin` should be the `data-rwa-skin` attribute value of the *single* skin `<style>` block in `INLINE_DOC`. If zero such blocks → `activeSkin: null` (the seed default, unskinned). If more than one (shouldn't happen, since re-skin replaces) → report the *first* and surface it as a soft anomaly, never crash. This mirrors the existing "container facts authoritative over author claims" precedence: the attribute is read from bytes, not declared prose.

2. **Reset semantics.** `/skin reset` is `apply_edits` deleting exactly the `<style data-rwa-skin="…">…</style>` block (a single unique anchor). Because the seed baseline is specificity-0 and always present in the frozen runtime, deletion cleanly returns the document to baseline — no "restore default theme" block needs writing. Confirmed safe against all six here (each is one contiguous block).

3. **`prefers-reduced-motion`.** `terminal-mono` (`.sk-blink`) and `whiteboard-sketch` (tilt transforms) ship reduced-motion guards. The two with motion-ish effects are the only ones that need it; the others are fully static. Worth keeping as a family convention so the gallery can advertise "respects reduced motion."

4. **L1 `data-rwa-id` preservation.** Every recipe above *adds* `class="sk-…"` to existing elements or *wraps* them in new `<div class="sk-…">`. The restyle prompt for this family must state: when wrapping a `data-rwa-id`-bearing element, the id stays on that original element (move the element into the wrapper unchanged — do not lift the id to the wrapper, do not drop it). The newspaper `.sk-columns` wrapper is the riskiest (it gathers multiple paragraphs); its recipe explicitly forbids reordering or merging id-bearing blocks.

5. **Workflow-kind caution.** This family's high-impact wrappers (`.sk-columns`, `.sk-hero` window chrome) assume prose/article content. For the `workflow` kind (frozen `wf-style` + runner zones), the L1 restyle must be downgraded to L0-only (variable + element re-point) so it never tries to wrap inside a frozen zone. Flagging here because three of these (newspaper, retro-mac-system, brutalist) are visually weakest at L0-only and the gallery may want to gray them out or label them "theme-only" for workflow containers.

6. **Contrast sanity.** All six keep body-text-on-background contrast ≥ ~7:1 except `terminal-mono`'s dimmer `--gray-500` phosphor green on near-black (~6:1, still AA for body) — intentional for the CRT look. `brutalist`/`newspaper`/`receipt`/`retro-mac`/`whiteboard` are black-ish ink on light paper (very high contrast). No accessibility regression versus baseline.


---

## Always-on restyle & the safety net

The user chose **always-on full content-aware restyle** landing as a **single commit**. This is structurally true in rwa-edit/1 and need not be invented — but it has one real prerequisite that does not exist today.

**Single commit, one ⌘Z.** `modify()` holds the mutex, drives a multi-turn tool-use conversation (retry budget 3), and commits the document + undo + history in **one IDB transaction** on the single accepted tool call. So a skin must be expressible as **one batch** — one `apply_edits` envelope (the theme-block swap edit + N markup-rewrite edits, ordered `(find,replace)` pairs) — stamped `actor: "skin:NAME"`. The loop must **not split a skin across multiple accepted tool calls** (that would be two commits → a half-skinned doc after one undo). Reset and re-skin are each their own single `modify()`, independently revertible.

**The prerequisite (G-A — flagged, not hand-waved).** "Seed the agent's batch with the deterministic theme edit, then let the agent append its restyle edits" has **no mechanism in the runtime today** — `modify()` drives the model; the model emits its own envelopes. The canonical realization: the runtime runs the agent loop to **accumulate** a proposed edit batch, **prepends** the deterministic theme-block edit, and commits the combined batch through **one** `commitCore`/`applyPlan` call (one `rwa_hist` `edit_batch`, one `rwa_undo` frame). This **compose-then-commit primitive** is new runtime surface (seed territory, dirac-adjacent) and is the hard gate for L1. It is *the* cleanest argument for shipping deterministic theme-only first (where single-commit is trivially satisfied) and L1 second.

**The safety net for "always full restyle" (the tension, surfaced).** Always-on markup rewrite is the most surprising operation for the overwhelmed user this is *for*. The compensating affordances — all already in the substrate — are: (1) **⌘Z** = full single-step revert; (2) **`/skin reset`** = single-block delete to baseline; (3) **`rwa_hist`** records the `skin:NAME` actor → visible, auditable; (4) the **gallery shows thumbnail swatches before apply** (you saw the look first); (5) an optional **confirm** for `/skin like <image>` (non-deterministic extraction); (6) the **dirty-state nudge** + "the exported `.html` is the durable artifact" reminder → ⌘S before experimenting is a disk-level escape hatch independent of IDB. The phasing below leans on these by shipping the *reversible deterministic* half first.

### Invariant guardrails

Each load-bearing invariant stressed against always-on restyle, with the concrete guardrail. Most are **already enforced** by the existing apply path — the design's job is to not break them and to instruct the model.

| # | Invariant | Risk | Guardrail | Sev |
|---|---|---|---|---|
| **G1** | One batch ⇒ one `rwa_hist` ⇒ one ⌘Z | Skin staged across 2+ accepted tool calls → partial undo | **Prompt-enforce a single envelope**; runtime accepts the first successful skin batch and ends the loop (no auto-"polish" continuation). | High |
| **G2** | `apply_edits`/DSL `insert` reject a change to the `(scripts, styles)` count (`structural_shape_changed`) | A *new* `<style data-rwa-skin>` raises the style count → rejected. **The central trap.** | **Seed-baked empty placeholder** (locked) → count is constant → every skin op is a content-only swap. Fallback: `replace_document` up front (no silent escalation). | High |
| **G3** | Marker-form frozen zones inviolable | A restyle `find` overlaps a frozen zone | **Already enforced** (`editCrossesFrozenZone`). Prompt: don't anchor across named frozen regions. | Med |
| **G4** | Attribute-form `data-rwa-frozen` byte-invariant (incl. workflow `wf-style`/runner) | Skin restyles a frozen block | **Already enforced** (`dataRwaFrozenSnapshot`). Frozen `wf-style` is un-skinnable by construction — correct. | Med |
| **G5** | `data-rwa-id` preserved verbatim | Restyle drops/invents ids when wrapping | Prompt (mirror §6.1): keep the id on the *inner* element; the wrapper gets its id **backfilled at commit** (skips frozen). Additive-only wrappers (above) make this safe. | Med |
| **G6** | Reserved namespaces; reserved-substring guard blocks `find`/`replace` mentioning `data-rwa-frozen` | (a) `data-rwa-skin` collides; (b) guard blocks writing `data-rwa-skin` | **Reserve `data-rwa-skin`** in CLAUDE.md/spec, but **do NOT** add it to `RESERVED_MARKERS`. Verified: `containsReservedMarker` uses `includes()` and `data-rwa-frozen ⊄ data-rwa-skin`, so the model can write it. | High |
| **G7** | The skin block must be edit-reachable, never mistaken for frozen | Placeholder marked frozen → re-skin impossible | The block carries `data-rwa-skin` only (no `data-rwa-frozen`), so it's naturally excluded from the frozen snapshot. The one style block the model may rewrite. | High |
| **G8** | Self-containment: no web fonts / external assets / fetch | A vision-extracted theme re-introduces `@font-face`, `url(http…)`, `@import` | Reuse `cli/src/self-contained.mjs findExternalRefs` over the **vision-synthesized** block + any model-emitted CSS (named presets are trusted constants — no scan). **Extend** with a font guard (reject `@font-face` / non-system `font-family`) in a sibling `skin-validate.mjs`. Vision emits *tokens*, never URLs. | High |
| **G9** | Idempotent re-skinning (B replaces A) | L1 hooks from A persist → class-soup | **L0** is clean (single block, swapped). **L1**: re-skin = **reset-then-apply** as canonical semantics (returns to pre-B, not pre-A); `sk-*` strip is deterministic *because* wrappers are additive-only/invertible. | High |
| **G10** | Data-URI SVG written into INLINE_DOC | A raw `<`/`>` (e.g. `</svg>`, `</style>`) breaks the inline doc / trips the reserved-marker guard | **Any data-URI SVG in INLINE_DOC must be percent-encoded** (`%3C…%3E`); reject raw `<`/`>` in synthesized CSS. (The `whiteboard-sketch` preset complies — but the vision synthesizer and all future skins must be *held* to it.) | High |
| **G11** | Anchors unique within a batch | N rewrites → an anchor becomes non-unique mid-batch | Inherited: `apply_edits` recomputes occurrence count each iteration; self-correcting near-miss feedback within the retry budget. Prompt: anchor on stable unique text, prefer `data-rwa-id` anchors. | Low |

## Image → tokens: the `/skin like <image>` vision contract (v3)

`/skin like <image>` is the one entry point where the look lives outside the system — in a screenshot. It **bottoms out in the same preset apply path**: the vision pass differs *only* in how the token set is acquired. There is no second pipeline.

**Backend matrix.** openrouter (default) sends the image as an OpenAI-compat `image_url` content part **iff** a vision model is selected; ollama/lmstudio likewise **iff** a VLM is loaded; **bridge (`claude -p`) cannot accept an image** as wired (single-shot base64-stdin text; no file path for a pasted blob). The runtime computes `visionAvailable` at dispatch; when `false`, it **degrades loudly** (Rule 12) to a *describe-the-look-in-words* path that runs the **same extraction prompt** against the user's typed description (`/skin like a warm 1970s print magazine, cream paper, red serif headlines`) — pixels and prose are two front-ends to one extractor.

**Extraction contract — a validated token set, never pasted CSS.** The pass returns a JSON object (`{"rwa-skin-extract":"1", name, feel, confidence, tokens:{ramp, semantic, accent, fontUi/fontMono (intent enum: sans|serif|mono|rounded|condensed), typeScaleRatio, baseSize, radius, shadow (enum), density (enum), borderWeight, motion (enum)}}`). It **cannot** name a font family or a URL — fonts are *intents* resolved to system stacks; any token value resembling `url(...)`/`@import`/`@font-face`/a host is **dropped at validation**; numbers clamp to safe ranges. The validated tokens feed the **same token→CSS synthesizer** the presets use → one `<style data-rwa-skin="warm-print">` block → the **same L1 restyle** → one commit, `actor: "skin:warm-print"` (the generated name, matching `activeSkin` — *not* `skin:image`). `confidence:"low"` routes to a gallery **preview ("apply?")** instead of auto-commit.

**Image guardrails:** never embed the source screenshot (request-scoped, discarded — the file gains only tokens-derived CSS); never synthesize a web font or remote asset; no script/behavior from a look (CSS-only, `motion` is CSS transitions). Frozen-zone + `data-rwa-id` safety is inherited from the standard loop. **The URL path stays deferred** — it breaks offline-first/self-containment and adds a fetch/exfil surface; if ever revived it must route through a *rendered screenshot* of the URL (re-entering the image channel with the same validated-token output), never in-document `fetch` of remote CSS.

## Gallery + lens surface

Both entry points are **runtime chrome** — they ship inside the frozen `#rwa-runtime` block (beside `#rwa-set`/`#rwa-pal`/`#rwa-lens`), never inside `INLINE_DOC`. They are *drivers*: every applied skin lands as one commit through the existing `modify()` machinery. The document holds only the resulting `<style data-rwa-skin>` block.

**The gallery.** A `✦` button joins the `#rwa-set` status-bar row (`● ready  ⓘ  ✦  ⚙  ⌘S`); bare `/skin` in the lens also opens it (no button-hunting). It opens `#rwa-skin-panel`, reusing the seed's panel idiom (`var(--white)`, `1px solid var(--gray-200)`, `--radius-sm`, soft shadow), styled to match the light theme exactly:

```
+------------------------------------------------------+
|  SKINS                                    active: —   |   <- mono 9px header
|------------------------------------------------------|
|  +--------+  +--------+  +--------+  +--------+        |
|  | Aa  ▤  |  | Aa  ▤  |  | Aa  ▤  |  | Aa  ▤  |        |   <- swatch = pure-CSS preview
|  |        |  |  ●●●●  |  |        |  |        |        |      (●●●● = palette ramp dots)
|  | Paper  |  | Mono   |  | Editor | | Brutal |        |   <- preset name, mono caption
|  +--------+  +--------+  +--------+  +--------+        |
|  +--------+  +--------+  +--------+  +--------+        |
|  | Slate  |  | Warm   |  | Press  | | Terminal|       |
|  +--------+  +--------+  +--------+  +--------+        |
|------------------------------------------------------|
|  [ From image… ]              [ 🎲 ]   [ Reset skin ] |
+------------------------------------------------------+
```

Each swatch is a `<button data-skin="paper">` whose thumbnail is **pure inline CSS/SVG** (no images, no fetch) generated from the *same token block* the skin applies — what you see is structurally what lands. The active card gets a `--gray-900` ring; on chrome init, `querySelector('#rwa-doc-mount style[data-rwa-skin]')` lights the active card (no formal SD field needed for this). A card click calls `applySkin(name)` → one commit `actor:"skin:NAME"`. `🎲` picks a preset **by code** (Rule 5 — not an agent round-trip); `From image…` opens a hidden file input routing into the vision path; `Reset skin` is model-free.

**Lens commands** (recognized in `submitLens` before the generic slash fallthrough, staying inside the rwa-lens-spec §6 slash convention):

| Input | State | Compiles to |
|---|---|---|
| `/skin NAME` | default only | `applySkin('NAME')` → theme swap (+ L1 restyle), one commit |
| `/skin like` (+ pasted/attached image) | default only | vision extract → synthesize → swap + restyle, `actor:"skin:<generated>"` |
| `/skin reset` | default only | model-free `apply_edits` resetting the block to the placeholder |
| `/skin random` | default only | `applySkin(randomPresetName())` (name by code) |
| `/skin` (bare) | default only | opens the gallery — no commit, no agent |

A `/skin …` submitted while **anchored** is rejected with the existing brief-affordance pattern (*"Skins apply to the whole document — release the anchor (Esc) to skin."*), preserving the lens's exactly-two-states invariant. Image attachment rides the lens via **paste** (extend the existing paste handler: stash an `image/*` blob on `lensState.pendingImage`, show a `📎 image · ✕` chip in `#rwa-lens-badge`) or the **file picker**.

**Discoverability (the whole motivation).** The `✦` button is always visible — a user who knows zero skin names clicks the sparkle, sees thumbnails, clicks one. A blank document's lens hint rotates in *"New document — pick a look with ✦ Skins, or type /skin."* Hover-preview (transient `<style id="rwa-skin-preview">` injected into the *runtime DOM*, never `rwa_doc`) shows the L0 palette/type taste live with zero commit risk — *deferred to v2* (it's real new chrome logic; thumbnails already preview).

## Self-description + CLI integration

**`activeSkin` is a top-level attribute, not an affordance.** A skin adds no *capability* (the affordance kernel's `view`/`edit-surface`/`tool`/`compute`/`hook` each name a thing you can *do*) — it is the document's current *appearance*, a scalar on one `<style>` block. It is the appearance analogue of `activeView`: a top-level optional `string | null` field, read from the `data-rwa-skin` attribute. It is **body-computable**, so it appears in **all three projections** (static `rwa doc`, live `runtime.describe()`, declared) and static==live by construction; container facts win over any declared value. Strictly additive (`activeSkin: null` for every pre-skin file), no conformance test changes; spec bumps to **v1.2** with an SD-08 line. This touches the **4 mirror sites** (oracle `tools/self-description.mjs` → `cli/src/identity.mjs` → seed `runtimeDescribe` → spec) — they land together or `identity.test.mjs`/`doc.test.mjs` fail loudly. The affordance machinery (`KIND_PROVIDERS`, `checkAffordanceAgreement`) is **untouched**, confirming attribute-not-affordance.

**The preset library is one source:** a new zero-dep `cli/src/skins.mjs` exporting a frozen `SKINS` table (`{name, label, swatch, theme, restyle}`), shipped in-package like the seed (so the CLI reads it offline). The runtime gallery block is a **test-pinned mirror** of it (same discipline as `identity.mjs`/`apply-edits.mjs`), so the CLI, the gallery, and a published share render the *same preset bytes* offline. **Skin is orthogonal to kind** — it touches only the INLINE_DOC body, composing with `kindOverrides`' six regions without a new substitution region (a skinned presentation, a skinned workflow are valid). CLI surface:

| Invocation | Theme | Restyle | Network | Commits |
|---|---|---|---|---|
| `rwa new --skin NAME` | inject (det.) | — | offline | n/a (emit) |
| `rwa skin <file> NAME --theme-only` | swap (det.) | — | offline | 1 (`skin:NAME`) |
| `rwa skin <file> NAME` (default) | swap (det.) | agent loop | backend | 1 (`skin:NAME`) |
| `rwa skin <file> reset` | placeholder (det.) | — | offline | 1 (`skin:reset`) |

The deterministic paths are model-free `applyPlan` envelopes reusing `edit.mjs`'s stable exit codes / `CliError`. The default path runs the agent loop to **accumulate** edits, **prepends** the theme edit, commits **one** batch (the same compose-then-commit primitive as the runtime) — and on backend failure **fails loud** (exit 4: "retry or use `--theme-only`"), never silently downgrading. `rwa skin <workflow> NAME --theme-only` honestly restyles prose/chrome but cannot restructure the frozen runner. `--skin` injects *after* `applySeedSubs` (mirroring the `rwa import` ordering lesson) so the skin CSS can't false-match a substitution regex.

## MVP slice & phasing

The critique's central finding: the design conflates a **cheap, shippable, deterministic theme-only v1** with an **expensive, model-dependent L1 + vision v2/v3**. The locked decision is "always full restyle, maximum impact" — that remains the **target**. But L1 has a hard runtime prerequisite (the compose-then-commit primitive, G-A) and an invariant-completeness bar (additive-only invertible wrappers, re-skin idempotence) that the deterministic half does not. So the honest build order ships the reversible half first and reaches the headline feature in phase 2 — *not* dropped, sequenced.

**v1 — deterministic theme-only skinning (no model, no vision):**
1. One scoping model (`#rwa-doc-mount` tokens + element rules; `sk-` hooks).
2. Lean token contract (ramp re-point + ~6 knobs).
3. **3 presets**, each clearly distinct: `notion-clean` (clean default), `linear-dark` (proves the dark-canvas path — honest "dark article on default page", since a skin in INLINE_DOC can't repaint `body`), `editorial-serif` (serif/light). Each looks good at L0 with **no** L1 wrappers required.
4. First-skin path resolved: **seed-baked placeholder** (dirac dependency) — or `replace_document` up front if unavailable.
5. Gallery chrome (`✦` → 3 thumbnail swatches → one-click deterministic apply; `Reset` = placeholder).
6. Lens: `/skin NAME`, `/skin reset`, bare `/skin`. Anchored → reject.
7. CLI: `rwa skin <file> NAME --theme-only` + `rwa skin <file> reset` (model-free). **No** `--skin` on `new` yet, **no** model path yet.
8. Reserve `data-rwa-skin` (collision only; **not** in `RESERVED_MARKERS`).

Single-commit in v1 is trivially satisfied (theme-only = one deterministic envelope). The active-card highlight reads the DOM directly — the formal `self-description/1` `activeSkin` field can wait until an external consumer needs it.

**v2 — always-on content-aware L1 restyle** (the maximum-impact headline). Gated on: the **compose-then-commit primitive** (G-A), the **additive-only/invertible-wrapper** invariant (V4/G-B), and **re-skin idempotence**. Constrain or cut multi-column (`.sk-columns` is the single riskiest L1 op — it moves paragraphs). This is where single-commit, re-skin, and wrapper hazards all live; ship it as a deliberate second phase.

**v3 — `/skin like <image>` vision** (the whole second acquisition pipeline) + the **full 12-preset library** + the full token vocabulary + `rwa new --skin` + hover-preview + `/skin random` + the formal `self-description/1` `activeSkin` v1.2 field.

## Coordination (other agents in this repo)

This is design-only; nothing here is implemented. When implementation starts, these touch-points overlap other agents' areas and must be sequenced (per the shared-tree git protocol — explicit-path commits, one seed editor at a time):

- **`seeds/rewritable.html`** (dirac's recent area; he confirmed it's free): the **seed-baked `<style data-rwa-skin="">` placeholder** per kind, the **gallery chrome** (`✦` panel) and lens `/skin` parsing, the **compose-then-commit primitive** (v2), and `runtimeDescribe` emitting `activeSkin`. Reserve `data-rwa-skin` (not in `RESERVED_MARKERS`).
- **`cli/src/seed.mjs` `kindOverrides`** and **`cli/src/skins.mjs` (new)**: skin is *orthogonal* to kind, so it adds its own region/data module rather than overloading kind regions — but it's textually near shannon's possible `skill-host` kind / CSP `<meta>` work. Agreed protocol (chat #145/#146): textually-disjoint seed regions (theme/`data-rwa-skin` by the `<style>` block; CSP `<meta>` in `<head>`), one-at-a-time commits, marker comment for whoever lands first. shannon's per-install CSP is **connect-src only** — it does not touch `style-src`, so applied skins are unaffected.
- **The 4 self-description mirror sites** for `activeSkin` (v1.2): land together, pinned by `identity.test.mjs`/`doc.test.mjs`.
- **`docs/specs/rwa-lens-spec.md`**: add the `/skin …` slash commands to §4.3.

## Open questions

1. **First-skin path final call:** seed-baked placeholder (preferred — surgical, but needs a dirac seed change in every kind) vs `replace_document` up front (no seed change, weaker audit). Recommend the placeholder.
2. **Compose-then-commit primitive ownership** (the v2 gate): a new runtime affordance to accumulate-then-prepend-then-commit one batch. Seed territory — sequence with dirac.
3. **Font/self-containment guard location:** a sibling `skin-validate.mjs` (preferred) vs extending `self-contained.mjs` (risks scope-creep on the create-path tripwire).
4. **Presentation kind:** like workflow, presentation ships frozen `.rwa-slide`/`viewmode-presentation` rules in `<head>`; the gallery should label it "theme-only" and skins must not assume `article` is the layout root in present mode.

---

*Status: design-only. No code shipped. The invariant analysis (G2/G6/single-commit) is source-verified against `apply-edits.mjs`, `rwa-edit-spec.md`, and the seed; the three blocker-level contradictions the fan-out produced (scoping, chrome-tinting, first-skin path) are resolved to one answer each above. Ship the deterministic theme-only slice with 3 presets first; sequence the always-on L1 restyle and vision behind their runtime prerequisites.*
