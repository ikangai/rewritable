# Landing page for rewritable.ikangai.com — design

**Status:** approved 2026-05-16. Modeled on here.now's structure, styled in the playground.ikangai.com design system (the same tokens documented in `CLAUDE.md` § "Design constraints for documents").

## Why

`rewritable.ikangai.com/` currently `302`s to `/new`, which auto-downloads `rewritable.html` via a one-line trigger page. There is no surface that explains what a rewritable *is* to someone who lands cold. A landing page closes that gap and gives us a single URL to share.

## Non-goals

- Marketing chrome, hero illustrations, screenshot mockups, sign-up flow, animated backgrounds.
- A JS framework. Vanilla HTML + inline `<style>` + a tiny clipboard handler.
- Making the landing itself a rewritable container. Cute, but it forces a first-paint LLM call and asset weight that's wrong for a marketing page.
- Hosting brand-asset logos for the agent row. Text chips suffice and avoid attribution drift.

## Architecture

One file: `service/public/landing.html`. The service loads it at startup via `readFileSync` (same pattern as `IMPORT_HTML`, `TRIGGER_HTML`). `service/server.js` `/` switches from `302 → /new` to serving the landing bytes directly. `/new` is preserved as the auto-download trigger page and is the target of the landing's "Download" button (so the existing download UX is unchanged for anyone with a direct `/new` link).

The landing needs the contents of the rewritable-building `SKILL.md` for its copy-button. The skill lives outside the repo (`~/Downloads/rwa/rewritable/SKILL.md` on the author's machine). The service reads it at startup from a path configured via `RWA_SKILL_PATH`, falling back to a bundled copy at `service/public/build-skill.md` if the env var isn't set or the file is missing. Embedding it as a template literal in the landing HTML at startup keeps the page self-contained at request time (no extra fetch).

## Design tokens (lifted from playground.ikangai.com)

```css
:root {
  --white: #ffffff;
  --gray-50: #fafafa;  --gray-100: #f5f5f5; --gray-200: #e5e5e5;
  --gray-300: #d4d4d4; --gray-400: #a3a3a3; --gray-500: #737373;
  --gray-600: #525252; --gray-700: #404040; --gray-800: #262626;
  --gray-900: #171717;
  --green: #22c55e;  --yellow: #eab308;  --red: #ef4444;
  --radius: 24px; --radius-sm: 12px;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
code, pre { font-family: 'SF Mono', Monaco, ui-monospace, monospace; }
```

Primary action is `gray-900` background, white text, 100px radius pill — matches the playground "send" affordance. Secondary chips are white with `gray-200` border, 100px radius. Cards are white, 24px radius, `0 2px 8px rgba(0,0,0,.04)` baseline shadow, `0 4px 16px rgba(0,0,0,.08)` on hover. The hero CTA card mimics the playground lens chrome (white, 24px radius, soft shadow, max-width 680px).

## Sections (top → bottom)

1. **Header** — 56px fixed, white background. Left: `rewritable` wordmark (15px, weight 600). Right: text links to `Specs`, `GitHub`, `Demo gallery`.

2. **Hero** — centered, generous top padding.
   - H1: *"The HTML file that rewrites itself."* (~48px desktop, weight 600, `-0.02em` tracking)
   - Subhead: *"One `.html` file you open in any browser. Type into the lens, the file rewrites itself in place. No server, no account, no build step."* (18px, `gray-500`)
   - Primary CTA pill: **"Download a fresh container"** → `/rewritable.html`.
   - Inline secondary link: *"or import a doc you already have"* → `/import`.

3. **Two-step strip** — matches here.now's numbered structure. Two large numerals (gray-300 outline, 64px) with adjacent copy.
   1. *Download a blank container or import your own doc.*
   2. *Open it in a browser. Type into the lens. ⌘S writes the file back to disk.*

4. **"Works with every agent"** — section title in the playground's uppercase-tracked style (`12px`, `gray-500`). Two sub-rows:
   - **Inside the container** — chip row: `OpenRouter (any model)`, `Local claude -p via bridge`.
   - **To build a rewritable from scratch** — chip row: `Claude Code`, `Codex`, `Cursor`, `any agent with the rewritable skill`. Below the chips: a primary-style button **"Copy the rewritable skill"** that copies `SKILL.md` to clipboard and flips to "Copied!" with the green semantic color (same UX as here.now's "Copy setup instructions").

5. **CLI block** — rounded `pre` card. Contents:
   ```
   npx rwa new                 # fresh blank container
   npx rwa import notes.md     # convert md/html/csv/docx/pdf
   ```

6. **Demo gallery teaser** — full-width card linking to `/demo/html-effectiveness/` with copy *"20 examples — original HTML vs. rewritable, side by side."*

7. **FAQ** — 10 `<details>` items, no JS. Drafted from `README.md` and the specs:
   - What is a rewritable?
   - Do I need an account?
   - What does the agent see when it edits?
   - Where is my data stored?
   - Does it work offline?
   - What about iOS Safari?
   - Can I lock parts of a document?
   - What's the difference vs. Claude artifacts?
   - What's the difference vs. here.now?
   - Is it really one file? What does that cost me?

8. **Footer** — muted gray. Links: `Specs · GitHub · CHANGELOG · llms.txt · contact`.

## What ships

| File | Change |
|---|---|
| `service/public/landing.html` | New. Self-contained landing. |
| `service/public/build-skill.md` | New. Bundled fallback copy of the rewritable-building skill (so the page works in production without an env var pointing at someone's `~/Downloads`). |
| `service/server.js` | `/` serves landing bytes; embeds skill contents into landing at startup via a `{{SKILL_MD}}` template marker. |
| `service/Dockerfile` | `COPY` includes `service/public/build-skill.md` (already covered by `COPY service/public/`, verify). |
| `CLAUDE.md` | Service section: note the route change and the `build-skill.md` dependency. |

## Verification

- `curl -sI http://localhost:8080/` → `200 OK text/html`, body contains "rewritable".
- Open in browser → hero renders, mobile viewport ≤600px reflows cleanly.
- Click "Download a fresh container" → `rewritable.html` downloads.
- Click "Copy the rewritable skill" → clipboard contains the SKILL.md text, button shows "Copied!" for ~2s.
- Click each FAQ `<details>` → expands/collapses without JS errors.
- All footer/header links resolve (`/import`, `/demo/html-effectiveness/`, GitHub, specs).
- `node service/server.js` → starts without error even if `RWA_SKILL_PATH` is unset (uses bundled fallback).
