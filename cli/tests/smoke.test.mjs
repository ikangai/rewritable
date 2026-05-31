// Smoke tests: the CLI bin and every src module must PARSE and the bin must
// boot. These exist because a syntax error in bin/rwa.mjs (e.g. an unescaped
// backtick inside the HELP template literal) otherwise surfaces only indirectly
// — as a confusing "Unexpected identifier" failure inside whatever child-process
// test happens to spawn the bin first. These turn that into a single, obvious,
// fail-loud signal (CLAUDE.md Rule 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const BIN = join(here, '..', 'bin', 'rwa.mjs');

test('bin/rwa.mjs passes node --check (parses)', async () => {
  // WHY: a parse error in the bin breaks EVERY command; catch it here with a
  // clear message rather than as a cascade of opaque child-process failures.
  await execFileP('node', ['--check', BIN]); // throws (rejects) on a syntax error
});

test('every cli/src/*.mjs passes node --check (parses)', async () => {
  const files = (await readdir(SRC)).filter(n => n.endsWith('.mjs'));
  assert.ok(files.length > 0, 'expected src modules to exist');
  for (const f of files) {
    await execFileP('node', ['--check', join(SRC, f)]); // throws on a syntax error
  }
});

test('rwa --help boots and exits 0 with usage text', async () => {
  // WHY: --check proves the file parses; this proves the module graph actually
  // loads (a bad import / top-level throw would pass --check but crash on boot).
  const { stdout } = await execFileP('node', [BIN, '--help']);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /rwa new/);
});
