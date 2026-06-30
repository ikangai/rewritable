// Bin-level arg wiring for `rwa import` flags that take a VALUE. Regression: `--target-fidelity`
// was absent from the positional filter, so its value leaked into the positionals — silently
// misrouting the output path (`import doc --target-fidelity 0.9` wrote a file literally named "0.9")
// or the input path (reversed order tried to import "0.9"). A .txt import isolates the arg parsing
// (no pdf.js, offline, and the fidelity loop is PDF-only so the flag is otherwise inert here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const RWA = join(here, '..', 'bin', 'rwa.mjs');
const run = (args, cwd) => execFileP('node', [RWA, ...args], { cwd });
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function withNote(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rwa-importargs-'));
  try { await writeFile(join(dir, 'note.txt'), 'Hello world.\n\nSecond paragraph.\n'); await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('--target-fidelity <n> after the file does NOT become the output path', async () => {
  // WHY: the value must be consumed by the flag, not treated as outPath. The bug wrote "0.9".
  await withNote(async (dir) => {
    await run(['import', 'note.txt', '--target-fidelity', '0.9'], dir);
    assert.ok(await exists(join(dir, 'note.html')), 'note.html should be written');
    assert.ok(!(await exists(join(dir, '0.9'))), 'must NOT write a file named "0.9"');
  });
});

test('--target-fidelity <n> before the file does NOT become the input path', async () => {
  // WHY: the bug made inputPath="0.9" → "file not found"; the real file must still import.
  await withNote(async (dir) => {
    await run(['import', '--target-fidelity', '0.9', 'note.txt'], dir);
    assert.ok(await exists(join(dir, 'note.html')), 'note.html should be written');
  });
});

test('--no-escalate (valueless) leaves the positionals intact', async () => {
  await withNote(async (dir) => {
    await run(['import', 'note.txt', '--no-escalate'], dir);
    assert.ok(await exists(join(dir, 'note.html')), 'note.html should be written');
  });
});
