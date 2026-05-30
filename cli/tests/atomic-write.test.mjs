// Tests for atomicWrite (cli/src/atomic-write.mjs).
//
// `rwa edit` writes the rebuilt container to a sibling temp file, fsyncs it, and
// rename(2)s it over the target — crash-safe. The bug this pins: a failure during
// writeFile/datasync used to leave the `.rwa-tmp-<pid>` file behind (only the
// rename-failure path cleaned up). atomicWrite now removes the temp on ANY
// failure. `deps` is injectable so the disk-failure cleanup is deterministic to
// test without actually failing a real disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/atomic-write.mjs';

const tmpName = (filePath) => `${filePath}.rwa-tmp-${process.pid}`;

// A fake fs that fails at a chosen step, recording the calls it saw.
function fakeDeps(failAt) {
  const calls = [];
  const handle = {
    writeFile: async () => { calls.push('writeFile'); if (failAt === 'write') throw new Error('boom-write'); },
    datasync: async () => { calls.push('datasync'); if (failAt === 'datasync') throw new Error('boom-datasync'); },
    close: async () => { calls.push('close'); },
  };
  return {
    calls,
    deps: {
      open: async (t) => { calls.push('open:' + t); return handle; },
      rename: async () => { calls.push('rename'); if (failAt === 'rename') throw new Error('boom-rename'); },
      unlink: async (t) => { calls.push('unlink:' + t); },
    },
  };
}

// ─── Happy path (real fs) ─────────────────────────────────────────────

test('writes the content atomically and leaves no temp file behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-aw-'));
  const f = join(dir, 'doc.html');
  try {
    writeFileSync(f, 'OLD');
    await atomicWrite(f, 'NEW CONTENT');
    assert.equal(readFileSync(f, 'utf8'), 'NEW CONTENT');
    // No .rwa-tmp-* sibling survives a successful write.
    assert.deepEqual(readdirSync(dir).filter(n => n.includes('.rwa-tmp-')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── Failure cleanup (the bug): the temp must never leak ──────────────

for (const failAt of ['write', 'datasync', 'rename']) {
  test(`a ${failAt} failure removes the temp file and re-throws (no leak)`, async () => {
    const f = '/some/where/doc.html';
    const { calls, deps } = fakeDeps(failAt);
    await assert.rejects(atomicWrite(f, 'X', deps), new RegExp(`boom-${failAt === 'write' ? 'write' : failAt}`));
    // The cleanup unlinked exactly the temp path we wrote to.
    assert.ok(calls.includes('unlink:' + tmpName(f)), `expected unlink of ${tmpName(f)}; calls: ${calls.join(',')}`);
  });
}

test('a real-fs write to an unwritable target leaves no temp file', async () => {
  // Force a rename failure with real fs: rename onto a path that is a directory.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-aw-'));
  const target = join(dir, 'isdir');
  try {
    // mkdir target so rename(tmp, target) fails (can't replace a non-empty dir / type clash)
    writeFileSync(join(dir, 'isdir-marker'), 'x'); // ensure dir non-empty later
    const fs = await import('node:fs/promises');
    await fs.mkdir(target);
    await fs.writeFile(join(target, 'child'), 'x'); // non-empty dir → rename over it fails
    await assert.rejects(atomicWrite(target, 'NEW'));
    // The temp must be gone even though the rename failed.
    assert.equal(existsSync(tmpName(target)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
