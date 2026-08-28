// Stale-seed detection (#18).
//
// WHY (Rule 9): `seeds/rewritable.html` is canonical, but copies of it live elsewhere, and the audit
// that produced this gave a clean natural experiment — the ONE copy with an automated gate (the
// references, via the refs-fresh CI job) stayed correct, while both ungated copies rotted:
// `cli/seeds/` three times in one day, the vendored authoring skill by two months.
//
// `cli/seeds/` was the dangerous one: gitignored, so pulling never refreshes it, and FIRST in the
// seed-load order, so it silently made `rwa new` emit a week-old runtime.
//
// DETECT, not fix: loading a seed must never rewrite or delete a file as a side effect.
//
// SCOPE NOTE (#49): these test `loadSeed`/`seedStaleness` as the general multi-candidate helper they
// are. The CLI's own resolution no longer goes through that path — `SEED_CANDIDATES` now yields
// exactly one seed, the canonical one in a dev checkout, so nothing can shadow anything. That is
// pinned separately, on emitted bytes, by `seed-resolution.test.mjs`. Kept rather than deleted
// because the helper is still the documented primitive for "several copies, which wins", which
// `tools/check-seeds.mjs` reports on — but read these as tests of a function, not as evidence that
// the shipped CLI still has a shadowing hazard to warn about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeed, seedStaleness, seedIdentity } from '../src/seed.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANON = fs.readFileSync(path.join(REPO, 'seeds', 'rewritable.html'), 'utf8');

test('seedStaleness: a single present candidate is never stale', () => {
  // This is the PUBLISHED PACKAGE shape — cli/seeds is the only seed there. The warning must be
  // structurally impossible for a real user, not merely unlikely.
  assert.equal(seedStaleness([{ path: 'a', text: 'x' }]), null);
  assert.equal(seedStaleness([{ path: 'a', text: 'x' }, { path: 'b', text: null }]), null);
});

test('seedStaleness: identical copies are not stale', () => {
  assert.equal(seedStaleness([{ path: 'a', text: CANON }, { path: 'b', text: CANON }]), null);
});

test('seedStaleness: a differing loser is reported, with both identities', () => {
  const older = CANON.replace('<title>re-writeable</title>', '<title>re-writeable OLD</title>');
  assert.notEqual(older, CANON, 'precondition: the mutation applied');
  const r = seedStaleness([{ path: '/win', text: older }, { path: '/lose', text: CANON }]);
  assert.ok(r, 'staleness should be detected');
  assert.equal(r.using, '/win');
  assert.equal(r.usingSeedId, seedIdentity(older));
  assert.equal(r.shadowed.length, 1);
  assert.equal(r.shadowed[0].path, '/lose');
  assert.equal(r.shadowed[0].seedId, seedIdentity(CANON));
});

test('seedStaleness reports the WINNER as the one in use — the direction matters', () => {
  // The whole hazard is that the stale copy wins. A report naming the fresh one as "using" would
  // send someone to fix the wrong file.
  const older = CANON.replace('re-writeable</title>', 'older</title>');
  const r = seedStaleness([{ path: '/in-package', text: older }, { path: '/repo', text: CANON }]);
  assert.equal(r.using, '/in-package', 'the first present candidate is what gets used');
});

test('loadSeed returns the first present candidate and warns when shadowing a different one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rwa-stale-'));
  const win = path.join(dir, 'win.html');
  const lose = path.join(dir, 'lose.html');
  writeFileSync(win, CANON.replace('<title>re-writeable</title>', '<title>stale</title>'));
  writeFileSync(lose, CANON);

  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  let text;
  try { text = await loadSeed([win, lose]); } finally { process.stderr.write = realWrite; }

  assert.match(text, /<title>stale<\/title>/, 'the FIRST candidate is what is used');
  const out = written.join('');
  assert.match(out, /shadows a different one/, 'it must warn');
  assert.match(out, /fix: cp /, 'the warning must carry the fix, not just the complaint');
});

test('loadSeed is silent when the candidates agree', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rwa-fresh-'));
  const a = path.join(dir, 'a.html');
  const b = path.join(dir, 'b.html');
  writeFileSync(a, CANON); writeFileSync(b, CANON);

  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  try { await loadSeed([a, b], { warn: true }); } finally { process.stderr.write = realWrite; }
  assert.equal(written.join(''), '', 'no noise when there is nothing wrong');
});

test('loadSeed still throws a useful error when no candidate exists', async () => {
  await assert.rejects(() => loadSeed(['/nope/a.html', '/nope/b.html']), /seed not found in any of/);
});
