# Landing refresh: template shelf + authoring-skill bundle — build plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the template shelf (`/t/<name>` stamping route + 5 curated rewritables + landing section), the executable skill bundle (`/authoring-skill.zip`), and the v0.15 copy/FAQ refresh — landing style byte-conservative.

**Architecture:** Everything rides existing machinery: `/t/` clones the `/rewritable.html` per-request `UUID_RE` stamp; the zip clones the `/skill.zip` startup `buildStoredZip`; the landing section reuses the existing class system. New repo dirs: `service/templates/` (five committed rewritables) and `skills/authoring-rewritables/` (the upstreamed glue — no `src/` duplication; the zip assembles from `cli/src` at startup).

**Design:** `docs/plans/2026-06-11-landing-templates-skill-design.md` — read it first; it carries the rationale and the v1 template table.

**Tech stack:** zero-dep Node `http` (service), `node:test` + spawn-server harness (`service/tests/hosted.test.mjs` is the template), `rwa` CLI + authoring discipline for template content.

---

### Task 1: Service — `GET /t/<name>` stamping route

**Files:** Test `service/tests/templates.test.mjs` (new); Modify `service/server.js` (template registry near `SEED_TEMPLATE` :28; route beside `/rewritable.html` :1464).

1. Copy the spawn-server harness from `share.test.mjs`. Tests pass `RWA_TEMPLATES_DIR` pointing at a fixture dir holding one minimal valid rewritable (`makeRewritable`-style, with `data-rwa-template="fixture"` on its first body element) and one garbage `.html`.
2. Failing tests: (a) two `GET /t/fixture` responses both 200, both contain exactly one `DOC_UUID` line, and the **two UUIDs differ** (the whole point); (b) `?dl=1` → `Content-Disposition` attachment `fixture.html`; plain → no attachment header (preview); (c) both `Cache-Control: no-store`; (d) `GET /t/nope` → 404; `GET /t/../etc` → 404 (regex gate); (e) the garbage template is **absent** from the registry (startup `validateContainer` skips it with a warn — assert `/t/garbage` 404s while the server log carries the warn); (f) served body still contains `data-rwa-template="fixture"`.
3. Implement: startup registry `Map<name, text>` read from `RWA_TEMPLATES_DIR || service/templates/` (read-once convention; `validateContainer` per file, warn+skip on failure); route apex-only, name regex `/^[a-z0-9-]{1,40}$/`, stamp + headers per design §2.1.
4. Run `node --test service/tests/templates.test.mjs` → green; then the full service suite (share/hosted/vendored) → still green.
5. Commit: `feat(service): GET /t/<name> — fresh-UUID-stamped template downloads` — explicit paths.

### Task 2: The five templates

**Files:** Create `service/templates/{field-notes,deck,budget,kanban,invoice}.html`. Extend `service/tests/templates.test.mjs` with a shipped-set block.

For each (one sub-commit per template is fine):
1. Author per design §2.2. Bootstrap via `rwa new` / `rwa new --kind presentation` (or `node skills' rwa-lite`), then fill content through the normal edit path or careful `INLINE_DOC` authoring. **Real content** (CLAUDE.md: never lorem ipsum): field-notes = a short real photo-essay (2–3 images ingested through the seed's own ladder — open in Chrome, drag images in, ⌘S — so they're properly WebP'd); budget = slim the datatable example to one readable monthly table + summary; kanban = derive from the kanban-skill board seed; invoice = polish `demo/invoice-tracker.html`; deck = upgrade the presentation starter's content.
2. Stamp `data-rwa-template="<name>"` on the first element of the doc body; apply a distinct preset skin via `rwa skin <file> <NAME>` (L0, offline) — five templates, five different skins.
3. Shipped-set tests (loop over `service/templates/*.html`): `validateContainer` passes; contains `data-rwa-template="<filename-stem>"`; expanded body ≤ 1.5 MB; contains a `<style data-rwa-skin>` block; exactly one `DOC_UUID` line.
4. Sanity per file: `node skills/authoring-rewritables/bin/rwa-lite.mjs doc <file> --json` (after Task 3 lands the glue — or use `~/.claude/skills/...` until then) emits `self-description/1` with the right kind.
5. Commit per template or as one: `feat(service): template shelf content — five curated rewritables`.

### Task 3: Upstream the skill glue + `/authoring-skill.zip`

**Files:** Create `skills/authoring-rewritables/{SKILL.md,bin/rwa-lite.mjs,references/edit-contract.md,install.sh}` (copy from `~/.claude/skills/authoring-rewritables/` — these are the glue files only; `VENDORED.md` does NOT come along, the repo is now the source). Modify `service/server.js` (zip assembly beside the `/skill.zip` block :51; route beside :1398). Test `service/tests/authoring-skill-zip.test.mjs` (new).

1. Copy the glue in; write `install.sh`: `#!/bin/sh`, `set -eu`, `DEST="${1:-$HOME/.claude/skills/authoring-rewritables}"`, `mkdir -p`, `cp -R "$(dirname "$0")"/. "$DEST"/, echo`. Mark executable.
2. Failing tests: `GET /authoring-skill.zip` → 200, `application/zip`, attachment filename; unzip in a temp dir (use `node:zlib`-free check: parse central directory names from the buffer, or shell `unzip -l` — the hosted tests shell out already, follow suit) and assert the entry set: `SKILL.md`, `install.sh`, `bin/rwa-lite.mjs`, `references/edit-contract.md`, `references/PROVENANCE.txt`, all nine `src/*.mjs`, `seeds/rewritable.html`; PROVENANCE contains the `cli/package.json` version; two server starts produce **byte-identical** zips (deterministic, same as `/skill.zip`).
3. Implement: startup assembly per design §3.2 — read glue dir + the nine `cli/src` files + root seed + generate PROVENANCE; **assert all nine exist** (throw at boot otherwise); `buildStoredZip`; route.
4. Functional proof: unzip to a temp dir, `sh install.sh /tmp/skill-dest`, then `node /tmp/skill-dest/bin/rwa-lite.mjs new /tmp/t.html && node .../rwa-lite.mjs doc /tmp/t.html --json` → valid. (Manual or scripted in the test — scripted preferred.)
5. Commit: `feat(service,skills): authoring-rewritables upstreamed + /authoring-skill.zip built from source`.

### Task 4: Landing section + FAQ refresh

**Files:** Modify `service/public/landing.html`. Extend `service/tests/templates.test.mjs` (landing block).

1. Failing tests (fetch `/`): contains `id="templates"`; one `.tpl-card` per shipped template with `/t/<name>` and `/t/<name>?dl=1` hrefs; contains `/authoring-skill.zip`; FAQ count grew (assert the four new `<summary>` strings); nav Gallery href is `#templates`; the import-demo link survives.
2. Implement per design §2.3/§3.2-landing/§4. New CSS only `.tpl-grid`/`.tpl-card` composed from existing vars; no new colors/fonts/sizes. FAQ entries + the five-backend touch + checkpoint/share vocabulary where ⌘S appears.
3. Eyeball in a real browser (`node service/server.js`, open `localhost`) — the style bar is "indistinguishable from the rest of the page".
4. Commit: `feat(service): landing — template shelf section + v0.15 FAQ refresh`.

### Task 5: Plumbing — Dockerfile, deploy script, docs

**Files:** `service/Dockerfile` (+3 COPY: `cli/src/`, `cli/package.json`, `skills/`), `scripts/deploy.sh` (`SOURCES` += `cli/src cli/package.json skills service/templates` — note `service/templates` rides only if `service/` isn't already wholesale-synced: it is NOT, sources are explicit — add it), `CLAUDE.md` (service conventions: `/t/` reserved prefix + templates dir + the zip; routing entry for "Templates / template shelf"), `README.md` (one short paragraph in "Getting a fresh file" pointing at the shelf).

1. Make the edits; `DRY_RUN=1 scripts/deploy.sh deploy` to see the itemized list includes the new paths.
2. Commit: `chore(deploy,docs): ship templates + skill bundle in image and deploy set`.

### Task 6: Battery + release + deploy

1. Full service suite + `cd tests && node share.mjs backends.mjs e2e.mjs` (seed untouched in this feature — these pin that) + conformance.
2. REQUIRED SUB-SKILL superpowers:verification-before-completion — real outputs only.
3. Release per house flow if asked (CHANGELOG entry; this is service+content, no cli bump unless `cli/src` changed — it didn't).
4. Deploy — **ordered**: (a) `scp service/Dockerfile root@185.164.4.77:/opt/docker/rewritable/Dockerfile` (the manual INFRA step — the deploy script deliberately never syncs it); (b) `scripts/deploy.sh deploy`; (c) verify: landing shows the shelf, `curl /t/kanban` twice → two different UUIDs, `curl /authoring-skill.zip | unzip -l -` lists 15 entries, import demo still serves.
5. Groupchat announce + memory update (landing refresh shipped; skill glue now repo-sourced — the `~/.claude` copy installs from it).
