// Tests for the CLI mirror of image-asset virtualization (images-v1).
// Seed source of truth: seeds/rewritable.html (virtualizeImages/expandImages/
// assertNoNewAssetTokens beside containsReservedMarker), pinned browser-side
// by tests/image-assets.mjs blocks A–G. Normative contract: rwa-edit-spec.md §19.
//
// WHY this mirror matters: `rwa edit "<instruction>"` ships the doc to a model.
// Without virtualization, one embedded photo is ~170K prompt tokens and any
// edit that quotes an <img> tag is un-anchorable. The CLI must speak the same
// token vocabulary as the seed so files edited from either surface behave
// identically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockBackend } from './helpers/mock-backend.mjs';
import {
  virtualizeImages, virtualizeWithMap, expandImages, registerImageAsset, RwaEditError,
} from '../src/apply-edits.mjs';
import { applyPlan, CliError } from '../src/edit.mjs';
import { extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA = ['node', join(__dirname, '..', 'bin', 'rwa.mjs')];

function runRwa(args, { stdin = null, env } = {}) {
  return new Promise(resolve => {
    const child = spawn(RWA[0], [...RWA.slice(1), ...args], env ? { env } : {});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    if (stdin !== null) { child.stdin.write(stdin); }
    child.stdin.end();
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const URI_A = 'data:image/png;base64,' + 'QUJD'.repeat(120);
const URI_BIG = 'data:image/jpeg;base64,' + 'QUJD'.repeat(50000); // ~200 KB
const FIG = (uri, alt = 'photo') => '<figure><img src="' + uri + '" alt="' + alt + '"></figure>';

// Bootstrap a rewritable whose body contains an image figure. Returns
// { dir, path, body }.
async function imageFixture(uri = URI_A) {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-img-'));
  const path = join(dir, 'doc.html');
  const r = await runRwa(['new', path]);
  assert.equal(r.code, 0, 'rwa new must succeed');
  const body = '<article>\n<h1>Imgs</h1>\n<p>intro paragraph</p>\n'
    + FIG(uri) + '\n<p>tail paragraph</p>\n</article>';
  const env = JSON.stringify({ version: 'rwa-edit/1', doc: body, reason: 'fixture: image doc' });
  const w = await runRwa(['edit', path], { stdin: env });
  assert.equal(w.code, 0, 'fixture replace_document must succeed: ' + w.stderr);
  return { dir, path, body };
}

// ── Unit: virtualize/expand parity with the seed ──

test('round-trip identity: expand(virtualize(doc)) is byte-equal, dedupes', () => {
  const doc = '<article>\n' + FIG(URI_A, 'one') + '\n<p>x</p>\n' + FIG(URI_A, 'dup') + '\n' + FIG(URI_BIG, 'two') + '\n</article>';
  const v = virtualizeImages(doc);
  assert.match(v.doc, /src="rwa-asset:[0-9a-f]{8,}"/);
  assert.ok(!v.doc.includes('data:image/'), 'virtual form carries no pixels');
  assert.equal(v.assets.size, 2, 'identical images share one token');
  assert.equal(expandImages(v.doc, v.assets, v.orphans), doc, 'byte-identical round-trip');
});

test('substring coherence: a virtualized doc slice equals the vdoc slice (anchors work)', () => {
  const doc = '<p>before</p>\n' + FIG(URI_A) + '\n<p>after</p>';
  const v = virtualizeImages(doc);
  const slice = virtualizeWithMap(FIG(URI_A), v.assets);
  assert.ok(v.doc.includes(slice));
});

test('unknown token fails loud; pre-existing orphans pass through', () => {
  assert.throws(
    () => expandImages('<p><img src="rwa-asset:deadbeef"></p>', new Map(), new Set()),
    (e) => e instanceof RwaEditError && e.code === 'unknown_asset_reference',
  );
  const doc = '<p><img src="rwa-asset:cafebabe" alt="pre"></p>\n' + FIG(URI_A);
  const v = virtualizeImages(doc);
  assert.ok(v.orphans.has('rwa-asset:cafebabe'));
  assert.equal(expandImages(v.doc, v.assets, v.orphans), doc, 'orphan survives verbatim');
});

// ── applyPlan({ virtualImages: true }) — the agent-path apply ──

test('virtual apply: token-form move envelope expands to real bytes on disk', async () => {
  const { dir, path, body } = await imageFixture(URI_BIG);
  try {
    const v = virtualizeImages(body);
    const vfig = virtualizeWithMap(FIG(URI_BIG), v.assets);
    const envelope = { version: 'rwa-edit/1', edits: [{
      find: vfig + '\n<p>tail paragraph</p>',
      replace: '<p>tail paragraph</p>\n' + vfig,
    }] };
    await applyPlan(path, envelope, { virtualImages: true });
    const after = extractInlineDoc(readFileSync(path, 'utf8'));
    assert.ok(after.includes('<p>tail paragraph</p>\n' + FIG(URI_BIG)), 'image moved with real bytes');
    assert.ok(!after.includes('rwa-asset:'), 'no token persisted');
  } finally { rmSync(dir, { recursive: true }); }
});

test('virtual apply: invented token rejects as unknown_asset_reference, file untouched', async () => {
  const { dir, path } = await imageFixture();
  try {
    const beforeBytes = readFileSync(path, 'utf8');
    const envelope = { version: 'rwa-edit/1', edits: [{
      find: '<p>intro paragraph</p>',
      replace: '<p>intro paragraph</p>\n<img src="rwa-asset:0badf00d" alt="ghost">',
    }] };
    await assert.rejects(
      () => applyPlan(path, envelope, { virtualImages: true }),
      (e) => e instanceof CliError && e.subcode === 'unknown_asset_reference' && e.exitCode === 3,
    );
    assert.equal(readFileSync(path, 'utf8'), beforeBytes, 'file untouched after reject');
  } finally { rmSync(dir, { recursive: true }); }
});

// ── Raw envelope paths (piped / --plan): real bytes, fail-loud guard ──

test('raw path: introducing a NEW rwa-asset token without bytes rejects (no silent broken image)', async () => {
  const { dir, path } = await imageFixture();
  try {
    const env = JSON.stringify({ version: 'rwa-edit/1', edits: [{
      find: '<p>intro paragraph</p>',
      replace: '<p>intro paragraph</p>\n<img src="rwa-asset:0badf00d" alt="ghost">',
    }] });
    const { code, stderr } = await runRwa(['edit', path], { stdin: env });
    assert.equal(code, 3);
    assert.match(stderr, /unknown_asset_reference/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('raw path: moving a PRE-EXISTING orphan token stays legal (pre-broken docs stay editable)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-img-'));
  const path = join(dir, 'doc.html');
  try {
    await runRwa(['new', path]);
    // A pre-broken doc comes from OUTSIDE the protocol (hand edit, import) —
    // the guarded paths correctly refuse to mint tokens, so splice directly.
    const { replaceInlineDoc } = await import('../src/seed.mjs');
    const { writeFileSync } = await import('node:fs');
    const body = '<article>\n<p>a</p>\n<img src="rwa-asset:cafebabe" alt="pre">\n</article>';
    writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body));
    const env = JSON.stringify({ version: 'rwa-edit/1', edits: [{
      find: '<p>a</p>\n<img src="rwa-asset:cafebabe" alt="pre">',
      replace: '<img src="rwa-asset:cafebabe" alt="pre">\n<p>a</p>',
    }] });
    const { code, stderr } = await runRwa(['edit', path], { stdin: env });
    assert.equal(code, 0, stderr);
  } finally { rmSync(dir, { recursive: true }); }
});

// ── End-to-end instruction path: the model never sees pixels ──

test('rwa edit <instruction>: prompt carries tokens, commit restores bytes', async () => {
  const { dir, path, body } = await imageFixture(URI_BIG);
  const v = virtualizeImages(body);
  const vfig = virtualizeWithMap(FIG(URI_BIG), v.assets);
  const mock = await startMockBackend([{
    tool_calls: [{
      id: 'tc1', type: 'function',
      function: { name: 'apply_edits', arguments: JSON.stringify({
        version: 'rwa-edit/1',
        edits: [{ find: vfig + '\n<p>tail paragraph</p>', replace: '<p>tail paragraph</p>\n' + vfig }],
      }) },
    }],
  }]);
  try {
    const { code, stderr } = await runRwa(
      ['edit', path, 'move the image below the tail', '--base-url', mock.baseUrl, '--api-key', 'test-key'],
    );
    assert.equal(code, 0, stderr);
    const userMsg = mock.requests[0].messages.find(m => m.role === 'user').content;
    assert.ok(userMsg.includes('rwa-asset:'), 'prompt speaks tokens');
    assert.ok(!userMsg.includes('data:image/'), 'prompt carries no pixels');
    assert.ok(userMsg.length < 20 * 1024, 'prompt stays small for a 200 KB image doc');
    const after = extractInlineDoc(readFileSync(path, 'utf8'));
    assert.ok(after.includes('<p>tail paragraph</p>\n' + FIG(URI_BIG)), 'real bytes moved on disk');
    assert.ok(!after.includes('rwa-asset:'));
  } finally {
    await mock.stop();
    rmSync(dir, { recursive: true });
  }
});

// ── Hint parity with the seed ──

test('unknown_asset_reference hint is identical across seed and CLI', async () => {
  const { FAILURE_HINTS } = await import('../src/apply-edits.mjs');
  const { readFileSync: rf } = await import('node:fs');
  const seed = rf(join(__dirname, '..', '..', 'seeds', 'rewritable.html'), 'utf8');
  const m = /unknown_asset_reference: '([^']+)'/.exec(seed);
  assert.ok(m, 'seed carries the hint');
  assert.equal(FAILURE_HINTS.unknown_asset_reference, m[1]);
});
