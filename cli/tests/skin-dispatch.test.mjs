// `rwa skin <file> <name|reset>` dispatch — the bin wiring over src/skin.mjs.
// Pins the user-facing contract: exit 0 + confirmation on apply/reset, --json
// emits the structured result, an unknown skin exits 2 naming the known list,
// and missing args exits 1 (usage). The deterministic theme-only behavior is
// what ships in v1; the always-on restyle is a later phase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInlineDoc } from '../src/seed.mjs';

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const RWA = join(here, '..', 'bin', 'rwa.mjs');
const run = (args, cwd) => execFileP('node', [RWA, ...args], { cwd });

async function mkDoc() {
  const dir = await mkdtemp(join(tmpdir(), 'rwa-skin-disp-'));
  const path = join(dir, 'doc.html');
  await run(['new', path]);
  return { dir, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('rwa skin <file> NAME applies the preset block and confirms (exit 0)', async () => {
  const fx = await mkDoc();
  try {
    const { stdout } = await run(['skin', fx.path, 'notion-clean']);
    assert.match(stdout, /notion-clean/, 'confirmation names the skin');
    const body = extractInlineDoc(await readFile(fx.path, 'utf8'));
    assert.match(body, /<style data-rwa-skin="notion-clean">/);
  } finally { await fx.cleanup(); }
});

test('rwa skin <file> reset removes the block', async () => {
  const fx = await mkDoc();
  try {
    await run(['skin', fx.path, 'linear-dark']);
    await run(['skin', fx.path, 'reset']);
    const body = extractInlineDoc(await readFile(fx.path, 'utf8'));
    assert.doesNotMatch(body, /data-rwa-skin/, 'reset leaves no skin block');
  } finally { await fx.cleanup(); }
});

test('rwa skin <file> NAME --json prints the structured result on stdout', async () => {
  const fx = await mkDoc();
  try {
    const { stdout } = await run(['skin', fx.path, 'editorial-serif', '--json']);
    const obj = JSON.parse(stdout);
    assert.equal(obj.skin, 'editorial-serif');
    assert.equal(obj.mode, 'insert');
    assert.equal(obj.exitCode, 0);
  } finally { await fx.cleanup(); }
});

test('rwa skin <file> <unknown> exits 2 and lists the known skins', async () => {
  const fx = await mkDoc();
  try {
    await assert.rejects(run(['skin', fx.path, 'nope-skin']), (err) => {
      assert.equal(err.code, 2, 'unknown skin exits 2');
      const msg = String(err.stderr || '');
      assert.match(msg, /nope-skin/);
      assert.match(msg, /notion-clean/, 'lists a known skin');
      return true;
    });
  } finally { await fx.cleanup(); }
});

test('rwa skin with missing args exits 1 (usage)', async () => {
  await assert.rejects(run(['skin']), (err) => {
    assert.equal(err.code, 1);
    assert.match(String(err.stderr || ''), /skin/i);
    return true;
  });
});
