// Tests for `rwa skin <file> NAME` — the deterministic, model-free theme-swap
// command (cli/src/skin.mjs → skinCmd). It applies a preset's <style
// data-rwa-skin> block to an existing rewritable through the canonical applyPlan
// write path, so it inherits atomic write + frozen-zone safety + the file-error
// surface for free.
//
// The intent these tests pin (Rule 9 — WHY, not just WHAT):
//  - First skin must INSERT via replace_document, because adding a <style> would
//    trip the structural-shape guard on apply_edits. Re-skin must SWAP via
//    apply_edits (count-stable, surgical). This is the C4 resolution made
//    observable: assert the `mode`.
//  - Exactly one data-rwa-skin block ever exists (re-skin replaces, not stacks).
//  - A skin must NEVER disturb a frozen zone — that's the safety contract that
//    justifies routing through applyPlan rather than a raw write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skinCmd } from '../src/skin.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');
const SKIN_BLOCK_RE = /<style\b[^>]*\bdata-rwa-skin=["']([^"']*)["'][^>]*>[\s\S]*?<\/style>/gi;

function mkFixture(inlineDocBody = '<article><h1>Quarterly review</h1><p>Body.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-skin-test-'));
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

test('applying a skin to an unskinned file INSERTS the block at the top (via replace_document)', async () => {
  const fx = mkFixture('<article><h1>Quarterly review</h1><p>Body.</p></article>');
  try {
    const r = await skinCmd(fx.path, 'notion-clean');
    assert.equal(r.exitCode, 0);
    assert.equal(r.mode, 'insert', 'first skin must use the replace_document insert path');
    assert.equal(r.skin, 'notion-clean');

    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(skinBlocks(body).length, 1, 'exactly one skin block');
    assert.equal(activeSkin(body), 'notion-clean');
    // block is the FIRST thing in the body (the contract: leading child of INLINE_DOC)
    assert.match(body.trimStart(), /^<style data-rwa-skin="notion-clean">/);
    // original content is preserved
    assert.match(body, /<h1>Quarterly review<\/h1>/);
    assert.match(body, /<p>Body\.<\/p>/);
  } finally { fx.cleanup(); }
});

test('re-skinning SWAPS the single block (via apply_edits), never stacking', async () => {
  const fx = mkFixture();
  try {
    await skinCmd(fx.path, 'notion-clean');
    const r = await skinCmd(fx.path, 'editorial-serif');
    assert.equal(r.mode, 'swap', 're-skin over an existing block must use apply_edits');
    assert.equal(r.skin, 'editorial-serif');

    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(skinBlocks(body).length, 1, 'still exactly one skin block (no stacking)');
    assert.equal(activeSkin(body), 'editorial-serif');
    assert.doesNotMatch(body, /data-rwa-skin="notion-clean"/, 'old skin fully replaced');
  } finally { fx.cleanup(); }
});

test('reset removes the skin block, leaving the document otherwise intact', async () => {
  const fx = mkFixture('<article><h1>Plain</h1><p>Keep me.</p></article>');
  try {
    await skinCmd(fx.path, 'linear-dark');
    const r = await skinCmd(fx.path, 'reset');
    assert.equal(r.mode, 'reset');
    assert.equal(r.skin, null);

    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(skinBlocks(body).length, 0, 'no skin block remains');
    assert.match(body, /<h1>Plain<\/h1>/);
    assert.match(body, /<p>Keep me\.<\/p>/);
  } finally { fx.cleanup(); }
});

test('reset on an unskinned file is an idempotent no-op (exit 0, file unchanged)', async () => {
  const fx = mkFixture('<article><h1>Bare</h1></article>');
  try {
    const before = readFileSync(fx.path, 'utf8');
    const r = await skinCmd(fx.path, 'reset');
    assert.equal(r.exitCode, 0);
    assert.equal(r.mode, 'noop');
    assert.equal(readFileSync(fx.path, 'utf8'), before, 'file must be byte-identical (no write)');
  } finally { fx.cleanup(); }
});

test('applying a skin preserves a marker-form frozen zone byte-for-byte', async () => {
  const frozen = '<!-- rwa:frozen:begin notice -->\n<p class="legal">All rights reserved.</p>\n<!-- rwa:frozen:end notice -->';
  const fx = mkFixture(`<article><h1>Doc</h1>\n${frozen}\n<p>After.</p></article>`);
  try {
    const r = await skinCmd(fx.path, 'notion-clean');
    assert.equal(r.exitCode, 0);
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.ok(body.includes(frozen), 'frozen zone bytes must survive a skin apply unchanged');
    assert.equal(activeSkin(body), 'notion-clean');
  } finally { fx.cleanup(); }
});

test('an unknown skin throws exit-2; a missing or non-rewritable file throws exit-2', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(() => skinCmd(fx.path, 'no-such-skin'), (e) => e.exitCode === 2);
    await assert.rejects(() => skinCmd(join(fx.dir, 'nope.html'), 'notion-clean'),
      (e) => e.exitCode === 2 && e.subcode === 'not_found');
    const plain = join(fx.dir, 'plain.txt');
    writeFileSync(plain, 'just text, not a rewritable', 'utf8');
    await assert.rejects(() => skinCmd(plain, 'notion-clean'),
      (e) => e.exitCode === 2 && e.subcode === 'not_a_rewritable');
  } finally { fx.cleanup(); }
});
