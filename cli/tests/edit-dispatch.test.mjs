// Tests for the `rwa edit` CLI dispatcher — covers flag parsing, input-source
// detection (positional / stdin / --plan), exit codes, --json mode, and the
// plan-path end-to-end happy paths. The instruction path is stubbed
// (`not_yet_implemented`) until Tasks 6/7 land.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA = ['node', join(__dirname, '..', 'bin', 'rwa.mjs')];

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
  const { code, stderr } = await runRwa(['edit', '/tmp/definitely-does-not-exist-12345.html'], {
    stdin: '{"version":"rwa-edit/1","edits":[{"find":"x","replace":"y"}]}'
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
  const { code, stderr } = await runRwa(['edit', '/tmp/nx-12345.html', '--json'], {
    stdin: '{"version":"rwa-edit/1","edits":[]}'
  });
  assert.equal(code, 2);
  const lines = stderr.trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.code, 'file_error');
  assert.equal(last.subcode, 'not_found');
});

test('plan path — apply_edits via stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  try {
    // Bootstrap a rewritable
    const newResult = await runRwa(['new', path]);
    assert.equal(newResult.code, 0);

    // Read the doc body via extractInlineDoc to get something to anchor on
    const { extractInlineDoc } = await import('../src/seed.mjs');
    const before = readFileSync(path, 'utf8');
    const beforeBody = extractInlineDoc(before);

    // Build an envelope that anchors on a unique substring in the body
    // (`rwa new` produces a starter doc with a known title — use that)
    // We'll use a generic anchor that should always exist
    const anchor = '<article'; // the opening tag is unique in the body
    assert.ok(beforeBody.includes(anchor), 'fixture must contain anchor');

    const envelope = JSON.stringify({
      version: 'rwa-edit/1',
      edits: [{ find: anchor, replace: '<article data-test="true"' }]
    });
    const { code } = await runRwa(['edit', path], { stdin: envelope });
    assert.equal(code, 0);
    const written = readFileSync(path, 'utf8');
    const writtenBody = extractInlineDoc(written);
    assert.ok(writtenBody.includes('data-test="true"'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('plan path — apply_dsl_plan via --plan file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  const planPath = join(dir, 'plan.json');
  try {
    await runRwa(['new', path]);
    writeFileSync(planPath, JSON.stringify({
      version: 'rwa-edit-dsl/1',
      ops: [{ op: 'replace', find: '<article', replace: '<article data-via="dsl"' }]
    }));
    const { code } = await runRwa(['edit', path, '--plan', planPath]);
    assert.equal(code, 0);
    const { extractInlineDoc } = await import('../src/seed.mjs');
    const writtenBody = extractInlineDoc(readFileSync(path, 'utf8'));
    assert.ok(writtenBody.includes('data-via="dsl"'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('plan path — instruction stub returns not_yet_implemented for now', async () => {
  // This test will be flipped to "instruction path happy path" in Task 7
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  try {
    await runRwa(['new', path]);
    const { code, stderr } = await runRwa(['edit', path, 'do something']);
    assert.equal(code, 1);
    assert.match(stderr, /not_yet_implemented/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
