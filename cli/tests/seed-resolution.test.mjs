// Which seed does the CLI actually emit from? (#49)
//
// `cli/seeds/rewritable.html` is gitignored and written only by `prepublishOnly`.
// It used to be FIRST in the seed-load order, which is right in a published
// package (it is the only seed there) and wrong in a dev checkout, where it beat
// the repo-canonical `seeds/rewritable.html`. That produced two failures:
//
//   staleness   — a leftover copy is never refreshed by pulling, so it silently
//                 made `rwa new` emit a week-old runtime (three times in a day)
//   concurrency — the refresh is a hand-typed, non-atomic `cp` in a checkout
//                 several agents share, so a suite can read it mid-replacement
//
// Both come from a gitignored file WINNING a load order, so the fix resolves the
// canonical seed directly and the in-package copy is not read at all in a dev
// checkout. This pins that, and it is the replacement for the `seed_ambiguous`
// refusal `rwa upgrade` used to carry — a guard whose premise the fix removes.
//
// It asserts on EMITTED BYTES, not on the value of SEED_CANDIDATES. The constant
// is computed at module load from the module's own location, so a test that
// imported it would only ever see this checkout's answer; and the property that
// matters to a user is which seed came out, not which path was chosen.
//
// The identity check rides `<meta name="rwa-seed">` — sha-256 over the source
// seed's bytes, stamped by applySeedSubs. Title or body markers would not
// survive, because `rwa new` substitutes both.
//
// It runs the real bin from a fabricated tree with NO node_modules, which works
// because the eager import graph is dependency-free (see eager-deps.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seedIdentity } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..');
const REPO = join(CLI, '..');
const CANON = readFileSync(join(REPO, 'seeds', 'rewritable.html'), 'utf8');
// A second, genuinely different seed. A trailing comment changes the bytes (and
// so the identity) while leaving a fully valid container to emit from.
const OTHER = CANON + '\n<!-- a different seed -->\n';

const CANON_ID = seedIdentity(CANON);
const OTHER_ID = seedIdentity(OTHER);
assert.notEqual(CANON_ID, OTHER_ID, 'precondition: the two fixtures are distinguishable');

/**
 * Fabricate a tree shaped like either a dev checkout or an installed package.
 * `marker` controls which: the repo-root file whose presence means "the
 * canonical seed is reachable beside us".
 */
function makeTree({ marker, repoSeed, inPackageSeed }) {
  const root = mkdtempSync(join(tmpdir(), 'rwa-seedres-'));
  if (marker) writeFileSync(join(root, 're-write-able-spec.md'), '# marker\n');
  if (repoSeed != null) {
    mkdirSync(join(root, 'seeds'), { recursive: true });
    writeFileSync(join(root, 'seeds', 'rewritable.html'), repoSeed);
  }
  // Only what the eager graph needs — no node_modules, by design.
  mkdirSync(join(root, 'cli'), { recursive: true });
  cpSync(join(CLI, 'src'), join(root, 'cli', 'src'), { recursive: true });
  cpSync(join(CLI, 'bin'), join(root, 'cli', 'bin'), { recursive: true });
  cpSync(join(CLI, 'package.json'), join(root, 'cli', 'package.json'));
  if (inPackageSeed != null) {
    mkdirSync(join(root, 'cli', 'seeds'), { recursive: true });
    writeFileSync(join(root, 'cli', 'seeds', 'rewritable.html'), inPackageSeed);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** `rwa new` in the fabricated tree; returns the emitted seed identity. */
function emitAndReadSeedId(root) {
  const out = join(root, 'out.html');
  const r = spawnSync(process.execPath, [join(root, 'cli', 'bin', 'rwa.mjs'), 'new', out],
    { encoding: 'utf8', cwd: root });
  return { r, id: existsSync(out) ? (readFileSync(out, 'utf8').match(/<meta name="rwa-seed" content="([0-9a-f]+)"/) || [])[1] : null };
}

test('#49: a dev checkout emits from the CANONICAL seed, ignoring a different cli/seeds/', () => {
  // The exact condition that used to bite: both seeds exist and disagree.
  const t = makeTree({ marker: true, repoSeed: CANON, inPackageSeed: OTHER });
  try {
    const { r, id } = emitAndReadSeedId(t.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(id, CANON_ID, 'the tracked seed is what gets emitted');
    assert.notEqual(id, OTHER_ID, 'the gitignored copy did not win');
  } finally { t.cleanup(); }
});

test('#49: …and it does not merely prefer the canonical bytes — the other copy is UNREAD', () => {
  // Same tree, but the in-package copy is not a seed at all. If it were still
  // being read, this would fail or warn; the point of the fix is that the file
  // is out of the path entirely, so a torn or corrupt one cannot matter.
  const t = makeTree({ marker: true, repoSeed: CANON, inPackageSeed: '<<< truncated mid-write' });
  try {
    const { r, id } = emitAndReadSeedId(t.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(id, CANON_ID);
    assert.doesNotMatch(r.stderr, /shadows a different one/,
      'and no stale-seed warning: there is nothing being shadowed any more');
  } finally { t.cleanup(); }
});

test('#49 negative control: without the repo marker, the IN-PACKAGE seed is used', () => {
  // The published-package shape, and the control that proves the two tests above
  // are measuring resolution rather than passing for some unrelated reason. A
  // fixture that produced the canonical seed here would mean the marker is not
  // what decides — and would also mean an installed `rwa` had stopped working.
  const t = makeTree({ marker: false, repoSeed: CANON, inPackageSeed: OTHER });
  try {
    const { r, id } = emitAndReadSeedId(t.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(id, OTHER_ID, 'an installed package emits from its own bundled seed');
  } finally { t.cleanup(); }
});

test('#49: THIS checkout resolves the canonical seed — the marker still exists', async () => {
  // The fabricated trees above write their own marker, so they would keep passing
  // if the real `re-write-able-spec.md` were renamed or removed: commands.mjs
  // would stop finding it, every dev checkout would silently fall back to
  // `cli/seeds/`, and the trap would be back with no test going red.
  //
  // So this one asserts against the real repository rather than a fixture. It is
  // the only test here that may legitimately need updating if the marker changes
  // — and it will say so by failing, which is the point.
  const { SEED_CANDIDATES } = await import('../src/commands.mjs');
  assert.equal(SEED_CANDIDATES.length, 1, 'exactly one seed is resolvable');
  assert.equal(SEED_CANDIDATES[0], join(REPO, 'seeds', 'rewritable.html'),
    'a dev checkout must resolve the canonical seed; if this fails, check that the marker '
    + 'file commands.mjs looks for still exists at the repo root');
});

test('#49: a checkout with the marker but no canonical seed FAILS LOUDLY', () => {
  // Deliberately not a fallback. Falling back to cli/seeds/ here would rebuild
  // the shadowing this removes, and would do it in the one situation where the
  // two are most likely to disagree.
  const t = makeTree({ marker: true, repoSeed: null, inPackageSeed: OTHER });
  try {
    const { r } = emitAndReadSeedId(t.root);
    assert.notEqual(r.status, 0, 'must not silently emit different bytes');
    assert.match(r.stderr, /seed not found/i);
  } finally { t.cleanup(); }
});
