// Tests for `rwa upgrade <path>` (issue #12) — re-bootstraps an existing
// container onto the CLI's current seed while preserving DOC_UUID, the
// INLINE_DOC body verbatim, PRODUCT_KIND, <title>, and RWA.FILE.
//
// Why this verb exists: by Invariant 1 a shipped container's bootstrap is
// frozen forever, so a bug fixed in seeds/rewritable.html after a file ships
// stays fixed only for NEW files. These tests pin the load-bearing guard
// (Rule 12): a rebuild that doesn't round-trip DOC_UUID + INLINE_DOC
// byte-for-byte must never be written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadSeed, applySeedSubs, kindOverrides, replaceInlineDoc, extractInlineDoc, seedIdentity } from '../src/seed.mjs';
import { SEED_CANDIDATES } from '../src/commands.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

// Load the seed the EXACT same way `rwa upgrade` (via SEED_CANDIDATES) will —
// not by reading the repo-root seed directly — so these tests stay correct
// even when an in-package cli/seeds/rewritable.html build artifact shadows
// it (the CLI's own dev/publish seed-resolution order; see cli/README.md).
const SEED = await loadSeed(SEED_CANDIDATES);
const CURRENT_SEED_ID = seedIdentity(SEED);

// A byte-mutated seed whose id differs from SEED's, so a container built from
// it needs an upgrade. Inserting a harmless comment just before the bootstrap
// script tag is safe: it doesn't touch any of the single-occurrence markers
// (UUID/TITLE/FILE/rwa-seed/kind regions) applySeedSubs requires exactly once.
const BOOTSTRAP_TAG = '<script id="rwa-bootstrap">';
const bootstrapIdx = SEED.indexOf(BOOTSTRAP_TAG);
if (bootstrapIdx < 0) throw new Error('precondition: seed has no <script id="rwa-bootstrap"> tag');
const MUTATED_SEED = SEED.slice(0, bootstrapIdx) + '<!-- rwa-upgrade-test-mutation -->\n' + SEED.slice(bootstrapIdx);

test('precondition: the mutated seed has a different id than the current seed', () => {
  assert.notEqual(MUTATED_SEED, SEED);
  assert.notEqual(seedIdentity(MUTATED_SEED), CURRENT_SEED_ID);
});

function runRwa(args) {
  return new Promise(resolve => {
    const child = spawn('node', [RWA_BIN, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// Build a full bootstrap for an "old" container from `seed`, via the same
// applySeedSubs/kindOverrides path `rwa new` uses — just called directly so
// the test controls the seed bytes, kind, uuid, title, and FILE precisely.
function mkOldContainer(seed, { kind = 'document', uuid = randomUUID(), title = 'Old Title', fileMeta = 'old.html', body } = {}) {
  const ov = kindOverrides(kind);
  let out = applySeedSubs(seed, {
    uuid, title, fileMeta, productKind: kind,
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  if (body != null) out = replaceInlineDoc(out, body);
  return { uuid, text: out };
}

function mkFixtureFile(text) {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-upgrade-test-'));
  const path = join(dir, 'container.html');
  writeFileSync(path, text, 'utf8');
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── 1. Round-trip: an old (mutated-seed) container upgrades cleanly ───────

test('upgrade: DOC_UUID + INLINE_DOC survive byte-for-byte; seed id becomes current', async () => {
  const body = '<article><h1>Quarterly Report</h1><p>Revenue up 12%.</p></article>';
  const old = mkOldContainer(MUTATED_SEED, { body });
  const fx = mkFixtureFile(old.text);
  try {
    const { code, stdout, stderr } = await runRwa(['upgrade', fx.path]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /upgraded/);
    const after = readFileSync(fx.path, 'utf8');
    assert.equal(extractInlineDoc(after), body);
    assert.match(after, new RegExp(`const DOC_UUID = '${old.uuid}';`));
    const idMatch = after.match(/<meta name="rwa-seed" content="([0-9a-f]{12})">/);
    assert.ok(idMatch, 'rwa-seed meta present after upgrade');
    assert.equal(idMatch[1], CURRENT_SEED_ID);
  } finally { fx.cleanup(); }
});

// ─── 2. Non-default kind keeps PRODUCT_KIND + kind regions ────────────────

test('upgrade: a presentation container keeps PRODUCT_KIND and its kind regions', async () => {
  const old = mkOldContainer(MUTATED_SEED, { kind: 'presentation' });
  const fx = mkFixtureFile(old.text);
  try {
    const { code, stderr } = await runRwa(['upgrade', fx.path]);
    assert.equal(code, 0, stderr);
    const after = readFileSync(fx.path, 'utf8');
    assert.match(after, /const PRODUCT_KIND = 'presentation';/);
    // The presentation kind's lens placeholder is a kind-specific region —
    // its presence proves kindOverrides was re-applied, not just DOC_UUID.
    assert.match(after, /const LENS_PLACEHOLDER = 'Add a slide, or describe a change\.';/);
    assert.match(after, /const LENS_CLICK_TO_ANCHOR = false;/);
  } finally { fx.cleanup(); }
});

// ─── 3. --check / default on an already-current container: no write ───────

test('upgrade --check on an already-current container: no upgrade needed, no write', async () => {
  const old = mkOldContainer(SEED, { title: 'Current' }); // built from the REAL current seed
  const fx = mkFixtureFile(old.text);
  try {
    const before = readFileSync(fx.path, 'utf8');
    const statBefore = statSync(fx.path);
    const { code, stdout, stderr } = await runRwa(['upgrade', fx.path, '--check']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /already at the current seed/);
    const after = readFileSync(fx.path, 'utf8');
    const statAfter = statSync(fx.path);
    assert.equal(after, before, '--check must never write');
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, '--check must never touch mtime');
  } finally { fx.cleanup(); }
});

test('upgrade (default, no flags) on an already-current container: no write, exit 0', async () => {
  const old = mkOldContainer(SEED, { title: 'Current' });
  const fx = mkFixtureFile(old.text);
  try {
    const before = readFileSync(fx.path, 'utf8');
    const { code, stdout, stderr } = await runRwa(['upgrade', fx.path]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /already at the current seed/);
    assert.equal(readFileSync(fx.path, 'utf8'), before, 'an already-current container must not be rewritten');
  } finally { fx.cleanup(); }
});

// ─── 4. A non-rewritable file is refused ───────────────────────────────────

test('upgrade: a non-rewritable file is refused with not_a_rewritable', async () => {
  const fx = mkFixtureFile('<!doctype html><html><body><p>just a page</p></body></html>');
  try {
    const { code, stdout, stderr } = await runRwa(['upgrade', fx.path]);
    assert.equal(code, 2);
    assert.match(stderr, /not_a_rewritable/);
    assert.equal(stdout, '');
  } finally { fx.cleanup(); }
});

// ─── 5. <title> and RWA.FILE are preserved ─────────────────────────────────

test('upgrade: <title> and RWA.FILE are preserved verbatim', async () => {
  const old = mkOldContainer(MUTATED_SEED, { title: 'Quarterly Report — Q3', fileMeta: 'q3-report.html' });
  const fx = mkFixtureFile(old.text);
  try {
    const { code, stderr } = await runRwa(['upgrade', fx.path]);
    assert.equal(code, 0, stderr);
    const after = readFileSync(fx.path, 'utf8');
    assert.match(after, /<title>Quarterly Report — Q3<\/title>/);
    assert.match(after, /FILE\s*:\s*'q3-report\.html'/);
  } finally { fx.cleanup(); }
});

// ─── 6. A frozen zone inside INLINE_DOC survives verbatim ──────────────────

test('upgrade: a frozen zone inside INLINE_DOC is preserved verbatim', async () => {
  const body = [
    '<article><h1>Doc</h1>',
    '<!-- rwa:frozen:begin signature -->',
    '<p>© 2026 — do not alter</p>',
    '<!-- rwa:frozen:end signature -->',
    '<p>Editable.</p></article>',
  ].join('\n');
  const old = mkOldContainer(MUTATED_SEED, { body });
  const fx = mkFixtureFile(old.text);
  try {
    const { code, stderr } = await runRwa(['upgrade', fx.path]);
    assert.equal(code, 0, stderr);
    const after = readFileSync(fx.path, 'utf8');
    assert.equal(extractInlineDoc(after), body);
  } finally { fx.cleanup(); }
});

// ─── 7. --dry-run verifies without writing ─────────────────────────────────

test('upgrade --dry-run: reports the upgrade, verifies the rebuild, never writes', async () => {
  const body = '<article><h1>Dry run</h1></article>';
  const old = mkOldContainer(MUTATED_SEED, { body });
  const fx = mkFixtureFile(old.text);
  try {
    const before = readFileSync(fx.path, 'utf8');
    const { code, stdout, stderr } = await runRwa(['upgrade', fx.path, '--dry-run']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /would upgrade/);
    assert.equal(readFileSync(fx.path, 'utf8'), before, '--dry-run must never write');
  } finally { fx.cleanup(); }
});

// ─── 8. An unterminated INLINE_DOC literal is a distinct refusal ──────────

test('upgrade: an unterminated INLINE_DOC literal is refused as inline_doc_unterminated', async () => {
  const old = mkOldContainer(MUTATED_SEED, { body: '<article>fine</article>' });
  // Corrupt the closing backtick of INLINE_DOC so the literal never
  // terminates, while keeping id="rwa-bootstrap" and the marker itself intact.
  const marker = 'const INLINE_DOC = `';
  const start = old.text.indexOf(marker);
  assert.ok(start >= 0, 'precondition: marker present');
  const corrupted = old.text.slice(0, start) + marker + old.text.slice(start + marker.length).replace(/`/g, '');
  const fx = mkFixtureFile(corrupted);
  try {
    const { code, stdout, stderr } = await runRwa(['upgrade', fx.path]);
    assert.equal(code, 2);
    assert.match(stderr, /inline_doc_unterminated/);
    assert.equal(stdout, '');
  } finally { fx.cleanup(); }
});

// ─── Usage ──────────────────────────────────────────────────────────────

test('upgrade: missing file arg is a usage error', async () => {
  const { code, stderr } = await runRwa(['upgrade']);
  assert.equal(code, 1);
  assert.match(stderr, /missing_file_arg/);
});
