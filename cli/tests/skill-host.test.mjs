// TDD — the `skill-host` PRODUCT_KIND (v0.8 spec §2). A skill-host carries the
// skill runtime; its INLINE_DOC stub ships an empty frozen #rwa-skills zone that
// the runtime (never the agent) rewrites on install/uninstall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_KINDS, kindOverrides } from '../src/seed.mjs';

const RWA_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rwa.mjs');

test('skill-host is a known kind with the expected override shape', () => {
  assert.ok(KNOWN_KINDS.includes('skill-host'));
  const o = kindOverrides('skill-host');
  assert.equal(o.lensClickToAnchor, false); // not prose-anchored
  assert.match(o.body, /<div data-rwa-frozen id="rwa-skills"><\/div>/); // empty frozen skill zone
});

test('rwa new --kind skill-host emits a valid skill-host container', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-sh-'));
  const p = join(dir, 'host.html');
  try {
    execFileSync('node', [RWA_BIN, 'new', '--kind', 'skill-host', p], { stdio: 'pipe' });
    const file = readFileSync(p, 'utf8');
    assert.match(file, /const PRODUCT_KIND = 'skill-host';/);
    assert.match(file, /<div data-rwa-frozen id="rwa-skills"><\/div>/);

    const sd = JSON.parse(execFileSync('node', [RWA_BIN, 'doc', p, '--json'], { stdio: 'pipe' }).toString());
    assert.equal(sd.kind, 'skill-host');
    assert.deepEqual(sd.affordances, []); // no installed skills yet (empty zone)
    assert.equal(sd.rewritable, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
