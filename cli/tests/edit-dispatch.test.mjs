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
import { startMockBackend } from './helpers/mock-backend.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA = ['node', join(__dirname, '..', 'bin', 'rwa.mjs')];

function runRwa(args, { stdin = null, env } = {}) {
  return new Promise(resolve => {
    const spawnOpts = env ? { env } : {};
    const child = spawn(RWA[0], [...RWA.slice(1), ...args], spawnOpts);
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

// Clean env that strips any inherited RWA_* vars the test author may have set.
// Tests that depend on flag-only resolution should pass `env: cleanEnv()` so
// a developer's `.env` doesn't accidentally inject `RWA_OPENROUTER_KEY` into
// the no_api_key test.
function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('RWA_') || k === 'OPENROUTER_API_KEY') delete env[k];
  }
  return { ...env, ...overrides };
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
  //
  // Post-Task-7: the instruction path is real, so we no longer expect
  // `not_yet_implemented`. With no --base-url / --api-key and no env var,
  // the openrouter default trips `no_api_key` (exit 4) — which is enough to
  // prove the instruction branch ran (and stdin wasn't drained).
  const { code, stderr } = await runRwa(['edit', '/tmp/x.html', 'instruction'], {
    stdin: '{}', env: cleanEnv(),
  });
  assert.equal(code, 4);
  assert.match(stderr, /no_api_key/);
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

test('instruction path — happy path via mock backend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  // Mock emits an apply_edits envelope that drops a data-attribute on the
  // first <article> tag — a stable anchor across the `rwa new` starter doc.
  const { baseUrl, stop } = await startMockBackend([{
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'apply_edits',
        arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: '<article', replace: '<article data-via="agent"' }],
        }),
      },
    }],
  }]);
  try {
    const { code } = await runRwa(
      ['edit', path, 'add a data attribute', '--backend', 'openrouter', '--base-url', baseUrl, '--api-key', 'test'],
      { env: cleanEnv() },
    );
    assert.equal(code, 0);
    const { extractInlineDoc } = await import('../src/seed.mjs');
    const body = extractInlineDoc(readFileSync(path, 'utf8'));
    assert.ok(body.includes('data-via="agent"'));
  } finally {
    await stop();
    rmSync(dir, { recursive: true });
  }
});

test('instruction path — no_api_key without RWA_OPENROUTER_KEY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  try {
    await runRwa(['new', path]);
    const { code, stderr } = await runRwa(['edit', path, 'do thing'], { env: cleanEnv() });
    assert.equal(code, 4);
    assert.match(stderr, /no_api_key/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('instruction path — retry exhaustion → agent_error/no_envelope_after_retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  const { baseUrl, stop } = await startMockBackend([
    { content: 'no' }, { content: 'still no' }, { content: 'final no' },
  ]);
  try {
    const { code, stderr } = await runRwa(
      ['edit', path, 'do thing', '--backend', 'openrouter', '--base-url', baseUrl, '--api-key', 'test', '--json'],
      { env: cleanEnv() },
    );
    assert.equal(code, 4);
    const lines = stderr.trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.code, 'agent_error');
    assert.equal(last.subcode, 'no_envelope_after_retries');
  } finally {
    await stop();
    rmSync(dir, { recursive: true });
  }
});

test('instruction path — retry emits stderr telemetry per attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  const { baseUrl, stop } = await startMockBackend([
    { content: 'forgot the tool' },
    {
      tool_calls: [{
        id: 'c1', type: 'function',
        function: {
          name: 'apply_edits',
          arguments: JSON.stringify({
            version: 'rwa-edit/1',
            edits: [{ find: '<article', replace: '<article data-r="1"' }],
          }),
        },
      }],
    },
  ]);
  try {
    const { code, stderr } = await runRwa(
      ['edit', path, 'do thing', '--backend', 'openrouter', '--base-url', baseUrl, '--api-key', 'test'],
      { env: cleanEnv() },
    );
    assert.equal(code, 0);
    // Plain stderr should announce the retry by attempt count.
    assert.match(stderr, /attempt 1\/3 retrying/);
  } finally {
    await stop();
    rmSync(dir, { recursive: true });
  }
});

test('instruction path — unknown_backend fails with usage_error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  try {
    await runRwa(['new', path]);
    const { code, stderr } = await runRwa(
      ['edit', path, 'do thing', '--backend', 'bogus', '--json'],
      { env: cleanEnv() },
    );
    assert.equal(code, 1);
    const lines = stderr.trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.code, 'usage_error');
    assert.equal(last.subcode, 'unknown_backend');
    assert.equal(last.details.backend, 'bogus');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('instruction mode does not block on partially-open upstream pipe', async () => {
  // Regression: previously the dispatcher eagerly drained stdin whenever
  // --plan <file> was absent, which hung on `slow_command | rwa edit X "instr"`.
  // I1 fix: skip the stdin drain when a positional instruction is given.
  //
  // Post-Task-7 the instruction path is real. With cleanEnv() the openrouter
  // default fails at the no_api_key gate (exit 4) BEFORE any agent call —
  // which is enough to prove (a) the instruction branch ran and (b) stdin
  // was never drained (else the test would hang).
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  try {
    await runRwa(['new', path]);
    const child = spawn(RWA[0], [...RWA.slice(1), 'edit', path, 'do thing'], { env: cleanEnv() });
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
    assert.equal(code, 4);
    assert.match(stderr, /no_api_key/);
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

test('instruction path — system prompt is not rules-duplicated (regression: C1)', async () => {
  // C1: SYSTEM_PROMPTS[kind] in seeds/rewritable.html already interpolates
  // ${SYSTEM_PROMPT_RULES} internally (seed lines 1369-1370 and 1481). The
  // dispatcher previously concatenated SYSTEM_PROMPT_RULES again, duplicating
  // ~4.5KB on every request. This regression test confirms the rules block
  // appears exactly once in the system prompt the backend receives.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  const { baseUrl, stop, requests } = await startMockBackend([{
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'apply_edits',
        arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: '<article', replace: '<article data-x="1"' }],
        }),
      },
    }],
  }]);
  try {
    const { code } = await runRwa(
      ['edit', path, 'do thing', '--backend', 'openrouter', '--base-url', baseUrl, '--api-key', 'test'],
      { env: cleanEnv() },
    );
    assert.equal(code, 0);
    assert.equal(requests[0].messages[0].role, 'system');
    const systemContent = requests[0].messages[0].content;

    // Load the actual SYSTEM_PROMPT_RULES bytes from the seed via the same
    // extractor the dispatcher uses, then count occurrences in the wire
    // system prompt. Using the first ~80 bytes as a marker is robust against
    // any single-line repetition inside the rules text.
    const { extractFromSeed } = await import('../src/seed-extract.mjs');
    const seedPath = join(__dirname, '..', '..', 'seeds', 'rewritable.html');
    const seedText = readFileSync(seedPath, 'utf8');
    const { SYSTEM_PROMPT_RULES } = extractFromSeed(seedText);
    const marker = SYSTEM_PROMPT_RULES.slice(0, 80);
    const occurrences = systemContent.split(marker).length - 1;
    assert.equal(
      occurrences, 1,
      `SYSTEM_PROMPT_RULES marker should appear exactly once in system prompt, found ${occurrences}`,
    );
  } finally {
    await stop();
    rmSync(dir, { recursive: true });
  }
});

test('flag parsing — --api-key with another flag as value errors with usage_error/missing_flag_value (I1)', async () => {
  // I1: previously, `--api-key --json` would set apiKey = '--json' and
  // jsonMode = true, sending `Authorization: Bearer --json` to OpenRouter.
  // The fix: getFlag returns {present, value} and resolveFlag rejects
  // values that start with `-` (treating them as another flag).
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  try {
    const { code, stderr } = await runRwa(
      ['edit', path, 'instr', '--api-key', '--json'],
      { env: cleanEnv() },
    );
    assert.equal(code, 1);
    assert.match(stderr, /missing_flag_value/);
    assert.match(stderr, /--api-key/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('flag parsing — --backend with no following value errors (I2)', async () => {
  // I2: `--backend` as the last token previously left backendName undefined,
  // which silently fell back to env or default. The fix surfaces this as
  // usage_error/missing_flag_value at exit code 1.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-disp-'));
  const path = join(dir, 'x.html');
  await runRwa(['new', path]);
  try {
    const { code, stderr } = await runRwa(
      ['edit', path, 'instr', '--backend'],
      { env: cleanEnv() },
    );
    assert.equal(code, 1);
    assert.match(stderr, /missing_flag_value/);
    assert.match(stderr, /--backend/);
  } finally { rmSync(dir, { recursive: true }); }
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
