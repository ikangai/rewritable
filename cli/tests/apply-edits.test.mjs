import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, containsReservedMarker, lockedRangesIn, markerZoneRangesIn, unterminatedFrozenMarker } from '../src/apply-edits.mjs';

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

// ─── attribute-form frozen zone enforcement ────────────────────────────
// The seed protects data-rwa-frozen elements via dataRwaFrozenSnapshot
// (seeds/rewritable.html :2971): each [data-rwa-frozen] element snapshotted as
// tagName + outerHTML, sorted; any change before/after an edit is rejected. The
// CLI now mirrors that BATCH-LEVEL snapshot equality, parser-free. This matters
// because a file can declare its own self-knowledge in a frozen inert
// <script id="rwa-affordances" data-rwa-frozen> block (tesla's datatable) — if a
// CLI agent could drift it, the declaration would lie. The reserved-substring
// check already blocks edits that mention `data-rwa-frozen` literally; this
// closes the remaining gap: edits whose anchors land INSIDE a frozen element.

test('attribute-form: mutating inner text of a data-rwa-frozen element is rejected', () => {
  const doc = '<article><div data-rwa-frozen><p>locked</p></div></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'locked', replace: 'unlocked' }]),
    err => err.code === 'frozen_zone_violation',
  );
});

test('attribute-form: drifting a frozen #rwa-affordances declaration is rejected (the real case)', () => {
  // tesla's datatable declares its affordances in a frozen inert script. An
  // agent must not be able to silently change what the file claims to be.
  const doc = [
    '<article><h1>Budget</h1>',
    '<script type="application/rwa-affordances+json" id="rwa-affordances" data-rwa-frozen>',
    '{ "kind": "datatable", "affordances": [{"kind":"view","name":"grid"}] }',
    '</script>',
    '<script type="application/json" id="dt-data">[{"a":1}]</script></article>',
  ].join('\n');
  assert.throws(
    () => applyEdits(doc, [{ find: '"name":"grid"', replace: '"name":"tampered"' }]),
    err => err.code === 'frozen_zone_violation',
  );
});

test('attribute-form: editing a DIFFERENT block is still allowed (no over-blocking)', () => {
  // The editable data region (#dt-data) must remain freely editable even when a
  // sibling #rwa-affordances is frozen — else we trade a security gap for a
  // usability one.
  const doc = [
    '<article>',
    '<script id="rwa-affordances" data-rwa-frozen>{"kind":"datatable"}</script>',
    '<script id="dt-data">[{"qty":1}]</script></article>',
  ].join('\n');
  const out = applyEdits(doc, [{ find: '"qty":1', replace: '"qty":2' }]);
  assert.match(out, /"qty":2/);
  assert.match(out, /\{"kind":"datatable"\}/); // declaration untouched
});

test('attribute-form: an edit fully outside any frozen element applies normally', () => {
  const doc = '<article><h1>Title</h1><div data-rwa-frozen><p>locked</p></div><p>free</p></article>';
  const out = applyEdits(doc, [{ find: 'free', replace: 'edited' }]);
  assert.equal(out, '<article><h1>Title</h1><div data-rwa-frozen><p>locked</p></div><p>edited</p></article>');
});

test('attribute-form: changing a non-frozen attribute ON the frozen element is rejected', () => {
  // outerHTML includes the element's attributes, so an id change is a drift too.
  const doc = '<article><div data-rwa-frozen id="a">x</div></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'id="a"', replace: 'id="b"' }]),
    err => err.code === 'frozen_zone_violation',
  );
});

test('attribute-form: matching close tag is found through nested same-tag elements', () => {
  // Depth-tracking: a naive "next </div>" would stop early and under-protect.
  const doc = '<article><div data-rwa-frozen><div>inner</div></div><p>after</p></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'inner', replace: 'changed' }]),
    err => err.code === 'frozen_zone_violation',
  );
  // …while content after the frozen element stays editable.
  assert.match(applyEdits(doc, [{ find: 'after', replace: 'tail' }]), /tail/);
});

test('attribute-form: a document with no data-rwa-frozen is unaffected (regression)', () => {
  const doc = '<article><h1>Plain</h1><p>body</p></article>';
  assert.equal(applyEdits(doc, [{ find: 'body', replace: 'text' }]), '<article><h1>Plain</h1><p>text</p></article>');
});

test('attribute-form: data-rwa-frozen in an attribute VALUE is not a frozen element (edit allowed)', () => {
  // The string in class="data-rwa-frozen" is NOT a real data-rwa-frozen attribute,
  // so the seed lens (DOM querySelectorAll('[data-rwa-frozen]')) does NOT freeze
  // it. The CLI must agree (DOM-accurate via tagHasFrozenAttr), or it over-freezes
  // vs the seed — the cross-surface divergence euler caught (seed 9864a66).
  const doc = '<article><div class="data-rwa-frozen"><p>editable</p></div></article>';
  const out = applyEdits(doc, [{ find: 'editable', replace: 'edited' }]);
  assert.equal(out, '<article><div class="data-rwa-frozen"><p>edited</p></div></article>');
});

// ─── #1: lockedRangesIn — byte ranges of .rwa-locked subtrees ──────────

test('lockedRangesIn returns the full subtree range of a .rwa-locked element', () => {
  const doc = '<article>a<div class="rwa-locked"><p>x</p></div>b</article>';
  const ranges = lockedRangesIn(doc);
  assert.equal(ranges.length, 1);
  const [start, end] = ranges[0];
  assert.equal(doc.slice(start, end), '<div class="rwa-locked"><p>x</p></div>');
});

test('lockedRangesIn tracks nested same-tag depth (does not stop at the first close)', () => {
  const doc = '<section class="rwa-locked"><section>inner</section>tail</section>after';
  const [[start, end]] = lockedRangesIn(doc);
  assert.equal(doc.slice(start, end), '<section class="rwa-locked"><section>inner</section>tail</section>');
});

test('lockedRangesIn ignores elements without the rwa-locked class', () => {
  assert.deepEqual(lockedRangesIn('<div class="other">x</div>'), []);
});

// ─── #1: markerZoneRangesIn — byte ranges of protected zones ───────────

test('markerZoneRangesIn covers a comment-form frozen zone including its fences', () => {
  const doc = 'before<!-- rwa:frozen:begin z --><b>x</b><!-- rwa:frozen:end z -->after';
  const [[start, end]] = markerZoneRangesIn(doc);
  assert.equal(doc.slice(start, end), '<!-- rwa:frozen:begin z --><b>x</b><!-- rwa:frozen:end z -->');
});

test('markerZoneRangesIn covers a data-rwa-frozen attribute-form element subtree', () => {
  const doc = 'a<div data-rwa-frozen><p>x</p></div>b';
  const [[start, end]] = markerZoneRangesIn(doc);
  assert.equal(doc.slice(start, end), '<div data-rwa-frozen><p>x</p></div>');
});

test('markerZoneRangesIn skips an unterminated begin marker', () => {
  assert.deepEqual(markerZoneRangesIn('x<!-- rwa:frozen:begin z -->y'), []);
});

// ─── #1: unterminatedFrozenMarker — half-open fence detection ──────────

test('unterminatedFrozenMarker flags a begin marker with no matching end (comment form)', () => {
  assert.equal(unterminatedFrozenMarker('<p>x</p><!-- rwa:frozen:begin orphan -->'), 'orphan');
});

test('unterminatedFrozenMarker flags a half-open script-comment fence', () => {
  assert.equal(unterminatedFrozenMarker('code;\n// rwa:frozen:begin orphan\nmore;'), 'orphan');
});

test('unterminatedFrozenMarker returns null when every begin has a matching end', () => {
  assert.equal(unterminatedFrozenMarker('<!-- rwa:frozen:begin z --><b>x</b><!-- rwa:frozen:end z -->'), null);
});

test('unterminatedFrozenMarker returns null for a doc with no frozen markers', () => {
  assert.equal(unterminatedFrozenMarker('<article>plain</article>'), null);
});

test('attribute-form: a longer attribute name (data-rwa-frozen-note) is not frozen', () => {
  const doc = '<article><div data-rwa-frozen-note="x"><p>editable</p></div></article>';
  assert.match(applyEdits(doc, [{ find: 'editable', replace: 'edited' }]), /edited/);
});

// ─── deferred scope-downs (2026-06-10): seed-faithful caps + canon + surrogate ──
// These close documented CLI-vs-seed gaps tracked in cli/TODO.md. Each mirrors a
// seed guard in seeds/rewritable.html applyEdits, so a file edited via the CLI
// behaves identically to one edited in the browser.

test('cap: a replace exceeding MAX_REPLACE (8KB) throws replace_too_large', () => {
  const doc = '<article><p>anchor</p></article>';
  const big = 'x'.repeat(8 * 1024 + 1);
  assert.throws(
    () => applyEdits(doc, [{ find: 'anchor', replace: big }]),
    err => err.code === 'replace_too_large' && err.editIndex === 0,
  );
});

test('cap: a replace exactly at MAX_REPLACE (8KB) is allowed', () => {
  const doc = '<article><p>anchor</p></article>';
  const atCap = 'x'.repeat(8 * 1024);
  assert.match(applyEdits(doc, [{ find: 'anchor', replace: atCap }]), /xxxx/);
});

test('cap: a result exceeding MAX_DOC (1MB) throws target_size_exceeded', () => {
  // Base doc near the cap; a modest replace pushes the whole doc over 1MB.
  const filler = 'y'.repeat(1024 * 1024 - 40);
  const doc = '<article><p>anchor</p>' + filler + '</article>';
  const chunk = 'z'.repeat(4096); // under MAX_REPLACE, but tips the doc past MAX_DOC
  assert.throws(
    () => applyEdits(doc, [{ find: 'anchor', replace: 'anchor' + chunk }]),
    err => err.code === 'target_size_exceeded',
  );
});

test('canonLF: a CRLF document matches an LF-only find (browser parity)', () => {
  const doc = '<article>\r\n<p>line one</p>\r\n<p>line two</p>\r\n</article>';
  // Anchor written with LF only — the seed canonicalizes the doc to LF before
  // matching, so this must hit. Pre-fix the CLI would throw find_not_found.
  const out = applyEdits(doc, [{ find: '<p>line one</p>\n<p>line two</p>', replace: '<p>merged</p>' }]);
  assert.match(out, /<p>merged<\/p>/);
  assert.ok(!out.includes('\r'), 'output is LF-canonical');
});

test('canonLF: a CRLF-containing find anchors against an LF doc', () => {
  const doc = '<article>\n<p>a</p>\n<p>b</p>\n</article>';
  const out = applyEdits(doc, [{ find: '<p>a</p>\r\n<p>b</p>', replace: '<p>c</p>' }]);
  assert.match(out, /<p>c<\/p>/);
});

// rwa-edit v1.7: canonical form is LF + NFC. NFD bytes enter documents via
// paste; models return NFC anchors; pre-v1.7 that was find_not_found on
// visually identical text. Escapes on purpose — literal NFD would not survive
// editor normalization of this source file.
test('canonNFC: an NFC find matches an NFD document (paste parity)', () => {
  const doc = '<article><p>Herr Mu\u0308ller war da.</p></article>';   // NFD u+diaeresis
  const out = applyEdits(doc, [{ find: 'Herr M\u00FCller', replace: 'Frau M\u00FCller' }]); // NFC
  assert.ok(out.includes('Frau M\u00FCller'), 'NFC replacement present');
  assert.ok(!/[\u0300-\u036F]/.test(out), 'output is NFC-canonical');
});

test('canonNFC: an NFD find and NFD replace anchor against an NFC doc, stored NFC', () => {
  const doc = '<article><p>im caf\u00E9 drau\u00DFen</p></article>';    // NFC e-acute
  const out = applyEdits(doc, [{ find: 'cafe\u0301', replace: 'Cafe\u0301 Zentral' }]); // NFD both ways
  assert.ok(out.includes('Caf\u00E9 Zentral'), 'stored in NFC form');
  assert.ok(!/[\u0300-\u036F]/.test(out), 'NFD replace content is stored NFC');
});

test('canonNFC: transliteration is not canonicalization — ue misses u-umlaut', () => {
  const doc = '<article><p>M\u00FCller</p></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'Mueller', replace: 'x' }]),
    (e) => e.code === 'find_not_found',
  );
});

test('surrogate: a lone surrogate in replace throws malformed_envelope', () => {
  const doc = '<article><p>anchor</p></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'anchor', replace: 'bad \uD800 surrogate' }]),
    err => err.code === 'malformed_envelope' && err.context && err.context.reason === 'lone_surrogate',
  );
});

// ─── regex limit fixes: unquoted class attribute on a .rwa-locked block ──
// Previously lockedRangesIn matched only quoted class="…"; an unquoted
// class=rwa-locked silently voided the lock. The browser enforces via real
// classList, so the text-scan must catch it too (fix lands in seed + CLI).
test('lockedRangesIn detects an UNQUOTED class=rwa-locked attribute', () => {
  const ranges = lockedRangesIn('<article><div class=rwa-locked><p>x</p></div></article>');
  assert.equal(ranges.length, 1, 'unquoted class=rwa-locked is a lock range');
});

test('lockedRangesIn detects rwa-locked among multiple unquoted-ish classes', () => {
  const ranges = lockedRangesIn('<article><div class="note rwa-locked pinned"><p>x</p></div></article>');
  assert.equal(ranges.length, 1);
});

// ─── class_lock_violation on the apply_edits path (seed parity) ──────────
// An edit whose find-range overlaps a .rwa-locked subtree must be rejected
// (the seed rejects it; the CLI previously only guarded replace_document).
test('apply_edits rejects an edit overlapping a .rwa-locked range', () => {
  const doc = '<article><p>free</p><section class="rwa-locked"><p>locked text</p></section></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'locked text', replace: 'tampered' }]),
    err => err.code === 'class_lock_violation' && err.editIndex === 0,
  );
});

test('apply_edits allows an edit OUTSIDE a .rwa-locked range', () => {
  const doc = '<article><p>free</p><section class="rwa-locked"><p>locked text</p></section></article>';
  assert.match(applyEdits(doc, [{ find: 'free', replace: 'edited' }]), /edited/);
});

test('apply_edits rejects an edit overlapping an UNQUOTED class=rwa-locked range', () => {
  const doc = '<article><p>free</p><section class=rwa-locked><p>locked text</p></section></article>';
  assert.throws(
    () => applyEdits(doc, [{ find: 'locked text', replace: 'tampered' }]),
    err => err.code === 'class_lock_violation',
  );
});
