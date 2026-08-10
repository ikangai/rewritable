// Diff oracle for fidelity stability scoring.
//
// Spec §2.3: "Compute diff(fixture, post_edit_doc) after LF canonicalization.
// Identify the 'expected change region' — the minimal byte span that contains
// every hunk a correct edit would produce. Sum bytes in hunks outside this
// region; that sum is drift_bytes."
//
// We don't ship a real diff library — for byte-level fidelity scoring, a
// minimal common-prefix/common-suffix walk is enough. It returns a single
// hunk: the maximal middle region that differs. Real diff libraries split
// changes into multiple hunks; for stability scoring on small edits, the
// single-hunk approximation is conservatively correct (it can over-attribute
// drift, but never under-attribute it).
//
// For multi-hunk diffs (e.g. multiple discrete edits in one batch), callers
// should provide an array of expected regions and the oracle checks that
// the single computed hunk is contained within their union.

// LF + NFC, matching the runtime's canonical text form (2026-08-10 design).
// The referee must compare in the same canonical space the contract defines —
// an NFD fixture against an NFC-committing runtime is normalization, not drift.
const canonLF = (s) => String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC');

/**
 * Compute the differing region as a single hunk via common-prefix and
 * common-suffix walks.
 *
 * @param {string} a — original (LF-canonical)
 * @param {string} b — modified (LF-canonical)
 * @returns {{ prefix: number, suffixA: number, suffixB: number, hunkA: [number, number], hunkB: [number, number], drift_bytes: number }}
 *   prefix: length of common prefix (0 if no shared start)
 *   suffixA, suffixB: lengths of common suffix in each
 *   hunkA: [start, end) byte offsets in `a` of the differing region
 *   hunkB: [start, end) byte offsets in `b` of the differing region
 *   drift_bytes: max(hunkA size, hunkB size) — the conservative byte count
 */
export function diffSingleHunk(a, b) {
  const A = canonLF(a);
  const B = canonLF(b);
  if (A === B) {
    return {
      prefix: A.length,
      suffixA: 0,
      suffixB: 0,
      hunkA: [A.length, A.length],
      hunkB: [B.length, B.length],
      drift_bytes: 0,
    };
  }
  // Common prefix
  const minLen = Math.min(A.length, B.length);
  let pre = 0;
  while (pre < minLen && A.charCodeAt(pre) === B.charCodeAt(pre)) pre++;
  // Common suffix (don't cross into prefix)
  let suf = 0;
  while (
    suf < minLen - pre &&
    A.charCodeAt(A.length - 1 - suf) === B.charCodeAt(B.length - 1 - suf)
  ) {
    suf++;
  }
  const hunkA = [pre, A.length - suf];
  const hunkB = [pre, B.length - suf];
  const sizeA = hunkA[1] - hunkA[0];
  const sizeB = hunkB[1] - hunkB[0];
  return {
    prefix: pre,
    suffixA: suf,
    suffixB: suf,
    hunkA,
    hunkB,
    drift_bytes: Math.max(sizeA, sizeB),
  };
}

/**
 * Compute drift_ratio per spec §2.2:
 *   drift_bytes = total bytes changed outside the expected change region
 *   drift_ratio = drift_bytes / total_doc_bytes
 *
 * @param {string} fixture — original doc
 * @param {string} result — post-edit doc
 * @param {Array<[number, number]>} expectedRegions — byte spans (in fixture
 *   coordinates) where edits are allowed. The diff hunk must be contained
 *   within the union of these regions for drift_bytes to be 0.
 * @returns {{ drift_bytes: number, drift_ratio: number, total_bytes: number, hunkA: [number, number], inExpectedRegion: boolean }}
 */
export function computeDrift(fixture, result, expectedRegions = []) {
  const A = canonLF(fixture);
  const B = canonLF(result);
  const total = A.length;
  if (A === B) return { drift_bytes: 0, drift_ratio: 0, total_bytes: total, hunkA: [0, 0], inExpectedRegion: true };

  const { hunkA, drift_bytes: hunkSize } = diffSingleHunk(A, B);
  const inRegion = expectedRegions.some(([lo, hi]) => hunkA[0] >= lo && hunkA[1] <= hi);
  const drift_bytes = inRegion ? 0 : hunkSize;
  const drift_ratio = total > 0 ? drift_bytes / total : 0;
  return { drift_bytes, drift_ratio, total_bytes: total, hunkA, inExpectedRegion: inRegion };
}

/**
 * Discretize drift_ratio into the spec's 0/1/2 stability score.
 * Spec §2.2:
 *   2 — drift_ratio = 0 (byte-identical outside region after LF canon)
 *   1 — 0 < drift_ratio ≤ 0.01 AND no semantic change
 *   0 — drift_ratio > 0.01 OR any semantic change regardless of size
 *
 * Mechanical scoring cannot reliably detect "semantic change" in arbitrary
 * HTML, so this implementation conservatively maps the drift_ratio bands
 * straight to the score. Scenarios that need stricter semantic checks
 * should layer a selector or function oracle on top.
 */
export function discretizeStability(drift_ratio) {
  if (drift_ratio === 0) return 2;
  if (drift_ratio <= 0.01) return 1;
  return 0;
}

/**
 * Helper: find the byte span of a literal substring in a doc. Useful for
 * scenarios that declare expected regions via marker text.
 *
 * @returns {[number, number] | null} [start, end) of the first match, null if absent
 */
export function regionOfLiteral(doc, literal) {
  const A = canonLF(doc);
  const idx = A.indexOf(literal);
  if (idx < 0) return null;
  return [idx, idx + literal.length];
}

/**
 * Compute drift from an apply_edits envelope rather than a textual diff.
 * When the model used apply_edits, the runtime guarantees that the only
 * changes in the post-edit doc are the literal find/replace splices. The
 * find spans (in fixture coordinates) ARE the changes — checking them
 * against expectedRegions is exact and avoids single-hunk diff overshoot.
 *
 * @param {string} fixture
 * @param {Array<{ find: string, replace: string }>} edits
 * @param {Array<[number, number]>} expectedRegions — fixture coords
 * @returns {{ drift_bytes: number, drift_ratio: number, total_bytes: number, spans: Array<[number, number] | null> }}
 */
export function computeDriftFromEdits(fixture, edits, expectedRegions = []) {
  const A = canonLF(fixture);
  // For non-overlapping edits whose finds were each unique in the pre-edit
  // doc, looking each find up in the ORIGINAL fixture gives exact span
  // coordinates without needing to track cumulative shift across reorderings.
  // Edits whose find depends on a prior edit's replace (the SEQ pattern)
  // won't match in fixture and report span=null — that's a degenerate case
  // for fidelity scoring and we surface it rather than silently drift.
  let driftBytes = 0;
  const spans = [];
  for (const edit of edits) {
    const find = edit.find ?? '';
    const replace = edit.replace ?? '';
    const idxFix = A.indexOf(find);
    if (idxFix < 0) { spans.push(null); continue; }
    // The bytes a (find, replace) pair ACTUALLY changes are only those that
    // differ between find and replace; the shared leading/trailing context is
    // byte-identical on both sides and is spliced back unchanged. The system
    // prompt tells the model to widen anchors with surrounding context for
    // uniqueness (seeds/rewritable.html ~§rules), so measuring the full find
    // span would score that safe padding as a side effect when it changes no
    // bytes outside its core. Strip the common prefix/suffix to get the
    // effective changed core. A genuine co-modification (the model also edits
    // adjacent bytes) keeps the core wide enough to fall outside a narrow
    // expected region, so real drift is still caught.
    let pre = 0;
    const minLen = Math.min(find.length, replace.length);
    while (pre < minLen && find.charCodeAt(pre) === replace.charCodeAt(pre)) pre++;
    let suf = 0;
    while (
      suf < minLen - pre &&
      find.charCodeAt(find.length - 1 - suf) === replace.charCodeAt(replace.length - 1 - suf)
    ) {
      suf++;
    }
    const coreStart = idxFix + pre;
    const coreEnd = idxFix + find.length - suf; // end of changed bytes within the find
    const span = [coreStart, Math.max(coreStart, coreEnd)];
    spans.push(span);
    const inRegion = expectedRegions.some(([lo, hi]) => span[0] >= lo && span[1] <= hi);
    if (!inRegion) driftBytes += span[1] - span[0];
  }
  const drift_ratio = A.length > 0 ? driftBytes / A.length : 0;
  return { drift_bytes: driftBytes, drift_ratio, total_bytes: A.length, spans };
}
