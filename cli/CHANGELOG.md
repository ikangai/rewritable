# Changelog

All notable changes to the `rewritable` CLI (`rwa`).

## [Unreleased]

### Added
- **`rwa create <task...>` / `rwa draft <task...>`** — scaffold *and* agent-fill a new
  rewritable in one shot from a natural-language task. The leading word picks a frame
  (a cwd `data-rwa-template` match, else a built-in kind) by the same template-first
  precedence as `rwa new`; the rest is the brief. Flags: `--kind`, `--from <file>`,
  `--data <file>` (or `-` for stdin), `--out`, `--force`/`--open`, and the
  `--backend`/`--model`/`--base-url`/`--api-key` backend flags. Output is held to a
  **code-enforced self-containment bar** (no runtime CDN/remote `<script src>`,
  `<link href>`, `@import`, `url()`, `srcset`, …) — visualizations are hand-rolled
  SVG/Canvas, data is embedded; a violation fails loud (exit 4) and writes no file.
  The write is atomic (temp-then-write); a failed run leaves nothing at `--out`. The
  API key is used only for the model call and is never baked into the artifact.
- **`rwa new <name>` bare-word kind dispatch** — a bare first positional now resolves
  template-first, then falls back to a built-in kind. `rwa new presentation` makes the
  built-in deck instead of erroring; a cwd `data-rwa-template="<name>"` file still
  overrides the built-in. Unknown words error naming both misses (lists the known
  kinds).
- **`rwa publish <file>`** — publish a local rewritable to the hosted share service and
  print the share URL (`<short>.rewritable.ikangai.com`, 24h anonymous share).
  `--url` overrides the base; `--json` emits the result/error object. Intentionally
  online (the offline-first invariant of `new`/`import` does not apply to publishing).

Exit codes are stable across the write verbs: `0` ok · `1` usage · `2` file ·
`3` envelope · `4` agent.
