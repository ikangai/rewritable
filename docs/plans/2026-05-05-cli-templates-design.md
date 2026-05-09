# CLI templates — design

Date: 2026-05-05
Status: design validated, ready to implement

## Problem

`rwa new` writes the canonical seed with a fresh UUID — every new container starts identical. Users who repeatedly produce the same kind of document (an invoice, a letter, a recipe) end up either copying their last file by hand and clearing per-instance data, or maintaining their own out-of-band template files.

We want `rwa new invoice` to find a labeled rwa file in cwd and clone it. No registry, no shipped starters, no runtime↔CLI bridge: the file you made yesterday is the template for the file you make tomorrow.

## Decision

A reserved attribute — `data-rwa-template="<kind>"` — declares an rwa file as the canonical template for that kind. `rwa new <kind>` scans cwd, finds the labeled file, and clones it: pristine seed + template's `INLINE_DOC`, fresh UUID, label stripped on the new file.

### Scope

**CLI-only for v1.** No runtime / shared-IDB integration. Cross-folder discovery (`~/.rwa/templates/`, `--from <path>`, `--list-templates`) is deferred. Bundled starters are deferred — your file is the template, full stop.

**Model: canonical blank, not "any instance."** The user labels a single blank-or-near-blank file per kind by hand. Multiple labeled files for the same kind aren't expected, but the CLI degrades gracefully (most-recent mtime wins, prints which file).

### The label

```html
<article data-rwa-template="invoice">
  …
</article>
```

- Lives in `INLINE_DOC`, on the **first child element of `#rwa-doc-mount`** (typically `<article>`). One canonical location keeps parsing simple.
- One value per file. Reserved attribute, listed alongside `data-rwa-frozen` and `data-rwa-id` in the spec.
- The agent must not produce `data-rwa-template` in `find` / `replace` (same rule as `data-rwa-frozen`). Template ↔ instance distinction is author-managed, not agent-managed.
- **Stripped on clone.** The new container is an instance, not the template.

### Discovery

`rwa new <kind>` scans cwd (non-recursive) for rwa containers and picks the file whose first-child-of-`#rwa-doc-mount` carries `data-rwa-template="<kind>"`.

1. Glob `*.html` in cwd. Cap candidate count at 200 — beyond that, error out.
2. Cheap pre-check: file contents include `id="rwa-bootstrap"` (string match, no parse).
3. For passing files: extract `INLINE_DOC` via the existing backtick-walk in `cli/src/seed.mjs`. Regex-match `data-rwa-template="…"` on the first element inside the body.

**No match**: hard error with hint — *"no rwa file in ./ is labeled `<kind>`. Mark a doc as the template by adding `data-rwa-template=\"<kind>\"` to its root element."* No silent fallback to a blank seed — that conflates "I forgot to label" with "I want a blank doc." If you want the blank, use `rwa new`.

**Multiple matches**: most-recent-mtime wins; print the chosen path (`using ./invoice.html as template`). No interactive prompt — keep the CLI scriptable.

**Malformed candidate** (corrupted INLINE_DOC backticks): treat as no-match for that file, continue scanning. Don't fail the whole command for one bad file in cwd.

### Cloning

1. Load the **current bootstrap from the seed** (not from the template file). The bootstrap is byte-identical between seed and template anyway, but always pulling from the seed means a stale template (made against an older bootstrap) automatically gets the latest runtime. The rwa runtime evolves; yesterday's labeled file should not lock you into yesterday's bootstrap.
2. Apply standard seed substitutions on the pristine seed: fresh `DOC_UUID`, `RWA.FILE`, title (via existing `titleFromBasename`).
3. Read the template's `INLINE_DOC` body, strip `data-rwa-template="…"` from the first opening tag, drop the result into the new file's `INLINE_DOC` via `replaceInlineDoc`.
4. Write to the output path.

Order matches `rwa import`: seed substitutions first on the pristine seed, then `INLINE_DOC` swap. Same reason — a literal in the template body that looks like `const DOC_UUID = …` would otherwise trip the exactly-one regex check.

### Output filename

Default: `./<kind>-YYYY-MM-DD.html` (today's ISO date). User can override: `rwa new invoice april.html`. `--force` and `--open` semantics unchanged from `rwa new` / `rwa import`.

## Implementation

**`cli/bin/rwa`** — argv parsing accepts `rwa new [<kind>] [<outPath>]`. Backward-compatible: `rwa new` and `rwa new path.html` continue to work. Disambiguation: if the first positional ends in `.html` or contains a path separator, treat as outPath; otherwise treat as kind.

**`cli/src/commands.mjs`** — `newCmd` grows an optional `templateName`. When set, invokes the template path (find + clone); when unset, current behavior.

**`cli/src/template.mjs` (new)** — small module with `findTemplate(dir, name)` → `{path, inlineDoc} | null` (globs, pre-checks, parses, dedupes, mtime-sorts) and `stripTemplateAttribute(html)` (removes the `data-rwa-template="…"` attribute from the first opening tag inside the body). Reuses `extractInlineDoc` from `seed.mjs` (export it if not already exported). Keeps `seed.mjs` focused on seed I/O.

**`cli/test/` (new)** — minimal `node --test` harness. The CLI has no tests today; this is the right moment to add one. Cases: match (one labeled file → clone with fresh UUID, label stripped, frozen-zones preserved), no-match (exit 2, hint on stderr), multi-match (most-recent mtime wins, prints chosen path), malformed candidate (skipped, valid one wins).

**`re-write-able-spec.md`** — new short subsection describing `data-rwa-template` as author-declared metadata, semantically inert at runtime. Add to the "Reserved namespaces" / "HTML attributes" line. Bump spec to 0.9 with a trailing changelog note.

**`rwa-edit-spec.md`** — append `data-rwa-template` to the reserved-substring list the agent must not produce in `find` / `replace`.

**`seeds/rewritable.html`** — mirror the agent rule in `SYSTEM_PROMPT`. Three sites stay aligned per the existing convention (spec, runtime, prompt).

**`CLAUDE.md`** — extend the "Reserved namespaces → HTML attributes" line to mention `data-rwa-template`. Add a brief "CLI templates" subsection under CLI conventions describing the model: label by hand, scan cwd, clone with strip.

## Verification

Per the test cases above, plus manual:

1. **End-to-end** — in a folder containing a hand-labeled `invoice.html`, `rwa new invoice` produces `invoice-2026-05-05.html`. Open in browser; confirm renders, ⌘K and ⌘S work — same lifecycle as a fresh `rwa new`.
2. **No-cwd-labeled** — `rwa new invoice` in an empty folder errors with the hint, exit 2.
3. **Cross-version** — label a file built against an older seed; confirm `rwa new invoice` produces a new file with the *current* seed's bootstrap. Verifies the "bootstrap from seed, not template" decision.

## Out of scope

- Runtime / shared-IDB template surfacing (e.g. `/new from template` inside an open container, or the service's `/import` page offering templates).
- Cross-folder template discovery: `~/.rwa/templates/`, `--from <path>`, `--list-templates`.
- Bundled starters (the `npx create-react-app` model).
- Per-element clearing on clone (`data-rwa-template-clear`). Model (a) — the user labels a blank — handles "fresh start" without this.
- Recursive cwd scan.
- Interactive disambiguation when multiple files match.
