// `rwa new --skin NAME` — emit a pre-skinned container (deterministic, offline,
// no model). A skin is orthogonal to kind, so it composes with --kind: a skinned
// presentation, a skinned document are both valid. The theme block is prepended
// into INLINE_DOC *after* the seed substitutions (the rwa import ordering lesson),
// so the skin CSS can't false-match a substitution regex.
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
const mkTmp = () => mkdtemp(join(tmpdir(), 'rwa-newskin-'));

test('rwa new --skin NAME bakes the skin block into the emitted container', async () => {
  const dir = await mkTmp();
  try {
    const out = join(dir, 'doc.html');
    await run(['new', '--skin', 'notion-clean', out]);
    const file = await readFile(out, 'utf8');
    const body = extractInlineDoc(file);
    assert.match(body, /<style data-rwa-skin="notion-clean">/);
    // deterministic: the skin attribute is in the body, so `rwa doc` could read it
    assert.equal((body.match(/data-rwa-skin/g) || []).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--skin composes with --kind (skin is orthogonal to kind)', async () => {
  const dir = await mkTmp();
  try {
    const out = join(dir, 'deck.html');
    await run(['new', '--kind', 'presentation', '--skin', 'editorial-serif', out]);
    const file = await readFile(out, 'utf8');
    assert.match(file, /const PRODUCT_KIND = 'presentation'/, 'kind preserved');
    assert.match(extractInlineDoc(file), /<style data-rwa-skin="editorial-serif">/, 'skin applied');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rwa new with no --skin is unskinned (no skin block)', async () => {
  const dir = await mkTmp();
  try {
    const out = join(dir, 'plain.html');
    await run(['new', out]);
    assert.doesNotMatch(extractInlineDoc(await readFile(out, 'utf8')), /data-rwa-skin/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rwa new --skin <unknown> exits 2 naming the known skins', async () => {
  const dir = await mkTmp();
  try {
    await assert.rejects(run(['new', '--skin', 'no-such', join(dir, 'x.html')]), (err) => {
      assert.equal(err.code, 2);
      const msg = String(err.stderr || '');
      assert.match(msg, /no-such/);
      assert.match(msg, /notion-clean/);
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
