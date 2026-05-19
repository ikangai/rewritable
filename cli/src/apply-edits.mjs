// rwa-edit/1 apply-edits — hand-mirrored from seeds/rewritable.html's
// applyEdits pipeline (~line 2823). Read alongside rwa-edit-spec.md §5
// (apply_edits semantics) and §7 (frozen zones).
//
// Differences from the seed, called out so future maintainers don't expect
// strict parity:
//   1. Seed collapses reserved-marker hits and zone-crossing hits both into
//      `frozen_zone_violation`. CLI splits them: `reserved_substring` for
//      a find/replace that *contains* a marker substring, and
//      `frozen_zone_violation` for an edit whose find-range overlaps a
//      marker-form frozen zone. The plan (Task 4/5 dispatch) is keyed on
//      these distinct codes.
//   2. Seed enforces `data-rwa-frozen` attribute-form zones via a DOMParser
//      snapshot of [data-rwa-frozen] elements. CLI v1 is parser-free
//      (offline-first, no jsdom) and covers MARKER-FORM ONLY. Reserved-
//      substring detection still blocks edits that mention `data-rwa-frozen`
//      literally — the primary attack surface — but text inside an
//      attribute-form frozen element is not yet guarded. Tracked as xfail
//      in tests/apply-edits.test.mjs.
//   3. Seed's structural-shape check uses DOMParser + executable-script-
//      type filtering + top-level-tag-types set. CLI v1 uses regex counting
//      of <script>/<style> tags — enough to catch the realistic accidental-
//      damage signal (a model emitting an inline <script> in a content
//      edit) without pulling in a parser.

export class RwaEditError extends Error {
  constructor(code, editIndex = null, context = {}) {
    super(code);
    this.code = code;
    this.editIndex = editIndex;
    this.context = context;
  }
}

// Source of truth: seeds/rewritable.html RWA_EDIT.RESERVED (line ~1608).
// The string-concat trick on the comment/attribute markers prevents this
// source file itself from tripping reserved-marker scans run over the CLI
// tree.
const RESERVED_MARKERS = [
  'rwa:frozen:begin',
  'rwa:frozen:end',
  '<' + '!-- rwa:',
  '/*' + ' rwa:',
  '//' + ' rwa:',
  'data-rwa-frozen',
];

export function containsReservedMarker(s) {
  if (!s) return false;
  for (const m of RESERVED_MARKERS) if (s.includes(m)) return true;
  return false;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// Extract marker-form frozen zones. Returns array of
// `{ start, end, name }` covering the entire span from the opening
// `<!-- rwa:frozen:begin <name> -->` to the closing
// `<!-- rwa:frozen:end <name> -->` (inclusive of both markers).
//
// Scoped to the HTML-comment form. Source-of-truth seed also handles
// `/* rwa:frozen:* */` and `// rwa:frozen:*` (script/JS-comment forms);
// for the CLI v1 those are deferred — they were a niche need on the seed
// side and the substrate is the doc the CLI edits, not the bootstrap.
function findFrozenZones(doc) {
  const zones = [];
  const beginRe = /<!--\s*rwa:frozen:begin\s+([A-Za-z0-9_-]+)\s*-->/g;
  let m;
  while ((m = beginRe.exec(doc)) !== null) {
    const name = m[1];
    const innerStart = m.index + m[0].length;
    const endRe = new RegExp(
      '<!--\\s*rwa:frozen:end\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*-->',
      'g',
    );
    endRe.lastIndex = innerStart;
    const e = endRe.exec(doc);
    if (!e) continue; // unterminated — silently skipped; seed flags this elsewhere
    zones.push({ start: m.index, end: e.index + e[0].length, name });
  }
  return zones;
}

function editCrossesFrozenZone(doc, find, zones) {
  const findIdx = doc.indexOf(find);
  if (findIdx === -1) return null;
  const findEnd = findIdx + find.length;
  for (const z of zones) {
    // Overlap: edit range intersects zone range. Adjacent (findEnd === z.start
    // or findIdx === z.end) is OK — same convention as the seed's class-lock
    // check (seeds/rewritable.html ~line 2860).
    if (findIdx < z.end && findEnd > z.start) return z;
  }
  return null;
}

// Structural-shape check (rwa-edit-spec.md §7).
// CLI v1: regex count of <script> and <style> tags. The seed additionally
// tracks top-level tag-types-set and exempts non-executable scripts
// (text/workflow-node, application/json) — both deferred for v1; the realistic
// damage signal (a model emitting an inline <script> inside a content edit)
// is fully caught by the count check.
function structuralShape(doc) {
  return {
    scripts: (doc.match(/<script[\s>]/gi) || []).length,
    styles: (doc.match(/<style[\s>]/gi) || []).length,
  };
}

export function applyEdits(doc, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new RwaEditError('malformed_envelope', null, { reason: 'edits must be a non-empty array' });
  }

  const before = structuralShape(doc);
  const zones = findFrozenZones(doc);

  let working = doc;
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i] || {};
    if (!find) throw new RwaEditError('empty_find', i);

    // Reserved-substring check (spec §4 rule 6) — runs before the find lookup
    // so a literal `data-rwa-frozen` in either side fails fast.
    if (containsReservedMarker(find) || containsReservedMarker(replace || '')) {
      throw new RwaEditError('reserved_substring', i, { find, replace });
    }

    const count = countOccurrences(working, find);
    if (count === 0) throw new RwaEditError('find_not_found', i, { find });
    if (count > 1) throw new RwaEditError('find_not_unique', i, { find, count });

    // Frozen-zone overlap check (marker form). Recompute zones each iteration
    // against `working` so prior edits can't shift the zone boundaries
    // under the next edit's check.
    const liveZones = findFrozenZones(working);
    const zone = editCrossesFrozenZone(working, find, liveZones);
    if (zone) {
      throw new RwaEditError('frozen_zone_violation', i, { zone: zone.name });
    }

    // Slice-based splice — String.prototype.replace honors $&/$`/$'/$$
    // patterns in the replacement string even for literal-string searches,
    // mangling content like "$$amount". Splicing keeps bytes verbatim.
    const idx = working.indexOf(find);
    working = working.slice(0, idx) + (replace || '') + working.slice(idx + find.length);
  }

  const after = structuralShape(working);
  if (before.scripts !== after.scripts || before.styles !== after.styles) {
    throw new RwaEditError('structural_shape_changed', null, { before, after });
  }

  // Frozen-zone integrity: zone count must match. (Marker-form-only; seed
  // additionally diffs the inner bytes via extractFrozenZones — for the CLI
  // v1 the count check + per-edit crossing check is the practical guard.)
  const newZones = findFrozenZones(working);
  if (newZones.length !== zones.length) {
    throw new RwaEditError('frozen_zone_corrupted', null, {
      before: zones.length,
      after: newZones.length,
    });
  }

  return working;
}
