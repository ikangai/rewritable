# `rwa publish-site` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `rwa publish-site <file>` CLI verb that copies a self-contained rewritable verbatim onto a static site over `scp` and prints the live URL.

**Architecture:** A new dep-free module `cli/src/publish-site.mjs` exporting `publishSite(filePath, opts, deps)`. It reuses `publish.mjs`'s read+validate fail-fast (same `CliError` `file_error` surface), resolves `{host,path,url}` from flags-over-env, sanitizes the remote name to `basename`, and shells out to the system `scp` via an injected `execFile` (deps seam, so tests run offline). `bin/rwa.mjs` gets a `publish-site` verb branch mirroring the existing `publish` branch (its own exit-4 `publish_error` label).

**Tech Stack:** Node ESM, `node:child_process` `execFile` (promisified), `node:test`, the existing `CliError` (from `edit.mjs`) and `extractInlineDoc` (from `seed.mjs`).

**Design reference:** `docs/plans/2026-06-06-ikangai-custom-publish-design.md`.

**Conventions to honor:** Rule 2 (simplicity — no config file, no versioning), Rule 9 (tests encode WHY), the CLI exit-code map (1 usage/config, 2 file, 4 remote→`publish_error`), and the security model in the design doc (execFile-array transport, basename sanitization, no secret handling).

---

### Task 1: `publishSite` — read, validate, config, name sanitization

This task builds everything up to (not including) the `scp` call: the local fail-fast, the flags-over-env config resolution, and the remote-name safety check. The transport is Task 2.

**Files:**
- Create: `cli/src/publish-site.mjs`
- Test: `cli/tests/publish-site.test.mjs`

**Step 1: Write the failing tests**

Create `cli/tests/publish-site.test.mjs`:

```js
// Tests for `rwa publish-site` — durable scp publication of a rewritable to a
// static site. The transport (scp) is a real host side-effect, so publishSite
// takes a deps seam ({execFile, env}); these tests inject a FAKE execFile that
// records argv and a controlled env, so nothing touches a real network or host.
//
// What these pin (the contract, per Rule 9):
//   - fail-fast LOCALLY (exit 2) on a non-rewritable, BEFORE any scp (assert the
//     fake execFile was never called) — publishing a non-rewritable is a no-op
//   - config comes from flags-over-env; a missing var is a named config_error
//     (exit 1), so the user knows exactly what to set
//   - the remote name is basename-only and charset-checked — a crafted filename
//     can neither escape RWA_SITE_PATH (../) nor inject shell tokens (;), because
//     the load-bearing safety is "argv array + basename + allowlist", not a shell
//   - on success the bytes scp'd are the file's bytes and stdout is exactly the URL

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceInlineDoc } from '../src/seed.mjs';
import { publishSite } from '../src/publish-site.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

// A real rewritable on disk (same approach as publish.test.mjs / doc.test.mjs):
// `rwa new` lays a valid bootstrap, replaceInlineDoc swaps the body via the
// production splice. Returns a path + cleanup.
function mkFixture(name = 'test.html', body = '<article><h1>Hi</h1><p>Body.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-pubsite-'));
  const path = join(dir, name);
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A fake execFile that records calls and resolves OK (Task-1 tests should never
// reach it; Task-2 tests script its behavior).
function fakeExec() {
  const calls = [];
  const fn = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: '', stderr: '' }; };
  return { fn, calls };
}

const FULL_ENV = { RWA_SITE_HOST: 'user@host', RWA_SITE_PATH: '/var/www/r', RWA_SITE_URL: 'https://ikangai.com/r' };

test('fail-fast: a non-rewritable is rejected (exit 2) before any scp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-pubsite-'));
  const path = join(dir, 'plain.html');
  writeFileSync(path, '<!doctype html><p>not a rewritable</p>', 'utf8');
  const { fn, calls } = fakeExec();
  await assert.rejects(
    () => publishSite(path, {}, { execFile: fn, env: FULL_ENV }),
    (e) => e.exitCode === 2 && e.subcode === 'not_a_rewritable',
  );
  assert.equal(calls.length, 0, 'must not invoke scp for a non-rewritable');
  rmSync(dir, { recursive: true, force: true });
});

test('missing file is not_found (exit 2)', async () => {
  const { fn } = fakeExec();
  await assert.rejects(
    () => publishSite('/no/such/file.html', {}, { execFile: fn, env: FULL_ENV }),
    (e) => e.exitCode === 2 && e.subcode === 'not_found',
  );
});

test('missing config var → config_error (exit 1) naming the var; scp not called', async () => {
  const fx = mkFixture();
  const { fn, calls } = fakeExec();
  await assert.rejects(
    () => publishSite(fx.path, {}, { execFile: fn, env: { RWA_SITE_HOST: 'user@host' } }), // no PATH/URL
    (e) => e.exitCode === 1 && e.subcode === 'config_error'
      && e.details.missing.includes('RWA_SITE_PATH') && e.details.missing.includes('RWA_SITE_URL'),
  );
  assert.equal(calls.length, 0);
  fx.cleanup();
});

test('a --host flag overrides RWA_SITE_HOST', async () => {
  const fx = mkFixture();
  const { fn, calls } = fakeExec();
  await publishSite(fx.path, { host: 'flag@host' }, { execFile: fn, env: FULL_ENV });
  assert.ok(calls[0].args.some(a => a.startsWith('flag@host:')), 'flag host wins over env host');
  fx.cleanup();
});

test('shell-injection filename → invalid_name (exit 1), scp never called', async () => {
  const fx = mkFixture('a;rm -rf.html');
  const { fn, calls } = fakeExec();
  await assert.rejects(
    () => publishSite(fx.path, {}, { execFile: fn, env: FULL_ENV }),
    (e) => e.exitCode === 1 && e.subcode === 'invalid_name',
  );
  assert.equal(calls.length, 0, 'a dangerous name must never reach the transport');
  fx.cleanup();
});
```

**Step 2: Run the tests to verify they fail**

Run: `node tests/publish-site.test.mjs`
Expected: FAIL — `Cannot find module '../src/publish-site.mjs'`.

**Step 3: Write the minimal implementation (everything except the scp call)**

Create `cli/src/publish-site.mjs`:

```js
// `rwa publish-site <file>` — copy a self-contained rewritable VERBATIM onto a
// static site over scp, and print the live URL. The durable counterpart to
// `rwa publish` (an ephemeral 24h service share). Because a rewritable is already
// one self-contained .html, we publish the bytes unchanged — no hosted projection.
//
// Design: docs/plans/2026-06-06-ikangai-custom-publish-design.md.
//
// Online by design (the offline-first invariant of new/import does not apply to
// a publish action). Failure surface mirrors publish.mjs: local file problems
// reuse the CliError `file_error` codes (exit 2); missing config / bad name are
// usage-class (exit 1); every transport failure is exit 4 (the bin labels exit 4
// `publish_error`). The transport is injected ({execFile}) so tests run offline.

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractInlineDoc } from './seed.mjs';
import { CliError } from './edit.mjs';

// A publishable remote name: a plain filename ending in .html. basename() already
// strips any directory, so this only has to reject names that survive basename and
// could still inject shell tokens or be otherwise unsafe. No leading dot, no
// path/space/metacharacters. (basename of '../../x.html' is 'x.html' — safe.)
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

/**
 * @param {string} filePath
 * @param {{host?:string, path?:string, url?:string}} [opts] flag overrides
 * @param {{execFile?:Function, env?:object}} [deps] injection seam for tests
 * @returns {Promise<{name:string, url:string, remoteSpec:string}>}
 * @throws {CliError} 2 file_error · 1 config_error/invalid_name · 4 transport
 */
export async function publishSite(filePath, opts = {}, deps = {}) {
  const env = deps.env || process.env;
  const execFile = deps.execFile || promisify(_execFile);

  // 1. Read + validate — identical CliError file_error surface to publish.mjs.
  let bytes;
  try {
    bytes = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }
  try {
    extractInlineDoc(bytes);
  } catch {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  // 2. Config: flags override env; nothing is baked into the package.
  const host = opts.host || env.RWA_SITE_HOST;
  const remotePath = opts.path || env.RWA_SITE_PATH;
  const urlBase = opts.url || env.RWA_SITE_URL;
  const missing = [];
  if (!host) missing.push('RWA_SITE_HOST');
  if (!remotePath) missing.push('RWA_SITE_PATH');
  if (!urlBase) missing.push('RWA_SITE_URL');
  if (missing.length) throw new CliError(1, 'config_error', { missing });

  // 3. Remote name: basename only, then allowlist. Stops path traversal AND
  //    shell-token injection at the same gate.
  const name = basename(filePath);
  if (!SAFE_NAME.test(name)) throw new CliError(1, 'invalid_name', { name });

  // 4. Transport — Task 2.
  const remoteDir = remotePath.replace(/\/+$/, '');
  const remoteSpec = `${host}:${remoteDir}/${name}`;
  // (scp call added in Task 2)

  // 5. Result.
  const url = `${urlBase.replace(/\/+$/, '')}/${name}`;
  return { name, url, remoteSpec };
}
```

> Note: at the end of Task 1 the `--host` override test passes because the success path returns before any scp, but `calls[0]` is undefined. To keep Task 1 green WITHOUT the scp call, temporarily have the override test assert on the returned `remoteSpec` instead of `calls`. Simpler: defer the `--host` override test to Task 2 (where scp runs). **Move the `'a --host flag overrides'` test into Task 2's test block.** Keep only the three rejection tests + ensure they pass here.

**Step 4: Run the tests to verify they pass**

Run: `node tests/publish-site.test.mjs`
Expected: PASS (the rejection tests; the `--host` test lives in Task 2).

**Step 5: Commit**

```bash
git add cli/src/publish-site.mjs cli/tests/publish-site.test.mjs
git commit -m "feat(publish-site): read+validate+config+name-safety (no transport yet)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `publishSite` — scp transport, success result, transport errors

**Files:**
- Modify: `cli/src/publish-site.mjs` (fill in step 4)
- Test: `cli/tests/publish-site.test.mjs` (add transport tests)

**Step 1: Write the failing tests** (append to the test file)

```js
test('success: scp argv is an array with -- before paths; stdout shape via return', async () => {
  const fx = mkFixture('my-flow.html');
  const { fn, calls } = fakeExec();
  const r = await publishSite(fx.path, {}, { execFile: fn, env: FULL_ENV });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'scp');
  // argv: ['--', <abs local path>, 'user@host:/var/www/r/my-flow.html']
  assert.equal(calls[0].args[0], '--', 'first arg is -- so a leading-dash path is not an scp option');
  assert.ok(calls[0].args[1].endsWith('/my-flow.html'), 'local source is the file');
  assert.equal(calls[0].args[2], 'user@host:/var/www/r/my-flow.html', 'remote spec host:dir/name');
  assert.equal(r.url, 'https://ikangai.com/r/my-flow.html');
  fx.cleanup();
});

test('a --host flag overrides RWA_SITE_HOST in the remote spec', async () => {
  const fx = mkFixture();
  const { fn, calls } = fakeExec();
  await publishSite(fx.path, { host: 'flag@host' }, { execFile: fn, env: FULL_ENV });
  assert.ok(calls[0].args[2].startsWith('flag@host:'), 'flag host wins over env host');
  fx.cleanup();
});

test('trailing slash in RWA_SITE_PATH / RWA_SITE_URL is normalized (no //)', async () => {
  const fx = mkFixture('q1.html');
  const { fn, calls } = fakeExec();
  const r = await publishSite(fx.path, {}, { execFile: fn, env: {
    RWA_SITE_HOST: 'user@host', RWA_SITE_PATH: '/var/www/r/', RWA_SITE_URL: 'https://ikangai.com/r/' } });
  assert.equal(calls[0].args[2], 'user@host:/var/www/r/q1.html');
  assert.equal(r.url, 'https://ikangai.com/r/q1.html');
  fx.cleanup();
});

test('scp non-zero exit → transport_error (exit 4) carrying scp stderr verbatim', async () => {
  const fx = mkFixture();
  const fn = async () => { const e = new Error('cmd failed'); e.code = 255; e.stderr = 'Permission denied (publickey).'; throw e; };
  await assert.rejects(
    () => publishSite(fx.path, {}, { execFile: fn, env: FULL_ENV }),
    (e) => e.exitCode === 4 && e.subcode === 'transport_error'
      && e.details.stderr === 'Permission denied (publickey).',
  );
  fx.cleanup();
});

test('scp binary missing (ENOENT) → scp_not_found (exit 4)', async () => {
  const fx = mkFixture();
  const fn = async () => { const e = new Error('spawn scp ENOENT'); e.code = 'ENOENT'; throw e; };
  await assert.rejects(
    () => publishSite(fx.path, {}, { execFile: fn, env: FULL_ENV }),
    (e) => e.exitCode === 4 && e.subcode === 'scp_not_found',
  );
  fx.cleanup();
});
```

**Step 2: Run to verify the new tests fail**

Run: `node tests/publish-site.test.mjs`
Expected: the success/transport tests FAIL (`calls.length` is 0 — no scp yet).

**Step 3: Fill in the transport (replace the Task-1 step-4 placeholder)**

```js
  // 4. Transport. execFile with an ARGUMENT ARRAY (never a shell string), and
  //    `--` so a leading-dash path is not parsed as an scp option. The local
  //    source is an ABSOLUTE path so scp never mis-reads an embedded ':' as a
  //    remote host. scp overwrites the destination → republish is idempotent.
  const remoteDir = remotePath.replace(/\/+$/, '');
  const remoteSpec = `${host}:${remoteDir}/${name}`;
  try {
    await execFile('scp', ['--', resolve(filePath), remoteSpec]);
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(4, 'scp_not_found', {});
    throw new CliError(4, 'transport_error', {
      stderr: (e && e.stderr) || '', code: e && e.code, message: e && e.message,
    });
  }
```

(Remove the old `remoteDir`/`remoteSpec` lines from step 4 so they are defined once, just above the try.)

**Step 4: Run to verify all pass**

Run: `node tests/publish-site.test.mjs`
Expected: PASS (all Task 1 + Task 2 tests).

**Step 5: Commit**

```bash
git add cli/src/publish-site.mjs cli/tests/publish-site.test.mjs
git commit -m "feat(publish-site): scp transport (execFile-array, --, abs source) + honest exit-4 errors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire the `publish-site` verb into `bin/rwa.mjs`

**Files:**
- Modify: `cli/bin/rwa.mjs` (add a verb branch after the `publish` branch ~line 647; add a HELP line ~line 55)
- Test: `cli/tests/publish-site.test.mjs` (add two bin-level smoke tests via spawn)

**Step 1: Write the failing bin tests** (append)

```js
import { spawn } from 'node:child_process';
function runRwa(args, env = {}) {
  return new Promise(res => {
    const c = spawn('node', [RWA_BIN, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d);
    c.stdin.end(); c.on('close', code => res({ code, stdout, stderr }));
  });
}

test('bin: publish-site with no file → usage_error (exit 1)', async () => {
  const r = await runRwa(['publish-site']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rwa publish-site: usage_error\/missing_file_arg/);
});

test('bin: publish-site without config → config_error (exit 1), no scp attempted', async () => {
  const fx = mkFixture();
  // Strip the RWA_SITE_* env so resolution fails before transport. (spawn inherits
  // process.env; override the three to empty.)
  const r = await runRwa(['publish-site', fx.path],
    { RWA_SITE_HOST: '', RWA_SITE_PATH: '', RWA_SITE_URL: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rwa publish-site: config_error/);
  fx.cleanup();
});
```

**Step 2: Run to verify they fail**

Run: `node tests/publish-site.test.mjs`
Expected: the two bin tests FAIL (unknown verb falls through to current behavior, wrong exit/message).

**Step 3: Add the verb branch** in `cli/bin/rwa.mjs` immediately AFTER the `publish` branch closes (after line 647, before the `skin` branch):

```js
    // `rwa publish-site <file> [--host h] [--path p] [--url base] [--json]` —
    // copy a rewritable VERBATIM onto a static site over scp; print the live URL.
    // Durable counterpart to `rwa publish` (ephemeral share). Online by design.
    // Config: flags > RWA_SITE_HOST / RWA_SITE_PATH / RWA_SITE_URL. See
    // src/publish-site.mjs. Exit 4 is labeled `publish_error` (like `publish`).
    if (verb === 'publish-site') {
      const jsonMode = rest.includes('--json');
      const hostFlag = getFlag('--host', rest);
      const pathFlag = getFlag('--path', rest);
      const urlFlag = getFlag('--url', rest);
      // Flag VALUE tokens must not be mistaken for the positional file.
      const skip = new Set();
      for (const f of ['--host', '--path', '--url']) {
        const i = rest.indexOf(f); if (i >= 0) skip.add(i + 1);
      }
      const filePath = rest.find((a, i) => !a.startsWith('-') && !skip.has(i));
      const emitPS = (payload) => {
        if (jsonMode) { process.stderr.write(JSON.stringify(payload) + '\n'); return; }
        const parts = [payload.code, payload.subcode].filter(Boolean);
        let line = 'rwa publish-site: ' + parts.join('/');
        if (payload.details && Object.keys(payload.details).length) line += ' ' + JSON.stringify(payload.details);
        process.stderr.write(line + '\n');
      };
      if (!filePath) { emitPS({ code: 'usage_error', subcode: 'missing_file_arg' }); process.exitCode = 1; return; }
      for (const [name, flag] of [['--host', hostFlag], ['--path', pathFlag], ['--url', urlFlag]]) {
        if (flag.present && (flag.value === undefined || flag.value.startsWith('-'))) {
          emitPS({ code: 'usage_error', subcode: 'missing_flag_value', details: { flag: name } });
          process.exitCode = 1; return;
        }
      }
      const { publishSite } = await import('../src/publish-site.mjs');
      let result;
      try {
        result = await publishSite(filePath, { host: hostFlag.value, path: pathFlag.value, url: urlFlag.value });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          const code = e.exitCode === 4 ? 'publish_error' : codeName(e.exitCode);
          emitPS({ code, subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode; return;
        }
        throw e;
      }
      if (jsonMode) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(`✓ Published to ${result.url}\n`);
      return;
    }
```

Add a HELP line near the existing `publish` help (~line 55):

```js
  rwa publish-site <path>     scp a rewritable to a static site (needs RWA_SITE_* env)
```

**Step 4: Run to verify all pass**

Run: `node tests/publish-site.test.mjs`
Expected: PASS (module + bin tests).

**Step 5: Commit**

```bash
git add cli/bin/rwa.mjs cli/tests/publish-site.test.mjs
git commit -m "feat(publish-site): wire the CLI verb (flags-over-env, publish_error label) + HELP

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Documentation

**Files:**
- Modify: `cli/README.md` (a `rwa publish-site` entry beside `rwa publish`)
- Modify: `CLAUDE.md` (a bullet in the `## CLI conventions (cli/)` section)
- Modify: `cli/TODO.md` (note any deferred follow-up, e.g. rsync option / `--json` already supported)

**Step 1:** Add to `cli/README.md`, right after the `rwa publish` section, documenting: purpose (durable static-site publish vs ephemeral share), the three `RWA_SITE_*` env vars + `--host/--path/--url` overrides, that it needs `scp` + ssh access, that the filename is kept 1:1, that republish overwrites, and that it's network-bearing (offline-first does not apply).

**Step 2:** Add to `CLAUDE.md` `## CLI conventions`, after the `rwa clone` bullet:

```markdown
- **`rwa publish-site <file>` is the durable counterpart to `rwa publish`** (`cli/src/publish-site.mjs` → `publishSite`). Where `rwa publish` POSTs to the service for an ephemeral 24h share, `publish-site` scps the file VERBATIM onto a static site and returns the live URL. Config is flags-over-env: `RWA_SITE_HOST`/`RWA_SITE_PATH`/`RWA_SITE_URL` (overridable by `--host`/`--path`/`--url`); nothing is baked into the package. Network-bearing (offline-first excludes it, like `clone`). Security: transport is `execFile('scp', ['--', <abs source>, host:path/name])` — an argument array, never a shell string; the remote name is `basename` + `/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/`, which blocks both path traversal and shell-token injection at one gate; the published bytes carry no secret (a rewritable never stores the API key, sessionStorage only). Failure surface mirrors `publish.mjs`: exit 2 file_error, exit 1 usage/config, exit 4 `publish_error` (carries scp's stderr verbatim). Transport is injected (`{execFile}`) so `cli/tests/publish-site.test.mjs` runs offline.
```

**Step 3:** Add a `cli/TODO.md` line for any deferred item (e.g. "publish-site uses scp single-file; an rsync transport with checksum/--chmod is a possible v2").

**Step 4: Run the FULL suite to confirm nothing regressed**

Run: `for f in tests/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done`
Expected: all PASS (32 files now, including publish-site).

**Step 5: Commit**

```bash
git add cli/README.md CLAUDE.md cli/TODO.md
git commit -m "docs(publish-site): document the durable scp publish verb + conventions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Success criteria

- `publishSite` rejects a non-rewritable (exit 2) before any scp; missing config is a named `config_error` (exit 1); a dangerous filename is `invalid_name` (exit 1) and never reaches transport.
- The scp argv is an array (`['--', <abs path>, host:dir/name]`), trailing slashes normalized; scp failure → exit 4 `transport_error` with scp's stderr; missing scp → `scp_not_found`.
- `rwa publish-site <file>` prints the live URL on success; full CLI suite green (32 files).
- No seed change, no service change — pure CLI (no collision with concurrent seed work).

## Out of scope (YAGNI)

- Config file / `--save`. rsync transport. Slug-from-title or `--slug`. Versioning / overwrite prompts. Browser surface. A real-host integration test (the deps seam covers the logic; a live scp is a manual acceptance step the user runs once with real `RWA_SITE_*`).
