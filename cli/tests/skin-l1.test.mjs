// Tests for the opt-in L1 (agent-driven, content-aware) restyle:
//   - `skinCmdL1` (cli/src/skin.mjs) — the unit, backend stubbed via the same
//     mock /chat/completions server the agent-loop tests use (NO real network).
//   - `rwa skin <file> NAME --l1` (cli/bin/rwa.mjs) — the dispatch, backend
//     pointed at the mock via --backend ollama --base-url (ollama needs no key).
//
// The intent these tests pin (Rule 9 — WHY, not just WHAT):
//   - L1 lands the theme block AND the agent's additive sk-* wrappers in ONE
//     write (compose-then-commit: the agent edit is applied in memory, the theme
//     spliced on, then a single replace_document commit). Mirrors the seed's
//     applySkinL1.
//   - A re-skin via --l1 DETERMINISTICALLY de-skins the prior skin's wrappers
//     first (deskinDoc on the base), regardless of model compliance — so wrappers
//     never accumulate.
//   - `rwa skin reset` now clears sk-* wrappers too (deskinDoc), even without --l1.
//   - A missing/unreachable backend fails LOUD (exit 4) — L1 never silently
//     degrades to theme-only just because the model couldn't be reached.
//   - The default (no --l1) path is unchanged — covered by skin.test.mjs; here we
//     only add the reset-clears-wrappers behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { skinCmdL1, deskinDoc } from '../src/skin.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');
const SKIN_BLOCK_RE = /<style\b[^>]*\bdata-rwa-skin=["']([^"']*)["'][^>]*>[\s\S]*?<\/style>/gi;

function mkFixture(inlineDocBody = '<article><h1>Quarterly review</h1>\n<p>Strategy and outlook.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-skin-l1-test-'));
  const path = join(dir, 'doc.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  const current = readFileSync(path, 'utf8');
  writeFileSync(path, replaceInlineDoc(current, inlineDocBody), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const skinBlocks = (body) => body.match(SKIN_BLOCK_RE) || [];
const activeSkin = (body) => {
  const m = [...body.matchAll(SKIN_BLOCK_RE)][0];
  return m ? m[0].match(/data-rwa-skin=["']([^"']*)["']/i)[1] : null;
};

// One tool_call response that adds an sk-eyebrow class to the dek paragraph.
function eyebrowResponse(find, replace) {
  return {
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find, replace }] }),
      },
    }],
  };
}

const agentStubs = {
  systemPrompt: 'You restyle HTML documents by adding sk-* hooks.',
  toolSchemas: [{ type: 'function', function: { name: 'apply_edits', description: '...', parameters: { type: 'object' } } }],
};

// ── unit: skinCmdL1 ──────────────────────────────────────────────────────────

test('--l1 applies the theme block AND the agent sk-* wrapper in ONE write', async () => {
  const fx = mkFixture('<article><h1>Quarterly review</h1>\n<p>Strategy and outlook.</p></article>');
  const mock = await startMockBackend([
    eyebrowResponse('<p>Strategy and outlook.</p>', '<p class="sk-eyebrow">Strategy and outlook.</p>'),
  ]);
  try {
    const r = await skinCmdL1(fx.path, 'notion-clean', {
      ...agentStubs,
      backend: { baseUrl: mock.baseUrl, model: 'mock', apiKey: 'k' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.mode, 'l1');
    assert.equal(r.skin, 'notion-clean');
    assert.equal(r.degraded, false);

    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    // theme block present (exactly one) AND the agent's additive class applied
    assert.equal(skinBlocks(body).length, 1, 'exactly one skin block');
    assert.equal(activeSkin(body), 'notion-clean');
    assert.match(body, /<p[^>]*class="sk-eyebrow">Strategy and outlook\.<\/p>/, 'agent sk-* hook applied');
    // the theme rode in front of the (de-skinned) content
    assert.match(body.trimStart(), /^<style data-rwa-skin="notion-clean">/);
    // the model saw the DE-SKINNED base (here identical to the doc — no prior skin)
    assert.equal(mock.requests.length, 1);
    const userMsg = mock.requests[0].messages[1];
    assert.doesNotMatch(userMsg.content, /data-rwa-skin/, 'agent base carries no theme block');
  } finally { mock.stop(); fx.cleanup(); }
});

test('--l1 re-skin deterministically de-skins the prior skin\'s wrappers', async () => {
  // Start from a doc that ALREADY has a notion-clean skin + an sk-eyebrow wrapper.
  const seededBody = '<style data-rwa-skin="notion-clean">x{}</style>\n<article><h1>Doc</h1>\n<p class="sk-eyebrow">Dek line.</p></article>';
  const fx = mkFixture(seededBody);
  // The agent re-adds the hook on the CLEAN base (deskinDoc already stripped it).
  const mock = await startMockBackend([
    eyebrowResponse('<p>Dek line.</p>', '<p class="sk-eyebrow">Dek line.</p>'),
  ]);
  try {
    const r = await skinCmdL1(fx.path, 'editorial-serif', {
      ...agentStubs,
      backend: { baseUrl: mock.baseUrl, model: 'mock', apiKey: 'k' },
    });
    assert.equal(r.mode, 'l1');
    assert.equal(r.skin, 'editorial-serif');

    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(skinBlocks(body).length, 1, 'still exactly one skin block (no stacking)');
    assert.equal(activeSkin(body), 'editorial-serif');
    assert.doesNotMatch(body, /data-rwa-skin="notion-clean"/, 'old theme block fully removed');
    // exactly one sk-eyebrow (the prior one was deterministically stripped, the
    // agent added it back once) — wrappers never accumulate.
    assert.equal((body.match(/sk-eyebrow/g) || []).length, 1, 'no wrapper accumulation');
    // The model received the DE-SKINNED base: no theme block AND no stale sk-eyebrow.
    const userMsg = mock.requests[0].messages[1];
    assert.doesNotMatch(userMsg.content, /data-rwa-skin/, 'agent base has no prior theme');
    assert.doesNotMatch(userMsg.content, /sk-eyebrow/, 'agent base has no prior sk-* wrapper');
    assert.match(userMsg.content, /<p[^>]*>Dek line\.<\/p>/, 'agent base is the unwrapped content');
  } finally { mock.stop(); fx.cleanup(); }
});

test('--l1 degrades GRACEFULLY to theme-only when the agent declines (still one write)', async () => {
  const fx = mkFixture('<article><h1>Plain</h1>\n<p>Keep me.</p></article>');
  // Backend WAS reached but the model never called a tool → no_envelope_after_retries.
  // This is the "agent declines / produces nothing usable" case: the skin still
  // lands theme-only (one write). Mirrors the seed's model_declined degrade.
  const mock = await startMockBackend([
    { content: 'I will not restyle this.' },
    { content: 'Still declining.' },
    { content: 'No.' },
  ]);
  try {
    const r = await skinCmdL1(fx.path, 'linear-dark', {
      ...agentStubs,
      backend: { baseUrl: mock.baseUrl, model: 'mock', apiKey: 'k' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.mode, 'theme-only', 'a reachable-but-declining agent degrades to theme-only');
    assert.equal(r.degraded, true);
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(activeSkin(body), 'linear-dark', 'theme still applied (one write)');
    // No sk-* class in the CONTENT (the theme CSS naturally names sk-* rules);
    // check the part after the theme block.
    const content = body.slice(body.indexOf('</style>') + '</style>'.length);
    assert.doesNotMatch(content, /class="[^"]*sk-/, 'no sk-* wrappers added to the content');
    assert.match(body, /<p[^>]*>Keep me\.<\/p>/, 'content intact');
    assert.equal(mock.requests.length, 3, 'agent was retried to exhaustion (reachable)');
  } finally { mock.stop(); fx.cleanup(); }
});

test('--l1 degrades to theme-only when the agent edit is invalid against the base', async () => {
  const fx = mkFixture('<article><h1>Plain</h1>\n<p>Body.</p></article>');
  // Agent emits an apply_edits whose find does not match → applyEdits throws
  // RwaEditError → graceful theme-only commit (the skin still lands).
  const mock = await startMockBackend([
    eyebrowResponse('<p>NOT IN THE DOCUMENT</p>', '<p class="sk-eyebrow">x</p>'),
  ]);
  try {
    const r = await skinCmdL1(fx.path, 'stripe-docs', {
      ...agentStubs,
      backend: { baseUrl: mock.baseUrl, model: 'mock', apiKey: 'k' },
    });
    assert.equal(r.mode, 'theme-only', 'invalid agent edit degrades to theme-only');
    assert.equal(r.degraded, true);
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(activeSkin(body), 'stripe-docs', 'theme still applied');
    const content = body.slice(body.indexOf('</style>') + '</style>'.length);
    assert.doesNotMatch(content, /class="[^"]*sk-/, 'no bogus wrapper landed in the content');
    assert.match(body, /<p[^>]*>Body\.<\/p>/, 'original content intact');
  } finally { mock.stop(); fx.cleanup(); }
});

test('--l1 refuses a replace_document envelope (compose requires apply_edits) → theme-only', async () => {
  const fx = mkFixture('<article><h1>Plain</h1>\n<p>Body.</p></article>');
  const mock = await startMockBackend([{
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<article>rewritten wholesale</article>', reason: 'redo' }),
      },
    }],
  }]);
  try {
    const r = await skinCmdL1(fx.path, 'terminal-mono', {
      ...agentStubs,
      backend: { baseUrl: mock.baseUrl, model: 'mock', apiKey: 'k' },
    });
    assert.equal(r.degraded, true, 'wholesale rewrite refused, degraded to theme-only');
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(activeSkin(body), 'terminal-mono');
    assert.doesNotMatch(body, /rewritten wholesale/, 'agent could not rewrite the doc');
    assert.match(body, /<p[^>]*>Body\.<\/p>/);
  } finally { mock.stop(); fx.cleanup(); }
});

test('--l1 surfaces an unreachable backend LOUD (exit 4), no write', async () => {
  const fx = mkFixture('<article><h1>Doc</h1></article>');
  try {
    await assert.rejects(
      () => skinCmdL1(fx.path, 'notion-clean', {
        ...agentStubs,
        // nothing listening on this port → backend_error
        backend: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k' },
      }),
      (e) => e.exitCode === 4 && e.subcode === 'backend_error',
    );
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(skinBlocks(body).length, 0, 'no write on a loud backend failure');
  } finally { fx.cleanup(); }
});

test('--l1 file/skin errors keep the exit-2 surface (unknown skin, missing file)', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(
      () => skinCmdL1(fx.path, 'no-such-skin', { ...agentStubs, backend: { baseUrl: 'http://x', model: 'm', apiKey: 'k' } }),
      (e) => e.exitCode === 2 && e.subcode === 'unknown_skin',
    );
    await assert.rejects(
      () => skinCmdL1(join(fx.dir, 'nope.html'), 'notion-clean', { ...agentStubs, backend: { baseUrl: 'http://x', model: 'm', apiKey: 'k' } }),
      (e) => e.exitCode === 2 && e.subcode === 'not_found',
    );
  } finally { fx.cleanup(); }
});

// ── deskinDoc + reset (deterministic, no backend) ────────────────────────────

test('deskinDoc unwraps pure sk-* wrappers, strips sk-* class tokens, removes the theme block', () => {
  const doc =
    '<style data-rwa-skin="x">y{}</style>\n' +
    '<article>' +
    '<div class="sk-hero"><h1 class="title sk-kicker">Hi</h1></div>' +
    '<p class="sk-eyebrow">dek</p>' +
    '</article>';
  const out = deskinDoc(doc);
  assert.doesNotMatch(out, /data-rwa-skin/, 'theme block removed');
  assert.doesNotMatch(out, /sk-/, 'all sk-* tokens/wrappers gone');
  assert.match(out, /<h1 class="title">Hi<\/h1>/, 'mixed class keeps non-sk tokens, wrapper unwrapped');
  assert.match(out, /<p>dek<\/p>/, 'pure-sk class attr fully removed');
});

test('deskinDoc is a no-op on a doc with no skin (byte-identical)', () => {
  const doc = '<article><h1>Plain</h1>\n<p>Keep me.</p></article>';
  assert.equal(deskinDoc(doc), doc);
});

test('rwa skin reset now clears sk-* wrappers too (deskinDoc), not just the theme block', async () => {
  // A doc carrying a theme block AND an sk-* wrapper from a prior L1 restyle.
  const body = '<style data-rwa-skin="notion-clean">x{}</style>\n<article><h1>Doc</h1>\n<div class="sk-callout"><p>Note: hi.</p></div></article>';
  const fx = mkFixture(body);
  const run = (args) => execFileP('node', [RWA_BIN, ...args]);
  try {
    await run(['skin', fx.path, 'reset']);
    const out = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.doesNotMatch(out, /data-rwa-skin/, 'theme block removed');
    assert.doesNotMatch(out, /sk-callout/, 'sk-* wrapper removed (the new reset behavior)');
    assert.match(out, /<p[^>]*>Note: hi\.<\/p>/, 'inner content preserved');
    assert.match(out, /<h1[^>]*>Doc<\/h1>/);
  } finally { fx.cleanup(); }
});

test('rwa skin reset stays an idempotent no-op on a doc with neither theme nor sk-* hooks', async () => {
  const fx = mkFixture('<article><h1>Bare</h1></article>');
  const run = (args) => execFileP('node', [RWA_BIN, ...args]);
  try {
    const before = readFileSync(fx.path, 'utf8');
    const { stdout } = await run(['skin', fx.path, 'reset']);
    assert.match(stdout, /nothing to reset/);
    assert.equal(readFileSync(fx.path, 'utf8'), before, 'file byte-identical (no write)');
  } finally { fx.cleanup(); }
});

// ── dispatch: rwa skin --l1 (subprocess, backend → mock) ─────────────────────

test('rwa skin <file> NAME --l1 (ollama → mock) applies theme + sk-* wrapper, one write', async () => {
  const fx = mkFixture('<article><h1>Quarterly review</h1>\n<p>Strategy and outlook.</p></article>');
  const mock = await startMockBackend([
    eyebrowResponse('<p>Strategy and outlook.</p>', '<p class="sk-eyebrow">Strategy and outlook.</p>'),
  ]);
  try {
    const { stdout } = await execFileP('node', [
      RWA_BIN, 'skin', fx.path, 'notion-clean', '--l1',
      '--backend', 'ollama', '--base-url', mock.baseUrl, '--model', 'mock',
    ]);
    assert.match(stdout, /content-aware restyle/, 'confirms the L1 restyle landed');
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(activeSkin(body), 'notion-clean');
    assert.match(body, /<p[^>]*class="sk-eyebrow">Strategy and outlook\.<\/p>/);
    assert.equal(skinBlocks(body).length, 1);
  } finally { mock.stop(); await fx.cleanup(); }
});

test('rwa skin --l1 --json emits {mode:"l1", degraded:false}', async () => {
  const fx = mkFixture('<article><h1>X</h1>\n<p>dek</p></article>');
  const mock = await startMockBackend([eyebrowResponse('<p>dek</p>', '<p class="sk-eyebrow">dek</p>')]);
  try {
    const { stdout } = await execFileP('node', [
      RWA_BIN, 'skin', fx.path, 'notion-clean', '--l1', '--json',
      '--backend', 'ollama', '--base-url', mock.baseUrl, '--model', 'mock',
    ]);
    const obj = JSON.parse(stdout);
    assert.equal(obj.exitCode, 0);
    assert.equal(obj.mode, 'l1');
    assert.equal(obj.skin, 'notion-clean');
    assert.equal(obj.degraded, false);
  } finally { mock.stop(); await fx.cleanup(); }
});

test('rwa skin --l1 on openrouter with no key exits 4 (missing backend), no write', async () => {
  const fx = mkFixture('<article><h1>Doc</h1></article>');
  try {
    const before = readFileSync(fx.path, 'utf8');
    await assert.rejects(
      execFileP('node', [RWA_BIN, 'skin', fx.path, 'notion-clean', '--l1', '--backend', 'openrouter'], {
        env: { ...process.env, RWA_OPENROUTER_KEY: '', OPENROUTER_API_KEY: '' },
      }),
      (err) => {
        assert.equal(err.code, 4, 'missing openrouter key exits 4');
        assert.match(String(err.stderr || ''), /no_api_key/);
        return true;
      },
    );
    assert.equal(readFileSync(fx.path, 'utf8'), before, 'no write when the backend is missing');
  } finally { await fx.cleanup(); }
});

test('rwa skin reset --l1 ignores --l1 (reset is always deterministic)', async () => {
  const body = '<style data-rwa-skin="linear-dark">x{}</style>\n<article><h1>Doc</h1>\n<div class="sk-stat-row"><div class="sk-stat"><b>1</b><span>a</span></div></div></article>';
  const fx = mkFixture(body);
  try {
    // No backend flags at all — if --l1 were honored for reset this would try to
    // reach a backend and fail. reset must stay deterministic + offline.
    const { stdout } = await execFileP('node', [RWA_BIN, 'skin', fx.path, 'reset', '--l1']);
    assert.match(stdout, /skin removed/);
    const out = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.doesNotMatch(out, /data-rwa-skin/);
    assert.doesNotMatch(out, /sk-stat/, 'reset cleared the sk-* wrappers');
  } finally { await fx.cleanup(); }
});
