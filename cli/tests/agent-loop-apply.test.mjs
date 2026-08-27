// The CLI agent loop applies IN-LOOP and self-corrects (#44).
//
// Found while verifying #36. `runAgentLoop` returned as soon as it had a
// parseable envelope, and `rwa.mjs` applied it afterwards — so an APPLY failure
// (`find_not_found`, `frozen_zone_violation`, `structural_shape_changed`) was
// terminal. The retry budget of 3 covered only envelope-EXTRACTION problems.
//
// The seed's loop has always applied inside the loop and fed the structured
// failure back as a tool_result (rwa-edit-spec.md §8). That difference is why
// `findClosestAnchor` and the whole `FAILURE_HINTS` table existed with no
// consumer on this surface: they are built to let a model fix its own anchor in
// one retry, and the CLI never gave it the chance.
//
// It matters more after #30–#42, because the CLI is now the door a delegating
// agent uses. A door that gives up on the first miss makes the delegating agent
// pay for a whole new turn to learn what a tool_result would have told it.
//
// NOTE ON THE HARNESS: every test here drives the binary with an ASYNC spawn.
// `spawnSync` deadlocks against a mock backend running in the same process — it
// blocks the event loop, so the server can never answer — and it looks exactly
// like a product hang.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAgentLoop } from '../src/agent-loop.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';
import { startMockBackend } from './helpers/mock-backend.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

const DOC = '<article><h1>Doc</h1><p>Body text.</p></article>';
function mkFixture(body = DOC) {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-loopapply-'));
  const path = join(dir, 'x.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const bodyOf = (p) => extractInlineDoc(readFileSync(p, 'utf8'));
const editsCall = (find, replace) => ({
  tool_calls: [{
    id: 'c' + Math.random().toString(36).slice(2), type: 'function',
    function: { name: 'apply_edits', arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find, replace }] }) },
  }],
});
const runAsync = (args) => new Promise((resolve) => {
  const c = spawn('node', [RWA_BIN, ...args]);
  let stdout = '', stderr = '';
  c.stdout.on('data', d => { stdout += d; });
  c.stderr.on('data', d => { stderr += d; });
  c.stdin.end('');
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});

// ─── the defect ────────────────────────────────────────────────────────

test('#44: a first-attempt apply failure is corrected, not surfaced', async () => {
  const fx = mkFixture();
  const mock = await startMockBackend([
    editsCall('NOT IN THE DOCUMENT', 'x'),   // misses — the apply rejects
    editsCall('Body text.', 'Corrected body.'),
  ]);
  try {
    const r = await runAsync(['edit', fx.path, 'fix the body', '--backend', 'ollama', '--base-url', mock.baseUrl, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(bodyOf(fx.path).includes('Corrected body.'));
    assert.equal(mock.requests.length, 2, 'it took a second turn — that is the point');
    assert.equal(JSON.parse(r.stdout.trim()).applied, 1);
  } finally { await mock.stop(); fx.cleanup(); }
});

test('#44: the retry carries the failure code AND the closest-anchor context', async () => {
  // The reason findClosestAnchor exists. A whitespace-only miss returns the
  // verbatim surrounding text, which is directly re-usable as the next anchor —
  // and until now nothing on this surface ever handed it to a model.
  const fx = mkFixture();
  const mock = await startMockBackend([
    editsCall('Body  text.', 'x'),           // double space — a whitespace-only miss
    editsCall('Body text.', 'Corrected body.'),
  ]);
  try {
    await runAsync(['edit', fx.path, 'fix the body', '--backend', 'ollama', '--base-url', mock.baseUrl, '--json']);
    const second = mock.requests[1];
    const toolMsg = second.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg, 'the second turn carries a tool_result');
    const payload = JSON.parse(toolMsg.content);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'find_not_found');
    assert.equal(payload.closest, 'Body text.', 'the verbatim text to use as the next anchor');
    assert.equal(payload.match, 'whitespace');
    assert.match(payload.hint, /byte-for-byte/i, 'and the plain-English recovery hint');
  } finally { await mock.stop(); fx.cleanup(); }
});

test('#44: each failed attempt leaves the document untouched', async () => {
  // Load-bearing for the retry to be sound at all: the next attempt composes
  // against the same bytes it was shown. A partially-applied batch would make
  // the correction wrong even when the model got it right.
  const fx = mkFixture();
  const before = readFileSync(fx.path, 'utf8');
  const mock = await startMockBackend([
    editsCall('MISS ONE', 'x'),
    editsCall('MISS TWO', 'y'),
    editsCall('MISS THREE', 'z'),
  ]);
  try {
    const r = await runAsync(['edit', fx.path, 'do something', '--backend', 'ollama', '--base-url', mock.baseUrl, '--json']);
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(fx.path, 'utf8'), before, 'three failed attempts wrote nothing');
  } finally { await mock.stop(); fx.cleanup(); }
});

test('#44: exhausting the budget reports the LAST REAL failure, not a generic one', async () => {
  // "your third anchor also missed, here is the closest text" is actionable.
  // "no envelope after retries" is not — and would also be untrue: there WERE
  // envelopes, they just did not apply.
  const fx = mkFixture();
  const mock = await startMockBackend([
    editsCall('MISS ONE', 'x'), editsCall('MISS TWO', 'y'), editsCall('MISS THREE', 'z'),
  ]);
  try {
    const r = await runAsync(['edit', fx.path, 'do something', '--backend', 'ollama', '--base-url', mock.baseUrl, '--json']);
    assert.equal(r.status, 3, 'an envelope error, not an agent error');
    const last = JSON.parse(r.stderr.trim().split('\n').filter(Boolean).pop());
    assert.equal(last.code, 'envelope_error');
    assert.equal(last.subcode, 'find_not_found');
    assert.equal(last.details.find, 'MISS THREE', 'the failure actually reached is the one reported');
    assert.ok(last.details.hint, 'with its hint intact');
  } finally { await mock.stop(); fx.cleanup(); }
});

test('#44: every attempt is reported through the retry telemetry', async () => {
  const fx = mkFixture();
  const mock = await startMockBackend([editsCall('MISS', 'x'), editsCall('Body text.', 'Fixed.')]);
  try {
    const r = await runAsync(['edit', fx.path, 'fix it', '--backend', 'ollama', '--base-url', mock.baseUrl, '--json']);
    assert.equal(r.status, 0);
    const lines = r.stderr.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const retry = lines.find(l => l.phase === 'retry');
    assert.ok(retry, 'the attempt is visible to a --json consumer, not silent');
    assert.equal(retry.reason, 'find_not_found', 'and names the real reason');
  } finally { await mock.stop(); fx.cleanup(); }
});

// ─── what must NOT be retried ──────────────────────────────────────────

test('#44: a non-apply failure is not retried — looping would reach the same wall', async () => {
  // A file error or a usage error is not something the model can fix by trying
  // again; spending the budget on one only delays the same wall.
  const mock = await startMockBackend([editsCall('Body text.', 'x')]);
  const fileErr = Object.assign(new Error('read_error'), { exitCode: 2, subcode: 'read_error', details: {} });
  let calls = 0, thrown = null;
  try {
    await runAgentLoop({
      systemPrompt: 'sys', toolSchemas: [], currentDoc: DOC, instruction: 'x',
      backend: { baseUrl: mock.baseUrl, model: 'stub' },
      apply: async () => { calls++; throw fileErr; },
    });
  } catch (e) { thrown = e; } finally { await mock.stop(); }
  assert.equal(thrown, fileErr, 'the file error propagates unchanged');
  assert.equal(calls, 1, 'and it was attempted exactly once');
});

test('#44: without `apply`, the loop behaves exactly as before', async () => {
  // Backwards compatibility is deliberate: the option is opt-in, so any existing
  // caller that applies afterwards is byte-unaffected.
  const mock = await startMockBackend([editsCall('Body text.', 'Changed.')]);
  try {
    const r = await runAgentLoop({
      systemPrompt: 'sys', toolSchemas: [], currentDoc: DOC, instruction: 'x',
      backend: { baseUrl: mock.baseUrl, model: 'stub' },
    });
    assert.equal(r.toolName, 'apply_edits');
    assert.equal(r.applied, undefined, 'nothing was applied — the caller still owns that');
    assert.equal(r.envelope.edits[0].replace, 'Changed.');
  } finally { await mock.stop(); }
});
