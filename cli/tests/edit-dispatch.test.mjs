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

test('positional instruction wins over piped stdin (no stdin drain)', async () => {
  // Documented trade-off: when a positional instruction is given, we never drain
  // stdin (so we never hang on a slow upstream). The cost is that the rare
  // combination `pipe | rwa edit X "instruction"` is NOT flagged as
  // `conflicting_input` — the instruction wins. See rwa.mjs for the rationale.
  const { code, stderr } = await runRwa(['edit', '/tmp/x.html', 'instruction'], { stdin: '{}' });
  assert.equal(code, 1);
  assert.match(stderr, /not_yet_implemented/);
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

test('instruction mode does not block on partially-open upstream pipe', async () => {
  // Regression: previously the dispatcher eagerly drained stdin whenever
  // --plan <file> was absent, which hung on `slow_command | rwa edit X "instr"`.
  // I1 fix: skip the stdin drain when a positional instruction is given.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  try {
    await runRwa(['new', path]);
    const child = spawn(RWA[0], [...RWA.slice(1), 'edit', path, 'do thing']);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    // Write some bytes but never close — if the CLI drains, it hangs.
    child.stdin.write('partial...');
    // No child.stdin.end()
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('rwa edit hung waiting for stdin in instruction mode'));
      }, 3000);
      child.on('close', c => { clearTimeout(timer); resolve(c); });
    });
    // Force-close stdin so the child can exit cleanly if it hadn't already
    try { child.stdin.end(); } catch {}
    assert.equal(code, 1);
    assert.match(stderr, /not_yet_implemented/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('codeName has no synthetic fallback — all CliError codes are in 0-4 range', async () => {
  // I2 regression guard: codeName() in rwa.mjs throws on unknown exit codes
  // rather than returning a synthetic 'unknown_error' string. To keep that
  // safe, every `new CliError(N, ...)` call site in cli/src/ must use a code
  // that codeName can map. If you add a new exit code, extend codeName too.
  //
  // rwa.mjs has top-level IIFE side effects on import, so we can't cleanly
  // unit-test codeName directly — we do a static scan instead.
  const { readFileSync, readdirSync } = await import('node:fs');
  const srcDir = join(__dirname, '..', 'src');
  const files = readdirSync(srcDir);
  for (const f of files) {
    if (!f.endsWith('.mjs')) continue;
    const text = readFileSync(join(srcDir, f), 'utf8');
    const re = /new\s+CliError\(\s*(\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      assert.ok(n >= 0 && n <= 4, `${f} uses CliError(${n}) — codeName only handles 0-4`);
    }
  }
});

test('--plan <file> takes precedence over piped stdin (I3 documented behavior)', async () => {
  // I3: when --plan <file> is set, piped stdin is intentionally ignored.
  // A missing plan file must surface as `plan_not_found` (file_error / exit 2),
  // not as `conflicting_input` (usage_error / exit 1). Confirms the documented
  // trade-off in rwa.mjs.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  const missingPlan = join(dir, 'missing.json');
  try {
    await runRwa(['new', path]);
    const { code, stderr } = await runRwa(['edit', path, '--plan', missingPlan], {
      stdin: '{"version":"rwa-edit/1","edits":[{"find":"x","replace":"y"}]}'
    });
    assert.equal(code, 2);
    assert.match(stderr, /plan_not_found/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
