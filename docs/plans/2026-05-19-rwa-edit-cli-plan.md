# `rwa edit` CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `rwa edit <file>` as a single CLI verb that applies rwa-edit/1 envelopes to a rewritable file — either deterministically (envelope on stdin or `--plan <file>`) or via the same agent loop the browser runs (positional instruction string). Unlocks programmatic editing of rewritables by skills (diary first), CI jobs, and other automation.

**Architecture:** The CLI exposes one operation (`rwa edit`) and accepts envelopes from three input sources (positional instruction → agent path; piped stdin or `--plan -` → plan path from stdin; `--plan <file>` → plan path from file). Both paths converge in a shared apply pipeline that mirrors the runtime's edit semantics — DSL compile, apply_edits text substitution, frozen-zone enforcement, reserved-substring check, structural-shape check — then writes the file atomically (temp + rename). The DSL compiler is copied from `benchmark/oracles/dsl-compiler.mjs` and committed; apply-edits is hand-mirrored from `seeds/rewritable.html`; system prompt + tool schemas are parsed from the bundled seed via marker pairs that get added to the seed in this work. The agent loop talks OpenAI-compatible HTTP and reuses the same retry budget (3) and tool-use shape the browser already uses.

**Tech Stack:** Node ≥18 (uses `node:test`, `node:child_process`, `node:fs/promises`, built-in `fetch`). No new npm runtime deps. Test scenarios run via `node --test cli/tests/`. Reference design: `docs/plans/2026-05-19-rwa-edit-cli-design.md` v0.3.

---

## Pre-flight

Before starting any task:

1. **Read the design doc** at `docs/plans/2026-05-19-rwa-edit-cli-design.md` (v0.3). The plan below assumes its decisions; do not re-litigate them. If something seems wrong, surface it before continuing — don't silently diverge.

2. **Verify the current state of the seed's edit grammar** — line numbers drift; always grep before editing.
   ```
   grep -nE "^const (SYSTEM_PROMPTS|SYSTEM_PROMPT_RULES|TOOL_SCHEMAS|RWA_EDIT)\b" seeds/rewritable.html
   ```
   Expected: four hits — `SYSTEM_PROMPTS` (~line 1365), `SYSTEM_PROMPT_RULES` (~line 1455), `TOOL_SCHEMAS` (~line 1484), `RWA_EDIT` (~line 1607).

3. **Verify baseline tests pass** before starting Task 1:
   ```
   cd tests && npm install && node lens.mjs 2>&1 | tail -3
   ```
   Expected: lens + e2e + conformance scenarios all green. If anything is red on `main`, stop and surface before adding new work on top.

4. **Worktree.** This is a substantial CLI surface addition (~700 LOC across 6 new files, plus a small seed edit in Task 3). Use the `superpowers:using-git-worktrees` skill to create an isolated worktree before Task 1 if you prefer; otherwise work on `main`. The plan does not require a worktree.

5. **Decisions baked in (from v0.3 design — do not re-decide):**
   - Single verb `rwa edit`. Three input sources, exactly one required.
   - Validation order: usage → file → envelope/auth.
   - Atomic write: temp file + rename.
   - Runtime reuse option **B2**: `cli/src/dsl-compiler.mjs` is **committed** to the repo, re-copied from `benchmark/oracles/dsl-compiler.mjs` by `prepublishOnly`. `apply-edits.mjs` is hand-mirrored from the seed.
   - SYSTEM_PROMPTS/TOOL_SCHEMAS extraction: **marker-pair comments in the seed**. We add `// rwa:extract:begin <name>` / `// rwa:extract:end <name>` around each const in Task 3. Marker matches the `// rwa:` reserved prefix, so the agent cannot accidentally emit one in document content — safe by construction.
   - Backend set: `openrouter` (default), `ollama`, `lmstudio`. No `bridge`, no direct `claude`.
   - Tests use `node:test` (Node ≥18 builtin, no dep).

---

## Task 1: Bring `dsl-compiler.mjs` into the CLI (committed snapshot)

**Why first:** Smallest, lowest-risk piece. The DSL compiler is the only purely-Node module needed by the plan path that already exists elsewhere in the repo (`benchmark/oracles/dsl-compiler.mjs`). Committing a copy + wiring the prepublish refresh validates the snapshot pattern before any new code is written.

**Files:**
- Create: `cli/src/dsl-compiler.mjs` (copied verbatim from `benchmark/oracles/dsl-compiler.mjs`)
- Create: `cli/tests/dsl-compiler.test.mjs`
- Modify: `cli/package.json` (extend `prepublishOnly` to re-copy and verify)

### Step 1.1: Inspect the existing compiler

Run:
```
ls -la benchmark/oracles/dsl-compiler.mjs
head -5 benchmark/oracles/dsl-compiler.mjs
```
Expected: file exists; top comment names it as the DSL compiler. Note the file size — this is the byte-equality target for the publish-time verifier in Step 1.5.

### Step 1.2: Copy the file

```
cp benchmark/oracles/dsl-compiler.mjs cli/src/dsl-compiler.mjs
```

### Step 1.3: Write the failing test

Create `cli/tests/dsl-compiler.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDslPlan } from '../src/dsl-compiler.mjs';

test('compiles a single replace op to apply_edits', () => {
  const doc = '<article><h1>Title</h1></article>';
  const plan = {
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'replace', find: 'Title', replace: 'New Title' }]
  };
  const envelope = compileDslPlan(doc, plan);
  assert.equal(envelope.version, 'rwa-edit/1');
  assert.ok(Array.isArray(envelope.edits));
  assert.equal(envelope.edits.length, 1);
  assert.deepEqual(envelope.edits[0], { find: 'Title', replace: 'New Title' });
});

test('compiles insert/before to apply_edits with find+replace', () => {
  const doc = '<article><!-- end --></article>';
  const plan = {
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'insert', before: '<!-- end -->', content: '<p>Hello</p>' }]
  };
  const envelope = compileDslPlan(doc, plan);
  assert.equal(envelope.edits.length, 1);
  assert.equal(envelope.edits[0].find, '<!-- end -->');
  assert.equal(envelope.edits[0].replace, '<p>Hello</p><!-- end -->');
});

test('throws on unknown op', () => {
  const doc = '<article></article>';
  const plan = { version: 'rwa-edit-dsl/1', ops: [{ op: 'unknown_op' }] };
  assert.throws(() => compileDslPlan(doc, plan));
});
```

### Step 1.4: Run the test

```
cd cli && node --test tests/dsl-compiler.test.mjs
```
Expected: all three tests pass. If `compileDslPlan` is not the exported name, look at the file's actual exports and update the import — do not change the source.

### Step 1.5: Add publish-time refresh + verification

Modify `cli/package.json`'s `prepublishOnly` script. Current script copies `seeds/rewritable.html`; extend it to also re-copy `benchmark/oracles/dsl-compiler.mjs` and verify the copy is byte-identical:

```json
"prepublishOnly": "node -e \"import('fs').then(fs => { fs.copyFileSync('../seeds/rewritable.html', 'seeds/rewritable.html'); fs.copyFileSync('../benchmark/oracles/dsl-compiler.mjs', 'src/dsl-compiler.mjs'); const a = fs.readFileSync('../benchmark/oracles/dsl-compiler.mjs'); const b = fs.readFileSync('src/dsl-compiler.mjs'); if (!a.equals(b)) { console.error('dsl-compiler.mjs copy mismatch'); process.exit(1); } })\""
```

(If the existing `prepublishOnly` is already complex enough that an inline `node -e` is awkward, instead create `cli/scripts/prepublish.mjs` with the same logic and point `prepublishOnly` at it. Prefer a script file if the inline form crosses ~200 chars.)

### Step 1.6: Verify prepublish runs cleanly

```
cd cli && npm pack --dry-run
```
Expected: prepublishOnly runs without errors; the pack manifest includes `src/dsl-compiler.mjs`.

### Step 1.7: Commit

```
git add cli/src/dsl-compiler.mjs cli/tests/dsl-compiler.test.mjs cli/package.json
git commit -m "feat(cli): commit dsl-compiler snapshot + prepublish refresh"
```

---

## Task 2: `apply-edits.mjs` — text substitution + frozen-zone + reserved-substring

**Why second:** The other half of the plan-path runtime. Pure functions, fully testable in isolation, no I/O. Apply-edits is small (~80 LOC) but its error codes are load-bearing for the rest of the plan — getting the subcode names right here is what every later test asserts on.

**Files:**
- Create: `cli/src/apply-edits.mjs`
- Create: `cli/tests/apply-edits.test.mjs`

**Source-of-truth references** (read these before writing):
- `seeds/rewritable.html` `RwaEditError` class + `RWA_EDIT` constant + `containsReservedMarker` (~line 1599-1614)
- `seeds/rewritable.html` apply pipeline (grep for `findFrozenZones`, `applyEditsToDoc` — names may differ)
- `rwa-edit-spec.md` §5 (apply_edits semantics), §5.5 (modify mutex — not relevant here since CLI is single-process), §7 (structural-shape check)

### Step 2.1: Write the test scaffold + happy-path test

Create `cli/tests/apply-edits.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, containsReservedMarker } from '../src/apply-edits.mjs';

test('apply_edits — single edit, unique find, succeeds', () => {
  const doc = '<article><h1>Old</h1></article>';
  const result = applyEdits(doc, [{ find: 'Old', replace: 'New' }]);
  assert.equal(result, '<article><h1>New</h1></article>');
});

test('apply_edits — two sequential edits, both apply', () => {
  const doc = '<article><h1>A</h1><p>B</p></article>';
  const result = applyEdits(doc, [
    { find: 'A', replace: 'AA' },
    { find: 'B', replace: 'BB' }
  ]);
  assert.equal(result, '<article><h1>AA</h1><p>BB</p></article>');
});
```

Run: `node --test tests/apply-edits.test.mjs` → expected FAIL: "Cannot find module".

### Step 2.2: Minimal implementation for happy path

Create `cli/src/apply-edits.mjs`:

```js
export class RwaEditError extends Error {
  constructor(code, editIndex = null, context = {}) {
    super(code);
    this.code = code;
    this.editIndex = editIndex;
    this.context = context;
  }
}

const RESERVED_MARKERS = [
  'rwa:frozen:begin',
  'rwa:frozen:end',
  '<' + '!-- rwa:',
  '/*' + ' rwa:',
  '//' + ' rwa:',
  'data-rwa-frozen'
];

export function containsReservedMarker(s) {
  if (!s) return false;
  for (const m of RESERVED_MARKERS) if (s.includes(m)) return true;
  return false;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

export function applyEdits(doc, edits) {
  let working = doc;
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i];
    const count = countOccurrences(working, find);
    if (count === 0) throw new RwaEditError('find_not_found', i, { find });
    if (count > 1) throw new RwaEditError('find_not_unique', i, { find, count });
    working = working.replace(find, replace);
  }
  return working;
}
```

(The triple-concat for the reserved marker literals — `'<' + '!-- rwa:'` — matches the seed's pattern; it prevents the source file itself from containing the literal marker substring.)

Run the tests → expected PASS.

### Step 2.3: Add the error-path tests

Append to `cli/tests/apply-edits.test.mjs`:

```js
test('apply_edits — find_not_found', () => {
  assert.throws(
    () => applyEdits('<article>foo</article>', [{ find: 'bar', replace: 'baz' }]),
    err => err.code === 'find_not_found' && err.editIndex === 0
  );
});

test('apply_edits — find_not_unique', () => {
  assert.throws(
    () => applyEdits('<article>x x</article>', [{ find: 'x', replace: 'y' }]),
    err => err.code === 'find_not_unique' && err.editIndex === 0
  );
});

test('containsReservedMarker — detects frozen-begin marker', () => {
  assert.equal(containsReservedMarker('rwa:frozen:begin foo'), true);
});

test('containsReservedMarker — detects data-rwa-frozen attribute', () => {
  assert.equal(containsReservedMarker('<div data-rwa-frozen>'), true);
});

test('containsReservedMarker — false for ordinary content', () => {
  assert.equal(containsReservedMarker('<p>Hello world</p>'), false);
});
```

Run → expected PASS.

### Step 2.4: Add frozen-zone enforcement

Frozen zones are declared two ways (per `rwa-edit-spec.md` §15 + CLAUDE.md):
1. **Marker form**: HTML comments `<!-- rwa:frozen:begin <name> -->` ... `<!-- rwa:frozen:end <name> -->` spanning the zone.
2. **Attribute form**: any element with `data-rwa-frozen` (the element itself + all its content).

Append to `cli/src/apply-edits.mjs`:

```js
function findFrozenZones(doc) {
  const zones = []; // each: {start, end, name}
  const markerRe = /<!-- rwa:frozen:(begin|end) ([^>]+?) -->/g;
  const opens = new Map(); // name -> start index
  let m;
  while ((m = markerRe.exec(doc)) !== null) {
    const [, kind, name] = m;
    if (kind === 'begin') {
      opens.set(name.trim(), m.index);
    } else {
      const start = opens.get(name.trim());
      if (start !== undefined) {
        zones.push({ start, end: m.index + m[0].length, name: name.trim() });
        opens.delete(name.trim());
      }
    }
  }
  // Attribute form: find each element with data-rwa-frozen, compute its full span.
  // For simplicity in v1, use a tag-balancing scan starting from the attribute hit.
  // Implementation detail — match the seed's algorithm; verify against the spec scenarios in tests/.
  // ... (see test below for the contract this must satisfy)
  return zones;
}

function editCrossesFrozenZone(doc, find, replace, zones) {
  const findIdx = doc.indexOf(find);
  if (findIdx === -1) return null;
  const findEnd = findIdx + find.length;
  for (const z of zones) {
    if (findIdx < z.end && findEnd > z.start) {
      return z; // overlap
    }
  }
  return null;
}
```

Wire frozen-zone check into `applyEdits` BEFORE the substitution loop:

```js
export function applyEdits(doc, edits) {
  const zones = findFrozenZones(doc);
  let working = doc;
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i];
    // Reserved-substring check
    if (containsReservedMarker(find) || containsReservedMarker(replace)) {
      throw new RwaEditError('reserved_substring', i, { field: containsReservedMarker(find) ? 'find' : 'replace' });
    }
    // Frozen-zone check
    const zone = editCrossesFrozenZone(working, find, replace, findFrozenZones(working));
    if (zone) throw new RwaEditError('frozen_zone_violation', i, { zone: zone.name });
    // Uniqueness check
    const count = countOccurrences(working, find);
    if (count === 0) throw new RwaEditError('find_not_found', i, { find });
    if (count > 1) throw new RwaEditError('find_not_unique', i, { find, count });
    working = working.replace(find, replace);
  }
  return working;
}
```

Append tests:

```js
test('frozen_zone_violation — edit inside marker-form zone', () => {
  const doc = '<article>before<!-- rwa:frozen:begin lock --><h1>frozen</h1><!-- rwa:frozen:end lock -->after</article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'frozen', replace: 'unfrozen' }]),
    err => err.code === 'frozen_zone_violation' && err.context.zone === 'lock'
  );
});

test('reserved_substring — replace contains rwa:frozen:begin', () => {
  assert.throws(
    () => applyEdits('<article>foo</article>', [{ find: 'foo', replace: 'rwa:frozen:begin x' }]),
    err => err.code === 'reserved_substring'
  );
});
```

Run → expected PASS. If frozen-zone tests fail, your `findFrozenZones` is wrong — match the seed's algorithm exactly. Read `seeds/rewritable.html` and port it. (Attribute-form `data-rwa-frozen` requires HTML tag balancing; punt until v0.2 of this module if it's complex — but add an `xfail` test now so the gap is visible.)

### Step 2.5: Add structural-shape check

Per `rwa-edit-spec.md` §7: `apply_edits` must not change the count of `<script>` or `<style>` top-level tags.

Append:

```js
function structuralShape(doc) {
  // Top-level tag counts (these are the load-bearing checks per spec §7)
  const scripts = (doc.match(/<script[\s>]/g) || []).length;
  const styles = (doc.match(/<style[\s>]/g) || []).length;
  return { scripts, styles };
}
```

Wire into `applyEdits` after the loop, before return:

```js
const before = structuralShape(doc);
// ... loop ...
const after = structuralShape(working);
if (before.scripts !== after.scripts || before.styles !== after.styles) {
  throw new RwaEditError('structural_shape_changed', null, { before, after });
}
return working;
```

Test:

```js
test('structural_shape_changed — apply_edits cannot introduce a <script>', () => {
  assert.throws(
    () => applyEdits('<article>foo</article>', [{ find: 'foo', replace: '<script>x</script>' }]),
    err => err.code === 'structural_shape_changed'
  );
});
```

Run → expected PASS.

### Step 2.6: Commit

```
git add cli/src/apply-edits.mjs cli/tests/apply-edits.test.mjs
git commit -m "feat(cli): apply-edits with frozen-zone + reserved + structural checks"
```

---

## Task 3: `seed-extract.mjs` — pull SYSTEM_PROMPTS / TOOL_SCHEMAS from the bundled seed

**Why third:** The instruction path (Task 6) needs these to call the model. Doing it now means Tasks 4-5 can land the plan path independently without seed parsing blocking them. This task **edits the canonical seed** (`seeds/rewritable.html`) to add extract markers — small, surgical, but it's a real seed change that has to roundtrip through the references too.

**Files:**
- Modify: `seeds/rewritable.html` (add three marker pairs around `SYSTEM_PROMPTS`, `SYSTEM_PROMPT_RULES`, `TOOL_SCHEMAS`)
- Create: `cli/src/seed-extract.mjs`
- Create: `cli/tests/seed-extract.test.mjs`
- Run: `node tools/regenerate-refs.mjs` to propagate the seed change to `hello.html` and `re-write-able-spec.html`
- Modify: `cli/seeds/rewritable.html` (if it exists as a committed snapshot — check before assuming)
- Modify: `CLAUDE.md` (note the new extract-marker requirement under "Conventions when editing the bootstrap")

### Step 3.1: Add markers to the seed

Open `seeds/rewritable.html`. Locate the three const declarations (use the grep from pre-flight Step 2). For each, wrap with comment markers.

Before:
```js
const SYSTEM_PROMPTS = {
  document: ...,
  workflow: ...,
};
```

After:
```js
// rwa:extract:begin SYSTEM_PROMPTS
const SYSTEM_PROMPTS = {
  document: ...,
  workflow: ...,
};
// rwa:extract:end SYSTEM_PROMPTS
```

Repeat for `SYSTEM_PROMPT_RULES` and `TOOL_SCHEMAS`. The markers match the `// rwa:` reserved prefix, so the agent cannot accidentally emit them in document content (they're already in `RWA_EDIT.RESERVED`).

### Step 3.2: Regenerate references + verify

```
node tools/regenerate-refs.mjs
```
Expected: `hello.html` and `re-write-able-spec.html` updated; their bootstraps now also contain the markers. Open each in a browser to verify they still render and ⌘K still works (smoke check; full lens tests in Step 3.4).

If `cli/seeds/rewritable.html` exists in the worktree (it's an in-package copy created at prepublish — check `ls cli/seeds/`), refresh it: `cp seeds/rewritable.html cli/seeds/rewritable.html`. Otherwise skip — `rwa new` reads the canonical `seeds/rewritable.html` in dev.

### Step 3.3: Write the failing test

Create `cli/tests/seed-extract.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFromSeed } from '../src/seed-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = join(__dirname, '..', '..', 'seeds', 'rewritable.html');
const seedText = readFileSync(seedPath, 'utf8');

test('extracts SYSTEM_PROMPTS with document + workflow keys', () => {
  const { SYSTEM_PROMPTS } = extractFromSeed(seedText);
  assert.equal(typeof SYSTEM_PROMPTS, 'object');
  assert.ok('document' in SYSTEM_PROMPTS);
  assert.ok('workflow' in SYSTEM_PROMPTS);
  assert.equal(typeof SYSTEM_PROMPTS.document, 'string');
  assert.ok(SYSTEM_PROMPTS.document.length > 100);
});

test('extracts TOOL_SCHEMAS as an array of 3 tools', () => {
  const { TOOL_SCHEMAS } = extractFromSeed(seedText);
  assert.ok(Array.isArray(TOOL_SCHEMAS));
  assert.equal(TOOL_SCHEMAS.length, 3);
  const names = TOOL_SCHEMAS.map(t => t.function.name).sort();
  assert.deepEqual(names, ['apply_dsl_plan', 'apply_edits', 'replace_document']);
});

test('extracts SYSTEM_PROMPT_RULES as a non-empty string', () => {
  const { SYSTEM_PROMPT_RULES } = extractFromSeed(seedText);
  assert.equal(typeof SYSTEM_PROMPT_RULES, 'string');
  assert.ok(SYSTEM_PROMPT_RULES.length > 0);
});

test('throws when a marker pair is missing', () => {
  const broken = seedText.replace('// rwa:extract:end TOOL_SCHEMAS', '// removed');
  assert.throws(
    () => extractFromSeed(broken),
    err => /missing.*TOOL_SCHEMAS/i.test(err.message)
  );
});
```

Run → expected FAIL: module not found.

### Step 3.4: Implement extraction

Create `cli/src/seed-extract.mjs`:

```js
const EXTRACT_BEGIN = (name) => `// rwa:extract:begin ${name}`;
const EXTRACT_END = (name) => `// rwa:extract:end ${name}`;

function extractBlock(seedText, name) {
  const begin = EXTRACT_BEGIN(name);
  const end = EXTRACT_END(name);
  const startIdx = seedText.indexOf(begin);
  if (startIdx === -1) throw new Error(`seed-extract: missing begin marker for ${name}`);
  const endIdx = seedText.indexOf(end, startIdx);
  if (endIdx === -1) throw new Error(`seed-extract: missing end marker for ${name}`);
  return seedText.slice(startIdx + begin.length, endIdx);
}

function evalConstBlock(block, name) {
  // The block contains: `\nconst NAME = { ... };\n`
  // Evaluate it in an isolated scope and return the value.
  // Using `new Function` (no `eval`) so the block runs in module-level scope
  // without access to the surrounding seed code. The block must reference only
  // built-ins; SYSTEM_PROMPTS, SYSTEM_PROMPT_RULES, TOOL_SCHEMAS all do.
  const fn = new Function(`${block}\nreturn ${name};`);
  return fn();
}

export function extractFromSeed(seedText) {
  return {
    SYSTEM_PROMPTS: evalConstBlock(extractBlock(seedText, 'SYSTEM_PROMPTS'), 'SYSTEM_PROMPTS'),
    SYSTEM_PROMPT_RULES: evalConstBlock(extractBlock(seedText, 'SYSTEM_PROMPT_RULES'), 'SYSTEM_PROMPT_RULES'),
    TOOL_SCHEMAS: evalConstBlock(extractBlock(seedText, 'TOOL_SCHEMAS'), 'TOOL_SCHEMAS')
  };
}
```

**Safety note on `new Function`:** The seed is a build artifact in the repo, not user input. The CLI reads only `cli/seeds/rewritable.html` (or the canonical fallback). The extraction code does *not* run arbitrary user-supplied JS. Still — if the const blocks ever start referencing helpers defined elsewhere in the seed (e.g. a function call in the value position), this approach breaks loudly with a `ReferenceError`. The tests above cover the v0.10 const shapes; if a future seed introduces a reference, the tests fail at CI time and the maintainer chooses between (a) updating the marker pair to include the helper, or (b) inlining the helper into the const block.

Run → expected PASS.

### Step 3.5: Verify the seed change didn't break the runtime

```
cd tests && node lens.mjs 2>&1 | tail -3
```
Expected: same green output as in pre-flight Step 3. If anything went red, the marker comments are interfering with the seed's JS — investigate before continuing.

### Step 3.6: Update CLAUDE.md

Under "Conventions when editing the bootstrap", append a paragraph:

> The seed carries three extract-marker pairs (`// rwa:extract:begin <NAME>` / `// rwa:extract:end <NAME>`) around `SYSTEM_PROMPTS`, `SYSTEM_PROMPT_RULES`, and `TOOL_SCHEMAS`. These let the CLI (`cli/src/seed-extract.mjs`) parse the constants out of the bundled seed for the `rwa edit` instruction path. If you rename, restructure, or split any of these consts, preserve the marker pair (or update the matching name in both the seed and `seed-extract.mjs`). The markers match the `// rwa:` reserved prefix and are already covered by the runtime's `containsReservedMarker` check, so the agent cannot accidentally emit them in document content.

### Step 3.7: Commit

```
git add seeds/rewritable.html hello.html re-write-able-spec.html cli/seeds/rewritable.html cli/src/seed-extract.mjs cli/tests/seed-extract.test.mjs CLAUDE.md
git commit -m "feat(cli): seed extract-markers + seed-extract.mjs for SYSTEM_PROMPTS/TOOL_SCHEMAS"
```

---

## Task 4: `edit.mjs` plan-path entry — read file, validate envelope, apply, write atomically

**Why fourth:** First end-to-end wiring of the plan path. Brings together `dsl-compiler.mjs` (Task 1) + `apply-edits.mjs` (Task 2) + reuses `cli/src/seed.mjs`'s existing escapeTL + backtick-walk to splice the new doc back into INLINE_DOC. After this task, you can shell out `cat plan.json | node cli/bin/rwa.mjs edit foo.html` and it works for the deterministic case. CLI subcommand wiring is Task 5.

**Files:**
- Create: `cli/src/edit.mjs`
- Create: `cli/tests/edit-plan.test.mjs`
- Read (no modifications): `cli/src/seed.mjs` — locate the existing `escapeTL`, INLINE_DOC backtick-walk, and the function that extracts the current INLINE_DOC body from an existing file. The CLI uses this for `rwa import` already; we reuse the same helpers.

### Step 4.1: Inventory the existing splice helpers

```
grep -nE "(escapeTL|INLINE_DOC|backtick|extractInlineDoc|getInline)" cli/src/seed.mjs | head -20
```
Expected: hits for `escapeTL` and INLINE_DOC marker walking. Note the exact exported names — you'll import them into `edit.mjs`. If the helpers aren't exported (just internal to `seed.mjs`), add a minimal export — don't duplicate.

### Step 4.2: Write the happy-path test

Create `cli/tests/edit-plan.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan } from '../src/edit.mjs';

function mkFixture(inlineDocBody) {
  // Build a minimal rewritable: bootstrap shell + INLINE_DOC template literal.
  // Use the real seed; substitute INLINE_DOC body.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-edit-test-'));
  const path = join(dir, 'test.html');
  // Read the canonical seed and splice in the test body. Reuse cli/src/seed.mjs.
  // ... (helper details inline in the test)
  return { path, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('apply_edits envelope on stdin applies and writes', async () => {
  const fx = mkFixture('<article><h1>Old</h1></article>');
  try {
    const envelope = {
      version: 'rwa-edit/1',
      edits: [{ find: 'Old', replace: 'New' }]
    };
    const result = await applyPlan(fx.path, envelope);
    assert.equal(result.exitCode, 0);
    const written = readFileSync(fx.path, 'utf8');
    assert.ok(written.includes('<h1>New</h1>'));
    assert.ok(!written.includes('<h1>Old</h1>'));
  } finally {
    fx.cleanup();
  }
});
```

Run → expected FAIL.

### Step 4.3: Implement `applyPlan` — validation + dispatch + apply + atomic write

Create `cli/src/edit.mjs`:

```js
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { applyEdits, RwaEditError } from './apply-edits.mjs';
import { compileDslPlan } from './dsl-compiler.mjs';
import { extractInlineDoc, spliceInlineDoc } from './seed.mjs'; // adjust to actual exports

export class CliError extends Error {
  constructor(exitCode, subcode, details = {}) {
    super(subcode);
    this.exitCode = exitCode;
    this.subcode = subcode;
    this.details = details;
  }
}

function validateEnvelope(env) {
  if (typeof env !== 'object' || env === null) {
    throw new CliError(3, 'not_an_object');
  }
  const hasEdits = 'edits' in env;
  const hasOps = 'ops' in env;
  const hasDoc = 'doc' in env;
  const count = (hasEdits ? 1 : 0) + (hasOps ? 1 : 0) + (hasDoc ? 1 : 0);
  if (count === 0) throw new CliError(3, 'unknown_shape');
  if (count > 1) throw new CliError(3, 'ambiguous_envelope');
  if (typeof env.version !== 'string' || env.version.length === 0) {
    throw new CliError(3, 'missing_version');
  }
  if (hasEdits && env.version !== 'rwa-edit/1') {
    throw new CliError(3, 'version_mismatch', { expected: 'rwa-edit/1', got: env.version });
  }
  if (hasOps && env.version !== 'rwa-edit-dsl/1') {
    throw new CliError(3, 'version_mismatch', { expected: 'rwa-edit-dsl/1', got: env.version });
  }
  if (hasDoc && env.version !== 'rwa-edit/1') {
    throw new CliError(3, 'version_mismatch', { expected: 'rwa-edit/1', got: env.version });
  }
  if (hasDoc && (typeof env.reason !== 'string' || env.reason.length === 0)) {
    throw new CliError(3, 'missing_reason');
  }
  return hasEdits ? 'apply_edits' : hasOps ? 'apply_dsl_plan' : 'replace_document';
}

export async function applyPlan(filePath, envelope) {
  // 1. Read + parse the file
  let fileText;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (e) {
    throw new CliError(2, 'not_found', { path: filePath });
  }
  let currentDoc;
  try {
    currentDoc = extractInlineDoc(fileText);
  } catch (e) {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  // 2. Validate envelope shape + version
  const shape = validateEnvelope(envelope);

  // 3. Compute new doc per shape
  let newDoc;
  if (shape === 'replace_document') {
    newDoc = envelope.doc;
  } else {
    const editEnvelope = shape === 'apply_dsl_plan'
      ? compileDslPlan(currentDoc, envelope)
      : envelope;
    try {
      newDoc = applyEdits(currentDoc, editEnvelope.edits);
    } catch (e) {
      if (e instanceof RwaEditError) {
        throw new CliError(3, e.code, { editIndex: e.editIndex, ...e.context });
      }
      throw e;
    }
  }

  // 4. Splice + atomic write
  const newFileText = spliceInlineDoc(fileText, newDoc);
  const tmp = `${filePath}.rwa-tmp-${process.pid}`;
  await writeFile(tmp, newFileText, 'utf8');
  try {
    await rename(tmp, filePath);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return { exitCode: 0 };
}
```

Run the happy-path test → expected PASS.

If `extractInlineDoc` / `spliceInlineDoc` aren't the actual names in `cli/src/seed.mjs`, look at the real function names (Step 4.1) and adjust. If the helpers are internal-only, export them from `seed.mjs` (one-line change) rather than duplicating logic in `edit.mjs`.

### Step 4.4: Add the envelope-validation tests

Append:

```js
test('rejects malformed JSON envelope via not_an_object', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, 'not an object'),
      err => err.exitCode === 3 && err.subcode === 'not_an_object'
    );
  } finally { fx.cleanup(); }
});

test('rejects envelope with no discriminator (unknown_shape)', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, { version: 'rwa-edit/1' }),
      err => err.exitCode === 3 && err.subcode === 'unknown_shape'
    );
  } finally { fx.cleanup(); }
});

test('rejects envelope with multiple discriminators (ambiguous_envelope)', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, { version: 'rwa-edit/1', edits: [], doc: 'x' }),
      err => err.exitCode === 3 && err.subcode === 'ambiguous_envelope'
    );
  } finally { fx.cleanup(); }
});

test('rejects envelope missing version', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, { edits: [{ find: 'x', replace: 'y' }] }),
      err => err.exitCode === 3 && err.subcode === 'missing_version'
    );
  } finally { fx.cleanup(); }
});

test('rejects DSL envelope with wrong version (version_mismatch)', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, { version: 'rwa-edit/1', ops: [{ op: 'replace', find: 'x', replace: 'y' }] }),
      err => err.exitCode === 3 && err.subcode === 'version_mismatch'
    );
  } finally { fx.cleanup(); }
});

test('rejects replace_document missing reason', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, { version: 'rwa-edit/1', doc: '<article>y</article>' }),
      err => err.exitCode === 3 && err.subcode === 'missing_reason'
    );
  } finally { fx.cleanup(); }
});

test('replace_document with reason succeeds and replaces INLINE_DOC body', async () => {
  const fx = mkFixture('<article>old</article>');
  try {
    const r = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      doc: '<article>new</article>',
      reason: 'test'
    });
    assert.equal(r.exitCode, 0);
    const written = readFileSync(fx.path, 'utf8');
    assert.ok(written.includes('<article>new</article>'));
    assert.ok(!written.includes('<article>old</article>'));
  } finally { fx.cleanup(); }
});

test('apply_dsl_plan envelope routes through compiler', async () => {
  const fx = mkFixture('<article><!-- end --></article>');
  try {
    const r = await applyPlan(fx.path, {
      version: 'rwa-edit-dsl/1',
      ops: [{ op: 'insert', before: '<!-- end -->', content: '<p>Hello</p>' }]
    });
    assert.equal(r.exitCode, 0);
    const written = readFileSync(fx.path, 'utf8');
    assert.ok(written.includes('<p>Hello</p><!-- end -->'));
  } finally { fx.cleanup(); }
});

test('not_a_rewritable when target is plain text', async () => {
  const fx = mkFixture('plain text, no html marker');
  try {
    // Overwrite with plain text (not a rewritable)
    writeFileSync(fx.path, 'not a rewritable file');
    await assert.rejects(
      applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] }),
      err => err.exitCode === 2 && err.subcode === 'not_a_rewritable'
    );
  } finally { fx.cleanup(); }
});

test('not_found when target file does not exist', async () => {
  await assert.rejects(
    applyPlan('/tmp/this-does-not-exist-rwa-test.html', { version: 'rwa-edit/1', edits: [] }),
    err => err.exitCode === 2 && err.subcode === 'not_found'
  );
});
```

Run → expected PASS.

### Step 4.5: Atomic-write smoke test

Append:

```js
test('atomic write — no temp file remains on success', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] });
    // No temp file should remain
    const { readdirSync } = await import('node:fs');
    const dir = fx.path.substring(0, fx.path.lastIndexOf('/'));
    const remaining = readdirSync(dir).filter(f => f.includes('rwa-tmp'));
    assert.equal(remaining.length, 0);
  } finally { fx.cleanup(); }
});
```

Run → expected PASS.

### Step 4.6: Commit

```
git add cli/src/edit.mjs cli/tests/edit-plan.test.mjs
# Plus cli/src/seed.mjs if you exported helpers in 4.1.
git commit -m "feat(cli): plan-path apply with envelope validation + atomic write"
```

---

## Task 5: Wire `edit` subcommand into `rwa.mjs` — arg parsing, mode dispatch, --json output

**Why fifth:** Brings `applyPlan` to the command line. After this task, scenarios 1-14 from the design's verification list pass when invoked as `rwa edit ...`. Instruction path is still TODO (Task 6).

**Files:**
- Modify: `cli/bin/rwa.mjs` (add `edit` verb to the dispatcher)
- Create: `cli/tests/edit-dispatch.test.mjs`

### Step 5.1: Read the existing dispatcher

Look at `cli/bin/rwa.mjs` lines 50-100. Match its style — hand-rolled positional/flag parsing, no commander/yargs. Three things to add:
- A new `verb === 'edit'` branch
- `--plan <file>` and `--plan -` flag handling
- `--json` flag for structured stderr output

### Step 5.2: Write the dispatch tests

Create `cli/tests/edit-dispatch.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RWA = ['node', join(process.cwd(), 'bin/rwa.mjs')];

function runRwa(args, { stdin = null } = {}) {
  return new Promise(resolve => {
    const child = spawn(RWA[0], [...RWA.slice(1), ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    if (stdin !== null) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('exit 1 missing_input — TTY stdin, no positional, no --plan', async () => {
  const { code, stderr } = await runRwa(['edit', '/tmp/nonexistent.html']);
  assert.equal(code, 1);
  assert.match(stderr, /missing_input/);
});

test('exit 1 conflicting_input — both positional and stdin', async () => {
  const { code, stderr } = await runRwa(['edit', '/tmp/x.html', 'instruction'], { stdin: '{}' });
  assert.equal(code, 1);
  assert.match(stderr, /conflicting_input/);
});

test('exit 2 not_found — valid usage, missing file', async () => {
  const { code, stderr } = await runRwa(['edit', '/tmp/definitely-does-not-exist.html'], {
    stdin: '{"version":"rwa-edit/1","edits":[]}'
  });
  assert.equal(code, 2);
  assert.match(stderr, /not_found/);
});

test('exit 2 not_a_rewritable — file exists but is plain text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'plain.txt');
  writeFileSync(path, 'just text');
  try {
    const { code, stderr } = await runRwa(['edit', path], {
      stdin: '{"version":"rwa-edit/1","edits":[{"find":"x","replace":"y"}]}'
    });
    assert.equal(code, 2);
    assert.match(stderr, /not_a_rewritable/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--json emits structured stderr on failure', async () => {
  const { code, stderr } = await runRwa(['edit', '/tmp/nx.html', '--json'], {
    stdin: '{"version":"rwa-edit/1","edits":[]}'
  });
  assert.equal(code, 2);
  const parsed = JSON.parse(stderr.trim().split('\n').pop());
  assert.equal(parsed.code, 'file_error');
  assert.equal(parsed.subcode, 'not_found');
});
```

Run → expected FAIL (subcommand not wired).

### Step 5.3: Add the `edit` branch to `rwa.mjs`

Locate the `verb === 'new'` / `verb === 'import'` branches. Add a sibling branch:

```js
} else if (verb === 'edit') {
  // Parse edit-specific flags
  const planIdx = rest.indexOf('--plan');
  const planArg = planIdx >= 0 ? rest[planIdx + 1] : undefined;
  const jsonMode = rest.includes('--json');

  // Positional args (file path + optional instruction)
  const positionals = rest.filter((a, i) =>
    !a.startsWith('-') && rest[i - 1] !== '--plan' && rest[i - 1] !== '--model' &&
    rest[i - 1] !== '--backend' && rest[i - 1] !== '--base-url' && rest[i - 1] !== '--api-key'
  );
  const filePath = positionals[0];
  const instruction = positionals[1];
  if (!filePath) {
    emit({ code: 'usage_error', subcode: 'missing_file_arg' }, jsonMode);
    process.exit(1);
  }

  // Source detection
  const stdinPiped = !process.stdin.isTTY;
  const hasPositionalInstruction = typeof instruction === 'string' && instruction.length > 0;
  const hasPlanFile = typeof planArg === 'string' && planArg !== '-';
  const hasPlanDash = planArg === '-';

  // Count input sources
  const sources = [hasPositionalInstruction, stdinPiped || hasPlanDash, hasPlanFile].filter(Boolean).length;
  if (sources === 0) {
    emit({ code: 'usage_error', subcode: 'missing_input' }, jsonMode);
    process.exit(1);
  }
  if (sources > 1) {
    emit({ code: 'usage_error', subcode: 'conflicting_input' }, jsonMode);
    process.exit(1);
  }

  // Load envelope (plan path) or call agent loop (instruction path — Task 6)
  if (hasPositionalInstruction) {
    // TODO Task 6: wire agent loop
    emit({ code: 'usage_error', subcode: 'not_yet_implemented', details: { mode: 'instruction' } }, jsonMode);
    process.exit(1);
  }

  let envelopeJson;
  if (hasPlanFile) {
    envelopeJson = await import('node:fs/promises').then(fs => fs.readFile(planArg, 'utf8'));
  } else {
    envelopeJson = await readStdin();
  }

  let envelope;
  try {
    envelope = JSON.parse(envelopeJson);
  } catch (e) {
    emit({ code: 'envelope_error', subcode: 'malformed_json', details: { message: e.message } }, jsonMode);
    process.exit(3);
  }

  const { applyPlan } = await import('../src/edit.mjs');
  try {
    await applyPlan(filePath, envelope);
    process.exit(0);
  } catch (e) {
    if (e.exitCode !== undefined) {
      emit({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details }, jsonMode);
      process.exit(e.exitCode);
    }
    throw e;
  }
}
```

Add helpers `emit` and `readStdin` and `codeName` at the top of the file. `emit` writes one line of stderr (plain text or `--json`). `readStdin` collects piped stdin to a string. `codeName(n)` maps exit code → name (`1 → usage_error`, `2 → file_error`, etc.).

Run the dispatch tests → expected PASS.

### Step 5.4: Add plan-path end-to-end tests via the CLI

Append to `cli/tests/edit-dispatch.test.mjs`:

```js
test('plan path — apply_edits via stdin', async () => {
  // Bootstrap a rewritable via `rwa new`
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  try {
    const envelope = JSON.stringify({
      version: 'rwa-edit/1',
      edits: [{ find: '<article>', replace: '<article data-test="true">' }]
    });
    const { code } = await runRwa(['edit', path], { stdin: envelope });
    assert.equal(code, 0);
    const { readFileSync } = await import('node:fs');
    assert.ok(readFileSync(path, 'utf8').includes('data-test="true"'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('plan path — apply_dsl_plan via --plan file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  const planPath = join(dir, 'plan.json');
  await runRwa(['new', path]);
  writeFileSync(planPath, JSON.stringify({
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'replace', find: '<article>', replace: '<article data-via="dsl">' }]
  }));
  try {
    const { code } = await runRwa(['edit', path, '--plan', planPath]);
    assert.equal(code, 0);
    const { readFileSync } = await import('node:fs');
    assert.ok(readFileSync(path, 'utf8').includes('data-via="dsl"'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
```

Run → expected PASS.

### Step 5.5: Commit

```
git add cli/bin/rwa.mjs cli/tests/edit-dispatch.test.mjs
git commit -m "feat(cli): wire edit subcommand — dispatch, --plan, --json"
```

---

## Task 6: `agent-loop.mjs` + mock backend — multi-turn tool-use with retries

**Why sixth:** The instruction path. Standalone module; depends on `seed-extract.mjs` (Task 3) for the system prompt + tool schemas. The mock backend lets the entire loop be tested without network.

**Files:**
- Create: `cli/src/agent-loop.mjs`
- Create: `cli/tests/helpers/mock-backend.mjs`
- Create: `cli/tests/agent-loop.test.mjs`

### Step 6.1: Build the mock backend

Create `cli/tests/helpers/mock-backend.mjs`:

```js
import { createServer } from 'node:http';

/**
 * Start a mock OpenAI-compatible /chat/completions server.
 * Pass `responses`: an array of either:
 *   - A tool-call message: { tool_calls: [{ id, type: 'function', function: { name, arguments } }] }
 *   - An assistant text message: { content: '...' }
 * Each request consumes the next response in order.
 */
export function startMockBackend(responses) {
  let cursor = 0;
  const server = createServer((req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const next = responses[cursor++] || responses[responses.length - 1];
      const completion = {
        id: 'mock-' + cursor,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', ...next },
          finish_reason: next.tool_calls ? 'tool_calls' : 'stop'
        }]
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        stop: () => new Promise(r => server.close(r))
      });
    });
  });
}
```

### Step 6.2: Write the agent-loop tests

Create `cli/tests/agent-loop.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runAgentLoop } from '../src/agent-loop.mjs';

test('happy path — model emits valid apply_edits on first try', async () => {
  const { baseUrl, stop } = await startMockBackend([{
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'apply_edits',
        arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: 'Old', replace: 'New' }]
        })
      }
    }]
  }]);
  try {
    const result = await runAgentLoop({
      systemPrompt: 'test',
      toolSchemas: [],
      currentDoc: '<article>Old</article>',
      instruction: 'change Old to New',
      backend: { baseUrl, model: 'mock', apiKey: 'test' }
    });
    assert.equal(result.envelope.edits[0].find, 'Old');
  } finally { await stop(); }
});

test('retry exhaustion — 3 invalid attempts → no_envelope_after_retries', async () => {
  // Mock returns plain text (no tool_call) three times in a row
  const { baseUrl, stop } = await startMockBackend([
    { content: 'I cannot do that' },
    { content: 'Still cannot' },
    { content: 'No' }
  ]);
  try {
    await assert.rejects(
      runAgentLoop({
        systemPrompt: 'test', toolSchemas: [], currentDoc: '<article>x</article>',
        instruction: 'whatever',
        backend: { baseUrl, model: 'mock', apiKey: 'test' }
      }),
      err => err.subcode === 'no_envelope_after_retries'
    );
  } finally { await stop(); }
});

test('retry on first failure — second attempt succeeds', async () => {
  const { baseUrl, stop } = await startMockBackend([
    { content: 'forgot to call the tool' },
    {
      tool_calls: [{
        id: 'c1', type: 'function',
        function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] })
        }
      }]
    }
  ]);
  try {
    const result = await runAgentLoop({
      systemPrompt: 'test', toolSchemas: [], currentDoc: '<article>x</article>',
      instruction: 'change x to y',
      backend: { baseUrl, model: 'mock', apiKey: 'test' }
    });
    assert.equal(result.envelope.edits[0].find, 'x');
  } finally { await stop(); }
});
```

Run → expected FAIL.

### Step 6.3: Implement the loop

Create `cli/src/agent-loop.mjs`:

```js
const RETRY_BUDGET = 3;

export class AgentError extends Error {
  constructor(subcode, details = {}) {
    super(subcode);
    this.subcode = subcode;
    this.details = details;
  }
}

export async function runAgentLoop({ systemPrompt, toolSchemas, currentDoc, instruction, backend, onRetry }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Current document:\n\n${currentDoc}\n\nInstruction: ${instruction}` }
  ];

  for (let attempt = 1; attempt <= RETRY_BUDGET; attempt++) {
    const response = await callBackend(backend, { messages, tools: toolSchemas });
    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      const reason = `no tool_call emitted (got plain text)`;
      messages.push({ role: 'user', content: `Retry: ${reason}. You must call one of the provided tools.` });
      if (onRetry) onRetry({ attempt, reason });
      continue;
    }
    const call = message.tool_calls[0];
    let envelope;
    try {
      envelope = JSON.parse(call.function.arguments);
    } catch (e) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: 'Invalid JSON in tool arguments' });
      if (onRetry) onRetry({ attempt, reason: 'invalid_json' });
      continue;
    }
    return { envelope, toolName: call.function.name, messages };
  }
  throw new AgentError('no_envelope_after_retries', { retries: RETRY_BUDGET });
}

async function callBackend({ baseUrl, model, apiKey }, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, ...body })
  });
  if (!res.ok) {
    throw new AgentError('backend_error', { status: res.status });
  }
  return res.json();
}
```

Run → expected PASS.

### Step 6.4: Commit

```
git add cli/src/agent-loop.mjs cli/tests/agent-loop.test.mjs cli/tests/helpers/mock-backend.mjs
git commit -m "feat(cli): agent-loop with retries + mock backend"
```

---

## Task 7: Wire instruction path into `rwa.mjs` — backend flags, env, prompt extraction

**Why seventh:** Connects the agent loop (Task 6) to the dispatch in `rwa.mjs` (Task 5) using the seed extractor (Task 3). Finishes the end-to-end instruction path.

**Files:**
- Modify: `cli/bin/rwa.mjs`
- Modify (small): `cli/src/edit.mjs` (add `applyAgentResult` helper that takes the agent's envelope and runs it through the same apply pipeline)
- Modify: `cli/tests/edit-dispatch.test.mjs` (append instruction-path tests)

### Step 7.1: Add backend flag parsing in `rwa.mjs`

Inside the `verb === 'edit'` branch, extend the flag parsing to read `--backend`, `--model`, `--base-url`, `--api-key`. Wire them to env defaults: `RWA_BACKEND`, `RWA_MODEL`, `RWA_OLLAMA_URL` / `RWA_LMSTUDIO_URL` (per backend), `RWA_OPENROUTER_KEY`.

```js
const backend = getFlag('--backend') || process.env.RWA_BACKEND || 'openrouter';
const model = getFlag('--model') || process.env.RWA_MODEL || 'google/gemini-3-flash-preview';
const baseUrl = getFlag('--base-url') || envBaseUrl(backend);
const apiKey = getFlag('--api-key') || envApiKey(backend);

if (backend === 'openrouter' && !apiKey) {
  emit({ code: 'agent_error', subcode: 'no_api_key', details: { backend } }, jsonMode);
  process.exit(4);
}
```

Replace the Task 5 stub `TODO Task 6` block with the real wire-up:

```js
if (hasPositionalInstruction) {
  const { extractFromSeed } = await import('../src/seed-extract.mjs');
  const { runAgentLoop } = await import('../src/agent-loop.mjs');
  const { applyPlan } = await import('../src/edit.mjs');
  const seedText = await readBundledSeed();  // helper that finds cli/seeds/rewritable.html or canonical
  const { SYSTEM_PROMPTS, SYSTEM_PROMPT_RULES, TOOL_SCHEMAS } = extractFromSeed(seedText);
  const productKind = await detectKindFromFile(filePath);  // simple regex on the bootstrap's PRODUCT_KIND const
  const systemPrompt = (SYSTEM_PROMPTS[productKind] || SYSTEM_PROMPTS.document) + '\n\n' + SYSTEM_PROMPT_RULES;
  const currentDoc = extractInlineDocFromFile(filePath);
  try {
    const { envelope } = await runAgentLoop({
      systemPrompt, toolSchemas: TOOL_SCHEMAS, currentDoc, instruction,
      backend: { baseUrl, model, apiKey },
      onRetry: r => emit({ phase: 'retry', attempt: r.attempt, reason: r.reason }, jsonMode)
    });
    await applyPlan(filePath, envelope);
    process.exit(0);
  } catch (e) {
    if (e.subcode === 'no_envelope_after_retries') {
      emit({ code: 'agent_error', subcode: e.subcode, details: e.details }, jsonMode);
      process.exit(4);
    }
    if (e.exitCode !== undefined) {
      emit({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details }, jsonMode);
      process.exit(e.exitCode);
    }
    throw e;
  }
}
```

### Step 7.2: Add instruction-path dispatch tests using the mock backend

Append to `cli/tests/edit-dispatch.test.mjs`:

```js
import { startMockBackend } from './helpers/mock-backend.mjs';

test('instruction path — happy path via mock backend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  const { baseUrl, stop } = await startMockBackend([{
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'apply_edits',
        arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: '<article>', replace: '<article data-via="agent">' }]
        })
      }
    }]
  }]);
  try {
    const { code } = await runRwa(
      ['edit', path, 'do the thing', '--backend', 'openrouter', '--base-url', baseUrl, '--api-key', 'test'],
    );
    assert.equal(code, 0);
    const { readFileSync } = await import('node:fs');
    assert.ok(readFileSync(path, 'utf8').includes('data-via="agent"'));
  } finally {
    await stop();
    rmSync(dir, { recursive: true });
  }
});

test('instruction path — no_api_key without RWA_OPENROUTER_KEY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  try {
    // Explicitly unset to be sure
    const env = { ...process.env };
    delete env.RWA_OPENROUTER_KEY;
    const { code, stderr } = await new Promise(resolve => {
      const child = spawn(RWA[0], [...RWA.slice(1), 'edit', path, 'do thing'], { env });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.stdin.end();
      child.on('close', c => resolve({ code: c, stdout: out, stderr: err }));
    });
    assert.equal(code, 4);
    assert.match(stderr, /no_api_key/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('instruction path — retry exhaustion → agent_error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  const { baseUrl, stop } = await startMockBackend([
    { content: 'no' }, { content: 'still no' }, { content: 'final no' }
  ]);
  try {
    const { code, stderr } = await runRwa(
      ['edit', path, 'do thing', '--backend', 'openrouter', '--base-url', baseUrl, '--api-key', 'test', '--json']
    );
    assert.equal(code, 4);
    const last = JSON.parse(stderr.trim().split('\n').pop());
    assert.equal(last.subcode, 'no_envelope_after_retries');
  } finally {
    await stop();
    rmSync(dir, { recursive: true });
  }
});
```

Run → expected PASS.

### Step 7.3: Commit

```
git add cli/bin/rwa.mjs cli/src/edit.mjs cli/tests/edit-dispatch.test.mjs
git commit -m "feat(cli): instruction path — backend flags + agent-loop wire-up"
```

---

## Task 8: Documentation + CLAUDE.md alignment

**Why last:** Docs reflect the shipped surface; do them after everything works so they aren't stale before the first release.

**Files:**
- Modify: `cli/README.md` — document the new `rwa edit` verb (synopsis, two paths, exit codes, env vars).
- Modify: `CLAUDE.md`:
  - Under "Conventions when editing the CLI", add an entry noting that `cli/src/{dsl-compiler,apply-edits}.mjs` must stay aligned with their canonical sources (benchmark + seed respectively), and that `dsl-compiler.mjs` is auto-refreshed by `prepublishOnly`.
  - Update the top "Repository contents" section's `cli/` bullet to mention `rwa edit` alongside `rwa new` and `rwa import`.
- Modify: `cli/bin/rwa.mjs` — extend the inline `HELP` text to describe `edit`.

### Step 8.1: Run the full CLI test suite end-to-end

```
cd cli && node --test tests/
```
Expected: all tests across `dsl-compiler.test.mjs`, `apply-edits.test.mjs`, `seed-extract.test.mjs`, `edit-plan.test.mjs`, `edit-dispatch.test.mjs`, `agent-loop.test.mjs` pass.

### Step 8.2: Smoke test the published-shape

```
cd cli && npm pack --dry-run
```
Expected: pack includes `src/dsl-compiler.mjs` (the refreshed copy from prepublish), `src/apply-edits.mjs`, `src/edit.mjs`, `src/agent-loop.mjs`, `src/seed-extract.mjs`, `seeds/rewritable.html`, `bin/rwa.mjs`. Test files NOT included (verify `cli/.npmignore` or `files` array in package.json).

### Step 8.3: Update README + CLAUDE.md + help text

See file list above. Keep README additions short — one paragraph per path, one short example each.

### Step 8.4: Final commit

```
git add cli/README.md CLAUDE.md cli/bin/rwa.mjs
git commit -m "docs(cli): document rwa edit + mirror-alignment notes"
```

---

## Done criteria

- `node --test cli/tests/` green (all 16+ scenarios from the design doc).
- `cd tests && node lens.mjs` still green (seed change didn't break the runtime).
- `npm pack --dry-run` in `cli/` succeeds and includes all new files.
- `rwa edit foo.html < plan.json` works end-to-end on a real rewritable.
- `rwa edit foo.html "instruction"` works against OpenRouter (manual smoke, not CI) with a real API key.
- README and CLAUDE.md updated.

## Out of scope (do NOT do in this work)

- The diary skill itself (separate plan).
- `--dry-run` flag.
- File locking / concurrent-edit handling.
- Audit comments in CLI-driven edits.
- The runtime-core refactor (option B1 from the design).
- Multi-file batch editing.
- `--stream` for instruction path.

---

Plan version 0.1 — derived from design v0.3. If a task fundamentally diverges from this plan during execution (e.g. discovers that `seed.mjs`'s splice helpers are too coupled to inline DOC importing to be reused cleanly), stop and revise this plan rather than silently changing approach.
