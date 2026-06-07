# Vendored CLI apply pipeline + self-description reader (`service/lib/`)

These files are **byte-identical copies** of `cli/src/*.mjs`. They exist because
the service deploy is a flat `scp` of `service/` only — `cli/` is **not** present
after deploy — so the `/modify` endpoint (essentially `rwa edit --plan` run
server-side) and the hosted `/r .../describe`+`/doc` read endpoints must carry
their own copy of the file-edit apply pipeline AND the self-description reader
rather than reimplement the rwa-edit/1 validator / the `self-description/1`
computer. Same discipline the CLI itself uses to mirror the seed and the
dsl-compiler oracle.

## What the service calls

```js
import { applyPlan, CliError } from './lib/edit.mjs';
await applyPlan(filePath, envelope); // → { exitCode: 0 } | throws CliError
```

- **`applyPlan(filePath, envelope)`** — reads the stored rewritable `.html`,
  extracts the editable `INLINE_DOC` body, applies an `apply_edits` /
  `apply_dsl_plan` / `replace_document` envelope with **all** validation (frozen
  zones both forms, reserved markers, structural shape, find/replace splice),
  rebuilds the file bytes (escapeTL + INLINE_DOC backtick-walk), and writes it
  back atomically (temp + fsync + rename). Returns `{ exitCode: 0 }`; throws
  `CliError(exitCode, subcode, details)` on any failure.
- **`CliError`** — `exitCode` 2 (file: `not_found` / `read_error` /
  `not_a_rewritable`) or 3 (envelope/apply: `frozen_zone_violation`,
  `version_mismatch`, plus the underlying `RwaEditError.code` /
  `DslCompileError.code`).

## Files & why each is in the closure

The complete, minimal relative-import closure of `cli/src/edit.mjs`'s
`applyPlan`. Every file's only further imports are `node:` builtins — **no npm
deps** are pulled in, preserving the service's zero-dep constraint.

| Vendored file | Source | Public symbol the service uses | Why in the closure |
|---|---|---|---|
| `edit.mjs` | `cli/src/edit.mjs` | `applyPlan`, `CliError` | The entry. Composes the four siblings into the on-disk apply. |
| `apply-edits.mjs` | `cli/src/apply-edits.mjs` | (via `edit.mjs`) `applyEdits`, `RwaEditError`, `findFrozenZones`, `dataRwaFrozenSnapshot`, `FAILURE_HINTS` | The validator + find/replace splice (frozen-zone both forms, reserved markers, structural shape). |
| `dsl-compiler.mjs` | `cli/src/dsl-compiler.mjs` | (via `edit.mjs`) `compileDslPlan` | Compiles `apply_dsl_plan` → `apply_edits` (or the `replace_document` escape op). |
| `seed.mjs` | `cli/src/seed.mjs` | (via `edit.mjs`) `extractInlineDoc`, `replaceInlineDoc` | INLINE_DOC backtick-walk: extract the editable body, splice the new body back (escapeTL). |
| `atomic-write.mjs` | `cli/src/atomic-write.mjs` | (via `edit.mjs`) `atomicWrite` | temp + fsync + rename(2) durable write of the rebuilt file. |
| `identity.mjs` | `cli/src/identity.mjs` | `resolveSelfDescription` (+ `countBlocks`, validators) | Publish-safe mirror of `tools/self-description.mjs`: computes the `self-description/1` object from container bytes for the hosted `describe`/`doc` endpoints (Task 3). |
| `skill-manifest.mjs` | `cli/src/skill-manifest.mjs` | (via `identity.mjs`) `parseSkillZone` | Leaf import of `identity.mjs` (imports only `node:crypto`): parses the installed-skill frozen zone into `provenance:'installed'` affordances. |

`seed.mjs` also exports `loadSeed`/`applySeedSubs`/`kindOverrides` etc. that the
apply path does not use; they ride along because the file is copied verbatim (the
cmp gate forbids trimming). They import only `node:fs/promises`.

`identity.mjs`'s relative-import closure is `apply-edits.mjs` (already vendored
for the apply path) + `skill-manifest.mjs` (vendored above; a leaf importing only
`node:crypto`). No npm deps are pulled in — the zero-dep constraint holds.

## Drift check (cmp gate)

Run from the repo root. Any non-empty output means a vendored file drifted from
its `cli/src` source and must be re-copied (or the change rolled back):

```sh
for f in edit apply-edits dsl-compiler seed atomic-write identity skill-manifest; do \
  cmp cli/src/$f.mjs service/lib/$f.mjs; done
```

This is also pinned by `service/tests/vendored-apply.test.mjs` (the drift test
fails the suite on any mismatch). To roll a deliberate change: edit the canonical
`cli/src/<f>.mjs`, then re-copy here with `cp cli/src/<f>.mjs service/lib/<f>.mjs`.
