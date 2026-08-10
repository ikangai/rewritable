# NFC anchor normalization — canonical text form becomes LF + NFC

**Status:** BUILT (2026-08-10). **Decision:** operator, 2026-08-10 ("normalize both sides of anchor matching").

## Problem

`apply_edits` matches anchors by exact byte splice. Unicode has multiple byte
encodings for visually identical text (NFC `ü` U+00FC vs NFD `u`+U+0308), so a
model returning NFC anchors against a document containing NFD text fails with
`find_not_found` on text that *looks* identical everywhere it is rendered.
Reproduced live (2026-08-08 blindspot probe): NFD "Müller" in the doc + NFC
"Müller" in `find` → `find_not_found` through `cli/src/apply-edits.mjs`. The
test suite contained zero non-ASCII anchors, so the gap was invisible. NFD
enters real documents via paste (PDFs, some macOS pipelines), not typing.

## Decision

The canonical text form of a rewritable document is **LF-only AND Unicode NFC**,
implemented inside `canonLF` itself — the existing single chokepoint that the
document, every `find`, and every `replace` already flow through. Matching
stays a plain exact splice on canonical text; no normalized-to-raw position
mapping exists because nothing ever compares non-canonical text.

Rejected alternative: normalize only at comparison time, keeping raw doc bytes.
That requires mapping match positions from normalized space back to raw space —
a new, subtle machine — and leaves two byte-forms of "the document" alive in
one runtime.

## Sites (9 copies, one definition)

Edit-contract canonicalizer (doc + find + replace + hashes):
1. `seeds/rewritable.html` (`canonLF`, 28 call sites)
2. `cli/src/apply-edits.mjs`
3. `service/lib/apply-edits.mjs` — vendored, re-cp from 2 (cmp-gated)
4. `service/lib/hosted.js` (`baseBodyHash`, `/modify` canon)
5. `benchmark/oracles/diff.mjs` — the drift referee. Updated because the
   *definition of canonical form* changed, not to make code pass: an oracle
   comparing NFD fixture bytes against an NFC-committing runtime would report
   normalization as drift, i.e. it would referee the old contract.

INLINE_DOC embedding canonicalizer (`escapeTL` inputs — emitted containers are
born canonical):
6. `cli/src/seed.mjs`
7. `service/lib/seed.mjs` — vendored, re-cp from 6
8. `tools/compose-artifact.mjs`
9. `service/public/import.html`

Seed-byte identity (`seedIdentity` in `applySeedSubs`) does NOT flow through
`canonLF`; stamped `rwa-seed` hashes are unaffected.

## Interactions

- **`doc_baseline` / hosted `baseBodyHash`** inherit the new form automatically
  (both are sha-256 over `canonLF(body)`). Each container carries its own
  runtime, so every artifact is self-consistent. The one skew window: an
  old-runtime container editing through a new-runtime hosted `/modify` (or vice
  versa) with NFD content in the doc — `baseHash` mismatches and the edit fails
  loudly. Transient, rare (needs NFD content + version skew), and fail-loud is
  the correct degradation.
- **Boot reconciliation:** an NFD-containing container upgraded to this runtime
  recomputes `doc_baseline` with the new canon at first hydration; the ⌘S
  divergence guard may surface once. That is an honest byte change, surfaced by
  the machinery built for exactly this.
- **Signed `rwa-agent/1` records:** signatures verify over canon derived from
  stored strings. Signing-time inputs (browser fields, repo literals, CLI args)
  are NFC in practice; a hand-crafted NFD prompt inside a signed record could
  fail verification after normalization. Accepted; not coded around. Authors of
  signing tools should normalize inputs (noted, not enforced here).
- **Lone surrogates:** `String.prototype.normalize` passes them through; the
  existing lone-surrogate rejection is unchanged.
- **Perf:** `.normalize('NFC')` fast-paths ASCII; the browser-lane scale
  budgets (50/200 KB boot/render/commit) gate any regression.

## Non-goals

Grapheme-cluster-aware matching; preserving NFD in stored documents; NFKC
(compatibility folding changes meaning — `ﬁ`→`fi` is a content edit, not a
canonicalization); normalizing bootstrap bytes (canonLF never sees them).

## Verification

Held-in: `tests/unicode-anchors.mjs` (NFD doc + NFC find applies through the
runtime's envelope path; committed doc is NFC; NFD find also matches; mixed
umlaut/combining content) + a CLI mirror case in `cli/tests/`. Held-out: root
suite, CLI suite, service suite (vendored cmp), conformance, oracle self-tests.
Spec: `rwa-edit-spec.md` canonicalization language + version bump.
