// Tests for `rwa doctor <path>` (issue #23) — a standalone, offline,
// read-only health check for a rewritable container.
//
// Why this verb exists: the edit-validation battery (frozen-zone integrity,
// size caps, asset tokens, structural balance) previously only ran as a SIDE
// EFFECT of an actual `rwa edit`. There was no way to ask "is this container
// currently valid?" of a received, hand-edited, or years-old file. These
// tests pin: (1) a clean container reports all-green and exits 0, (2) each
// deliberately-broken fixture produces its OWN distinct finding id at
// error severity and exits 5, (3) warn-only findings still exit 0
// ("warnings are fine"), (4) the verb never writes to the target file, and
// (5) the file-error surface mirrors `rwa doc` exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadSeed, applySeedSubs, kindOverrides, replaceInlineDoc, extractInlineDoc, seedIdentity } from '../src/seed.mjs';
import { SEED_CANDIDATES } from '../src/commands.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

const SEED = await loadSeed(SEED_CANDIDATES);
const CURRENT_SEED_ID = seedIdentity(SEED);

function runRwa(args) {
  return new Promise(resolve => {
    const child = spawn('node', [RWA_BIN, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// Same fixture pattern as doc.test.mjs / upgrade.test.mjs: `rwa new` lays
// down a valid, CURRENT-seed bootstrap, then replaceInlineDoc swaps in a
// caller-supplied body via the production splice.
function mkFixture(inlineDocBody = '<article><h1>Hello</h1><p>Body.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-doctor-test-'));
  const path = join(dir, 'test.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  if (inlineDocBody !== null) {
    const current = readFileSync(path, 'utf8');
    writeFileSync(path, replaceInlineDoc(current, inlineDocBody), 'utf8');
  }
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A byte-mutated seed whose id differs from the current one — mirrors
// upgrade.test.mjs's MUTATED_SEED — so a container built from it exercises
// the seed_freshness mismatch path.
const BOOTSTRAP_TAG = '<script id="rwa-bootstrap">';
const bootstrapIdx = SEED.indexOf(BOOTSTRAP_TAG);
if (bootstrapIdx < 0) throw new Error('precondition: seed has no <script id="rwa-bootstrap"> tag');
const MUTATED_SEED = SEED.slice(0, bootstrapIdx) + '<!-- rwa-doctor-test-mutation -->\n' + SEED.slice(bootstrapIdx);

function mkOldSeedFixture(body) {
  const ov = kindOverrides('document');
  let out = applySeedSubs(MUTATED_SEED, {
    uuid: randomUUID(), title: 'Old Seed', fileMeta: 'old.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  out = replaceInlineDoc(out, body);
  const dir = mkdtempSync(join(tmpdir(), 'rwa-doctor-test-'));
  const path = join(dir, 'old.html');
  writeFileSync(path, out, 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function findingById(result, id) {
  return result.findings.find(f => f.id === id);
}

// ─── Clean container: all-green report ─────────────────────────────────

test('a freshly-created container is all-green: exit 0, ok:true, no errors or warnings', async () => {
  const fx = mkFixture();
  try {
    const { code, stdout, stderr } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.match(result.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(result.kind, 'document');
    assert.ok(Array.isArray(result.findings) && result.findings.length > 0);
    const bad = result.findings.filter(f => f.severity !== 'info');
    assert.deepEqual(bad, [], `expected no non-info findings; got: ${JSON.stringify(bad)}`);
    // Every declared check id is present — Rule 12: never silently omit a check.
    const ids = result.findings.map(f => f.id).sort();
    assert.deepEqual(ids, [
      'asset_tokens', 'block_ids', 'frozen_attr', 'frozen_unterminated',
      'frozen_zones', 'reserved_id', 'seed_freshness', 'size_headroom', 'tag_balance',
    ].sort());
    // Fresh `rwa new` output is built from the CLI's own current seed.
    assert.equal(findingById(result, 'seed_freshness').currentSeedId, CURRENT_SEED_ID);
  } finally { fx.cleanup(); }
});

test('plain mode prints a compact human-readable report ending in an OK summary', async () => {
  const fx = mkFixture();
  try {
    const { code, stdout, stderr } = await runRwa(['doctor', fx.path]);
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /^rwa doctor: /);
    assert.match(stdout, /\[INFO\] frozen_zones:/);
    assert.match(stdout, /OK — \d+ checks, 0 errors, 0 warnings/);
  } finally { fx.cleanup(); }
});

test('never writes to the target file (read-only)', async () => {
  const fx = mkFixture();
  try {
    const before = readFileSync(fx.path, 'utf8');
    const beforeMtime = statSync(fx.path).mtimeMs;
    await runRwa(['doctor', fx.path, '--json']);
    const after = readFileSync(fx.path, 'utf8');
    assert.equal(after, before, 'doctor must not modify the file bytes');
    assert.equal(statSync(fx.path).mtimeMs, beforeMtime, 'doctor must not even touch mtime');
  } finally { fx.cleanup(); }
});

// ─── Deliberately broken fixtures: each produces its OWN distinct finding ──

test('frozen_unterminated: an unterminated frozen-zone marker is an error finding, exit 5', async () => {
  const body = '<article><h1>Doc</h1>\n<!-- rwa:frozen:begin sig -->\n<p>No matching end marker.</p></article>';
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 5);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    const f = findingById(result, 'frozen_unterminated');
    assert.equal(f.severity, 'error');
    assert.equal(f.zone, 'sig');
    // No other check should misfire off the back of this one fixture.
    assert.equal(findingById(result, 'tag_balance').severity, 'info');
  } finally { fx.cleanup(); }
});

test('tag_balance: an unclosed <script> tag is an error finding, exit 5', async () => {
  const body = '<article><h1>Doc</h1><script>var x = 1;</article>';
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 5);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    const f = findingById(result, 'tag_balance');
    assert.equal(f.severity, 'error');
    assert.equal(f.opens.script, 1);
    assert.equal(f.closes.script, 0);
  } finally { fx.cleanup(); }
});

test('asset_tokens: an unbacked rwa-asset token is an error finding, exit 5', async () => {
  const body = '<article><h1>Doc</h1><img src="rwa-asset:deadbeef12" alt="broken"></article>';
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 5);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    const f = findingById(result, 'asset_tokens');
    assert.equal(f.severity, 'error');
    assert.deepEqual(f.tokens, ['rwa-asset:deadbeef12']);
  } finally { fx.cleanup(); }
});

test('reserved_id: id="rwa-doc-mount" inside the body is an error finding, exit 5', async () => {
  const body = '<article><h1>Doc</h1><div id="rwa-doc-mount">hijack</div></article>';
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 5);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    assert.equal(findingById(result, 'reserved_id').severity, 'error');
  } finally { fx.cleanup(); }
});

test('size_headroom: a document over MAX_DOC is an error finding, exit 5', async () => {
  const big = 'x'.repeat(1024 * 1024 + 1024);
  const body = `<article><h1>Doc</h1><p>${big}</p></article>`;
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 5);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    const f = findingById(result, 'size_headroom');
    assert.equal(f.severity, 'error');
    assert.equal(f.cap, 1024 * 1024);
    assert.ok(f.bytes > f.cap);
  } finally { fx.cleanup(); }
});

test('frozen_attr: an unterminated data-rwa-frozen element is an error finding, exit 5', async () => {
  // <div data-rwa-frozen> with no closing </div> anywhere in the document.
  const body = '<article><h1>Doc</h1><div data-rwa-frozen><p>never closes</article>';
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 5);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    const f = findingById(result, 'frozen_attr');
    assert.equal(f.severity, 'error');
    assert.deepEqual(f.elements, ['div']);
  } finally { fx.cleanup(); }
});

// ─── Warn-only findings: still exit 0 ("warnings are fine") ────────────────

test('block_ids: duplicate data-rwa-id values are a warning, not an error — exit 0', async () => {
  const body = '<article><h1>Doc</h1>'
    + '<p data-rwa-id="dup12345">First.</p>'
    + '<p data-rwa-id="dup12345">Second.</p></article>';
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, 'a warn-only report must still be ok:true / exit 0');
    const f = findingById(result, 'block_ids');
    assert.equal(f.severity, 'warn');
    assert.deepEqual(f.duplicates, ['dup12345']);
  } finally { fx.cleanup(); }
});

// Regression: size_headroom measured the RAW document, so a document holding a
// megabyte of embedded images was reported over cap and FAILED, while its real
// edit budget was untouched — applyEdits caps the VIRTUAL (rwa-asset token)
// form, "so image bytes never count against the text budget". A false alarm
// that reads as "delete your content" is worse than no meter at all.
test('size_headroom: image bytes do not count against the text budget', async () => {
  // ~1.5 MB of image data — well over MAX_DOC raw, ~nothing once virtualized.
  const dataUri = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024 + 512 * 1024);
  const body = `<article><h1>Chart</h1><p>One line of prose.</p><img src="${dataUri}" alt="chart"></article>`;
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    const result = JSON.parse(stdout);
    const f = findingById(result, 'size_headroom');
    assert.equal(f.severity, 'info', 'an image-heavy document has text headroom');
    assert.ok(f.bytes < 4096, `virtualized size should be tiny, got ${f.bytes}`);
    assert.equal(code, 0);
  } finally { fx.cleanup(); }
});

test('size_headroom: >=80% of MAX_DOC is a warning, not an error — exit 0', async () => {
  const filler = 'x'.repeat(Math.ceil(1024 * 1024 * 0.85));
  const body = `<article><h1>Doc</h1><p>${filler}</p></article>`;
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    const f = findingById(result, 'size_headroom');
    assert.equal(f.severity, 'warn');
    assert.ok(f.pct >= 80 && f.pct < 100, `expected pct in [80,100); got ${f.pct}`);
  } finally { fx.cleanup(); }
});

test('seed_freshness: a container built from an older seed is a warning, not an error — exit 0', async () => {
  const fx = mkOldSeedFixture('<article><h1>Old</h1><p>Body.</p></article>');
  try {
    const { code, stdout } = await runRwa(['doctor', fx.path, '--json']);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    const f = findingById(result, 'seed_freshness');
    assert.equal(f.severity, 'warn');
    assert.notEqual(f.currentSeedId, f.targetSeedId);
    assert.equal(f.targetSeedId, CURRENT_SEED_ID);
  } finally { fx.cleanup(); }
});

// ─── Error surface (mirrors `rwa doc` file_error codes) ────────────────────

test('exit 2 not_found — missing file', async () => {
  const { code, stdout, stderr } = await runRwa(['doctor', '/tmp/does-not-exist-rwa-doctor.html']);
  assert.equal(code, 2);
  assert.match(stderr, /not_found/);
  assert.equal(stdout, '');
});

test('exit 2 not_a_rewritable — a non-rewritable file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-doctor-test-'));
  const path = join(dir, 'plain.html');
  writeFileSync(path, '<!doctype html><html><body><p>just a page</p></body></html>', 'utf8');
  try {
    const { code, stdout, stderr } = await runRwa(['doctor', path]);
    assert.equal(code, 2);
    assert.match(stderr, /not_a_rewritable/);
    assert.equal(stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exit 1 missing_file_arg — no path given', async () => {
  const { code, stderr } = await runRwa(['doctor']);
  assert.equal(code, 1);
  assert.match(stderr, /missing_file_arg/);
});

test('--json error is structured JSON on stderr (not stdout)', async () => {
  const { code, stdout, stderr } = await runRwa(['doctor', '/tmp/nope-rwa-doctor.html', '--json']);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  const payload = JSON.parse(stderr.trim());
  assert.equal(payload.code, 'file_error');
  assert.equal(payload.subcode, 'not_found');
});

// Sanity: extractInlineDoc/replaceInlineDoc round-trip used by mkFixture
// actually produces the body doctor reads — otherwise every test above would
// be silently checking the wrong bytes.
test('precondition: mkFixture bodies round-trip through extractInlineDoc', () => {
  const fx = mkFixture('<article><h1>RT</h1></article>');
  try {
    assert.equal(extractInlineDoc(readFileSync(fx.path, 'utf8')), '<article><h1>RT</h1></article>');
  } finally { fx.cleanup(); }
});
