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
//      snapshot of [data-rwa-frozen] elements. The CLI mirrors that guard
//      parser-free (offline-first, no jsdom): `dataRwaFrozenSnapshot` captures
//      each frozen element as `tag\0outerHTML` (sorted), and applyEdits rejects
//      a batch that changes the set (`frozen_zone_violation`, `form:'attribute'`)
//      — covering BOTH marker-form and attribute-form now. Reserved-substring
//      detection still blocks edits that mention `data-rwa-frozen` literally.
//      The seed's DOMParser handles edge cases (a `>` inside a quoted attribute
//      value) that the CLI's pragmatic regex matcher does not; the before/after
//      snapshot is relative, so a consistent mis-parse of an UNCHANGED element
//      still compares equal. KEEP IN STEP with the seed (dataRwaFrozenSnapshot
//      :2971).
//   3. Seed's structural-shape check uses DOMParser + executable-script-
//      type filtering + top-level-tag-types set. CLI v1 uses regex counting
//      of <script>/<style> tags — enough to catch the realistic accidental-
//      damage signal (a model emitting an inline <script> in a content
//      edit) without pulling in a parser.
//
// ## Other known v1 scope-downs vs seed
//
// The seed (seeds/rewritable.html ~lines 2825-2910) enforces additional
// invariants the CLI does NOT in v1. Tracked in cli/TODO.md for v2:
//
//   - MAX_REPLACE = 8KB per-edit cap (seed throws 'replace_too_large')
//   - MAX_DOC = 1MB whole-doc cap (seed throws 'target_size_exceeded')
//   - isWellFormed lone-surrogate guard on find/replace/doc
//   - canonLF normalization of find/replace before matching
//     (CRLF-containing anchors fail with find_not_found in the CLI but
//     match correctly in the browser)
//   - Class-lock violation check (class_lock_violation / class_lock_uncovered)
//   - Reserved-id violation (reserved_id_used) — including data-rwa-id injection
//   - HTML parse-validity post-apply (parse_error_post_apply)

export class RwaEditError extends Error {
  constructor(code, editIndex = null, context = {}) {
    super(code);
    this.code = code;
    this.editIndex = editIndex;
    this.context = context;
  }
}

// Plain-English, code-keyed recovery hints. Self-documenting failures: an agent
// (or `rwa edit --json` consumer) gets one actionable line, not just a code.
// A static lookup — never a model call (Rule 5). Keep in sync with the seed's
// FAILURE_HINTS (failureToToolResult). No angle brackets / reserved markers in
// the strings, so they stay safe to embed in the seed bootstrap and survive the
// CLI tree's reserved-marker scan.
export const FAILURE_HINTS = {
  find_not_found: 'find must match the document byte-for-byte (whitespace and case included). If a closest match is shown, copy it exactly; otherwise pick a shorter, distinctive anchor.',
  find_not_unique: 'find appears more than once. Extend it with neighbouring text until it is unique; the hints list shows where.',
  frozen_zone_violation: 'This region is an author-protected frozen zone. Anchor on a different region — frozen zones change only by editing the file outside the runtime.',
  reserved_substring: 'find or replace contains a reserved rwa marker. Anchor on ordinary document text instead.',
  structural_shape_changed: 'The edit would change the document script/style tag count. Keep edits content-only, or use a structural plan.',
  replace_too_large: 'replace exceeds the per-edit size cap. Split the change into smaller anchored edits.',
  empty_find: 'find must be a non-empty string — provide the exact text to anchor on.',
  parse_error_post_apply: 'The result was not well-formed HTML — check that the tags in replace are balanced.',
};

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

// Surrounding-context snippets for find_not_unique — mirrors the seed's
// nearbySnippets so `rwa edit --json` (and the agent loop) can disambiguate.
// Source of truth: seeds/rewritable.html nearbySnippets (~line 1783).
function nearbySnippets(haystack, needle, max = 3, ctx = 40) {
  const out = []; let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1 && out.length < max) {
    const a = Math.max(0, i - ctx);
    const b = Math.min(haystack.length, i + needle.length + ctx);
    out.push({ pos: i, before: haystack.slice(a, i), after: haystack.slice(i + needle.length, b) });
    i += needle.length;
  }
  return out;
}

// Deterministic near-miss finder for find_not_found. Given a `find` that does
// NOT appear verbatim in `doc`, return a context fragment {closest, match}
// describing the closest actual text so an agent (or human) can self-correct
// the anchor in one retry — no model call (Rule 5). Returns {} when nothing
// useful is found. Cold path (failure only), so an O(n) projection is fine.
// Source of truth: seeds/rewritable.html findClosestAnchor — keep in sync.
function findClosestAnchor(doc, find) {
  if (!doc || !find) return {};
  const needleNorm = find.replace(/[ \t\n\r\f]+/g, ' ').trim();
  if (!needleNorm) return {};

  // Whitespace-collapsed projection of `doc`, with an offset map back to the
  // original bytes (map[k] = source index of norm[k]; a whitespace run collapses
  // to one space mapped to its first char). lowNorm mirrors norm length-for-length
  // (chars whose lowercase isn't single-char are left as-is) so the case pass
  // shares the same map without desync.
  let norm = '', lowNorm = '';
  const map = [];
  let inWs = false;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      if (!inWs) { norm += ' '; lowNorm += ' '; map.push(i); inWs = true; }
    } else {
      const lc = c.toLowerCase();
      norm += c;
      lowNorm += lc.length === 1 ? lc : c;
      map.push(i);
      inWs = false;
    }
  }
  // Cap the payload so an oversized anchor can't bloat the tool_result. When
  // elided, flag truncated:true — the elided text LOCATES the region but is NOT
  // byte-for-byte re-appliable, so the consumer must shorten its anchor rather
  // than paste the string back (honest, machine-actionable).
  const MAX = 300;
  const mk = (raw, match) => raw.length <= MAX
    ? { closest: raw, match }
    : { closest: raw.slice(0, MAX - 18) + ' …[' + (raw.length - MAX) + ' more]… ', match, truncated: true };
  const span = (k, normLen) => doc.slice(map[k], map[k + normLen - 1] + 1); // trim() ⇒ non-ws ends

  // Pass 1 — whitespace-only mismatch (verbatim normalized match).
  let k = norm.indexOf(needleNorm);
  if (k !== -1) return mk(span(k, needleNorm.length), 'whitespace');

  // Pass 2 — case (± whitespace) mismatch.
  k = lowNorm.indexOf(needleNorm.toLowerCase());
  if (k !== -1) return mk(span(k, needleNorm.length), 'case');

  // Pass 3 — partial: longest matching prefix of the needle (floor 12 chars).
  // Prefix-match is monotonic in length, so binary-search the longest L.
  const FLOOR = 12;
  if (needleNorm.length >= FLOOR) {
    let lo = FLOOR, hi = needleNorm.length, best = -1, bestK = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const j = norm.indexOf(needleNorm.slice(0, mid));
      if (j !== -1) { best = mid; bestK = j; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best !== -1) {
      const start = map[bestK];
      const matchEnd = map[bestK + best - 1] + 1;
      const ctxEnd = Math.min(doc.length, matchEnd + 40); // show where it diverges
      return mk(doc.slice(start, ctxEnd), 'partial');
    }
  }

  return {};
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
export function findFrozenZones(doc) {
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

// Void HTML elements have no closing tag, so the depth-matcher below must not
// scan to EOF looking for a close that never comes.
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Index just past the matching `</tag>` for an element opened at `from`,
// tracking nested same-tag depth so a naive "next close" can't stop early.
// -1 if unterminated.
function matchingCloseEnd(doc, tag, from) {
  const tagRe = new RegExp('<(/?)' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^>]*>', 'gi');
  tagRe.lastIndex = from;
  let depth = 1, t;
  while ((t = tagRe.exec(doc)) !== null) {
    if (t[1] === '/') { if (--depth === 0) return t.index + t[0].length; }
    else if (!/\/>\s*$/.test(t[0])) depth++; // a self-closing open doesn't nest
  }
  return -1;
}

// True iff `openTag` carries data-rwa-frozen as an actual attribute NAME — not
// inside a quoted value (class="data-rwa-frozen") and not a prefix of a longer
// name (data-rwa-frozen-note). Mirror of the seed's tagHasFrozenAttr
// (seeds/rewritable.html:2112) so the CLI's byte-range frozen detection agrees
// with the real DOM enforcement (querySelectorAll('[data-rwa-frozen]')) — the
// cheap /\bdata-rwa-frozen\b/ pre-filter's value/longer-name matches no longer
// false-positive. KEEP IN STEP with the seed.
export function tagHasFrozenAttr(openTag) {
  const am = /^<[a-zA-Z][a-zA-Z0-9]*((?:\s[^>]*)?)\/?>$/.exec(openTag);
  if (!am) return false;
  const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  let a;
  while ((a = attrRe.exec(am[1])) !== null) {
    if (a[1] === 'data-rwa-frozen') return true;
  }
  return false;
}

// Parser-free mirror of the seed's dataRwaFrozenSnapshot (seeds/rewritable.html
// :2971): each data-rwa-frozen element captured as `tagName\0outerHTML`, sorted.
// applyEdits compares this before/after to reject ANY change (inner text,
// attributes, add/remove) to an attribute-form frozen element — position-
// independent (sorted; outerHTML self-contained), batch-level like the seed.
//
// The seed uses DOMParser; the CLI stays parser-free (offline-first, no jsdom),
// so this is a pragmatic regex + tag-depth matcher. Edge cases a real parser
// handles (a literal `>` inside a quoted attribute value, a tag name inside a
// comment/string) are out of v1 scope — but because the check is a RELATIVE
// before/after snapshot, a consistent mis-parse of an UNCHANGED frozen element
// still compares equal, and the conservative failure direction (false-positive
// rejection) is the safe one for a frozen-zone guard. KEEP IN STEP with the seed.
export function dataRwaFrozenSnapshot(doc) {
  const out = [];
  const openRe = /<([a-zA-Z][A-Za-z0-9-]*)\b[^>]*\bdata-rwa-frozen\b[^>]*>/g;
  let m;
  while ((m = openRe.exec(doc)) !== null) {
    const tag = m[1].toLowerCase();
    const openTag = m[0];
    if (!tagHasFrozenAttr(openTag)) continue; // the cheap regex matched a value/longer-name; not a real frozen element
    if (VOID_ELEMENTS.has(tag) || /\/>\s*$/.test(openTag)) {
      out.push(tag + '\0' + openTag); // self-contained: no inner, no close
      continue;
    }
    const closeEnd = matchingCloseEnd(doc, tag, m.index + openTag.length);
    out.push(tag + '\0' + (closeEnd === -1 ? doc.slice(m.index) : doc.slice(m.index, closeEnd)));
  }
  return out.sort();
}

function snapshotsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  // Attribute-form frozen zones (data-rwa-frozen) are enforced batch-level by
  // snapshot equality (see dataRwaFrozenSnapshot), mirroring the seed.
  const frozenAttr = dataRwaFrozenSnapshot(doc);

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
    if (count === 0) throw new RwaEditError('find_not_found', i, { find, ...findClosestAnchor(working, find) });
    if (count > 1) throw new RwaEditError('find_not_unique', i, { find, count, hints: nearbySnippets(working, find) });

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

  // Attribute-form frozen zones: the set of data-rwa-frozen elements (by
  // tag+outerHTML) must be unchanged after the whole batch — mirrors the seed's
  // dataRwaFrozenSnapshot/snapshotsEqual guard. Reported as frozen_zone_violation
  // (the FAILURE_HINTS message already covers "author-protected frozen zone").
  if (!snapshotsEqual(frozenAttr, dataRwaFrozenSnapshot(working))) {
    throw new RwaEditError('frozen_zone_violation', null, { form: 'attribute' });
  }

  return working;
}
