// rwa-edit/1 apply-edits — hand-mirrored from seeds/rewritable.html's
// applyEdits pipeline (search `async function applyEdits`). Read alongside rwa-edit-spec.md §5
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
//      still compares equal. KEEP IN STEP with the seed (search
//      `function dataRwaFrozenSnapshot`).
//   3. Seed's structural-shape check uses DOMParser + executable-script-
//      type filtering + top-level-tag-types set. CLI v1 uses regex counting
//      of <script>/<style> tags — enough to catch the realistic accidental-
//      damage signal (a model emitting an inline <script> in a content
//      edit) without pulling in a parser.
//
// ## Other known v1 scope-downs vs seed
//
// The seed (search `async function applyEdits` in seeds/rewritable.html) enforces additional
// invariants the CLI does NOT in v1. Tracked in cli/TODO.md for v2:
//
//   - MAX_REPLACE = 8KB per-edit cap (seed throws 'replace_too_large')
//   - MAX_DOC = 1MB whole-doc cap (seed throws 'target_size_exceeded')
//   - isWellFormed lone-surrogate guard on find/replace/doc
//   - canonLF normalization of find/replace before matching
//     (CRLF-containing anchors fail with find_not_found in the CLI but
//     match correctly in the browser)
//   - Class-lock violation check on apply_edits (class_lock_violation — an edit
//     find-range crossing a .rwa-locked subtree). NOTE: the replace_document
//     coverage check (class_lock_uncovered) IS enforced — see edit.mjs
//     assertFrozenPreserved + the exported lockedRangesIn/markerZoneRangesIn.
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

// Size caps — mirror of the seed's RWA_EDIT (search `MAX_REPLACE:` in
// seeds/rewritable.html). MAX_REPLACE is the per-edit `replace` cap;
// MAX_DOC is the whole-document cap after the batch applies. With images-v1
// these are measured on the VIRTUAL (rwa-asset token) form when the caller
// virtualizes — a text budget, never a pixel budget (rwa-edit-spec.md §19).
const MAX_REPLACE = 8 * 1024;
// Exported so `rwa doctor` can report size headroom against the SAME cap
// applyEdits enforces (rather than re-declaring a shadow constant that could
// drift). MAX_REPLACE stays unexported — it's a per-edit cap, not meaningful
// to a static single-document health check.
export const MAX_DOC = 1024 * 1024;
// Real-bytes whole-document cap for the image paths, where MAX_DOC measures the
// VIRTUAL (token) form. Mirrors the GUI's container budget (RWA_IMG.FILE_STOP);
// authoritative server-side on the hosted /modify path (rwa-edit-spec.md §19).
export const MAX_DOC_EXPANDED = 10 * 1024 * 1024;

// Canonical text form — mirror of the seed's canonLF: LF-only + Unicode NFC.
// The seed canonicalizes the doc AND every find/replace before matching, so a
// CRLF document or an NFD-containing one (paste artifacts) behaves identically
// in the CLI and the browser. Without LF, a CRLF doc + LF anchor spuriously
// misses; without NFC, an NFC anchor misses visually identical NFD text.
// Exported so edit.mjs can hash exactly the bytes the edit contract operates on
// (bodyHash) — the same canonicalization the hosted /r/:id/doc baseHash uses.
export const canonLF = (s) => (s == null ? '' : String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC'));

// UTF-16 well-formedness — a lone surrogate in find/replace becomes U+FFFD on
// UTF-8 encode (the durable file write) and silently corrupts byte-equality.
// Mirror of the seed's isWellFormed guard. String.prototype.isWellFormed is
// Node 22+; treat its absence as "no check available."
const isWellFormed = (s) => typeof s !== 'string' || typeof s.isWellFormed !== 'function' || s.isWellFormed();

// Plain-English, code-keyed recovery hints. Self-documenting failures: an agent
// (or `rwa edit --json` consumer) gets one actionable line, not just a code.
// A static lookup — never a model call (Rule 5). Keep in sync with the seed's
// FAILURE_HINTS (failureToToolResult). No angle brackets / reserved markers in
// the strings, so they stay safe to embed in the seed bootstrap and survive the
// CLI tree's reserved-marker scan.
//
// Two entries are deliberately CLI-ONLY and must NOT be mirrored into the seed:
// `reserved_substring` and `base_hash_mismatch`. The seed cannot emit either —
// it has no compare-and-swap (its concurrency story is the modify mutex plus the
// cross-tab commit signal), and a hint for a code that surface never produces is
// dead weight in every emitted container.
export const FAILURE_HINTS = {
  base_hash_mismatch: 'The document changed since you read it — another writer committed in between. Re-read it, recompose your edit against the new text, and retry with the new base hash. Do not retry this envelope unchanged.',
  find_not_found: 'find must match the document byte-for-byte (whitespace and case included). If a closest match is shown, copy it exactly; otherwise pick a shorter, distinctive anchor.',
  find_not_unique: 'find appears more than once. Extend it with neighbouring text until it is unique; the hints list shows where.',
  frozen_zone_violation: 'This region is an author-protected frozen zone. Anchor on a different region — frozen zones change only by editing the file outside the runtime.',
  reserved_substring: 'find or replace contains a reserved rwa marker. Anchor on ordinary document text instead.',
  structural_shape_changed: 'The edit would change the document script/style tag count. Keep edits content-only, or use a structural plan.',
  replace_too_large: 'replace exceeds the per-edit size cap. Split the change into smaller anchored edits.',
  empty_find: 'find must be a non-empty string — provide the exact text to anchor on.',
  parse_error_post_apply: 'The result was not well-formed HTML — check that the tags in replace are balanced.',
  unknown_asset_reference: 'src uses an rwa-asset: token that does not exist in this document. Copy tokens verbatim from existing <img> tags; never invent or edit them.',
  // Issue #5 — mirrored for hint-text parity only. The CLI has no rwa_state
  // (browser-only IDB) so it does not enforce this gate itself; the seed's
  // replaceDocument is the sole enforcement point.
  script_introduction_denied: 'This document does not allow the AI to add <script> tags. Make the edit without introducing a script, or ask the user to allow scripts for this document first.',
  // #24 — the codes the retry loop could already feed back but had nothing to say
  // about, so the model got a bare code and spent its remaining attempts guessing.
  // Mirrored from the seed's FAILURE_HINTS; tests/doc-budget.mjs gates the pair.
  target_size_exceeded: 'The document would exceed its size budget. Nothing larger can be committed, so retrying the same edit cannot work — make the change smaller, or replace existing content instead of adding to it.',
  class_lock_violation: 'This region is marked rwa-locked by the author. Anchor on text outside the locked region — locked regions change only by editing the file directly.',
  class_lock_uncovered: 'A replace_document was refused because an rwa-locked region is not fully inside a frozen zone in the new document. Preserve every locked region and its surrounding frozen markers verbatim.',
  frozen_zone_corrupted: 'The result changed a frozen zone — its markers, its name, or its contents. Reproduce every frozen zone byte-for-byte, including the begin/end marker comments, and edit only the text between them.',
  reserved_id_used: 'The runtime owns the id "rwa-doc-mount"; a document element may not use it. Choose a different id.',
  rwa_id_stripped: 'This document requires data-rwa-id attributes to survive. Copy each one verbatim into the replacement — never drop, renumber, or invent them.',
  malformed_envelope: 'The tool call did not match the expected shape. Re-read the tool schema and send every required field, with edits as a non-empty array of {find, replace} objects.',
  version_unsupported: 'The envelope version must be exactly "rwa-edit/1".',
  unknown_tool: 'That tool does not exist. Use apply_dsl_plan, apply_edits, or replace_document.',
};

// ─── Image-asset virtualization (images-v1) ─────────────────────────
// Hand-mirror of the seed block beside containsReservedMarker in
// seeds/rewritable.html (rwaAssetHash8/registerImageAsset/virtualizeImages/
// virtualizeWithMap/expandImages/assertNoNewAssetTokens). Normative contract:
// rwa-edit-spec.md §19. KEEP IN STEP with the seed.
//
// The model never sees image bytes: `rwa edit <instruction>` builds its prompt
// from the VIRTUAL doc (data:image src → rwa-asset:<hash8> token) and the
// apply expands tokens back before the file write. Hash-keyed (FNV-1a — token
// identity/dedupe, not integrity), so tokens are stable across moves and the
// map can be re-derived deterministically from the same doc bytes.
export function rwaAssetHash8(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const RWA_ASSET_SRC_RE = /(\bsrc\s*=\s*)(["'])(data:image\/[^"']*)\2/g;
const RWA_ASSET_TOKEN_RE = /(\bsrc\s*=\s*)(["'])(rwa-asset:[0-9a-f]{8,})\2/g;
export function registerImageAsset(assets, uri) {
  // Collision probe: deterministic re-salt (32-bit birthday ~1e-6 at 100 images).
  let n = 1, token;
  do { token = 'rwa-asset:' + rwaAssetHash8(n === 1 ? uri : uri + '\0' + n); n++; }
  while (assets.has(token) && assets.get(token) !== uri);
  assets.set(token, uri);
  return token;
}
export function virtualizeImages(doc, assets) {
  assets = assets || new Map();
  // Orphans: tokens already present in the RAW doc (user-authored or
  // pre-broken). They map to nothing; expansion passes them through instead
  // of throwing, so a pre-broken doc stays editable.
  const orphans = new Set();
  let m;
  RWA_ASSET_TOKEN_RE.lastIndex = 0;
  while ((m = RWA_ASSET_TOKEN_RE.exec(doc)) !== null) orphans.add(m[3]);
  const vdoc = doc.replace(RWA_ASSET_SRC_RE, (_, p, q, uri) => p + q + registerImageAsset(assets, uri) + q);
  return { doc: vdoc, assets, orphans };
}
// URI→token substitution for ANY string (a doc slice virtualizes to the
// corresponding vdoc slice as long as it doesn't cut a URI in half).
export function virtualizeWithMap(s, assets) {
  if (!s || !assets || assets.size === 0) return s;
  let out = s;
  for (const [token, uri] of assets) out = out.split(uri).join(token);
  return out;
}
export function expandImages(vdoc, assets, orphans) {
  return vdoc.replace(RWA_ASSET_TOKEN_RE, (whole, p, q, token) => {
    const uri = assets ? assets.get(token) : null;
    if (uri == null) {
      if (orphans && orphans.has(token)) return whole;
      throw new RwaEditError('unknown_asset_reference', null, { token });
    }
    return p + q + uri + q;
  });
}
// Tokenize the data:image URIs inside an EXPANDED envelope's find/replace (and
// the replace_document `doc`), registering each into the shared `assets` map so
// expansion can resolve them afterward. Used by the hosted /modify path
// (rwa-edit-spec.md §19, opts.virtualizeEnvelope): the client relays an expanded
// envelope, the server tokenizes it against a map seeded from the stored doc so
// the apply runs on the token form (caps = text budget) and new image bytes ride
// in via the envelope's own URIs. Returns a NEW envelope; the input is untouched.
export function mapEnvelopeImages(envelope, assets) {
  const tok = (s) => virtualizeImages(s || '', assets).doc;   // shares + extends `assets`
  if (Array.isArray(envelope.edits)) {
    return { ...envelope, edits: envelope.edits.map(e => ({ ...e, find: tok(e.find), replace: tok(e.replace) })) };
  }
  if (typeof envelope.doc === 'string') {
    return { ...envelope, doc: tok(envelope.doc) };
  }
  return envelope;
}
// No-assets writers must not introduce a NEW rwa-asset token — a token with no
// bytes behind it is a permanently broken image; committing one silently is the
// failure mode Rule 12 forbids. Tokens already in the current doc stay legal.
export function assertNoNewAssetTokens(currentDoc, work) {
  const seen = new Set();
  let m;
  RWA_ASSET_TOKEN_RE.lastIndex = 0;
  while ((m = RWA_ASSET_TOKEN_RE.exec(currentDoc)) !== null) seen.add(m[3]);
  RWA_ASSET_TOKEN_RE.lastIndex = 0;
  while ((m = RWA_ASSET_TOKEN_RE.exec(work)) !== null) {
    if (!seen.has(m[3])) throw new RwaEditError('unknown_asset_reference', null, { token: m[3] });
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

// Regex-escape a dynamic literal (zone name) before embedding it in a RegExp.
// Mirror of the seed's escapeRegex. Zone names are [A-Za-z0-9_-]+ today so this
// is belt-and-suspenders, but keeping it shared means the three fence-form
// builders below stay byte-aligned with the seed and with each other.
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Full 3-fence-form frozen-zone scan — faithful mirror of the seed's
// extractFrozenZones (seeds/rewritable.html, search `function extractFrozenZones`).
// Returns one entry per begin-marker: { name, inner } for a terminated zone, or
// { name, error: 'unterminated' | 'duplicate' }. This is the canonical scan the
// replace_document guard uses for byte-preservation, add-rejection, unterminated
// AND duplicate detection — across <!-- -->, /* */ and // fence forms — so the
// escape hatch can't silently drop, mint, half-open, or shadow-duplicate a zone
// in any fence form. (findFrozenZones below stays comment-form-only on purpose:
// it is the REPORTING source for `rwa doc`/`ls` frozenZones, where SD-04 pins it
// to the seed's reporting projection. This scan is the ENFORCEMENT source.)
// KEEP IN STEP with the seed.
export function extractFrozenZones3(doc) {
  const zones = [];
  if (!doc) return zones;
  const seen = new Set();
  const beginRe = /(<!--|\/\*|\/\/)\s*rwa:frozen:begin\s+([A-Za-z0-9_-]+)\s*(-->|\*\/|(?=\r?\n|$))/g;
  let m;
  while ((m = beginRe.exec(doc)) !== null) {
    const opener = m[1];
    const name = m[2];
    let innerStart = m.index + m[0].length;
    if (opener === '//') {
      // Line-comment form: the inner zone starts after this line's newline.
      while (innerStart < doc.length && doc[innerStart] !== '\n') innerStart++;
      if (innerStart < doc.length) innerStart++;
    }
    let endRe;
    if (opener === '<!--') endRe = new RegExp('<!--\\s*rwa:frozen:end\\s+' + escapeRegex(name) + '\\s*-->', 'g');
    else if (opener === '/*') endRe = new RegExp('\\/\\*\\s*rwa:frozen:end\\s+' + escapeRegex(name) + '\\s*\\*\\/', 'g');
    else endRe = new RegExp('\\/\\/\\s*rwa:frozen:end\\s+' + escapeRegex(name) + '(?=\\r?\\n|$)', 'g');
    endRe.lastIndex = innerStart;
    const e = endRe.exec(doc);
    if (!e) { zones.push({ name, error: 'unterminated' }); continue; }
    if (seen.has(name)) { zones.push({ name, error: 'duplicate' }); continue; }
    seen.add(name);
    zones.push({ name, inner: doc.slice(innerStart, e.index) });
  }
  return zones;
}

// Detect an unterminated marker-form frozen zone (a begin marker with no
// matching end), across all three fence forms. Thin projection of
// extractFrozenZones3 so the standalone check and the full guard can never
// disagree. Returns the offending zone name, or null. KEEP IN STEP with the seed.
export function unterminatedFrozenMarker(doc) {
  const z = extractFrozenZones3(doc).find(z => z.error === 'unterminated');
  return z ? z.name : null;
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
// scan to EOF looking for a close that never comes. Exported so `rwa doctor`
// can tell a self-contained data-rwa-frozen element (fine, no close expected)
// from a genuinely unterminated one, without re-deriving the HTML void list.
export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Index just past the matching `</tag>` for an element opened at `from`,
// tracking nested same-tag depth so a naive "next close" can't stop early.
// -1 if unterminated. Mirror of the seed's findCloseTagEnd: EVERY non-close
// open of `tag` increments depth — including a self-closing `<tag/>`, because
// for the non-void container tags this is called with (void tags are guarded
// before the call), HTML ignores the trailing slash and treats it as an open.
// (A prior CLI deviation exempted `<tag/>`, diverging from the seed on
// malformed self-closing same-tag nesting — removed for parity.) Exported so
// `rwa doctor` can detect an unterminated data-rwa-frozen element (the same
// depth-tracked match dataRwaFrozenSnapshot uses internally) without
// reimplementing the tag-matching logic.
export function matchingCloseEnd(doc, tag, from) {
  const tagRe = new RegExp('<(/?)' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^>]*>', 'gi');
  tagRe.lastIndex = from;
  let depth = 1, t;
  while ((t = tagRe.exec(doc)) !== null) {
    if (t[1] === '/') { if (--depth === 0) return t.index + t[0].length; }
    else depth++;
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

// Parser-free mirror of the seed's dataRwaFrozenSnapshot (seeds/rewritable.html, search
// `function dataRwaFrozenSnapshot`): each data-rwa-frozen element captured as `tagName\0outerHTML`, sorted.
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

// Parser-free port of the seed's lockedRangesIn (seeds/rewritable.html, search `function lockedRangesIn`):
// the [start, end] byte range of each .rwa-locked element's whole subtree.
// Used by replace_document's class-lock coverage check. matchingCloseEnd is the
// CLI's equivalent of the seed's findCloseTagEnd (depth-tracked same-tag close).
// KEEP IN STEP with the seed.
export function lockedRangesIn(doc) {
  if (!doc) return [];
  // Quoted ("…" / '…') OR unquoted (class=rwa-locked) attribute values — the
  // browser's classList enforces the lock regardless of quoting, so the
  // text-scan must too (mirror of the seed's lockedRangesIn).
  const opening = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>/g;
  const out = [];
  let m;
  while ((m = opening.exec(doc)) !== null) {
    const cls = (m[3] || m[4] || m[5] || '');
    if (!/\brwa-locked\b/.test(cls)) continue;
    const end = matchingCloseEnd(doc, m[1], m.index + m[0].length);
    if (end !== -1) out.push([m.index, end]);
  }
  return out;
}

// Parser-free port of the seed's markerZoneRangesIn (seeds/rewritable.html, search `function markerZoneRangesIn`):
// the [start, end] byte ranges of every protected zone — marker-form frozen
// zones (all three fence forms, INCLUDING the fences) and data-rwa-frozen
// attribute-form element subtrees. Used by the class-lock coverage check to
// verify each .rwa-locked range is fully contained in a protected zone.
// Unterminated begin markers are skipped here (they carry no closed range);
// they are rejected separately by unterminatedFrozenMarker. KEEP IN STEP with
// the seed.
export function markerZoneRangesIn(doc) {
  if (!doc) return [];
  const out = [];
  const beginRe = /(<!--|\/\*|\/\/)\s*rwa:frozen:begin\s+([A-Za-z0-9_-]+)\s*(-->|\*\/|(?=\r?\n|$))/g;
  let m;
  while ((m = beginRe.exec(doc)) !== null) {
    const opener = m[1];
    const name = m[2];
    const startOfBegin = m.index;
    let innerStart = m.index + m[0].length;
    if (opener === '//') {
      while (innerStart < doc.length && doc[innerStart] !== '\n') innerStart++;
      if (innerStart < doc.length) innerStart++;
    }
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let endRe;
    if (opener === '<!--') endRe = new RegExp('<!--\\s*rwa:frozen:end\\s+' + esc + '\\s*-->', 'g');
    else if (opener === '/*') endRe = new RegExp('\\/\\*\\s*rwa:frozen:end\\s+' + esc + '\\s*\\*\\/', 'g');
    else endRe = new RegExp('\\/\\/\\s*rwa:frozen:end\\s+' + esc + '(?=\\r?\\n|$)', 'g');
    endRe.lastIndex = innerStart;
    const e = endRe.exec(doc);
    if (!e) continue; // unterminated — skip (caught by unterminatedFrozenMarker)
    out.push([startOfBegin, e.index + e[0].length]);
  }
  // data-rwa-frozen elements: opening tags carrying that attribute as a real
  // NAME (tagHasFrozenAttr filters value/longer-name false positives).
  const fzAttr = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-rwa-frozen\b[^>]*>/g;
  while ((m = fzAttr.exec(doc)) !== null) {
    if (!tagHasFrozenAttr(m[0])) continue;
    const end = matchingCloseEnd(doc, m[1], m.index + m[0].length);
    if (end !== -1) out.push([m.index, end]);
  }
  return out;
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

  // LF-canonicalize the document up front (mirror of the seed): all matching,
  // splicing, and the post-apply doc are LF-only, so CRLF in the source no
  // longer causes spurious find_not_found against LF anchors (or vice versa).
  doc = canonLF(doc);

  const before = structuralShape(doc);
  const zones = findFrozenZones(doc);
  // Attribute-form frozen zones (data-rwa-frozen) are enforced batch-level by
  // snapshot equality (see dataRwaFrozenSnapshot), mirroring the seed.
  const frozenAttr = dataRwaFrozenSnapshot(doc);

  let working = doc;
  for (let i = 0; i < edits.length; i++) {
    const raw = edits[i] || {};
    if (!raw.find) throw new RwaEditError('empty_find', i);
    // Lone-surrogate guard BEFORE canonLF/match: a malformed find/replace would
    // corrupt the durable file on UTF-8 encode (mirror of the seed).
    if (!isWellFormed(raw.find) || !isWellFormed(raw.replace)) {
      throw new RwaEditError('malformed_envelope', i, { reason: 'lone_surrogate' });
    }
    // Per-edit replace cap (mirror of the seed's MAX_REPLACE). Measured on the
    // raw replace bytes the caller supplied (the virtual/token form under
    // images-v1) — a text budget.
    if ((raw.replace || '').length > MAX_REPLACE) {
      throw new RwaEditError('replace_too_large', i, { length: (raw.replace || '').length, cap: MAX_REPLACE });
    }
    // Canonicalize the anchor + replacement to LF so a CRLF-containing find
    // matches the LF-canonical working copy (and the splice stays LF-only).
    const find = canonLF(raw.find);
    const replace = canonLF(raw.replace);

    // Reserved-substring check (spec §4 rule 6) — runs before the find lookup
    // so a literal `data-rwa-frozen` in either side fails fast.
    if (containsReservedMarker(find) || containsReservedMarker(replace)) {
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

    // Class-declared lock check (rwa-lens/1 spec §7; mirror of the seed's
    // apply path). Reject any find-range overlapping a .rwa-locked source
    // range. Adjacent insertions (find ends exactly where a lock begins, or
    // starts where one ends) are OK. Recomputed per iteration because
    // `working` mutates after each splice.
    const idxLock = working.indexOf(find);
    const editStart = idxLock, editEnd = idxLock + find.length;
    for (const [ls, le] of lockedRangesIn(working)) {
      if (editEnd > ls && editStart < le) {
        throw new RwaEditError('class_lock_violation', i, { lockRange: [ls, le], editRange: [editStart, editEnd] });
      }
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

  // #5 opt-in (rwa-id-strict): mirror of the seed — a container declaring
  // <meta name="rwa-id-strict"> (in a frozen zone) forbids losing an existing
  // data-rwa-id (the default would backfill a fresh one, breaking #frag links).
  if (/<meta\s+name\s*=\s*["']?rwa-id-strict\b/i.test(doc)) {
    const ids = (s) => new Set([...s.matchAll(/\sdata-rwa-id\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => (m[1] != null ? m[1] : m[2])));
    const after = ids(working);
    for (const id of ids(doc)) if (!after.has(id)) throw new RwaEditError('rwa_id_stripped', null, { id });
  }

  // Whole-document cap (mirror of the seed's MAX_DOC). Measured on the final
  // working copy — the virtual/token form under images-v1, so image bytes
  // never count against the text budget.
  if (working.length > MAX_DOC) throw new RwaEditError('target_size_exceeded', null, { length: working.length, cap: MAX_DOC });

  return working;
}
