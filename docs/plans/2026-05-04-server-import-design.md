# Server-side `/import` endpoint — design

**Date:** 2026-05-04
**Status:** shipped 2026-05-04 (md), 2026-05-04 (csv), 2026-05-08 (docx + pdf)
**Scope:** Add `/import` to the `service/` HTTP server, mirroring the CLI's `rwa import` for markdown only. HTML and TXT are deferred; CSV is a planned follow-up after TXT.

## Goal

Today, `rewritable.ikangai.com/new` hands out fresh empty containers. Users with existing markdown notes either install the CLI (`npm i -g rwa` then `rwa import notes.md`) or paste content into a fresh container after the fact. We want a browser-only path: visit `/import`, pick a `.md` file, get back a re-writeable container with the markdown rendered into `INLINE_DOC`.

## Architecture

`/import` is a sibling endpoint to `/new`. The service stays zero-dependency Node `http`; **all conversion happens in the browser**. The server's only new responsibility is serving a static page.

### Endpoints

| Route | Method | Returns | Notes |
|---|---|---|---|
| `/import` | GET / HEAD | `service/public/import.html` (static) | New |
| `/rewritable.html` | GET / HEAD | seed bytes with fresh `DOC_UUID` | **Reused** — same endpoint `/new` already uses |
| `/new` | GET / HEAD | `service/public/new.html` | Modified to add an `<a href="/import">` link |

No multipart parsing, no upload size limits, no `marked` dependency on the server.

### End-to-end flow

```
user → GET /import → import.html loads
     → user drops/picks notes.md
     → page validates extension (.md / .markdown)
     → page fetches /rewritable.html (seed with fresh DOC_UUID baked in)
     → page runs marked.parse(text, { gfm: true, breaks: false })
     → page derives title + FILE meta from filename
     → page substitutes <title> and FILE: in the seed
     → page splices converted HTML into INLINE_DOC slot
     → page builds Blob, triggers <a download="notes.html"> click
     → done — file lives only on the user's machine
```

The DOC_UUID arrives pre-substituted from the server (existing `/rewritable.html` behavior), so the client only handles three substitutions: `<title>`, `FILE:`, and the `INLINE_DOC` body.

### Why client-side conversion

- Matches the project's spirit: offline-first, the container itself is the runtime, the server is dumb.
- Keeps the service zero-dependency. No `marked`, no multipart parser, no body-size limits.
- Files never transit the server.
- The duplication (third copy of the splice logic) is small — ~30 lines, plus the existing CLAUDE.md mirror clause is extended to cover it.

## Server changes (`service/server.js`)

Six lines added:

```js
const IMPORT_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'import.html'));

// inside the dispatcher, after the /new branch:
if (url === '/import') {
  return send(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  }, IMPORT_HTML);
}
```

The existing `Dockerfile` already `COPY`s `service/public/`, so `import.html` ships automatically. The `isHead` closure on the dispatcher means HEAD support is free.

## `service/public/new.html` change

Add a single anchor under the existing `<p>`:

```html
<p style="margin-top:1rem"><a href="/import">import an existing markdown file instead</a></p>
```

`import.html` carries a symmetric link back: `<a href="/new">start with a blank container</a>`.

## `service/public/import.html`

Single static page, ~150 lines including dark-theme styling consistent with the rest of the project.

### Layout

- `<h1>` heading
- A drop zone (`<div id="drop">`) that accepts drag-drop and contains a `<label for="picker">` triggering a hidden `<input id="picker" type="file" accept=".md,.markdown,text/markdown">`.
- A `<p id="status">` for messages (idle / converting / success / error).
- A back-link to `/new`.
- A pinned `marked` script tag (see below) and an inline conversion script.

### `marked` loading

Pinned to **the same version `cli/package.json` resolves** (currently `marked@14.1.4`) with SRI. Aligning versions matters: the byte-equivalence guarantee between `rwa import` and the browser flow holds only if both run the same `marked` build. When the CLI's `marked` dep is bumped, bump `import.html` together and recompute the SRI.

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/14.1.4/marked.min.js"
        integrity="sha512-oUb+v+OGnC4ls/U+74UExKiWPxg/0M1AW6WGR94XFExsapAwqFRWwG1uds2YO/k38mAaai62SKhsMQHbIYX5Rw=="
        crossorigin="anonymous"></script>
```

To recompute SRI on a version bump:
```sh
curl -sL https://cdnjs.cloudflare.com/ajax/libs/marked/<ver>/marked.min.js | openssl dgst -sha512 -binary | openssl base64 -A
```

Pinning over floating: a CDN compromise on a floating reference would ship malicious JS into every freshly imported container. SRI plus a pinned version means we eat CVE updates on our schedule but are not exposed to silent supply-chain attacks.

### Ported helpers (from `cli/src/`)

The conversion script ports three things from the CLI, with a header comment marking each as a port:

```js
// PORTED FROM cli/src/seed.mjs and cli/src/commands.mjs — keep in sync.
// The CLI is the source of truth for the splice algorithm.
```

1. **`titleFromBasename(name)`** — verbatim from `commands.mjs:29-36`.
2. **`applyTitleAndFileSubs(seed, { title, fileMeta })`** — TITLE_RE and FILE_RE branches of `applySeedSubs`, with the same exactly-one-match guard. Skips DOC_UUID (server already substituted it). Includes `escapeHtml` and `escapeJsString` ports.
3. **`replaceInlineDoc(seed, html)`** — the backtick-walk verbatim from `seed.mjs:49-61`, with the `escapeTL` LF-canonicalization mirror.

### Conversion handler

```js
async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'md' && ext !== 'markdown') {
    return showError(`unsupported format: .${ext} (only .md / .markdown)`);
  }
  setStatus('converting…');
  const text = await file.text();
  if (!text.trim()) return showError('file is empty');
  const html = `<article>\n${marked.parse(text, { gfm: true, breaks: false }).trim()}\n</article>`;
  const seedRes = await fetch('/rewritable.html', { cache: 'no-store' });
  if (!seedRes.ok) return showError(`could not fetch seed (${seedRes.status})`);
  const seed = await seedRes.text();
  const baseName = file.name.replace(/\.(md|markdown)$/i, '');
  const outName = `${baseName}.html`;
  const title = titleFromBasename(baseName);
  const subbed = applyTitleAndFileSubs(seed, { title, fileMeta: outName });
  const result = replaceInlineDoc(subbed, html);
  triggerDownload(new Blob([result], { type: 'text/html' }), outName);
  setStatus(`downloaded ${outName}`);
}
```

Drag/drop wiring: `dragover` (preventDefault) and `drop` on `#drop` call `handleFile(e.dataTransfer.files[0])`. The `<label>` opens the native picker without extra JS.

## Error surfaces

| Failure | Where caught | UX |
|---|---|---|
| Extension not `.md`/`.markdown` | client | red status: `unsupported format: .X (only .md / .markdown)` |
| `marked` failed to load (CDN blocked, offline) | `<script onerror>` | red banner, drop zone disabled |
| `marked.parse` throws | try/catch in handler | red status with thrown message |
| `/rewritable.html` non-2xx | client | red status: `could not fetch seed (<status>)` |
| Seed missing INLINE_DOC marker (regression) | `replaceInlineDoc` throws | red status with thrown message |
| TITLE_RE / FILE_RE not exactly-one (seed regression) | `applyTitleAndFileSubs` throws | red status with thrown message |
| Empty file | client | red status: `file is empty` |

The exactly-one-match guards aren't theoretical — the CLI's `applySeedSubs` already enforces them because a silently-skipped substitution would ship partially-substituted containers. Same risk in the browser, same defense.

## CLAUDE.md update

Add a sentence to the CLI conventions section so the existing mirror clause covers the new file:

> The CLI mirrors three pieces of bootstrap-side logic: `escapeTL` (the template-literal escape), the INLINE_DOC backtick-walk, and the DOC_UUID substitution regex. If any of those change in `seeds/rewritable.html`, mirror the change in `cli/src/seed.mjs` **and `service/public/import.html`** (which ports the same logic for the browser-side import flow).

## Test strategy

The service has no automated test harness today. We won't introduce one for six lines of route plumbing. The check list is:

**Server (manual curl):**
- `GET /import` → 200, `text/html`, body contains `<input type="file"`.
- `HEAD /import` → 200, no body.
- `/new`, `/rewritable.html`, `/health`, and `/` redirect remain unaffected.

**Client (manual, in browser):**
1. Drop a small `notes.md` → download fires, filename is `notes.html`, opening it shows a rendered `<article>`.
2. "Choose one" path → same result.
3. Open the downloaded `.html` in Chromium → ⌘K reaches the agent, ⌘S writes back. **Load-bearing**: proves the bootstrap is intact.
4. Diff against `rwa import` of the same file — byte-identical except `DOC_UUID`.
5. Drop a `.txt` → red error, no download.
6. Drop an empty `.md` → red error.
7. Drop an `.md` containing literal `` ` ``, `${`, `</script`, `\\` → opens cleanly (escapeTL parity).
8. Throttle network in DevTools, block cdnjs → `marked failed to load` surfaces.
9. iOS Safari: tap "choose one" → native picker opens. Drag-drop is desktop-only; the click path must work on mobile.

Test #4 (CLI/server byte-equality) is the most valuable to automate eventually — a small jsdom test that drives the page with a stub `File` and diffs the output against `rwa import`. Worth a follow-up, not a blocker for shipping.

## Rollout

Single-binary Docker deploy. No migrations, no env vars, no config changes. Build → push → restart. Rollback = previous image. Risk profile: `/import` is a strict addition (no users depend on it yet); a broken `/import` does not affect `/new`.

## Known limitations

- **MD with embedded raw HTML passes through to the container.** `marked` doesn't sanitize by default, and the CLI's MD path doesn't sanitize either. If a user imports markdown containing `<script>`, those scripts run when the container opens. Consistent with the CLI's behavior; do not add sanitization here without a separate discussion that changes CLI semantics too.
- **Splice logic is now in three places**: `seeds/rewritable.html` (escapeTL for ⌘S), `cli/src/seed.mjs` (full splice), `service/public/import.html` (full splice). The CLAUDE.md update above keeps them aligned.
- **CSP precedent**: introducing cdnjs to the service constrains future CSP design (`script-src 'self' https://cdnjs.cloudflare.com` plus inline allowance). Acceptable but flagged.

## Future work (not in this change)

- **TXT import** — `convertTxt` from `cli/src/import.mjs:57-65` is trivially portable; same `/import` page, extend the accept list and the dispatch switch.
- **CSV import** — new ground (the CLI does not support it). Open question: render as `<table>`, or as something richer? Out of scope here, queued for after TXT.
- **HTML import** — last to land. The CLI prints a stderr `<script>`-tag warning; in the browser flow that warning has to be a visible UI element before the download fires.
- **Automated jsdom test** that diffs `/import` browser output against `rwa import` CLI output for a fixture set.

## Decisions log

| # | Decision | Why |
|---|---|---|
| 1 | Client-side conversion (vs server-side or hybrid) | Matches project ethos, keeps server zero-dep, files don't transit server |
| 2 | Drop zone + button page (vs auto-pop picker) | Programmatic file pickers without a user gesture are unreliable; landing page also gives space for errors and a back-link |
| 3 | Markdown only for v1 | HTML carries a script-tag foot-gun; TXT trivial; ship narrow first |
| 4 | Pin `marked` to the version `cli/package.json` resolves (currently 14.1.4) + SRI | Avoid silent supply-chain compromise via CDN; aligning with the CLI keeps `rwa import` ↔ `/import` byte-equivalent |
| 5 | Cross-link `/new` ↔ `/import` | Discoverability for both paths |
| 6 | Update CLAUDE.md mirror clause as part of this change | Convention should land before its first divergence opportunity |
