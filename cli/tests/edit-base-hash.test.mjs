// Tests for `rwa edit --base-hash` — optimistic concurrency on the CLI write
// path (#31).
//
// The defect these pin is the one reproduced in the 2026-08-27 agent-surface
// audit: two writers read the same baseline, both write, both exit 0, and the
// first one's work is gone with no signal to anyone. The hosted runtime has
// rejected exactly that since the /r/ foundation landed (409 on a baseHash
// mismatch, under a per-id write lock); the CLI — the surface agents actually
// use — had nothing.
//
// So the assertions below are not "does the flag work". They are:
//   1. the lost update is REFUSED, and the first writer's bytes survive intact;
//   2. the refusal is distinguishable from every other failure, because "someone
//      else edited this" and "your envelope is wrong" need different fixes;
//   3. the token a read hands out is accepted by the write — a compare-and-swap
//      is unusable if the two ends disagree about what to compare;
//   4. omitting the flag preserves the old last-writer-wins behaviour, so
//      nothing that exists today breaks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPlan, bodyHash, CliError } from '../src/edit.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

function mkFixture(body = '<article><h1>Old</h1><p>Body text.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-basehash-'));
  const path = join(dir, 'test.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const bodyOf = (p) => extractInlineDoc(readFileSync(p, 'utf8'));
const writePlan = (dir, name, env) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(env));
  return p;
};

// ─── The defect ────────────────────────────────────────────────────────

test('#31: the audit race — B cannot silently overwrite A', () => {
  const fx = mkFixture();
  try {
    // Both agents read the same baseline, as they would in parallel.
    const shared = JSON.parse(
      spawnSync('node', [RWA_BIN, 'doc', fx.path, '--json'], { encoding: 'utf8' }).stdout,
    ).baseHash;

    const planA = writePlan(fx.dir, 'a.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'Written by A' }] });
    const planB = writePlan(fx.dir, 'b.json', { version: 'rwa-edit/1', edits: [{ find: 'Body text.', replace: 'Written by B' }] });

    const a = spawnSync('node', [RWA_BIN, 'edit', fx.path, '--plan', planA, '--base-hash', shared, '--json'], { encoding: 'utf8' });
    assert.equal(a.status, 0, 'A had a fresh view and must succeed');

    const b = spawnSync('node', [RWA_BIN, 'edit', fx.path, '--plan', planB, '--base-hash', shared, '--json'], { encoding: 'utf8' });
    assert.equal(b.status, 3, "B's view is stale — the write must be refused, not applied");

    // The whole point: A's work is still there. Before #31 this assertion failed.
    const body = bodyOf(fx.path);
    assert.ok(body.includes('Written by A'), "A's edit survived B's attempt");
    assert.ok(!body.includes('Written by B'), 'B wrote nothing');

    // And B is told what happened well enough to recover on its own.
    const err = JSON.parse(b.stderr.trim());
    assert.equal(err.subcode, 'base_hash_mismatch');
    assert.equal(err.details.expected, shared);
    assert.equal(err.details.actual, bodyHash(body), 'the actual hash names the version B must re-read');
    assert.match(err.details.hint, /re-read/i);
  } finally { fx.cleanup(); }
});

test('#31: a matching hash applies normally and reports the new one', async () => {
  const fx = mkFixture();
  try {
    const before = bodyHash(bodyOf(fx.path));
    const result = await applyPlan(
      fx.path,
      { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] },
      { baseHash: before },
    );
    assert.equal(result.ok, true);
    assert.equal(result.baseHash, before);
    // The returned newHash is the token for the NEXT edit — a caller can chain
    // writes without a re-read between them.
    assert.equal(result.newHash, bodyHash(bodyOf(fx.path)));
  } finally { fx.cleanup(); }
});

test('#31: a stale hash leaves the file byte-identical', async () => {
  const fx = mkFixture();
  try {
    const untouched = readFileSync(fx.path, 'utf8');
    let err;
    try {
      await applyPlan(
        fx.path,
        { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] },
        { baseHash: 'f'.repeat(64) },
      );
    } catch (e) { err = e; }
    assert.ok(err instanceof CliError);
    assert.equal(err.exitCode, 3);
    assert.equal(err.subcode, 'base_hash_mismatch');
    // A refused write must not be a partial write.
    assert.equal(readFileSync(fx.path, 'utf8'), untouched);
  } finally { fx.cleanup(); }
});

// ─── Distinguishability: which failure am I looking at? ────────────────

test('#31: staleness is reported before an envelope error', async () => {
  // Deliberate ordering (documented in applyPlan): if the document moved, the
  // caller must re-read and recompose anyway — telling it about its envelope
  // first would send it to fix the wrong thing.
  const fx = mkFixture();
  try {
    let err;
    try {
      await applyPlan(fx.path, { version: 'rwa-edit/1' /* no edits/ops/doc */ }, { baseHash: 'f'.repeat(64) });
    } catch (e) { err = e; }
    assert.equal(err.subcode, 'base_hash_mismatch', 'not unknown_shape');
  } finally { fx.cleanup(); }
});

test('#31: not_a_rewritable still wins over staleness', async () => {
  // "This is not a document" is not a concurrency answer — a hash comparison
  // against a file that has no editable body would be nonsense.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-basehash-plain-'));
  const path = join(dir, 'plain.html');
  writeFileSync(path, '<html><body>not a rewritable</body></html>', 'utf8');
  try {
    let err;
    try {
      await applyPlan(path, { version: 'rwa-edit/1', edits: [{ find: 'a', replace: 'b' }] }, { baseHash: 'f'.repeat(64) });
    } catch (e) { err = e; }
    assert.equal(err.subcode, 'not_a_rewritable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#31: a malformed hash is a usage error, not a mismatch', () => {
  // "You typed it wrong" and "someone else edited" need different fixes, so a
  // 64-hex shape failure must never masquerade as a concurrency conflict.
  const fx = mkFixture();
  try {
    const plan = writePlan(fx.dir, 'p.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const r = spawnSync('node', [RWA_BIN, 'edit', fx.path, '--plan', plan, '--base-hash', 'nope', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stderr.trim()).subcode, 'malformed_base_hash');
    assert.equal(bodyOf(fx.path).includes('New'), false, 'nothing was written');
  } finally { fx.cleanup(); }
});

test('#31: --base-hash with no value is a usage error', () => {
  const fx = mkFixture();
  try {
    const plan = writePlan(fx.dir, 'p.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const r = spawnSync('node', [RWA_BIN, 'edit', fx.path, '--plan', plan, '--base-hash', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stderr.trim()).subcode, 'missing_base_hash_value');
  } finally { fx.cleanup(); }
});

// ─── The read/write ends agree, and the old behaviour is intact ────────

test('#31: the token from rwa doc --json is accepted by rwa edit', () => {
  const fx = mkFixture();
  try {
    const read = JSON.parse(spawnSync('node', [RWA_BIN, 'doc', fx.path, '--json'], { encoding: 'utf8' }).stdout);
    assert.match(read.baseHash, /^[0-9a-f]{64}$/);
    const plan = writePlan(fx.dir, 'p.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const r = spawnSync('node', [RWA_BIN, 'edit', fx.path, '--plan', plan, '--base-hash', read.baseHash, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'a read-modify-write cycle closes without a re-read in between');
    assert.equal(JSON.parse(r.stdout.trim()).baseHash, read.baseHash);
  } finally { fx.cleanup(); }
});

test('#31: without the flag, edits stay last-writer-wins', async () => {
  // Backwards compatibility is deliberate: opting in is the caller's choice, and
  // every existing script must keep working untouched.
  const fx = mkFixture();
  try {
    await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'First' }] });
    const r = await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'First', replace: 'Second' }] });
    assert.equal(r.ok, true);
    assert.ok(bodyOf(fx.path).includes('Second'));
  } finally { fx.cleanup(); }
});

test('#31: the instruction path refuses BEFORE spending the model call', () => {
  // The expensive step on the instruction path is the delegating agent's tokens.
  // A backend pointed at a dead port proves the ordering: if the staleness check
  // ran after the agent loop we would see a backend/agent error instead.
  const fx = mkFixture();
  try {
    const r = spawnSync('node', [
      RWA_BIN, 'edit', fx.path, 'rewrite the heading',
      '--backend', 'ollama', '--base-url', 'http://127.0.0.1:9/v1',
      '--base-hash', 'f'.repeat(64), '--json',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.equal(JSON.parse(r.stderr.trim()).subcode, 'base_hash_mismatch',
      'a stale document must cost nothing — no backend was contacted');
  } finally { fx.cleanup(); }
});
