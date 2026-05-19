# rwa-workflow — workflow product shape spec

## Status

Version 0.6 (current). Defines the HTML shape and execution semantics
of the **workflow** product type. The workflow product lives at the
substrate layer (per `docs/specs/rwa-product-types.md`); this spec is
layered on top of the substrate spec (`re-write-able-spec.md`) and
the edit protocols (`rwa-edit-spec.md`, `rwa-edit-dsl-spec.md`) and
does not replace them.

Conformance scenarios for §2's runner contract live under
`benchmark/scenarios/conformance/workflow-*.mjs`.

## 1. What this spec defines

A workflow renders inside an rwa container's `INLINE_DOC` body and
executes inside the browser. The structure is a tree of three
**primitives** — *linear*, *foreach*, *parallel* — that compose
freely. The frozen `<script>` runner block at the end of the body
walks the tree when the user clicks Run.

The spec is normative for §2 (data flow), §3 (`ctx` object), §4
(per-step state), §5 (reserved tokens), §6 (error codes). §7
(runner implementation) is informative.

## 2. Three primitives

### 2.1 Linear step (leaf)

```html
<li class="rwa-step" data-rwa-id="abc12345">
  <header>
    <h3>Step name</h3>
    <p>Description (optional).</p>
  </header>
  <details>
    <summary>Code</summary>
    <script type="text/rwa-step">
      async function run(ctx, prev) {
        return /* ... */;
      }
    </script>
  </details>
  <output class="rwa-step-output"></output>
</li>
```

- The `<script type="text/rwa-step">` body MUST declare an async
  function named `run` with signature `run(ctx, prev)`. The runner
  invokes `run(ctx, prev)` and threads its return value as the
  next step's `prev`.
- The `<output class="rwa-step-output">` slot is populated by the
  runner with `JSON.stringify(returnValue, null, 2)` (or the
  string itself if the return is already a string).
- The step's optional `<header>` may contain `<h3>` (the name) and
  `<p>` (a one-line description). Both are advisory; the runner
  does not read them.

### 2.2 Foreach container

```html
<li class="rwa-step rwa-foreach" data-rwa-id="def67890">
  <header>
    <h3>For each invoice</h3>
    <p>Iterates the previous step's array.</p>
  </header>
  <ol class="rwa-flow">
    <li class="rwa-step">…</li>
    <li class="rwa-step">…</li>
  </ol>
  <output class="rwa-step-output"></output>
</li>
```

- The container's class list includes BOTH `rwa-step` and
  `rwa-foreach`. The former marks it as a node in the pipeline;
  the latter is the loop discriminator.
- The inner `<ol class="rwa-flow">` holds the loop body — any
  sequence of linear steps, foreach cards, or parallel tables.
  Recursion is allowed.
- Foreach containers do **not** have a `<script type="text/rwa-step">`
  child — the inner `<ol>` IS the body.
- The container's `<output>` displays the final per-iteration
  output array (JSON-stringified).

### 2.3 Parallel block

```html
<table class="rwa-parallel" data-rwa-id="ghi45678">
  <tbody>
    <tr>
      <td class="rwa-step" data-rwa-label="gmail" data-rwa-id="aaa...">
        <header><h3>Fetch Gmail</h3></header>
        <details><summary>Code</summary>
          <script type="text/rwa-step">
            async function run(ctx, prev) { /* ... */ }
          </script>
        </details>
        <output class="rwa-step-output"></output>
      </td>
      <td class="rwa-step" data-rwa-label="slack" data-rwa-id="bbb...">…</td>
      <td class="rwa-step" data-rwa-label="linear" data-rwa-id="ccc...">…</td>
    </tr>
  </tbody>
</table>
```

- The table's class is `rwa-parallel`. Each cell is a leaf step
  carried as `<td class="rwa-step">`.
- Each `<td class="rwa-step">` MUST carry `data-rwa-label`. The
  value MUST match `^[a-z][a-z0-9_]{0,31}$` (lowercase, starts
  with a letter, snake_case, ≤32 chars). All labels in the same
  row MUST be unique.
- A cell MAY carry `data-allow-failure="true"` (v0.6). When set,
  a thrown rejection from that cell does NOT halt the pipeline;
  instead, the cell's slot in the output object becomes
  `{ __error: "<message>", __code: "<code or null>" }` and
  sibling cells / downstream steps continue. Without this
  attribute, the cell's rejection halts the parallel block per
  the default semantics in §3.3.
- A v0.4 parallel block has **one row** (`<tr>`) containing N
  cells. Multi-row parallel pipelines remain deferred (see §8).
- The `<tbody>` element is required for valid HTML (browsers
  auto-insert it; serialized HTML must include it explicitly so
  the runner can `:scope > tbody > tr > td.rwa-step`).

## 3. Data flow contracts

### 3.1 Linear pipeline

Step N receives `prev` = Step N−1's return value. Step 0 receives
`prev = undefined`. The pipeline's output is the last step's
return value.

### 3.2 Foreach

**Upstream contract:** The step immediately preceding a foreach
container MUST return a value V where `Array.isArray(V) === true`.
If V is not an array, the runner throws
`foreach_upstream_not_array` (see §6) and the pipeline halts at
the foreach.

**Per iteration:** For each item `V[i]` (i ∈ [0, V.length)), the
inner `<ol class="rwa-flow">`'s steps execute top-to-bottom with:

- `prev = V[i]` for the *first* inner step.
- `prev` threads forward within the iteration (linear semantics
  inside the loop body).
- `ctx.iter = { index, item, total }` available to every step in
  the iteration. `index` is `i`, `item` is `V[i]`, `total` is
  `V.length`.

**Iteration scope:** `ctx.iter` is the *innermost* enclosing
foreach's iter. Inner foreaches shadow outer ones. `ctx.iter.parent`
is reserved for v0.5; in v0.4, accessing it returns `undefined`.

**Empty array:** If V is `[]`, the foreach runs zero iterations
and its output is `[]`. Not an error.

**Output:** The foreach's output is `[innerFinal_0, innerFinal_1,
..., innerFinal_{V.length-1}]` — one element per iteration,
each being the inner pipeline's final return for that iteration.
Downstream sees this array as `prev`.

### 3.3 Parallel

**Upstream contract:** Any value (object, array, primitive,
undefined). All cells receive identical `prev`.

**`prev` sharing:** The runner MUST pass the same JavaScript value
reference to every cell. Cells MUST treat `prev` as read-only;
mutating it produces undefined behavior across siblings (one cell
may see another's mutation depending on timing).

**Execution:** The runner launches all cells via
`Promise.all([cell0Run(prev), cell1Run(prev), ...])`. Cells do
not see each other's intermediate state or results.

**Output:** `{ [data-rwa-label]: cellReturn, ... }` — an object
keyed by each cell's `data-rwa-label`, values are the cells'
return values. Cell order in the object reflects insertion order
of the cells in the `<tr>` (left-to-right).

**Error semantics:**

- **Default (no `data-allow-failure`):** Per `Promise.all` semantics,
  any cell rejection causes the parallel block to reject. The runner
  halts the pipeline at the parallel block. The failing cell shows
  `.failed` with the error message in its `<output>`. Surviving
  cells' resolved values exist but are NOT piped downstream — the
  rejection ate them.

- **Per-cell `data-allow-failure="true"` (v0.6):** The cell's
  rejection is contained. The cell still shows `.failed` with the
  error message in its `<output>`, but the parallel block does NOT
  reject. The cell's slot in the output object is replaced with
  `{ __error: "<message>", __code: "<code or null>" }`; sibling
  cells continue normally; downstream sees the partial result and
  runs as usual. Reserved keys `__error` and `__code` minimize
  collision risk with real cell-output shapes.

- **Mixed:** If multiple cells reject and at least one of them
  lacks `data-allow-failure`, the parallel block rejects with the
  first such rejection's reason (in cell DOM order). Tolerated
  failures alongside a fatal one are still surfaced in the result
  object, but the result is never returned to downstream because
  the fatal one wins.

### 3.4 Composition

All three primitives nest freely. The runner's tree-walker
dispatches per-node.

- **Foreach in foreach:** allowed. The inner foreach sees its own
  iteration via `ctx.iter`; the outer iteration is shadowed (see
  §3.2).
- **Parallel in foreach:** allowed. Each iteration spawns its own
  parallel block; sibling parallel cells across iterations are
  independent.
- **Foreach in a parallel cell:** allowed. Each cell can be its
  own mini-pipeline including foreaches.
- **Parallel in a parallel cell:** allowed structurally, but if
  the inner parallel's prev requirement matches the outer's prev,
  it's equivalent to flattening — usually a foreach is what the
  user actually wanted. Document but don't optimize for.

## 4. `ctx` object

The runner passes a `ctx` object into every step's `run(ctx, prev)`:

```ts
interface Ctx {
  credentials: {
    get(name: string): Promise<string | null>;
  };
  iter?: { index: number; item: unknown; total: number };
  // Reserved (do NOT use in v0.4):
  // signal?: AbortSignal;
  // log?: (msg: string) => void;
  // shared?: any;
}
```

- `ctx.credentials.get(name)` reads a credential by name. On first
  call for that name in this session, prompts the user via
  `window.prompt`. Caches the entered value in
  `sessionStorage` under key `rwa_cred_<name>`. Returns `null` if
  the user dismisses the prompt. Cleared on tab close.
- `ctx.iter` is present only inside a foreach iteration (§3.2).
- Reserved fields MUST NOT be relied upon in v0.4. The runner
  MAY add them but their semantics are not specified here.

## 5. Per-step state attributes

Both leaf step nodes (linear `<li class="rwa-step">` without
`rwa-foreach`, and parallel `<td class="rwa-step">`) AND container
nodes (`<li class="rwa-step rwa-foreach">`, `<table class="rwa-parallel">`)
carry these runtime-managed attributes. The dirty / staleness chain
remains leaf-only (see §5.1); pin and last-output cache work on both.

| Attribute | Type | Set by | Applies to | Meaning |
|---|---|---|---|---|
| `data-rwa-id` | 8-char | substrate | all step nodes | substrate-assigned stable identifier (per `re-write-able-spec.md` §5.9) |
| `data-rwa-label` | string | author / agent | parallel cells only | required on `<td class="rwa-step">`; must match `^[a-z][a-z0-9_]{0,31}$`; unique within its `<tr>` |
| `data-allow-failure` | `"true"` | author / agent | parallel cells only | opt-in containment (§3.3). Cell's rejection becomes `{__error, __code}` in the output object; sibling cells and downstream continue |
| `data-pinned-output` | JSON string | user gesture | leaves AND containers | runner short-circuits the node's execution and returns the parsed value as if the node had completed normally |
| `data-last-output` | JSON string | runner | leaves AND containers | cache of the most recent successful run's return value |
| `data-last-run-hash` | 8-char hex | runner | leaves only | FNV-1a hash of `stepBody + '::' + prevHash` at last successful run; mismatch ⇒ runner marks node `.stale`. Not set on containers — see §5.1 |

**Preserve verbatim:** Agents editing the workflow via `apply_edits`
or `apply_dsl_plan` MUST preserve all five attributes when editing
the surrounding node. Substrate-level data-rwa-id preservation rules
(per `re-write-able-spec.md`) extend to the workflow-managed
attributes.

### 5.1 Container pin semantics (v0.5)

A pinned container — `<li class="rwa-step rwa-foreach" data-pinned-output="...">`
or `<table class="rwa-parallel" data-pinned-output="...">` — causes
the runner to skip the container's execution entirely:

- Foreach: skips iteration; returns the parsed value as the
  container's output (which downstream sees as `prev`). Inner
  steps' `<output>` slots are NOT updated by the pin path (the
  container short-circuited before reaching them).
- Parallel: skips `Promise.all`; returns the parsed value as the
  container's output. Cells' `<output>` slots are NOT updated.

Pinning a container with a malformed value throws
`pinned_value_invalid_json` exactly like a leaf.

**Staleness for containers is not tracked in v0.5.** Edits to the
container's body (changing an inner step's script, swapping a
parallel cell, etc.) do NOT mark the container `.stale`. The
runtime cannot detect this without a recursive structural
fingerprint, which is a v0.6 candidate. Users who pin a container
must manually unpin to re-run after edits.

**Pin precedence:** When a container is pinned, the pins on its
descendants never run — the container short-circuits before reaching
them. Their `data-pinned-output` values remain in the document and
take effect again once the container is unpinned.

## 6. Error codes

Errors thrown by the runner during workflow execution. Each has a
fixed `code` string accessible via `err.code`.

| Code | Meaning |
|---|---|
| `foreach_upstream_not_array` | Step preceding a foreach returned a non-array value. The foreach cannot iterate. |
| `parallel_label_invalid` | A parallel cell is missing `data-rwa-label`, or the value doesn't match `^[a-z][a-z0-9_]{0,31}$`, or duplicates another label in the same `<tr>`. Detected at runtime when the parallel block is first reached (NOT at boot). |
| `step_missing_script` | A linear step or parallel cell lacks a `<script type="text/rwa-step">` child. |
| `step_script_no_run` | Step body executed but did not define an async function named `run`. |
| `pinned_value_invalid_json` | A leaf node has `data-pinned-output` but the value is not valid JSON. |

User-code exceptions (anything thrown from inside `run(ctx, prev)`)
propagate unchanged with their original `message` and `code`. The
runner marks the originating node `.failed` and halts the pipeline.

## 7. Runner contract (informative)

A conformant runner implementation MUST:

- Walk the workflow tree top-to-bottom on Run, recursively.
- Honor leaf pin short-circuit before invoking `run()`.
- Cache `data-last-output` and `data-last-run-hash` on successful
  leaf execution.
- Provide a per-leaf `▶ Test` affordance that runs that leaf
  against the closest upstream's cached value (`data-last-output`
  or `data-pinned-output`).
- Provide a per-leaf `📌 Pin/Unpin` affordance that commits via
  `runtime.applyEnvelope`, snapshotting the live DOM's other
  runner attrs into the commit so they survive IDB replay.
- Recompute `.stale` on every render (boot, post-commit,
  post-run).
- Render error states via `.failed` + error message in the leaf's
  `<output>`.
- Render running state via `.running`.
- Surface workflow-level status via `.rwa-run-status`
  (`● running…`, `✓ done (N steps)`, `✗ <code>`).

The reference implementation lives in the frozen runner block at
the bottom of `KIND_WORKFLOW_BODY` in `cli/src/seed.mjs`.

## 8. Non-goals (deferred to v0.7+)

- Multi-row parallel tables (each column its own internal pipeline
  meeting at row boundaries).
- Inter-cell communication within a parallel block.
- Branching / conditional execution (`if (prev) { ... } else { ... }`
  at the structural level). Use code-level branching inside a
  step body.
- Dynamic parallelism (spawning N parallel branches based on a
  runtime value). Use a foreach for this pattern.
- Container-level test-step (running just a foreach or parallel
  table without re-running the whole pipeline above).
- Container-level dirty/stale tracking (a foreach or parallel
  pinned to a value whose body has been edited shows no warning;
  user must manually unpin to see code drift).
- `ctx.iter.parent` chain for outer-iteration access.
- `ctx.signal`, `ctx.log`, `ctx.shared`.

(Container-level **pin** shipped in v0.5 — see §5.1. Per-cell
**`data-allow-failure`** shipped in v0.6 — see §3.3.)

## 9. Composition example

A "morning workflow" combining all three primitives:

```html
<ol class="rwa-flow">
  <li class="rwa-step">
    <header><h3>Fetch repos</h3></header>
    <details><summary>Code</summary>
      <script type="text/rwa-step">
        async function run(ctx, prev) {
          const r = await fetch('https://api.github.com/orgs/anthropics/repos?per_page=5');
          return await r.json();
        }
      </script>
    </details>
    <output class="rwa-step-output"></output>
  </li>
  <li class="rwa-step rwa-foreach">
    <header><h3>For each repo</h3></header>
    <ol class="rwa-flow">
      <table class="rwa-parallel">
        <tbody><tr>
          <td class="rwa-step" data-rwa-label="issues">
            <details><summary>Code</summary>
              <script type="text/rwa-step">
                async function run(ctx, prev) {
                  const r = await fetch(`https://api.github.com/repos/${prev.full_name}/issues?per_page=3`);
                  return (await r.json()).map(i => i.title);
                }
              </script>
            </details>
            <output class="rwa-step-output"></output>
          </td>
          <td class="rwa-step" data-rwa-label="prs">
            <details><summary>Code</summary>
              <script type="text/rwa-step">
                async function run(ctx, prev) {
                  const r = await fetch(`https://api.github.com/repos/${prev.full_name}/pulls?per_page=3`);
                  return (await r.json()).map(p => p.title);
                }
              </script>
            </details>
            <output class="rwa-step-output"></output>
          </td>
        </tr></tbody>
      </table>
      <li class="rwa-step">
        <header><h3>Summarize</h3></header>
        <details><summary>Code</summary>
          <script type="text/rwa-step">
            async function run(ctx, prev) {
              return { repo: ctx.iter.item.full_name, issues: prev.issues, prs: prev.prs };
            }
          </script>
        </details>
        <output class="rwa-step-output"></output>
      </li>
    </ol>
    <output class="rwa-step-output"></output>
  </li>
</ol>
```

Reading the structure top-to-bottom:

1. Linear step fetches 5 repos.
2. Foreach iterates the array; per iteration:
   - Parallel block fetches issues + PRs concurrently. Output:
     `{ issues: [...], prs: [...] }`.
   - Linear step uses `ctx.iter.item.full_name` + `prev.issues` +
     `prev.prs` to build a per-repo summary.
3. The foreach's final output is an array of those summaries, one
   per repo.

---

Spec version 0.6 — adds per-cell `data-allow-failure` (§3.3). A
parallel cell can now opt into failure containment; its rejection
becomes `{__error, __code}` in the output object while sibling cells
and downstream continue. Container dirty/stale tracking, container
test-step, multi-row parallel, inter-cell comms, and dynamic
parallelism remain deferred to v0.7+.

Spec version 0.5 — adds container-level pin (§5.1).

Spec version 0.4 — initial release. Defines linear / foreach /
parallel primitives, leaf state attributes, error codes, and the
runner contract.
