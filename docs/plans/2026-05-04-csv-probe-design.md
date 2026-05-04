# CSV import probe — design

Date: 2026-05-04
Status: design validated, ready to implement

## Problem

`rwa import` and `/import` currently route by file extension. A `.csv` extension goes straight to `convertCsv`, which feeds the file to papaparse with `header: false`. Papaparse is permissive: any text becomes *some* table — even a paragraph of prose collapses to a one-column `<table>`. A user who mislabels a file (renames `notes.md` to `notes.csv`, or saves a markdown file with the wrong extension) gets a degenerate container instead of an error.

The extension is the right primary signal — it's almost always correct — but we want a sanity check before treating the bytes as tabular.

## Decision

Add a small probe to `convertCsv` on both the CLI (`cli/src/import.mjs`) and the browser (`service/public/import.html`). On probe failure, throw — the user gets a clear error and re-runs after fixing the input.

### Scope

**Defensive verification only.** The probe runs only on the `.csv` branch. `.txt` / extensionless files that happen to contain CSV are still rendered as paragraphs by `convertTxt` — auto-promotion is out of scope.

### Failure mode

**Reject, don't fall back.** A `.csv` file that fails the probe throws with `exitCode = 2`, matching the existing "unsupported format" pattern in `convert()`. No partial output, no fallback to `convertTxt`. Forgiving fallbacks would hide the underlying problem (the file isn't what its extension claims) which is exactly what the probe exists to surface.

### Heuristic

Use papaparse with `preview: 2` and the same options as the real parse:

```js
function looksLikeCsv(text) {
  const probe = Papa.parse(text, { preview: 2, skipEmptyLines: true, header: false });
  if (probe.errors.length > 0) return false;
  if (probe.data.length === 0) return false;
  const cols = probe.data[0].length;
  if (cols < 2) return false;
  if (probe.data.length === 2 && probe.data[1].length !== cols) return false;
  return true;
}
```

Why papaparse and not a regex: the parser already handles quoted fields containing commas, embedded newlines, and `,` / `;` / `\t` auto-detection. A regex on raw line content would falsely reject real CSV like `"Smith, John",1\n"Doe",2` because the comma counts differ. Papaparse is already imported on both surfaces, so the cost is the function above plus a single call site.

Why `preview: 2`: a single line always parses (even prose with one comma). Two lines is the minimum needed to check structural consistency, which is the strongest "this isn't tabular" signal.

### What passes / what fails

Passes:
- Multi-row CSV with consistent column count
- Header-only CSV (`name,age,email\n`) — one row of ≥2 columns
- CSV with quoted fields containing commas or newlines
- Semicolon- or tab-delimited CSV (papaparse auto-detects)

Fails:
- Empty file
- Single-column file (`red\ngreen\nblue`) — paragraphs, not CSV
- Markdown / HTML / prose mislabeled as `.csv`
- First two rows with mismatched column counts

## Implementation

Two files change, one doc updates.

**`cli/src/import.mjs`** — add `looksLikeCsv(text)`; in `convertCsv`, throw `Error("...")` with `e.exitCode = 2` before the existing parse logic when the probe fails. Existing happy-path code is untouched.

**`service/public/import.html`** — mirror `looksLikeCsv` and the throw in the inlined `convertCsv` (the file already carries a `// PORTED FROM cli/src/import.mjs (convertCsv) — keep in sync with the CLI` banner). The existing `try { ... convertCsv(text) ... } catch { showError(...) }` wrapper at line ~181 catches the throw and surfaces it through the existing red banner — no plumbing changes.

**`CLAUDE.md`** — in the "Conventions when editing the service" block, the line listing what `import.html` ports from the CLI currently names `escapeTL`, the INLINE_DOC backtick-walk, the TITLE/FILE substitutions, and `convertCsv`. Add `looksLikeCsv` so the next maintainer knows it's a fourth thing to keep in sync.

Total LOC: ~15-20 across the two source files, plus one line in CLAUDE.md.

## Verification

The import path has no automated test harness (`tests/` covers `rwa-edit/1`, not import), so verification is manual:

1. **CLI happy path** — `rwa import some.csv -o out.html` on a real CSV → unchanged, `<table>` produced.
2. **CLI probe rejects** — `cp re-write-able-spec.md fake.csv && rwa import fake.csv` → exit 2, probe error on stderr, no output file.
3. **CLI quoted-field CSV** — input `name,note\n"Smith, John",hi\n` → passes probe, renders correctly. Confirms regex-style probes are correctly avoided.
4. **CLI single-column** — `printf 'a\nb\nc\n' > col.csv && rwa import col.csv` → exit 2, probe rejects.
5. **Browser** — drag-drop the same four inputs at `/import` → matching outcomes, red banner where expected.

## Out of scope

- Auto-detecting CSV in `.txt` / extensionless files (option (b)/(c) in the brainstorm).
- Adding an automated test harness for the import pipeline.
- Surfacing the probe as a soft warning instead of a hard reject.
- Any change to `convertTxt`, `convertMd`, or `convertHtml`.
