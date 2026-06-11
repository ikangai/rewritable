# Landing refresh: template shelf + authoring-skill distribution — design

Status: agreed direction, 2026-06-11. Companion build plan:
`docs/plans/2026-06-11-landing-templates-skill-plan.md`. Origin: review of
https://rewritable.ikangai.com against the current product (landing last
substantively touched 2026-05-16 @ 7c85061, v0.10-era — predates inline edit,
skins, images, presentations, connected shares, hosted editing, kinds, and the
CLI verb family).

## 1. What changes, in one paragraph

The landing page keeps its current style and voice **unchanged** (explicit
user decision — same gray-ramp vars, mono accents, `section`/`step`/`chip`
class system, 24px radius). Three additions: (a) a **template shelf** — a new
front-page section of 5 curated, nice-looking rewritables served through a
fresh-UUID-stamping route (`GET /t/<name>`) with live preview + download; (b)
a **second skill bundle** (`GET /authoring-skill.zip`) packaging the
dependency-free authoring-rewritables skill, assembled from source at service
startup; (c) a **copy/FAQ refresh** that catches the page up to v0.15
(images, skins, the ↗ share link, hosted editing, five backends). The
import showcase (`/demo/html-effectiveness/`) is kept but demoted from "the
gallery" to an evidence link — it answers "can it convert my stuff?"; the
shelf answers "what do I get?", which is the first question now.

## 2. The template shelf

### 2.1 Serving — never static, always stamped

Identical template bytes would give every download the same `DOC_UUID`, and
two copies on one machine silently share IndexedDB (the §7b receiver-side
inversion the share work just closed; `/publish` and `/rewritable.html`
already stamp per-request for exactly this reason). Therefore:

- Templates live in **`service/templates/<name>.html`** — complete, committed
  rewritables. Read **once at startup** (the service's static-asset
  convention), validated with `validateContainer` (a bad template fails the
  boot loudly, not the request).
- **`GET /t/<name>`** (apex-only; `name` gated by `/^[a-z0-9-]{1,40}$/`):
  substitute a fresh `DOC_UUID` per request via the existing `UUID_RE`
  replace. `?dl=1` adds `Content-Disposition: attachment;
  filename="<name>.html"`; without it the template serves inline — **preview
  is the live page itself** (a rewritable IS a webpage; each preview visit
  gets a throwaway UUID, so previews can never collide with anything).
  `Cache-Control: no-store` both ways (caching defeats the stamping).
- `/t/` becomes a **reserved URL prefix** beside `/s/` and `/r/`
  (CLAUDE.md service conventions).
- Tests override the directory via **`RWA_TEMPLATES_DIR`** (same pattern as
  `RWA_DATA_DIR`).

### 2.2 The v1 set — five cards, each from existing material

| name | kind | shows off | source material |
|---|---|---|---|
| `field-notes` | document | embedded images (data-URI, self-contained), baseline typography | authored new; 2–3 real photos, ≤1.5 MB total |
| `deck` | presentation | Present toggle, slides | the presentation kind's starter, content-upgraded |
| `budget` | document+table | tables, data-rwa-id'd cells, "spreadsheet" feel | slimmed from `examples/datatable/` (the flagship) |
| `kanban` | app | interactive doc-as-app, runtime.db | derived from the kanban-skill board seed |
| `invoice` | document | a working tracker people actually want | `demo/invoice-tracker.html`, reviewed + polished |

Rules for every template: CLAUDE.md document design constraints hold (real
seed data — **no lorem ipsum** — system fonts, ikangai palette, single file,
inline CSS, JS only where interactive); each carries
**`data-rwa-template="<name>"`** on the first element inside the doc body, so
a downloaded template immediately seeds the CLI's existing template discovery
(`rwa new <name>` in that cwd) — the web shelf and the CLI template flow
become one system; each gets a **different preset skin** applied
(deterministic L0 `rwa skin <file> NAME` — offline), so the shelf doubles as
a skin showcase; each must pass `validateContainer` + a body-size budget
(≤1.5 MB expanded) + an `rwa-lite`-style `doc` sanity (it self-describes).

### 2.3 The landing section

A new `<section>` ("Start from a template", `section-eyebrow` + a card grid
reusing the `.step` card look — new classes `.tpl-card`/`.tpl-grid` styled
with the existing vars only, no new colors/fonts). Each card: template name,
one-line description, kind chip (existing `.chip`), and two actions —
**Preview** (`/t/<name>`, target _blank) and **Download** (`/t/<name>?dl=1`).
Section footer keeps the import demo as evidence: "or see 20 imported
originals, before and after →" linking to `/demo/html-effectiveness/`. The
nav "Gallery" link retargets to `#templates`.

## 3. The authoring-skill bundle

### 3.1 Correction that shapes the design

The authoring-rewritables skill does **not** need the CLI installed — it is by
construction a dep-free vendored subset (nine `cli/src` modules + the seed +
`rwa-lite.mjs` glue) that runs on bare `node`. So distribution needs no
installer for the CLI; it needs the glue **upstreamed into the repo** (today
it lives only in `~/.claude/skills/`, outside version control) and a zip
route.

### 3.2 Layout and assembly

- New repo dir **`skills/authoring-rewritables/`**: `SKILL.md`,
  `bin/rwa-lite.mjs`, `references/edit-contract.md`, `install.sh` (five-line
  POSIX: copy the unzipped folder into `~/.claude/skills/`, `$1` overrides
  the destination). **No `src/` duplication** — the zip assembles from
  `cli/src` directly, so there is no third mirror to drift.
- **`GET /authoring-skill.zip`**: built once at startup with the existing
  `buildStoredZip` (deterministic bytes), from: the glue dir + the **nine**
  vendored modules (`seed edit doc apply-edits dsl-compiler identity
  atomic-write ls skill-manifest`) out of `cli/src/` + the canonical
  `seeds/rewritable.html` + a generated `references/PROVENANCE.txt` (cli
  version from `cli/package.json`, build date). Startup asserts all nine
  files exist — fail loud, not a hollow zip.
- The landing's existing skill section gains the second download with honest
  labels: `/skill.zip` = prompt-only ("teach an agent the format"),
  `/authoring-skill.zip` = executable ("an agent with `node` gets the
  deterministic apply path: new / edit / doc / ls — no npm, no network").
- The `~/.claude/skills/` instance becomes an *install* of the repo source;
  its `VENDORED.md` flow inverts at the next re-vendor (repo is now the
  source of the glue, not the other way around).

## 4. Copy/FAQ refresh (style untouched)

New FAQ entries (same `<details>` pattern): **images** ("drag a photo in — it
lives in the file as compressed data, the model only ever sees a token"),
**skins** (✦, one commit, one ⌘Z), **the ↗ share link** (use the framings
language verbatim: *anyone with the link sees the version you publish — not
your live edits*), **editing from elsewhere** (hosted runtime, capability
URL). Touch the offline FAQ answer to name the five backends (OpenRouter /
Ollama / LM Studio / atomic.chat / bridge). Adopt checkpoint/share vocabulary
where ⌘S is mentioned so the site and the chrome speak the same model
(spec §5.11 / framings doc). Hero and overall voice: unchanged.

## 5. Deployment reality (the part that bites)

The Docker build context is the repo root, but the image only COPYs what the
Dockerfile names. This feature adds three COPY lines (`cli/src/`,
`cli/package.json`, `skills/`, plus `service/templates/` via the existing
`service/` line if placed there — it is, so only the first three are new) and
`scripts/deploy.sh` gains the new paths in `SOURCES`. **The host keeps its
Dockerfile at the top level and the deploy script deliberately does not sync
it** — shipping this requires the documented manual step
(`scp service/Dockerfile root@…:/opt/docker/rewritable/Dockerfile`) before
the rebuild. The build plan makes this an explicit task, not a footnote.

## 6. Explicitly out of scope (v1)

Template search/categories (five cards don't need it); user-submitted
templates; per-template screenshots (preview IS the artifact); reworking the
import showcase; changing hero copy/style; a `rwa template` CLI verb
(downloaded files already feed `rwa new <name>` via the stamped attribute).
