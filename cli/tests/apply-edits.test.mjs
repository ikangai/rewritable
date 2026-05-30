import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, containsReservedMarker } from '../src/apply-edits.mjs';

// ─── Happy-path ────────────────────────────────────────────────────────

test('apply_edits — single edit, unique find, succeeds', () => {
  const doc = '<article><h1>Old</h1></article>';
  const result = applyEdits(doc, [{ find: 'Old', replace: 'New' }]);
  assert.equal(result, '<article><h1>New</h1></article>');
});

test('apply_edits — two sequential edits, both apply', () => {
  const doc = '<article><h1>A</h1><p>B</p></article>';
  const result = applyEdits(doc, [
    { find: 'A', replace: 'AA' },
    { find: 'B', replace: 'BB' }
  ]);
  assert.equal(result, '<article><h1>AA</h1><p>BB</p></article>');
});

// ─── Error paths ───────────────────────────────────────────────────────

test('apply_edits — find_not_found', () => {
  assert.throws(
    () => applyEdits('<article>foo</article>', [{ find: 'bar', replace: 'baz' }]),
    err => err.code === 'find_not_found' && err.editIndex === 0
  );
});

test('apply_edits — find_not_unique', () => {
  assert.throws(
    () => applyEdits('<article>x x</article>', [{ find: 'x', replace: 'y' }]),
    err => err.code === 'find_not_unique' && err.editIndex === 0
  );
});

// ─── Self-correcting failures: near-miss anchor hints ───────────────────
// WHY: find_not_found is the dominant failure mode of the rwa-edit loop. An
// opaque code gives an agent (or human) nothing to recover with. The runtime
// computes — deterministically, no model call — the closest text that IS in the
// doc so the next retry can copy the exact anchor. These tests pin the contract
// the agent's retry loop and `rwa edit --json` depend on.

test('find_not_found — whitespace-only miss returns verbatim closest', () => {
  const doc = '<article><p>Hello   world</p></article>'; // 3 spaces
  assert.throws(
    () => applyEdits(doc, [{ find: 'Hello world', replace: 'x' }]), // 1 space
    err => err.code === 'find_not_found'
      && err.context.match === 'whitespace'
      && err.context.closest === 'Hello   world'
  );
});

test('find_not_found — closest is re-appliable as the next anchor', () => {
  const doc = '<article><p>Hello   world</p></article>';
  let closest;
  try {
    applyEdits(doc, [{ find: 'Hello world', replace: 'x' }]);
  } catch (err) {
    closest = err.context.closest;
  }
  // The whole point: feeding `closest` straight back as `find` must succeed.
  const result = applyEdits(doc, [{ find: closest, replace: 'BYE' }]);
  assert.equal(result, '<article><p>BYE</p></article>');
});

test('find_not_found — case-only miss returns verbatim closest', () => {
  const doc = '<article><h1>Quarterly Report</h1></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'quarterly report', replace: 'x' }]),
    err => err.code === 'find_not_found'
      && err.context.match === 'case'
      && err.context.closest === 'Quarterly Report'
  );
});

test('find_not_found — partial miss surfaces the real surrounding text', () => {
  const doc = '<article><p>The quick brown fox jumps over</p></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'The quick brown cat jumps', replace: 'x' }]),
    err => err.code === 'find_not_found'
      && err.context.match === 'partial'
      && err.context.closest.includes('The quick brown fox')
  );
});

test('find_not_found — genuinely absent anchor yields no closest', () => {
  const doc = '<article><p>nothing alike here</p></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'ZZZZ-absent-XYZ', replace: 'x' }]),
    err => err.code === 'find_not_found'
      && err.context.closest === undefined
      && err.context.match === undefined
  );
});

test('find_not_found — newline-reflow miss returns verbatim multi-line closest', () => {
  // The most common real near-miss: the model reproduced a block but reflowed
  // the line breaks. Collapsing whitespace must match, and `closest` must hand
  // back the EXACT bytes (newlines + indentation included) so the retry anchors.
  const doc = '<article><p>The quarterly numbers\n  are strong this year</p></article>';
  let ctx;
  try {
    applyEdits(doc, [{ find: 'The quarterly numbers are strong this year', replace: 'x' }]);
  } catch (err) { ctx = err.context; }
  assert.equal(ctx.match, 'whitespace');
  assert.equal(ctx.closest, 'The quarterly numbers\n  are strong this year');
  assert.equal(ctx.truncated, undefined); // a normal-size match is not truncated
  // and it must re-apply verbatim:
  const fixed = applyEdits(doc, [{ find: ctx.closest, replace: 'OK' }]);
  assert.equal(fixed, '<article><p>OK</p></article>');
});

test('find_not_found — oversized closest is bounded and flagged truncated', () => {
  // An anchor longer than the payload cap can't be returned whole. Eliding it is
  // fine for LOCATING the region, but the agent must NOT paste a truncated string
  // as its next anchor — so the runtime flags truncated:true (honest, machine-
  // actionable: "shorten your anchor", not "copy this").
  const big = 'Lorem ipsum '.repeat(40).trim();            // ~470 chars
  const doc = '<article><p>' + big.replace('Lorem ipsum', 'Lorem  ipsum') + '</p></article>';
  let ctx;
  try {
    applyEdits(doc, [{ find: big, replace: 'x' }]);          // whitespace-off vs the doc
  } catch (err) { ctx = err.context; }
  assert.equal(ctx.match, 'whitespace');
  assert.equal(ctx.truncated, true);
  assert.ok(ctx.closest.length <= 300, `closest should be bounded, was ${ctx.closest.length}`);
});

test('find_not_unique — carries surrounding-context hints', () => {
  const doc = '<article><p>one cat</p><p>two cat</p></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'cat', replace: 'dog' }]),
    err => err.code === 'find_not_unique'
      && err.context.count === 2
      && Array.isArray(err.context.hints)
      && err.context.hints.length === 2
  );
});

test('containsReservedMarker — detects frozen-begin marker', () => {
  assert.equal(containsReservedMarker('rwa:frozen:begin foo'), true);
});

test('containsReservedMarker — detects data-rwa-frozen attribute', () => {
  assert.equal(containsReservedMarker('<div data-rwa-frozen>'), true);
});

test('containsReservedMarker — false for ordinary content', () => {
  assert.equal(containsReservedMarker('<p>Hello world</p>'), false);
});

test('containsReservedMarker — detects all comment-prefix forms', () => {
  // String-concat to keep these literals out of containsReservedMarker's
  // own scan over the source tree — see apply-edits.mjs RESERVED_MARKERS
  // for the same trick.
  const forms = [
    '<' + '!-- rwa: x',
    '/*' + ' rwa: x',
    '//' + ' rwa: x',
  ];
  for (const s of forms) {
    assert.equal(containsReservedMarker(s), true, `should flag: ${s}`);
  }
});

// ─── Frozen zones (marker form) ────────────────────────────────────────

test('frozen_zone_violation — edit inside marker-form zone', () => {
  // Use a find that's unique to the zone body (avoid matching the marker
  // comments' own `rwa:frozen:*` text — that would trip find_not_unique
  // first; and `data-rwa-frozen` in find/replace would trip
  // reserved_substring first).
  const doc = '<article>before<!-- rwa:frozen:begin lock --><h1>LOCKED</h1><!-- rwa:frozen:end lock -->after</article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'LOCKED', replace: 'unlocked' }]),
    err => err.code === 'frozen_zone_violation' && err.context.zone === 'lock'
  );
});

test('reserved_substring — replace contains rwa:frozen:begin', () => {
  assert.throws(
    () => applyEdits('<article>foo</article>', [{ find: 'foo', replace: 'rwa:frozen:begin x' }]),
    err => err.code === 'reserved_substring'
  );
});

test('reserved_substring — find contains data-rwa-frozen', () => {
  assert.throws(
    () => applyEdits('<article>foo</article>', [{ find: 'data-rwa-frozen', replace: 'x' }]),
    err => err.code === 'reserved_substring'
  );
});

test('apply_edits — edit OUTSIDE frozen zone succeeds', () => {
  const doc = '<article>before<!-- rwa:frozen:begin lock --><h1>frozen</h1><!-- rwa:frozen:end lock -->after</article>';
  const result = applyEdits(doc, [{ find: 'before', replace: 'BEFORE' }]);
  assert.ok(result.includes('BEFORE'));
  assert.ok(result.includes('<!-- rwa:frozen:begin lock -->'));
});

// ─── Structural-shape check ────────────────────────────────────────────

test('structural_shape_changed — apply_edits cannot introduce a <script>', () => {
  assert.throws(
    () => applyEdits('<article>foo</article>', [{ find: 'foo', replace: '<script>x</script>' }]),
    err => err.code === 'structural_shape_changed'
  );
});

test('structural_shape_changed — apply_edits cannot introduce a <style>', () => {
  assert.throws(
    () => applyEdits('<article>foo</article>', [{ find: 'foo', replace: '<style>p{color:red}</style>' }]),
    err => err.code === 'structural_shape_changed'
  );
});

test('apply_edits — preserves existing <script> count', () => {
  // Existing <script> stays intact across a content edit.
  const doc = '<article><script>VAR_X = 1;</script></article>';
  const result = applyEdits(doc, [{ find: 'VAR_X', replace: 'VAR_Y' }]);
  assert.equal(result, '<article><script>VAR_Y = 1;</script></article>');
});

// ─── todo: attribute-form frozen zone (v1 scope-down) ──────────────────
// The seed enforces data-rwa-frozen attribute-form zones via DOMParser
// snapshots (seeds/rewritable.html dataRwaFrozenSnapshot). Implementing
// tag-balanced HTML parsing without a parser is significantly more
// complex; v1 covers marker-form only. Reserved-substring detection
// (above) already blocks edits that mention `data-rwa-frozen` literally,
// which is the primary attack surface — but an edit that finds anchors
// inside an attribute-form frozen element's text would currently apply.
// Marked as todo so it shows up in the run summary as outstanding work
// (see cli/TODO.md).
test('attribute-form frozen zone enforcement (v1 scope-down)', { todo: true }, () => {
  const doc = '<article><div data-rwa-frozen><p>locked</p></div></article>';
  // Per spec §7.3 + seed dataRwaFrozenSnapshot, this should throw.
  assert.throws(
    () => applyEdits(doc, [{ find: 'locked', replace: 'unlocked' }]),
    err => err.code === 'frozen_zone_violation'
  );
});
