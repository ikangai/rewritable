# CLI Templates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `rwa new <name>` where `<name>` is a user-defined template — the CLI scans cwd for a re-writeable whose first child element of `#rwa-doc-mount` carries `data-rwa-template="<name>"` and clones it (pristine seed + template's `INLINE_DOC`, fresh UUID, label stripped on the new file).

**Architecture:** A small `cli/src/template.mjs` exports `findTemplate(dir, name)` and `stripTemplateAttribute(html)`. `newCmd` (`cli/src/commands.mjs`) grows an optional `templateName`; when set, it calls `findTemplate`, strips the label, and feeds the body through the existing `applySeedSubs` + `replaceInlineDoc` pipeline. `cli/bin/rwa.mjs` argv parser disambiguates the first positional: path-like (`.html` or contains `/`) → `outPath`; otherwise → `templateName`. `--kind` (built-in scaffold) and positional `<templateName>` are mutually exclusive. `data-rwa-template` lands on the reserved-attribute list across spec / runtime / agent prompt.

**Tech Stack:** Node ≥18, `node:test`. No new npm deps. Reference design: `docs/plans/2026-05-05-cli-templates-design.md`.

---

## Drift reconciliation (design 2026-05-05 → codebase 2026-05-25)

The May 5 design predates today's `--kind` flag. Three concrete reconciliations the original design did not address:

1. **Positional vs `--kind` collision.** Design's positional `<kind>` meant a user-template name (e.g. `invoice`). Today `--kind <name>` already exists for built-in scaffolds (`document`, `workflow`). **Resolution:** keep them orthogonal. Positional `<name>` always means user-template lookup; `--kind` always means built-in scaffold. Providing both in one call is an error. To get the built-in `workflow` scaffold the user keeps writing `rwa new --kind workflow`; to clone a labeled `data-rwa-template="workflow"` file they write `rwa new workflow`.

2. **Tests directory.** Design wrote `cli/test/`. The CLI's actual tests live at `cli/tests/` (plural) with multiple `*.test.mjs` files. Use the existing dir.

3. **`extractInlineDoc` export.** Design said "export it if not already exported." It is already exported from `cli/src/seed.mjs:1342`. Just import it.

Everything else in the design holds: cwd-only non-recursive scan, glob `*.html`, cap 200 candidates, `id="rwa-bootstrap"` string pre-check, regex match `data-rwa-template="…"` on the first opening tag inside `INLINE_DOC`, most-recent-mtime on multi-match, hard error on no-match, default output filename `./<name>-YYYY-MM-DD.html`.

---

## Pre-flight

1. **Read the design** at `docs/plans/2026-05-05-cli-templates-design.md`. The plan below assumes its decisions on label location, discovery rules, and clone order.

2. **Verify baseline tests pass:**
   ```
   cd cli && node --test tests/*.test.mjs 2>&1 | tail -5
   ```
   Expected: all suites green. If anything is red on `main`, stop and surface before starting Task 1.

3. **Confirm seed.mjs exports** the helpers this plan reuses:
   ```
   grep -nE "^export (async )?function (loadSeed|applySeedSubs|replaceInlineDoc|extractInlineDoc)" cli/src/seed.mjs
   ```
   Expected: four hits (`loadSeed`, `applySeedSubs`, `replaceInlineDoc`, `extractInlineDoc`).

4. **Worktree decision.** The existing `.worktrees/cli-templates` branch is stale (no template-feature commits, behind `main` by 100+ commits). Do **not** use it. Either work on `main` directly (small feature, ~6 tasks) or create a fresh worktree from `main` via `superpowers:using-git-worktrees`. Leave the stale branch alone for now.

5. **No spec version bump needed mid-task.** The spec change (Task 5) lands at the end so each task's tests are independent.

---

## Task 1: `stripTemplateAttribute` helper

**Files:**
- Create: `cli/src/template.mjs`
- Create: `cli/tests/template.test.mjs`

**Step 1.1 — Write the failing tests:**

```javascript
// cli/tests/template.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTemplateAttribute } from '../src/template.mjs';

test('stripTemplateAttribute: double-quoted attr alongside other attrs', () => {
  const html = '<article data-rwa-template="invoice" class="rwa">body</article>';
  assert.equal(stripTemplateAttribute(html), '<article class="rwa">body</article>');
});

test('stripTemplateAttribute: single-quoted value', () => {
  const html = "<article data-rwa-template='recipe'>body</article>";
  assert.equal(stripTemplateAttribute(html), '<article>body</article>');
});

test('stripTemplateAttribute: attribute is the only one on the tag', () => {
  const html = '<article data-rwa-template="x">body</article>';
  assert.equal(stripTemplateAttribute(html), '<article>body</article>');
});

test('stripTemplateAttribute: no-op when attribute absent', () => {
  const html = '<article class="rwa">body</article>';
  assert.equal(stripTemplateAttribute(html), html);
});

test('stripTemplateAttribute: only touches the first opening tag', () => {
  const html = '<article data-rwa-template="a">x</article><p data-rwa-template="b">y</p>';
  assert.equal(stripTemplateAttribute(html), '<article>x</article><p data-rwa-template="b">y</p>');
});

test('stripTemplateAttribute: leading whitespace before first tag is preserved', () => {
  const html = '\n  <article data-rwa-template="k">body</article>';
  assert.equal(stripTemplateAttribute(html), '\n  <article>body</article>');
});
```

**Step 1.2 — Run, expect failure:**

```
cd cli && node --test tests/template.test.mjs
```
Expected: `Cannot find module '../src/template.mjs'`.

**Step 1.3 — Minimal implementation:**

```javascript
// cli/src/template.mjs
//
// CLI-only helpers for user-declared templates: scan cwd for a file whose
// INLINE_DOC root carries data-rwa-template="<name>", clone its body into a
// fresh seed. Per docs/plans/2026-05-05-cli-templates-design.md and the
// 2026-05-25 reconciliation plan.

// Strip `data-rwa-template="..."` (or single-quoted) from the FIRST opening
// tag in `html`. Leaves the rest of the document untouched. No-op when the
// attribute is absent. The label is author-managed, single-location-per-file
// (first child of #rwa-doc-mount), so only the first tag needs cleaning.
export function stripTemplateAttribute(html) {
  return html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9]*)([^>]*)(>)/, (m, open, attrs, close) => {
    const cleaned = attrs.replace(/\s+data-rwa-template\s*=\s*("[^"]*"|'[^']*')/i, '');
    return `${open}${cleaned}${close}`;
  });
}
```

**Step 1.4 — Run, expect pass:**

```
cd cli && node --test tests/template.test.mjs
```
Expected: 6/6 tests pass.

**Step 1.5 — Commit:**

```
git add cli/src/template.mjs cli/tests/template.test.mjs
git commit -m "feat(cli): stripTemplateAttribute helper for template cloning"
```

---

## Task 2: `findTemplate(dir, name)`

**Files:**
- Modify: `cli/src/template.mjs` (add `findTemplate`)
- Modify: `cli/tests/template.test.mjs` (extend with fixture-based tests)

**Step 2.1 — Write the failing tests:**

Add to `cli/tests/template.test.mjs`:

```javascript
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findTemplate } from '../src/template.mjs';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'rwa-tpl-'));
}

// Minimal rwa-shaped file: contains the `id="rwa-bootstrap"` pre-check string
// and an INLINE_DOC backtick-walk that extractInlineDoc can parse.
function fakeRwa(bodyHtml) {
  return [
    '<!DOCTYPE html><html><body>',
    '<div id="rwa-doc-mount"></div>',
    '<script id="rwa-bootstrap">',
    'const INLINE_DOC = `' + bodyHtml.replace(/`/g, '\\`') + '`;',
    '</script>',
    '</body></html>',
  ].join('\n');
}

test('findTemplate: returns null when no labeled file exists', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'plain.html'), fakeRwa('<article>nope</article>'));
  const r = await findTemplate(dir, 'invoice');
  assert.equal(r, null);
});

test('findTemplate: matches a single labeled file', async () => {
  const dir = await tmpDir();
  await fs.writeFile(
    path.join(dir, 'invoice.html'),
    fakeRwa('<article data-rwa-template="invoice"><h1>Invoice</h1></article>')
  );
  const r = await findTemplate(dir, 'invoice');
  assert.ok(r);
  assert.equal(path.basename(r.path), 'invoice.html');
  assert.match(r.inlineDoc, /data-rwa-template="invoice"/);
});

test('findTemplate: most-recent mtime wins on multi-match', async () => {
  const dir = await tmpDir();
  const older = path.join(dir, 'a.html');
  const newer = path.join(dir, 'b.html');
  await fs.writeFile(older, fakeRwa('<article data-rwa-template="x">old</article>'));
  await fs.writeFile(newer, fakeRwa('<article data-rwa-template="x">new</article>'));
  // Force older mtime backwards by 60s so the comparison is unambiguous.
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(older, past, past);
  const r = await findTemplate(dir, 'x');
  assert.equal(path.basename(r.path), 'b.html');
});

test('findTemplate: ignores files lacking the rwa-bootstrap marker', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'not-rwa.html'), '<html><body>random html</body></html>');
  await fs.writeFile(
    path.join(dir, 'real.html'),
    fakeRwa('<article data-rwa-template="x">ok</article>')
  );
  const r = await findTemplate(dir, 'x');
  assert.equal(path.basename(r.path), 'real.html');
});

test('findTemplate: skips files with corrupted INLINE_DOC backticks but keeps scanning', async () => {
  const dir = await tmpDir();
  // No closing backtick in INLINE_DOC.
  await fs.writeFile(
    path.join(dir, 'broken.html'),
    '<script id="rwa-bootstrap">const INLINE_DOC = `<article data-rwa-template="x">unterminated'
  );
  await fs.writeFile(
    path.join(dir, 'good.html'),
    fakeRwa('<article data-rwa-template="x">ok</article>')
  );
  const r = await findTemplate(dir, 'x');
  assert.equal(path.basename(r.path), 'good.html');
});

test('findTemplate: looks only at the first opening tag of INLINE_DOC', async () => {
  const dir = await tmpDir();
  // Label is on a SECOND element; should not count as a match.
  await fs.writeFile(
    path.join(dir, 'misplaced.html'),
    fakeRwa('<article><p data-rwa-template="x">misplaced</p></article>')
  );
  const r = await findTemplate(dir, 'x');
  assert.equal(r, null);
});
```

**Step 2.2 — Run, expect failure:**

```
cd cli && node --test tests/template.test.mjs
```
Expected: failures on `findTemplate is not a function`.

**Step 2.3 — Implementation:**

Append to `cli/src/template.mjs`:

```javascript
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractInlineDoc } from './seed.mjs';

const MAX_CANDIDATES = 200;

// Look in `dir` (non-recursive) for an rwa file whose INLINE_DOC's first
// opening tag carries `data-rwa-template="<name>"`. Returns
// `{ path, inlineDoc, mtimeMs }` on match, `null` on no-match. On multi-match,
// most-recent mtime wins. Malformed candidates (corrupted INLINE_DOC) are
// skipped rather than failing the whole call — one bad file in cwd should not
// block a legitimate template lookup.
export async function findTemplate(dir, name) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const htmlFiles = entries
    .filter(e => e.isFile() && /\.html?$/i.test(e.name))
    .map(e => path.join(dir, e.name));
  if (htmlFiles.length > MAX_CANDIDATES) {
    const e = new Error(`too many .html files in ${dir} (${htmlFiles.length} > ${MAX_CANDIDATES})`);
    e.exitCode = 2;
    throw e;
  }

  // Regex against the first opening tag inside INLINE_DOC.
  const attrRe = new RegExp(
    `^\\s*<[a-zA-Z][a-zA-Z0-9]*[^>]*\\sdata-rwa-template\\s*=\\s*("${escapeAttrValue(name)}"|'${escapeAttrValue(name)}')[\\s>]`
  );

  const matches = [];
  for (const file of htmlFiles) {
    let bytes;
    try {
      bytes = await fs.readFile(file, 'utf8');
    } catch (_) { continue; }
    if (!bytes.includes('id="rwa-bootstrap"')) continue;
    let inlineDoc;
    try {
      inlineDoc = extractInlineDoc(bytes);
    } catch (_) { continue; }
    if (typeof inlineDoc !== 'string') continue;
    if (!attrRe.test(inlineDoc)) continue;
    let mtimeMs = 0;
    try {
      const st = await fs.stat(file);
      mtimeMs = st.mtimeMs;
    } catch (_) { /* keep mtimeMs=0 */ }
    matches.push({ path: file, inlineDoc, mtimeMs });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0];
}

function escapeAttrValue(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

**Step 2.4 — Run, expect pass:**

```
cd cli && node --test tests/template.test.mjs
```
Expected: all 12 tests pass (6 strip + 6 find).

**Step 2.5 — Commit:**

```
git add cli/src/template.mjs cli/tests/template.test.mjs
git commit -m "feat(cli): findTemplate scans cwd for data-rwa-template label"
```

---

## Task 3: Wire `newCmd` to the template path

**Files:**
- Modify: `cli/src/commands.mjs:135-167` (`newCmd`)
- Create: `cli/tests/new-template.test.mjs`

**Step 3.1 — Write the failing test:**

```javascript
// cli/tests/new-template.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newCmd } from '../src/commands.mjs';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'rwa-newt-'));
}

test('newCmd with templateName clones the labeled file with label stripped + fresh UUID', async () => {
  const dir = await tmpDir();
  // Make a "template" by running newCmd once and hand-injecting the label.
  await newCmd({ outPath: path.join(dir, 'invoice-template.html') });
  const tplPath = path.join(dir, 'invoice-template.html');
  let tpl = await fs.readFile(tplPath, 'utf8');
  // Insert label onto the first <article> tag inside INLINE_DOC.
  tpl = tpl.replace('<article>', '<article data-rwa-template="invoice">');
  await fs.writeFile(tplPath, tpl);

  // Now clone it.
  const outPath = path.join(dir, 'new-invoice.html');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await newCmd({ outPath, templateName: 'invoice' });
  } finally {
    process.chdir(cwd);
  }

  const result = await fs.readFile(outPath, 'utf8');
  // Label stripped on the new file.
  assert.ok(!result.includes('data-rwa-template'), 'data-rwa-template should be stripped');
  // Fresh UUID — different from the template's.
  const tplUuid = tpl.match(/const DOC_UUID = '([^']+)'/)[1];
  const newUuid = result.match(/const DOC_UUID = '([^']+)'/)[1];
  assert.notEqual(newUuid, tplUuid, 'new file must have a fresh DOC_UUID');
});

test('newCmd with templateName errors when no match in cwd', async () => {
  const dir = await tmpDir();
  const cwd = process.cwd();
  process.chdir(dir);
  let err;
  try {
    await newCmd({ outPath: path.join(dir, 'out.html'), templateName: 'nonexistent' });
  } catch (e) {
    err = e;
  } finally {
    process.chdir(cwd);
  }
  assert.ok(err, 'should throw');
  assert.equal(err.exitCode, 2);
  assert.match(err.message, /no rwa file in .* is labeled `nonexistent`/);
});
```

**Step 3.2 — Run, expect failure.**

**Step 3.3 — Implementation.** Modify `newCmd` in `cli/src/commands.mjs`:

```javascript
import { findTemplate, stripTemplateAttribute } from './template.mjs';

export async function newCmd({ outPath, force, open, kind, templateName }) {
  if (templateName && kind) {
    const e = new Error('--kind and a positional template name are mutually exclusive');
    e.exitCode = 2;
    throw e;
  }
  const out = path.resolve(outPath || defaultOutPath(templateName));
  await ensureWritable(out, force);
  const seed = await loadSeed(SEED_CANDIDATES);
  const fileMeta = path.basename(out);
  const title = titleFromBasename(path.basename(out, path.extname(out)));

  if (templateName) {
    const match = await findTemplate(process.cwd(), templateName);
    if (!match) {
      const e = new Error(
        `no rwa file in ${rel(process.cwd())}/ is labeled \`${templateName}\`. ` +
        `Mark a doc as the template by adding data-rwa-template="${templateName}" to its root element.`
      );
      e.exitCode = 2;
      throw e;
    }
    console.error(`note: using ${rel(match.path)} as template`);
    // Order: pristine seed subs first, then INLINE_DOC swap — same as importCmd.
    const subbed = applySeedSubs(seed, {
      uuid: crypto.randomUUID(),
      title,
      fileMeta,
    });
    const cleanedBody = stripTemplateAttribute(match.inlineDoc);
    const result = replaceInlineDoc(subbed, cleanedBody);
    await fs.writeFile(out, result, 'utf8');
    console.log(`wrote ${rel(out)} (template: ${templateName})`);
  } else {
    // Existing built-in / blank path (unchanged).
    const resolvedKind = kind || 'document';
    const overrides = kindOverrides(resolvedKind);
    let result = applySeedSubs(seed, {
      uuid: crypto.randomUUID(),
      title,
      fileMeta,
      lensPlaceholder:    overrides.lensPlaceholder,
      palPlaceholder:     overrides.palPlaceholder,
      productHeader:      overrides.productHeader,
      productKind:        resolvedKind,
      lensClickToAnchor:  overrides.lensClickToAnchor,
    });
    if (overrides.body != null) result = replaceInlineDoc(result, overrides.body);
    await fs.writeFile(out, result, 'utf8');
    console.log(`wrote ${rel(out)}${kind && kind !== 'document' ? ` (kind: ${kind})` : ''}`);
  }

  if (open) {
    const prefill = await collectPrefill();
    if (prefill.key) console.error('note: passing OPENROUTER_API_KEY via ?key= URL parameter');
    if (prefill.backend) console.error(`note: passing RWA_BACKEND=${prefill.backend} via ?backend= URL parameter`);
    if (prefill.model) console.error(`note: passing RWA_MODEL=${prefill.model} via ?model= URL parameter`);
    openFile(out, prefill);
  }
}

function defaultOutPath(templateName) {
  if (!templateName) return './rewritable.html';
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `./${templateName}-${iso}.html`;
}
```

**Step 3.4 — Run, expect pass.**

**Step 3.5 — Commit:**

```
git add cli/src/commands.mjs cli/tests/new-template.test.mjs
git commit -m "feat(cli): newCmd template path — clone labeled file with strip + fresh UUID"
```

---

## Task 4: argv parsing in `cli/bin/rwa.mjs`

**Files:**
- Modify: `cli/bin/rwa.mjs` (HELP text + the `if (verb === 'new')` branch)
- Create: `cli/tests/new-argv.test.mjs` (subprocess-based)

**Step 4.1 — Write the failing tests:**

```javascript
// cli/tests/new-argv.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const RWA_BIN = path.resolve(new URL('../bin/rwa.mjs', import.meta.url).pathname);

function run(args, cwd) {
  return spawnSync('node', [RWA_BIN, ...args], { cwd, encoding: 'utf8' });
}

test('rwa new <name>  (no flags) treats <name> as templateName when no template found → exit 2', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwa-argv-'));
  const r = run(['new', 'invoice'], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no rwa file in .* is labeled `invoice`/);
});

test('rwa new <path.html>  treats path-like positional as outPath (unchanged)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwa-argv-'));
  const r = run(['new', 'my-notes.html'], dir);
  assert.equal(r.status, 0, r.stderr);
  await fs.access(path.join(dir, 'my-notes.html'));
});

test('rwa new (no args) writes ./rewritable.html (unchanged)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwa-argv-'));
  const r = run(['new'], dir);
  assert.equal(r.status, 0, r.stderr);
  await fs.access(path.join(dir, 'rewritable.html'));
});

test('rwa new --kind workflow keeps working (unchanged)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwa-argv-'));
  const r = run(['new', '--kind', 'workflow'], dir);
  assert.equal(r.status, 0, r.stderr);
  const body = await fs.readFile(path.join(dir, 'rewritable.html'), 'utf8');
  assert.match(body, /PRODUCT_KIND = ['"]workflow['"]/);
});

test('rwa new <name> --kind X is mutually exclusive → exit 2', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwa-argv-'));
  const r = run(['new', 'invoice', '--kind', 'document'], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});
```

**Step 4.2 — Run, expect failure** on the first three tests (positional `invoice` currently parses as `outPath` and writes a file called `invoice` — wrong).

**Step 4.3 — Implementation.** In `cli/bin/rwa.mjs`, inside the `new` verb branch:

```javascript
// Disambiguation: a path-like first positional (ends in .html / .htm or
// contains a path separator) is the outPath, matching the pre-template
// behavior. Otherwise it is a templateName (user-declared via
// data-rwa-template). --kind and templateName are mutually exclusive.
function isPathLike(s) {
  return /\.html?$/i.test(s) || s.includes('/') || s.includes(path.sep);
}

// (existing flag parsing collects `kind`, `force`, `open`, positionals)

let templateName = null;
let outPath = null;
if (positionals.length === 1) {
  if (isPathLike(positionals[0])) outPath = positionals[0];
  else templateName = positionals[0];
} else if (positionals.length === 2) {
  templateName = positionals[0];
  outPath = positionals[1];
} else if (positionals.length > 2) {
  console.error('rwa new: too many positional arguments');
  process.exit(2);
}

await newCmd({ outPath, force, open, kind, templateName });
```

Update HELP text:

```
  rwa new                     ./rewritable.html, blank document
  rwa new <name>              clone the cwd file labeled data-rwa-template="<name>"
                              → ./<name>-YYYY-MM-DD.html
  rwa new <name> <path>       same, written to <path>
  rwa new <path>              ./<path> (path-like positional preserves old behavior)
  rwa new --kind <kind>       built-in scaffold (document | workflow), unchanged
```

Also document the mutual exclusion in the `--kind` flag description.

**Step 4.4 — Run, expect pass.**

**Step 4.5 — Commit:**

```
git add cli/bin/rwa.mjs cli/tests/new-argv.test.mjs
git commit -m "feat(cli): rwa new <name> positional + path-like disambiguation"
```

---

## Task 5: Reserved-attribute updates (three sites + spec + CLAUDE.md)

**Files:**
- Modify: `re-write-able-spec.md` — "Reserved namespaces" / "HTML attributes" line; spec version bump in trailer
- Modify: `rwa-edit-spec.md` — reserved-substring list the agent must not produce in `find` / `replace`
- Modify: `seeds/rewritable.html` — `SYSTEM_PROMPT_RULES` reserved-marker list
- Modify: `CLAUDE.md` — "Reserved namespaces" line; add a "CLI templates" subsection under CLI conventions
- Modify: `cli/README.md` — short subsection describing the template surface

**Step 5.1 — Verify three-sites alignment after edits:**

```
grep -n "data-rwa-template" re-write-able-spec.md rwa-edit-spec.md seeds/rewritable.html CLAUDE.md cli/README.md cli/src/template.mjs
```
Expected: at least one hit per file.

**Step 5.2 — Regenerate references:**

```
node tools/regenerate-refs.mjs
git diff --stat hello.html re-write-able-spec.html
```
Expected: bootstrap-only changes (the SYSTEM_PROMPT_RULES region carries the new reserved-marker mention). No drift in `INLINE_DOC` bodies.

**Step 5.3 — Run the full test suite to confirm no regressions:**

```
cd cli && node --test tests/*.test.mjs 2>&1 | tail -5
cd ../tests && npm install && node lens.mjs 2>&1 | tail -3
cd ../benchmark && npm run conformance 2>&1 | tail -3
```
Expected: all green.

**Step 5.4 — Commit:**

```
git add re-write-able-spec.md rwa-edit-spec.md seeds/rewritable.html CLAUDE.md cli/README.md hello.html re-write-able-spec.html
git commit -m "docs(spec,seed,cli): reserve data-rwa-template attribute"
```

---

## Task 6: End-to-end manual verification

**Files:** none (verification only).

**Step 6.1 — Cold-start end-to-end:**

```
mkdir /tmp/rwa-templates-e2e && cd /tmp/rwa-templates-e2e
node /path/to/repo/cli/bin/rwa.mjs new invoice-template.html
# Edit invoice-template.html: add data-rwa-template="invoice" to the first
# <article> tag inside INLINE_DOC. Add some invoice-like body content.
node /path/to/repo/cli/bin/rwa.mjs new invoice
# → wrote ./invoice-YYYY-MM-DD.html (template: invoice)
ls -la
# Should see invoice-template.html and invoice-2026-MM-DD.html
```

Open `invoice-2026-MM-DD.html` in Chromium. Verify:
- `data-rwa-template` is absent from the rendered body.
- `DOC_UUID` differs from the template's (`diff <(grep DOC_UUID invoice-template.html) <(grep DOC_UUID invoice-2026-*.html)`).
- The lens (⌘K) accepts a prompt and commits.
- ⌘S writes the file back to disk.
- Frozen zones in the template (if any) survive the clone.

**Step 6.2 — Cross-version verification:**

```
# In a folder with a "template" labeled against an older seed:
node /path/to/repo/cli/bin/rwa.mjs new <name>
# Confirm the new file's bootstrap matches the CURRENT seed bytes (not the
# template's bootstrap). The design's "bootstrap from seed, not template"
# rule guarantees stale templates inherit runtime upgrades.
diff <(sed -n '/<script id="rwa-bootstrap">/,/<\/script>/p' new-output.html) \
     <(sed -n '/<script id="rwa-bootstrap">/,/<\/script>/p' /path/to/repo/seeds/rewritable.html)
# Expected: differ only in DOC_UUID and INLINE_DOC body.
```

**Step 6.3 — No-match hint readable:**

```
mkdir /tmp/rwa-empty && cd /tmp/rwa-empty
node /path/to/repo/cli/bin/rwa.mjs new invoice
echo "exit=$?"
# Expected: stderr hint mentions adding data-rwa-template="invoice"; exit=2.
```

**Step 6.4 — Multi-match disambiguation:**

```
# In a folder with two files both labeled "invoice", confirm the printed
# `note: using ./<filename> as template` reports the most recent mtime.
touch -d "2 minutes ago" older.html  # if both are templates
node /path/to/repo/cli/bin/rwa.mjs new invoice
# Expected: note line shows the newer file.
```

**Step 6.5 — Commit verification notes if relevant (optional):**

If any verification step revealed a behavior gap, file a follow-up in `cli/TODO.md`. Otherwise no commit.

---

## Out of scope (matches design — do not implement)

- Runtime / shared-IDB template surfacing (e.g. `/new from template` inside an open container, or the service's `/import` page offering templates).
- Cross-folder discovery (`~/.rwa/templates/`, `--from <path>`, `--list-templates`).
- Bundled starters.
- Per-element clearing on clone (`data-rwa-template-clear`).
- Recursive cwd scan.
- Interactive disambiguation on multi-match.

---

## Verification checklist

- [ ] Task 1: 6 strip tests pass.
- [ ] Task 2: 6 find tests pass.
- [ ] Task 3: 2 newCmd-level tests pass.
- [ ] Task 4: 5 argv tests pass.
- [ ] Task 5: `data-rwa-template` appears in all 4 reserved-attribute sites + CLAUDE.md + cli/README.md.
- [ ] Task 5: full test suite green (`cli/tests`, `tests/lens.mjs`, `benchmark/npm run conformance`).
- [ ] Task 6: cold-start clone produces a working browser-side rewritable with fresh UUID and stripped label.
- [ ] Task 6: cross-version clone inherits the current bootstrap.
