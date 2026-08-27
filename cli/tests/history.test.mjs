// `rwa log` — the durable audit trail (#39).
//
// `rwa_hist` is IndexedDB-only and the `actor` it carries never reaches disk, so
// across sessions — or on a file someone sent you — "what happened to this
// document?" had no answer but git. Under two agents that matters more than it
// did under one: the external agent delegates, never reads the body, and has
// only the report and the record to audit.
//
// Two properties carry most of the weight here:
//
//   • the hashes CHAIN, and the last one equals the file's current body — so the
//     log is verifiable AGAINST the document rather than merely adjacent to it.
//     A log nobody can check is decoration.
//   • the log holds hashes, never envelope bodies. It is an audit trail, not a
//     second copy of the document — which is also the reason it can never become
//     a second copy of the document's secrets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bodyHash } from '../src/edit.mjs';
import { historyPath, readHistory, appendHistory, actorPair } from '../src/history.mjs';
import { extractInlineDoc, replaceInlineDoc } from '../src/seed.mjs';
import { startMockBackend } from './helpers/mock-backend.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

function mkFixture(body = '<article><h1>Old</h1><p>Body.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-log-'));
  const path = join(dir, 'test.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// `input: ''` by default, deliberately: with no --plan the edit verb drains
// stdin, and spawnSync without `input` leaves it open — the child then waits
// forever on a pipe nobody is going to close. Overridable for the stdin path.
const run = (args, opts) => spawnSync('node', [RWA_BIN, ...args], { encoding: 'utf8', input: '', ...opts });
// The log is OPT-IN (#39, revised on review): `rwa edit` must not drop an
// unrequested file beside someone's document. Tests that expect a record ask
// for one, exactly as a caller would.
const runLogged = (args, opts) => run([...args, '--log'], opts);
const plan = (dir, name, env) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(env)); return p; };
// ASYNC spawn, required whenever a mock backend is running IN THIS PROCESS:
// spawnSync blocks the event loop, so the in-process HTTP server can never
// answer the child's request and both sides wait forever. A harness deadlock
// that looks exactly like a product hang, which is why it is called out here.
const runAsync = (args, stdin = '') => new Promise((resolve) => {
  const child = spawn('node', [RWA_BIN, ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.stdin.end(stdin);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const bodyOf = (p) => extractInlineDoc(readFileSync(p, 'utf8'));

test('#39: the log is OFF by default — no unrequested file beside the document', () => {
  // The property this was CHANGED to have, found in review: `rwa edit` was
  // dropping a sidecar next to the user's document on every edit. No other verb
  // writes a second file, and a stray `report.rwa-log.jsonl` in a shared folder,
  // a git status or a publish directory is worse than an absent one. It was
  // caught by a test that carefully cleaned up its temp .html and still left a
  // sidecar it could not have known about.
  const fx = mkFixture();
  try {
    const p = plan(fx.dir, 'a.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    assert.equal(run(['edit', fx.path, '--plan', p]).status, 0);
    assert.equal(existsSync(historyPath(fx.path)), false, 'nothing was written that nobody asked for');
    assert.ok(bodyOf(fx.path).includes('New'), 'and the edit itself still landed');
  } finally { fx.cleanup(); }
});

test('#39: RWA_LOG=1 opts in without a flag', () => {
  const fx = mkFixture();
  try {
    const p = plan(fx.dir, 'a.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    run(['edit', fx.path, '--plan', p], { env: { ...process.env, RWA_LOG: '1' } });
    assert.equal(readHistory(fx.path).records.length, 1);
  } finally { fx.cleanup(); }
});

test('#39: an edit appends a record describing what it did', () => {
  const fx = mkFixture();
  try {
    const p = plan(fx.dir, 'a.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    assert.equal(runLogged(['edit', fx.path, '--plan', p]).status, 0);
    const h = readHistory(fx.path);
    assert.equal(h.exists, true);
    assert.equal(h.records.length, 1);
    const r = h.records[0];
    assert.equal(r.tool, 'apply_edits');
    assert.equal(r.applied, 1);
    assert.match(r.ts, /^\d{4}-\d\d-\d\dT/);
    assert.equal(r.newHash, bodyHash(bodyOf(fx.path)));
  } finally { fx.cleanup(); }
});

test('#39: the log is verifiable against the document — hashes chain to the current body', () => {
  // The property that makes this an audit trail rather than a note-to-self:
  // an auditor can confirm the record set is complete and consistent with the
  // bytes on disk, without trusting the writer.
  const fx = mkFixture('<article><h1>Old heading</h1><p>Body.</p></article>');
  try {
    // Distinctive multi-word anchors: single letters collide with the block ids
    // the commit path now backfills, and a find_not_unique here would be the
    // fixture's fault rather than the feature's.
    for (const [from, to] of [['Old heading', 'First heading'], ['First heading', 'Second heading'], ['Second heading', 'Third heading']]) {
      const p = plan(fx.dir, `${to.replace(/\W/g, '')}.json`, { version: 'rwa-edit/1', edits: [{ find: from, replace: to }] });
      const r = runLogged(['edit', fx.path, '--plan', p]);
      assert.equal(r.status, 0, r.stderr);
    }
    const { records } = readHistory(fx.path);
    assert.equal(records.length, 3);
    for (let i = 1; i < records.length; i++) {
      assert.equal(records[i].baseHash, records[i - 1].newHash, `record ${i} continues from record ${i - 1}`);
    }
    assert.equal(records.at(-1).newHash, bodyHash(bodyOf(fx.path)), 'the chain ends at the file as it stands');
  } finally { fx.cleanup(); }
});

test('#39: the actor is a PAIR — who decided, and who typed', () => {
  const fx = mkFixture();
  try {
    const p = plan(fx.dir, 'a.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    runLogged(['edit', fx.path, '--plan', p, '--actor', 'claude-code@host']);
    const r = readHistory(fx.path).records[0];
    assert.equal(r.actor.principal, 'claude-code@host', 'who decided');
    assert.equal(r.actor.operator, 'cli:plan', 'who typed');
  } finally { fx.cleanup(); }
});

test('#39: an unknown principal is left null, never fabricated', () => {
  // The CLI genuinely cannot know who an agent is acting for. Inventing a
  // plausible principal would make the audit trail actively misleading — worse
  // than admitting the field is unknown.
  const fx = mkFixture();
  try {
    const p = plan(fx.dir, 'a.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    runLogged(['edit', fx.path, '--plan', p]);
    const r = readHistory(fx.path).records[0];
    assert.equal(r.actor.principal, null);
    assert.equal(r.actor.operator, 'cli:plan');
  } finally { fx.cleanup(); }
});

test('#39: RWA_PRINCIPAL supplies the principal when the flag is absent', () => {
  const fx = mkFixture();
  try {
    const p = plan(fx.dir, 'a.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    runLogged(['edit', fx.path, '--plan', p], { env: { ...process.env, RWA_PRINCIPAL: 'ci-bot' } });
    assert.equal(readHistory(fx.path).records[0].actor.principal, 'ci-bot');
  } finally { fx.cleanup(); }
});

test('#39: stdin and instruction paths name themselves distinctly', async () => {
  const fx = mkFixture();
  const mock = await startMockBackend([{
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'Body.', replace: 'Rewritten.' }] }),
      },
    }],
  }]);
  try {
    await runAsync(['edit', fx.path, '--log'], JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] }));
    const r = await runAsync(['edit', fx.path, 'rewrite the body', '--log', '--backend', 'ollama', '--base-url', mock.baseUrl, '--model', 'stub-model']);
    assert.equal(r.status, 0, r.stderr);
    const { records } = readHistory(fx.path);
    assert.equal(records.length, 2);
    assert.equal(records[0].actor.operator, 'cli:stdin');
    assert.equal(records[1].actor.operator, 'cli:instruction');
    // Which model produced the envelope is part of "who typed" — under
    // back-delegation the operator is a program, and naming it is the point.
    assert.equal(records[1].actor.model, 'stub-model');
  } finally { await mock.stop(); fx.cleanup(); }
});

test('#39: a FAILED edit appends nothing — no phantom records', () => {
  const fx = mkFixture();
  try {
    const bad = plan(fx.dir, 'bad.json', { version: 'rwa-edit/1', edits: [{ find: 'NOT PRESENT', replace: 'x' }] });
    assert.equal(runLogged(['edit', fx.path, '--plan', bad]).status, 3);
    assert.equal(existsSync(historyPath(fx.path)), false, 'a log that recorded attempts would not be a record of the document');
  } finally { fx.cleanup(); }
});

test('#39: the log holds hashes, never envelope bodies', () => {
  // An audit trail that quoted every edit would be a second copy of the
  // document — and therefore a second copy of anything sensitive in it, sitting
  // in a file nobody thinks to protect.
  const fx = mkFixture('<article><h1>Old</h1><p>Account number 4111-1111-1111-1111.</p></article>');
  try {
    const p = plan(fx.dir, 'a.json', {
      version: 'rwa-edit/1',
      edits: [{ find: 'Account number 4111-1111-1111-1111.', replace: 'Account number redacted.' }],
    });
    runLogged(['edit', fx.path, '--plan', p]);
    const raw = readFileSync(historyPath(fx.path), 'utf8');
    assert.ok(!raw.includes('4111'), 'the replaced text is not in the log');
    assert.ok(!raw.includes('redacted'), 'and neither is the replacement');
    assert.ok(raw.includes('newHash'), 'only the hashes');
  } finally { fx.cleanup(); }
});

test('#39: rwa log on a container with no history says so, and exits 0', () => {
  const fx = mkFixture();
  try {
    const r = run(['log', fx.path]);
    assert.equal(r.status, 0, 'no history is not an error');
    assert.match(r.stdout, /no log yet/);
    const j = JSON.parse(run(['log', fx.path, '--json']).stdout);
    assert.equal(j.exists, false);
    assert.deepEqual(j.records, []);
  } finally { fx.cleanup(); }
});

test('#39: a truncated final line is skipped and COUNTED, not fatal', () => {
  // A process killed mid-append must not make the whole history unreadable —
  // and silently returning fewer records than exist would be worse than saying
  // how many could not be read.
  const fx = mkFixture();
  try {
    const p = plan(fx.dir, 'a.json', { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    runLogged(['edit', fx.path, '--plan', p]);
    appendFileSync(historyPath(fx.path), '{"ts":"2026-01-01T00:00:00Z","tool":"apply_ed');
    const h = readHistory(fx.path);
    assert.equal(h.records.length, 1, 'the intact record still reads');
    assert.equal(h.skipped, 1, 'and the damaged one is reported');
    assert.match(run(['log', fx.path]).stdout, /1 unreadable line skipped/);
  } finally { fx.cleanup(); }
});

test('#39: an unwritable sidecar never fails an edit that already succeeded', () => {
  // The write to disk is the thing that matters. A log failure that rolled back
  // (or reported failure for) a completed edit would trade a real success for a
  // bookkeeping problem.
  const fx = mkFixture();
  try {
    const ok = appendHistory(join(fx.dir, 'no', 'such', 'dir', 'x.html'), { tool: 'apply_edits' }, '2026-01-01T00:00:00Z');
    assert.equal(ok, false, 'it reports the failure…');
    // …and does not throw, which is what the caller depends on.
  } finally { fx.cleanup(); }
});

test('#39: the sidecar sits beside the container, named after it', () => {
  assert.equal(historyPath('/tmp/report.html'), '/tmp/report.rwa-log.jsonl');
  assert.equal(historyPath('/tmp/report.htm'), '/tmp/report.rwa-log.jsonl');
  assert.deepEqual(actorPair({ operator: 'cli:plan' }), { principal: null, operator: 'cli:plan' });
});
