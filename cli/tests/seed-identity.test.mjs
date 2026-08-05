// Derived seed identity — `<meta name="rwa-seed">` (#12).
//
// WHY (Rule 9 — encode the intent): a shipped container's runtime is frozen forever by Invariant 1,
// so every bug fixed after a file ships is fixed only for new files. An upgrade path therefore needs
// to answer "exactly which bootstrap does this container carry". The pre-existing
// `<meta name="rwa-bootstrap" content="0.9">` cannot: it was set 2026-05-16 and 163 seed commits
// landed on top without changing it, so containers spanning images-v1, the skill layer, drop-in AI,
// the artifact bus and boot reconciliation all claim the same version. That marker is the SEMANTIC
// compatibility generation and stays; this one is the identifier.
//
// Stamped in applySeedSubs rather than a build tool because that is the single choke point every
// emission passes through (rwa new / import / clone, tools/regenerate-refs.mjs, the service), so it
// cannot be current for some callers and stale for others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { applySeedSubs, kindOverrides, seedIdentity } from '../src/seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = fs.readFileSync(path.resolve(HERE, '..', '..', 'seeds', 'rewritable.html'), 'utf8');

const emit = (seed = SEED, over = {}) => applySeedSubs(seed, {
  uuid: randomUUID(), title: 'T', fileMeta: 't.html', ...over,
});
const idOf = (html) => (html.match(/<meta name="rwa-seed" content="([^"]*)">/) || [])[1];

test('seedIdentity is sha-256 of the seed bytes, first 12 hex', () => {
  const expected = createHash('sha256').update(SEED, 'utf8').digest('hex').slice(0, 12);
  assert.equal(seedIdentity(SEED), expected);
  assert.match(seedIdentity(SEED), /^[0-9a-f]{12}$/);
});

test('an emitted container carries a real id, never the placeholder', () => {
  const out = emit();
  assert.equal(idOf(out), seedIdentity(SEED));
  assert.ok(!out.includes('0000000000pl'), 'placeholder leaked into an emitted container');
});

test('identity is a property of the SEED, not of the container', () => {
  // Different uuid, title, and product kind — same bootstrap bytes, so the same id. This is the
  // whole point: it answers "which runtime do you have", not "which document are you".
  const ov = kindOverrides('presentation');
  const a = emit();
  const b = emit(SEED, {
    productKind: 'presentation', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor, title: 'Other',
  });
  assert.equal(idOf(a), idOf(b));
  assert.notEqual(a, b, 'the two containers should otherwise differ');
});

test('a changed seed yields a different id', () => {
  const mutated = SEED.replace('<title>re-writeable</title>', '<title>re-writeable </title>');
  assert.notEqual(mutated, SEED, 'precondition: the mutation applied');
  assert.notEqual(seedIdentity(mutated), seedIdentity(SEED));
  assert.equal(idOf(emit(mutated)), seedIdentity(mutated));
});

test('a seed missing the marker is refused, not silently emitted', () => {
  // This guard is not theoretical: it immediately caught a stale, gitignored
  // cli/seeds/rewritable.html shadowing the repo seed in the load order, which had been silently
  // emitting a pre-August runtime. Failing loudly is the point (Rule 12).
  const stripped = SEED.replace(/<meta name="rwa-seed" content="[^"]*">\n?/, '');
  assert.throws(() => emit(stripped), /exactly one rwa-seed meta/);
});
