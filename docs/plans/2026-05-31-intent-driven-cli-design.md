# Intent-driven CLI — design

Date: 2026-05-31
Status: design (validated in brainstorm; not yet built)
Related memory: `project-intent-cli-model`
Supersedes nothing; extends `docs/plans/2026-05-05-cli-templates-design.md` (the `rwa new <kind>` template-clone path) and reuses the `rwa edit` instruction path.

## 1. Motivation

`rwa new presentation` errors today:

```
rwa: no rwa file in ./ is labeled "presentation". Mark a doc as the template by
adding data-rwa-template="presentation" to its root element.
```

Two things are wrong with that, from a UX standpoint:

1. The `presentation` **kind already exists and works** (`rwa new --kind presentation`
   emits a real deck; the seed ships the §5.10 view provider). The bare word
   `presentation` got routed to the *template-clone* path (commit `2460277`), which
   scans the cwd for a `data-rwa-template="presentation"` file, finds none, and
   errors — instead of resolving to the built-in kind.
2. The natural way to ask for things is intent, not flags:
   `rwa new presentation`, and beyond that
   `rwa create an interactive document that visualizes token consumption`.

This design covers two layers that share one resolver:

- **Layer 1 — bare-word kind dispatch on `rwa new`** (offline, deterministic). Fixes
  the immediate `rwa new presentation` failure.
- **Layer 2 — `rwa create` (agentic)** — a new verb that scaffolds *and* fills, so a
  one-line task produces a finished, self-contained artifact.

## 2. The model (load-bearing — do not drift)

A rewritable is **one self-contained `.html` with everything baked in**: no external
data, no live refresh, no standing dependencies, no runtime `<script src>` to any
CDN. Browser-native JS/Canvas/SVG provide interactivity, not libraries.

- The CLI is the **bootstrapper**. It takes a task (+ optional input data) and emits
  the initial container with content/dataset baked into the `INLINE_DOC` snapshot.
  First iteration only.
- After that the file is an **ordinary rewritable**: change it via in-browser ⌘K, or
  re-run the CLI with new inputs to produce a **fresh** artifact.
- The task is a **CLI input, not a file capability**. Its only residue in the file is
  self-description/1 (kind + affordances + baseline) — "what this is." Optionally an
  *inert* origin record (see §10). There is no task layer and nothing to re-run.
- **Recurrence is the CLI's job, not the file's.**

### Offline-first splits in two

The invariant being protected is about the **artifact**, not the command.

- `rwa new` / `rwa import` stay offline + deterministic (unchanged).
- `rwa create` **does** use the network — it calls a model. That is not a violation:
  the command needing a model ≠ a *file* needing a server. Every file `rwa create`
  emits runs with zero external dependencies. "Send the file, they have everything"
  holds without caveat.

### Explicitly NOT building

Re-run-from-file, live external fetch, stored credentials, network/refresh
capability, any persisted "task layer." A credential or standing external dependency
is the v0.7 actions layer (`docs/specs/re-write-able-actions-spec-v0.7.md`) — a
separate, deliberate decision, out of scope here.

## 3. Layer 1 — bare-word kind dispatch on `rwa new`

### 3.1 The conflict

`cli/bin/rwa.mjs` currently treats a bare first positional as a **template name**:

```js
// rwa.mjs (current)
if (!kind && positional[0] && !/\.html?$/i.test(positional[0]) && !/[\\/]/.test(positional[0])) {
  templateName = positional[0];   // bare word ⇒ template name
  outPath = positional[1];
} else {
  outPath = positional[0];
}
```

So `presentation` (a bare word) → template lookup → not found → exit 2. The bare
positional is overloaded between "template label" and "kind name," and the template
path shadows the kind path. `rwa new workflow` / `rwa new document` have the same
problem.

### 3.2 Resolution (RATIFIED 2026-05-31): template-first, kind-fallback

For a bare-word first positional `W` in `rwa new W [path]`:

1. Scan cwd for a file labeled `data-rwa-template="W"` (existing `findTemplate`). If
   found → clone it (existing path, unchanged).
2. Else if `W ∈ KNOWN_KINDS` → emit the built-in kind (as `--kind W`).
3. Else → error. The message should mention *both* failures: no template labeled
   `W`, and `W` is not a known kind (the message lists `KNOWN_KINDS`, mirroring the
   existing `--kind` error — no hardcoded triple).

**Why template-first:** preserves the "your file is tomorrow's template" philosophy
(`2460277`) — a user who customizes a deck and labels it
`data-rwa-template="presentation"` overrides the built-in starter. The common case
(no such file) falls through to the built-in. Strictly backward compatible: the only
behavior change is **error → intended success** for known-kind words; no currently
working invocation changes.

### 3.3 Touch points

- `cli/bin/rwa.mjs` — the dispatch block above: after `findTemplate` misses, fall
  back to `kind = W` when `KNOWN_KINDS.includes(W)`.
- `cli/src/commands.mjs newCmd` — already funnels both body sources through one
  seed-subs flow; the fallback just sets `resolvedKind = W` instead of throwing.
- Help text in `rwa.mjs` HELP and `cli/README.md`.

This layer is tiny, offline, model-free, and ships on its own.

## 4. Layer 2 — `rwa create`

### 4.1 Verb surface

```
rwa create <task...>            scaffold + agent-fill, emit a self-contained file
rwa draft  <task...>            alias of create
```

`create` is canonical; `draft` is the one alias (one dispatch entry). Trimmed from four
spellings to two (RATIFIED 2026-05-31, Rule 2 — no speculative surface): `draft` reads
naturally for the deck/doc case in §1 and §5; `write`/`make` add no capability and are
not shipped. More aliases only if a user actually reaches for one.
Flags:

```
--kind <name>      force the frame kind (skip kind detection)
--from <file>      base the artifact on an existing rewritable's body
--data <file>      bake this dataset into the artifact (or `-` for stdin)
--out <path>       output path (default ./<kind>-YYYY-MM-DD.html)
--force, -o        (as elsewhere) overwrite / open
--backend/--model/--base-url/--api-key   (as in `rwa edit` instruction path)
```

Output path is a **flag** (`--out`), not a trailing positional as in `rwa new [path]`
/ `rwa import <input> [path]`. The whole positional tail of `create` is the task body,
so a trailing path would be ambiguously swallowed by the instruction. This is a
deliberate, documented divergence from the `new`/`import` positional convention.

**Credentials are transient.** `--api-key` (flag→env) is used only for the model call
and is **never** written to the artifact, the data-island, the origin record, or an
echoed error. `create` bakes the *task output* into the file, not its own secrets
(§8 tests this) — keeping the "no stored credentials" cut (§2) intact.

### 4.2 The frame cascade

Every create input splits into a **frame** (what surface, derived from what) and a
**body** (what to generate). The body *always* goes to the agent — it is never
routed. Only the frame is resolved, in stages:

- **Stage 1 — syntactic frame (always; offline; free).** Deterministic:
  - verb → `action = create`;
  - the leading token resolves to a `kind` by the **same precedence as Layer 1**
    (§3.2): a cwd `data-rwa-template` match first, else `KNOWN_KINDS` — so the two
    layers genuinely share one resolver. E.g. `create presentation about Q3` ⇒
    kind=presentation, body="about Q3";
  - explicit flags (`--kind`, `--from`, `--data`) override/short-circuit detection.
    An explicit `--kind` always wins and disables leading-token detection — the
    leading word is then part of the body (`rwa create presentation about X --kind
    document` ⇒ a document whose brief is "presentation about X").
  - Routing is code (CLAUDE.md Rule 5). No model is consulted for a frame that
    resolves here.
- **Stage 2 — model frame inference (only when Stage 1 is silent).** When the leading
  tokens don't name a kind (`create an interactive document that visualizes…`), a
  single cheap model call classifies the frame into
  `{kind, from?, instruction}` and the result is **shown to the user for
  confirmation** before anything is written. The model *names the frame*; it still
  does not route deterministic cases. **v1b ships with Stage 2 OFF**: when Stage 1 is
  silent, default to `kind = document` with the full string as the body (always safe).
  Stage 2 is a v2 addition (§9.2).
- **Stage 3 — agent bakes the body in (always).** The existing agent loop
  (`runAgentLoop`) generates content; `applyPlan` applies the envelope; the result is
  written once (see §4.6).

`--from <file>` is the deterministic base-on-previous mechanism for v1. Natural
phrasing ("based on the last one") is a Stage-2 concern and is deferred to v2
(§9) — v1 either matches `the last <kind>` to the newest cwd file of that kind or
asks for `--from`.

### 4.3 Input data (`--data`)

`--data <file>` (or `-` for stdin) reads a dataset and passes its **contents into the
agent's context** as part of the brief — never executed, never fetched at runtime.
The agent bakes it into the artifact as an inline data island (e.g.
`<script type="application/json" id="…">…</script>` or a JS `const`) so the file
renders standalone. v1 uses a single hard-coded size cap (the data lands in
`INLINE_DOC`, so the binding constraint is snapshot size + browser memory, not the
model window). A **missing** `--data` file → exit 2 (file); an **oversized** but
readable file → exit 1 (usage, `data_too_large`) — fail loud, never silently truncate.
The cap value and a dedicated subcode are only worth tuning if v1 shows it biting.

### 4.4 Authoring prompt — start minimal

The seed's `SYSTEM_PROMPTS` are editor-first, but `create`'s scaffold is **not empty**
— `document` carries a placeholder, `presentation` ships a 3-slide starter, `workflow`
its stages. So `create` is *editing a starter*, which the existing per-kind prompts
already handle (the agent uses `apply_edits`, or `replace_document` with a `reason` to
rewrite wholesale — and the `workflow` prompt already proves the empty-doc path works
under the existing framing).

v1b therefore adds **only** the one create-specific piece actually required for
`create` to succeed: a CLI-injected self-containment directive (the §4.5 contract — no
runtime CDN, browser-native viz, bake the `--data`). Without it the seed prompt's
"cdnjs when genuinely needed" license would produce output the §4.5 guard then
rejects. The directive is CLI-exclusive (never used at runtime) and composes the
seed-extracted `SYSTEM_PROMPT_RULES`, so frozen-zone / `data-rwa-id` / reserved-marker
rules stay single-sourced.

Deferred until a measured `create` failure justifies it (Rule 2): a dedicated
authoring-framing family, and extending the `document`/`presentation` seed prompts with
an explicit empty-doc clause. Try the existing prompts first.

### 4.5 Self-containment generation contract

The create-only directive (§4.4) forbids runtime external dependencies: no
`<script src>` / `<link href>` to any CDN or URL; inline all CSS; hand-roll
visualizations in SVG/Canvas (no D3/Chart.js); embed all data. This is **stricter than
the seed's "cdnjs only when genuinely needed"** and applies **only to `rwa create`
output** — `new`/`import` emit from the same seed and stay prompt/convention-governed
(still permitting cdnjs when genuinely needed). So the "self-contained" guarantee is
*code-enforced for create, convention-governed elsewhere* — stated plainly so we don't
overclaim a universal guard (Rule 7).

Defense in depth (code, not just prompt): a deterministic `assertSelfContained(body)`
guard runs on the agent's output before writing. To actually enforce Invariant 1 (not
give false assurance) it is an **allowlist**, not a scheme denylist:

- A URL-bearing value is allowed only if it is `data:`, a `#` fragment, or an
  authority-less relative path. Anything with a scheme (`scheme:`) **or** a
  protocol-relative prefix (`//host/…`) is rejected.
- It scans the real fetch surface, not just `src`/`href`: `srcset`, SVG
  `href`/`xlink:href`, `<source>`/`<track>`/`<object data>`/`<embed>`, and CSS
  `url(…)` / `@import` inside both inline `<style>` and `style=` attributes.

A violation → fail loud (exit 4, `not_self_contained`). The checked surface is
enumerated here so the §8 test covers each vector; any knowingly-uncovered vector must
be documented, not silently passed (Rule 12).

### 4.6 Atomicity

`rwa create` writes **nothing** unless the whole pipeline succeeds:

1. Build the scaffold in memory (`loadSeed` → `applySeedSubs` →
   `replaceInlineDoc(kind body | --from body)`).
2. Run `runAgentLoop({currentDoc: scaffoldBody, instruction, …})` → envelope.
3. Apply the envelope to the scaffold body and validate the result
   (`assertSelfContained` + the existing reserved-marker / structural checks). Because
   the public `applyPlan(filePath, envelope)` reads+writes a *file*, `create` either
   composes its underlying compile+apply step in memory or applies to a **temp** file
   — never the destination — so a failure never touches `--out`.
4. `replaceInlineDoc` the validated body into the scaffold and write **once** to
   `--out` atomically (tmp-then-rename, cf. `67e0af5` — no leaked `.rwa-tmp`).

Agent failure after the retry budget → exit 4, no file written. The user can always
`rwa new --kind <k>` for a bare scaffold. We never leave a half-baked turd on disk.

Implementation note: the in-memory compose path needs a pure
`applyEnvelope(doc, envelope) → {doc}` extracted from `cli/src/edit.mjs` (which today
only exposes the file-writing `applyPlan`) — named as a work item in §9.1. The
temp-file path avoids that refactor at the cost of extra IO + cleanup.

### 4.7 `app` kind deferred

The `app` kind is reserved/unwired in `KIND_TABLE` ("app, workspace: reserved — wire
when the templates land"). Interactive artifacts ship as **`document` with inline JS**
for v1 (the substrate already allows "JS inline only when interactive"). Wiring `app`
is a separate change (a `KIND_TABLE` entry + `SYSTEM_PROMPTS` entry + README), not
required by this design.

An interactive artifact (e.g. the §5 token-viz) ships as a `document`-with-JS in v1
*by design* even though it is functionally app-like; promoting it to a first-class
`app` kind is a v2 taxonomy decision, not a regression (Rule 7).

## 5. Data flow (worked examples)

**`rwa create an interactive document that visualizes token consumption --data tokens.json`**
1. Stage 1: leading token "an" is not a kind → frame unresolved.
2. Stage 2: model infers `{kind: document, instruction: "interactive document that
   visualizes token consumption"}`; confirm with user.
3. `--data tokens.json` read into the brief.
4. Stage 3 (authoring prompt, document): agent emits a `document` whose inline JS reads
   an embedded `<script type="application/json">` copy of the data and renders a chart
   in SVG/Canvas. `assertSelfContained` passes (no external refs). Write once.
5. Result: opens and renders standalone; `rwa doc --json` reports kind=document and
   any registered view/compute affordance; further change via ⌘K.

**`rwa draft presentation --from ./q2-deck.html --data q3.csv` ("updated numbers")**
1. Stage 1: leading token `presentation` → kind=presentation; `--from ./q2-deck.html`
   sets the base body (must be a rewritable — else exit 2, `not_a_rewritable`); the
   trailing words are the brief.
2. `--data q3.csv` → the new numbers, into the brief.
3. Stage 3: agent produces a fresh deck from the prior body with the numbers baked in;
   `assertSelfContained` passes; write once.
4. Recurrence next quarter = run the command again with new `--data`. The file does not
   refresh itself.

(The natural phrasing "draft a presentation from the last one" — resolving "the last
one" to the newest cwd presentation without `--from` — is Stage-2 / v2 sugar (§9.2). v1
uses explicit `--from`.)

## 6. Reused machinery (signatures read from source 2026-05-31; pin verbatim at implementation)

- `cli/src/agent-loop.mjs` — `runAgentLoop({systemPrompt, toolSchemas, currentDoc,
  instruction, frozenZoneNames = [], backend, onRetry})` → returns
  `{envelope, toolName, messages}`.
- `cli/src/edit.mjs` — `applyPlan(filePath, envelope)` takes a **file path** and writes
  the file itself; throws `CliError(code, subcode, details)`. Envelopes:
  `apply_edits` / `apply_dsl_plan` / `replace_document` (the last requires a non-empty
  `reason`, else `CliError(3, 'missing_reason')`). See §4.6 — `create` composes
  apply+validate+write atomically rather than calling the file-writing `applyPlan`
  directly on `--out`.
- Backend config is resolved **inline** in `cli/bin/rwa.mjs` (there is **no**
  `resolveBackendConfig`): `backendName`/`modelId`/`baseUrl` via flag→env→default,
  `apiKey` via `resolveApiKey(backendName, flagValue)` in `cli/src/backend.mjs`; the
  loop receives `backend: {baseUrl, model, apiKey}`. `create` reuses this verbatim.
- `cli/src/seed-extract.mjs` — `extractFromSeed(seedText)` →
  `{SYSTEM_PROMPTS, SYSTEM_PROMPT_RULES, TOOL_SCHEMAS}` (marker-pair extraction).
- `cli/bin/rwa.mjs` — `detectProductKind(fileText)` (reads `const PRODUCT_KIND`).
- `cli/src/seed.mjs` — `loadSeed`, `applySeedSubs`, `replaceInlineDoc`,
  `kindOverrides`, `KNOWN_KINDS`.
- `cli/src/template.mjs` — `findTemplate` (Layer 1 fallback ordering).

## 7. Error handling & exit codes

Reuse the stable `rwa edit` codes: `0` success, `1` usage (incl. oversized `--data`,
`data_too_large`), `2` file (not found / not a rewritable / dest exists / missing
`--data` file / missing-or-non-rewritable `--from` file), `3` envelope, `4` agent
(incl. `not_self_contained`). `--from` extracts its base body via `extractInlineDoc`,
reusing the same exit-2 `not_found` / `not_a_rewritable` surface as `rwa doc`/`edit`. `--json` mode
emits one `{code, subcode, details}` object per line on stderr, consistent with
`rwa edit`. No new top-level codes (a `new CliError(5,…)` throws by design). The API
key never appears in any emitted file, data-island, origin record, or `--json` error
payload (§4.1).

## 8. Testing (intent, not just behavior — Rule 9)

Layer 1 (offline, deterministic):
- `rwa new presentation` with **no** template → built-in presentation kind, exit 0,
  `PRODUCT_KIND==='presentation'`. (Encodes: known-kind words now create the kind.)
- `rwa new presentation` **with** a `data-rwa-template="presentation"` file → clones
  the template, not the built-in. (Encodes: template-first precedence.)
- `rwa new myreport` with a labeled file → clones (unchanged).
- `rwa new bogus` (no template, not a kind) → exit 2, message names both misses.

Layer 2 (stub backend, à la `benchmark` fidelity stub / `RWA_OPENROUTER_KEY` swap):
- Stage 1 frame unit tests: verb→action; leading-kind greedy match; `--kind`/`--from`
  override; **`--kind` + leading-kind-word conflict → `--kind` wins, leading word is
  body**.
- Create run against a stub envelope → output is valid rwa, correct kind, data baked
  in, `assertSelfContained` passes.
- `assertSelfContained` unit tests: reject `https:` `src`, **protocol-relative
  `//cdn/…`, CSS `url(https://…)` / `@import` in inline `<style>` and `style=`,
  `srcset`, SVG `href`/`xlink:href`, `<source>/<track>/<object>/<embed>`**; allow
  `data:` / relative / `#`.
- **Credential safety: the `--api-key` value never appears in create output**
  (artifact, data-island, origin record, or `--json` error).
- Atomicity: forced agent failure → **no file written**; no `.rwa-tmp` left.

## 9. Open questions / staging

### 9.1 Decisions
- **RATIFIED 2026-05-31:** Layer-1 precedence = **template-first, kind-fallback**
  (§3.2); shared by Layer-2 Stage 1 (§4.2).
- **RATIFIED 2026-05-31:** verb surface = **`create` + `draft`** only (§4.1).

Still open (decide while implementing, not blocking):
- `applyPlan` reuse — extract a pure `applyEnvelope(doc, envelope) → {doc}` from
  `cli/src/edit.mjs` and have `applyPlan` wrap it (clean, named work), **or** use the
  temp-file path (no refactor, extra IO + cleanup). Decide before wiring §4.6.

### 9.2 Staging
- **v1a** — Layer 1 dispatch fix. Ships immediately; offline; model-free; closes the
  original `rwa new presentation` report.
- **v1b** — `rwa create` with Stage-1 syntactic frame + `--kind`/`--from`/`--data`, the
  existing per-kind prompts + the single create-only self-containment directive (§4.4),
  the `assertSelfContained` allowlist guard (§4.5), atomic write (§4.6).
  Descriptive/ambiguous frames default to `document` (Stage 2 OFF).
- **v2** — Stage-2 model frame inference (descriptive kinds, natural base refs);
  optionally the dedicated authoring-framing family (if v1b underperforms) and wiring
  the `app` kind.

## 10. Origin metadata (optional; net-new; deferred)

Correction: there is currently **no** generator/provenance metadata in the seed or CLI
output (verified — no `<meta name="generator">`, no `data-rwa-*` origin). If an inert
origin record is ever wanted (deferred, low priority), it is net-new and constrained:

- **Non-reserved namespace only:** a single `<meta name="generator" content="rwa
  create">` in `<head>`. **Not** a `data-rwa-*` attribute — that namespace is reserved
  runtime-only (CLAUDE.md), so a CLI-stamped `data-rwa-origin` would need a spec
  version bump + registry entry. Not worth it.
- **Bootstrap region, not `INLINE_DOC`:** in `<head>` it sits in the byte-identical
  bootstrap, so it must be a *sanctioned* one-time CLI substitution (like
  `DOC_UUID`/`FILE`) that `loadSeed`/`applySeedSubs` and the reference-regeneration set
  treat as intended, not drift — added to the seed once. Inside `INLINE_DOC` it would
  be ⌘K/agent-editable, defeating "inert record."
- **Inert** — a record, never a capability, never re-run.

Flagged because the brainstorm referred to it as existing; it is not.
```
