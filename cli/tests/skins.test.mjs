// Tests for the canonical preset library (cli/src/skins.mjs) — the single
// source the CLI (and, later, the runtime gallery + service) read skins from.
// These pin the load-bearing invariants of a preset: it is ONE self-contained
// <style data-rwa-skin="NAME"> block, system-fonts only, whose attribute equals
// its key (so the gallery + self-description can locate "which skin is applied"
// from the bytes). A preset that smuggles in a web font / remote URL — breaking
// the single-file self-containment the whole product rests on — must fail here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKINS, SKIN_NAMES, skinByName } from '../src/skins.mjs';
import { findExternalRefs } from '../src/self-contained.mjs';

const SKIN_BLOCK_RE = /<style\b[^>]*\bdata-rwa-skin=["']([^"']*)["'][^>]*>/i;

test('SKIN_NAMES mirrors SKINS keys and includes the 3 v1 presets', () => {
  assert.deepEqual(SKIN_NAMES, Object.keys(SKINS));
  for (const n of ['notion-clean', 'linear-dark', 'editorial-serif']) {
    assert.ok(SKIN_NAMES.includes(n), `v1 library must include "${n}"`);
  }
});

test('every preset is one self-contained <style data-rwa-skin="NAME"> block, system fonts only', () => {
  for (const name of SKIN_NAMES) {
    const s = SKINS[name];
    assert.equal(s.name, name, `${name}: .name must equal its key`);
    assert.equal(typeof s.label, 'string', `${name}: needs a label`);
    assert.ok(s.label.length > 0, `${name}: label non-empty`);

    // Exactly one <style> element, and its data-rwa-skin attribute IS the key —
    // this is what lets the gallery/self-description read the active skin from
    // the document bytes.
    const styleCount = (s.theme.match(/<style\b/gi) || []).length;
    assert.equal(styleCount, 1, `${name}: theme must hold exactly one <style> (got ${styleCount})`);
    const m = s.theme.match(SKIN_BLOCK_RE);
    assert.ok(m, `${name}: theme must be a <style data-rwa-skin> block`);
    assert.equal(m[1], name, `${name}: data-rwa-skin="${m[1]}" must equal the key`);
    assert.match(s.theme.trim(), /<\/style>$/, `${name}: block must be closed`);

    // Self-containment is the load-bearing invariant: no CDN/url()/srcset refs…
    assert.deepEqual(findExternalRefs(s.theme), [], `${name}: theme must be self-contained`);
    // …and no web fonts or remote schemes (findExternalRefs has no font guard,
    // so check it explicitly — this is the rule a vision-extracted skin could break).
    assert.doesNotMatch(s.theme, /@font-face|@import|https?:|fonts\.(googleapis|gstatic)/i,
      `${name}: no web fonts / remote refs allowed`);
  }
});

test('skinByName returns the preset; an unknown name throws an exit-2 error listing known skins', () => {
  assert.equal(skinByName('notion-clean').name, 'notion-clean');
  assert.throws(
    () => skinByName('does-not-exist'),
    (e) => e.exitCode === 2 && /does-not-exist/.test(e.message) && /notion-clean/.test(e.message),
    'unknown skin must throw exitCode 2 with the name + known list',
  );
});
