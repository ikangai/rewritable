# Webpage → rewritable clone (`rwa clone`) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `rwa clone <url>` — fetch a public webpage, extract its main article + title, sanitize it, and bootstrap a self-contained rewritable. First target: ikangai.com blog posts.

**Architecture:** A new, network-bearing command kept **separate from `rwa import`** (which CLAUDE.md requires to stay offline). Pipeline: `fetch (SSRF-safe) → extract article → sanitize → bootstrap`. The bootstrap reuses the exact import path (`applySeedSubs` + `replaceInlineDoc` + the existing `sanitizeImportedHtml`). v1 does **content-only** cloning — no style extraction — because the seed's baseline typography is already playground.ikangai.com-aligned and the ikangai post body is clean semantic HTML (`p/h2/a/em/code/strong/pre`, verified: zero `<script>`, zero inline `style=`). Style/skin extraction is explicitly v2.

**Tech Stack:** Node ≥18 `fetch` (no new deps), parser-free balanced-tag extraction (same discipline as the seed's INLINE_DOC backtick-walk), Node's built-in `node:test`. Reuses `cli/src/seed.mjs`, `cli/src/commands.mjs`, and `sanitizeImportedHtml` from `cli/src/import.mjs`.

**Scope boundaries (YAGNI):**
- v1 = ikangai/WordPress profile (`.entry-content` + `og:title`) + a generic largest-text-block fallback. No model, no readability dep.
- v1 = CLI only. A browser/service `/clone` needs a server-side fetch proxy (CORS) — deferred.
- v1 = content only. Skin-from-CSS = v2 (ties into the skinning track).
- No auth, no recursion/crawl (single URL), no pagination.

**Grounding facts (captured 2026-06-04 from the live site):**
- ikangai.com is WordPress: article container `<main id="main">` → `<article class="… post">` → `<div class="entry-content">` (appears exactly once per post page).
- Title: `<meta property="og:title" content="…">`.
- Reference post URL: `https://www.ikangai.com/no-orchestration-required-how-parallel-coding-agents-coordinate-through-a-shared-log/`
- Content element histogram: `p:41 a:22 em:22 code:17 h2:8 strong:8 div:6 pre:1`; no scripts, no inline styles.

---

## Task 0: Capture a deterministic test fixture

**Files:**
- Create: `cli/tests/fixtures/ikangai-post.html`

**Step 1:** Fetch the reference post once and save it as a fixture so tests are offline + deterministic (CLAUDE.md: offline-first; tests must not hit network).

Run:
```bash
curl -sS -L --max-time 20 -A "Mozilla/5.0" \
  "https://www.ikangai.com/no-orchestration-required-how-parallel-coding-agents-coordinate-through-a-shared-log/" \
  -o cli/tests/fixtures/ikangai-post.html
```
Expected: a ~94 KB HTML file containing exactly one `class="entry-content"`.

**Step 2:** Verify the fixture.
Run: `grep -c 'class="entry-content"' cli/tests/fixtures/ikangai-post.html`
Expected: `1`

**Step 3: Commit**
```bash
git add cli/tests/fixtures/ikangai-post.html
git commit -m "test(clone): add ikangai blog-post fixture for extraction tests"
```

---

## Task 1: Article extractor (`extractArticle`)

The core new logic. Pure function: HTML string → `{ title, html }`. Parser-free.

**Files:**
- Create: `cli/src/clone-extract.mjs`
- Test: `cli/tests/clone-extract.test.mjs`

**Step 1: Write the failing tests**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractArticle } from '../src/clone-extract.mjs';

const fixture = readFileSync(new URL('./fixtures/ikangai-post.html', import.meta.url), 'utf8');

test('pulls og:title as the title', () => {
  const { title } = extractArticle(fixture);
  assert.match(title, /No Orchestration Required/);
});

test('extracts the entry-content body, not nav/footer', () => {
  const { html } = extractArticle(fixture);
  assert.ok(html.includes('<h2'), 'keeps article headings');
  assert.ok(/<p[\s>]/.test(html), 'keeps paragraphs');
  assert.ok(!/site-header|site-footer|<nav[\s>]/i.test(html), 'drops chrome');
});

test('balanced extraction keeps nested divs intact', () => {
  const { html } = extractArticle(fixture);
  const opens = (html.match(/<div[\s>]/gi) || []).length;
  const closes = (html.match(/<\/div>/gi) || []).length;
  assert.equal(opens, closes, 'nested divs are balanced (no truncation)');
});

test('generic fallback when no known profile matches', () => {
  const html = '<html><body><nav>menu</nav><div class="x"><h1>Hi</h1><p>'
    + 'a'.repeat(400) + '</p></div><footer>f</footer></body></html>';
  const { html: out } = extractArticle(html);
  assert.ok(out.includes('Hi') && out.includes('aaaa'), 'finds the dense block');
  assert.ok(!/menu|footer/.test(out), 'drops thin chrome');
});
```

**Step 2: Run to verify failure**
Run: `node --test cli/tests/clone-extract.test.mjs`
Expected: FAIL — `extractArticle is not a function`.

**Step 3: Implement `cli/src/clone-extract.mjs`**

Implementation notes for the engineer:
- `extractTitle(html)`: prefer `<meta property="og:title" content="…">`, then `<title>…</title>` (strip a trailing `" | Site"` / `" – Site"` suffix), then the first `<h1>`.
- **Site profiles** (ordered): try each profile's container selector; first hit wins.
  - WordPress/ikangai: the element with `class` containing `entry-content`.
  - Generic Article: the first `<article>…</article>`.
- **Balanced extraction** (parser-free): given the opening tag of the chosen container, scan forward counting `<tag` / `</tag>` depth (same byte-walk discipline as the seed's INLINE_DOC backtick locator) and cut at the matching close. This is why regex-only `(<div>)(.*?)(</div>)` is wrong — nested divs (histogram showed `div:6`) would truncate.
- **Generic fallback** (no profile matched): split top-level block elements, pick the subtree with the highest text-length-to-tag-count density, drop `<nav>/<header>/<footer>/<aside>` and elements whose class matches `/nav|menu|sidebar|footer|header|comment|share|related/i`.
- Return `{ title, html }` with `html` being the inner content of the container (the seed wraps it in `<article>` later — Task 3).
- No sanitization here (Task 3 owns it). This module only *locates* content.

**Step 4: Run to verify pass**
Run: `node --test cli/tests/clone-extract.test.mjs`
Expected: PASS (4 tests).

**Step 5: Commit**
```bash
git add cli/src/clone-extract.mjs cli/tests/clone-extract.test.mjs
git commit -m "feat(clone): parser-free article extractor (WP/article profiles + density fallback)"
```

---

## Task 2: SSRF-safe page fetch (`fetchPage`)

Network boundary. The repo already hardened SSRF in the seed bridge (redirect:'error', private-range blocks — see commits 068924a/1c0082c). Mirror that discipline.

**Files:**
- Create: `cli/src/fetch-page.mjs`
- Test: `cli/tests/fetch-page.test.mjs`

**Step 1: Write the failing tests** (unit-level — guards, no real network)
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFetchableUrl } from '../src/fetch-page.mjs';

test('rejects non-http(s) schemes', () => {
  assert.throws(() => assertFetchableUrl('file:///etc/passwd'), /scheme/);
  assert.throws(() => assertFetchableUrl('ftp://host/x'), /scheme/);
});
test('rejects loopback + private + link-local hosts', () => {
  for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.1/',
                   'http://192.168.1.1/', 'http://169.254.169.254/', 'http://[::1]/']) {
    assert.throws(() => assertFetchableUrl(u), /blocked|private|loopback|link-local/i, u);
  }
});
test('allows a normal public https url', () => {
  assert.doesNotThrow(() => assertFetchableUrl('https://www.ikangai.com/some-post/'));
});
```

**Step 2: Run to verify failure**
Run: `node --test cli/tests/fetch-page.test.mjs`
Expected: FAIL — `assertFetchableUrl is not a function`.

**Step 3: Implement `cli/src/fetch-page.mjs`**

- `assertFetchableUrl(url)`: parse with `new URL`; require `http:`/`https:`; reject hostnames that are `localhost`, resolve-literal loopback/private/link-local IPv4 (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `0.0.0.0`) and IPv6 (`::1`, `fc00::/7`, `fe80::/10`). For hostnames (not IP literals), also resolve via `node:dns/promises` `lookup({all:true})` and re-check every resolved address (DNS-rebinding defence).
- `fetchPage(url, {maxBytes=3_000_000, timeoutMs=15000})`: `assertFetchableUrl`; `fetch(url, {redirect:'manual', signal})`; on a 3xx, read `location`, `assertFetchableUrl` the resolved target, and follow manually (cap 5 hops, re-validating each) — never blind `redirect:'follow'`. Require `content-type` to include `text/html`. Stream-cap to `maxBytes`. Send a real `User-Agent`. Return the HTML string.
- Throw `CloneError` (small class with `exitCode`/`subcode`, mirroring `edit.mjs` `CliError`): subcodes `bad_scheme`, `blocked_host`, `too_many_redirects`, `not_html`, `too_large`, `fetch_failed`, `http_error` (carry status).

**Step 4: Run to verify pass**
Run: `node --test cli/tests/fetch-page.test.mjs`
Expected: PASS (3 tests).

**Step 5: Commit**
```bash
git add cli/src/fetch-page.mjs cli/tests/fetch-page.test.mjs
git commit -m "feat(clone): SSRF-safe page fetch (scheme + private-range + rebinding guards, manual redirects)"
```

---

## Task 3: Wire `cloneCmd` + export the sanitizer

**Files:**
- Modify: `cli/src/import.mjs` (export `sanitizeImportedHtml`)
- Create: `cli/src/clone.mjs` (the `cloneCmd`)
- Test: `cli/tests/clone.test.mjs`

**Step 1: Write the failing end-to-end test** (offline — feed the fixture, stub the fetch)
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { cloneFromHtml } from '../src/clone.mjs';
import { inspectDoc } from '../src/doc.mjs';

const fixture = readFileSync(new URL('./fixtures/ikangai-post.html', import.meta.url), 'utf8');

test('cloneFromHtml produces a valid rewritable with the post title + content', async () => {
  const out = '/tmp/clone-test-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'https://www.ikangai.com/post/');
  const info = await inspectDoc(out);
  assert.equal(info.self.kind, 'document');
  assert.match(info.self.title, /No Orchestration Required/);
  assert.ok(info.doc.includes('<article'), 'wraps content in an article');
  assert.ok(!/<script[\s>]/i.test(info.doc), 'no scripts survive into the body');
  rmSync(out, { force: true });
});
```
(`cloneFromHtml(html, outPath, sourceUrl)` is the offline core; `cloneCmd` = `fetchPage` + `cloneFromHtml`. Splitting keeps the network out of the test.)

**Step 2: Run to verify failure**
Run: `node --test cli/tests/clone.test.mjs`
Expected: FAIL — `cloneFromHtml is not a function`.

**Step 3: Implement**
- In `import.mjs`, change `function sanitizeImportedHtml` → `export function sanitizeImportedHtml` (no behaviour change; it already strips scripts + unsafe attrs/URLs).
- `cli/src/clone.mjs`:
  - `cloneFromHtml(html, outPath, sourceUrl)`: `extractArticle(html)` → `sanitizeImportedHtml(content)` → wrap as `` `<article>\n${clean}\n</article>` `` → `loadSeed(SEED_CANDIDATES)` → `applySeedSubs(seed,{uuid:crypto.randomUUID(), title, fileMeta:basename(outPath)})` → `replaceInlineDoc(...)` → `atomicWrite(outPath, …)`. Append a `<p>` provenance footer linking `sourceUrl` (cloned-from line). Reuse `SEED_CANDIDATES` from `commands.mjs`.
  - `cloneCmd({url, outPath, force})`: `fetchPage(url)` then `cloneFromHtml`, default `outPath` from the URL slug, `ensureWritable`.

**Step 4: Run to verify pass**
Run: `node --test cli/tests/clone.test.mjs`
Expected: PASS.

**Step 5: Commit**
```bash
git add cli/src/clone.mjs cli/src/import.mjs cli/tests/clone.test.mjs
git commit -m "feat(clone): cloneFromHtml — extract+sanitize+bootstrap into a rewritable"
```

---

## Task 4: CLI dispatch + help + README

**Files:**
- Modify: `cli/bin/rwa.mjs` (add the `clone` verb + HELP entry; mirror `import`'s flag handling)
- Modify: `cli/README.md` (document `rwa clone <url>`)

**Step 1:** Add a `if (verb === 'clone') { … }` branch: parse positional `url` + optional `outPath`, `--force`; `await import('../src/clone.mjs')`; on `CloneError` emit `code/subcode` to stderr and set `process.exitCode` (mirror the `edit` failure surface + exit-code map). Add a `clone` line to `HELP`.

**Step 2: Manual acceptance (real network, once)**
Run:
```bash
node cli/bin/rwa.mjs clone "https://www.ikangai.com/no-orchestration-required-how-parallel-coding-agents-coordinate-through-a-shared-log/" /tmp/cloned.html
node cli/bin/rwa.mjs doc /tmp/cloned.html --json | head -c 400
```
Expected: `wrote /tmp/cloned.html`; JSON shows `kind:"document"`, the real title, `rewritable:true`.

**Step 3:** Verify render (per `authoring-rewritables` skill: NOT a one-shot headless screenshot — IDB hydration won't have settled). Use the standalone-body render trick or open in a real browser. Confirm the post reads cleanly on the ikangai-aligned baseline.

**Step 4: Commit**
```bash
git add cli/bin/rwa.mjs cli/README.md
git commit -m "feat(clone): wire 'rwa clone <url>' CLI verb + docs"
```

---

## Task 5: Full suite + done

**Step 1:** Run the whole CLI test suite to confirm no regression.
Run: `cd cli && npm test`
Expected: all green, including the 3 new test files.

**Step 2:** Update `cli/README.md` and the repo `CLAUDE.md` CLI-conventions note (one line: `rwa clone <url>` is the network-bearing sibling of `import`; import stays offline).

**Step 3: Commit**
```bash
git add cli/README.md CLAUDE.md
git commit -m "docs(clone): note rwa clone in README + CLAUDE.md conventions"
```

---

## Out of scope (explicit follow-ups)
- **v2 skin extraction** — derive a `data-rwa-skin` block from the source page's CSS (ties into the skinning track). v1 leans on the ikangai-aligned baseline.
- **Generic readability** — beyond WP/`<article>` + density fallback (e.g. Readability-grade extraction) if non-ikangai sites become a real target.
- **Web/service `/clone`** — needs a server-side fetch proxy (browser CORS blocks cross-origin fetch).
- **Images** — v1 keeps `<img src>` as absolute URLs (online-referenced); inlining as data URIs / OPFS is a follow-up if offline-faithful clones are wanted.
