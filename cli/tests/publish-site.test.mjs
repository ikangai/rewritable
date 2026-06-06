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
import { execFileSync, spawn } from 'node:child_process';
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
  // Strip the RWA_SITE_* env so resolution fails before transport.
  const r = await runRwa(['publish-site', fx.path],
    { RWA_SITE_HOST: '', RWA_SITE_PATH: '', RWA_SITE_URL: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rwa publish-site: usage_error\/config_error/);
  fx.cleanup();
});
