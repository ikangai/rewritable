# Edit envelope contract (rwa-edit/1)

`rwa-lite edit` applies a JSON **envelope** to a rewritable in place. You (Claude)
compose the envelope; the applier is deterministic and fails loud — it never
silently rewrites more than you asked. Three envelope shapes, in preference order.

The applier reads the **editable body only** (the text `rwa-lite doc` prints) — never
the bootstrap/runtime. Anchors must match that body **byte-for-byte** (whitespace and
case included). Always `rwa-lite doc <file>` first and copy anchors from its output.

## 1. apply_edits — content edits (preferred)

Surgical `(find, replace)` pairs on **unique** anchors. Applied all-or-nothing.

```json
{ "version": "rwa-edit/1",
  "edits": [
    { "find": "<h1>Untitled</h1>", "replace": "<h1>Coffee Brewing</h1>" },
    { "find": "<p>old line</p>",   "replace": "<p>new line</p>" }
  ] }
```

- `find` must occur **exactly once** in the body (`find_not_unique` otherwise).
- `find` must exist (`find_not_found` — the error carries a near-miss `closest`/`hint`; copy it exactly or pick a shorter distinctive anchor).
- To **insert**, anchor on something unique and include it in `replace`:
  insert-after → `find: "ANCHOR"`, `replace: "ANCHOR\n<new/>"`.

## 2. apply_dsl_plan — structural transforms (use via `--plan`)

A bounded op vocabulary that compiles deterministically to apply_edits. Ops run in order.

```json
{ "version": "rwa-edit-dsl/1",
  "ops": [
    { "op": "insert",   "content": "<p>New para.</p>", "after": "<h1>Title</h1>" },
    { "op": "insert",   "content": "<p>Lead.</p>",     "before": "<h2>Body</h2>" },
    { "op": "replace",  "find": "<td>old</td>", "replace": "<td>new</td>", "all": true },
    { "op": "delete",   "find": "<p class=\"placeholder\">Start writing, or ask the lens below to draft something for you.</p>" },
    { "op": "set_attr", "anchor": "<tr><td", "attr": "class", "value": "highlight" }
  ] }
```

Ops: **`replace`** (`find`,`replace`, optional `all`/`region`), **`insert`** (`content` + `after` **or** `before`), **`delete`** (`find`), **`set_attr`** (`anchor` ending before `>`, `attr`, `value`). `replace_document` is also accepted **as the sole op** in a plan (see below).

## 3. replace_document — escape hatch (requires reason)

Whole-body swap. Only when the change is too irregular for the above. **No silent
escalation** — you choose it explicitly.

```json
{ "version": "rwa-edit/1", "doc": "<article>…entire new body…</article>", "reason": "full redesign: converting prose doc to a dashboard layout" }
```

## Failure codes (exit 3 = envelope_error, exit 2 = file_error)

| subcode | meaning |
|---|---|
| `missing_version` / `version_mismatch` | envelope needs `version` (`rwa-edit/1` for edits/doc; `rwa-edit-dsl/1` for ops) |
| `find_not_found` | anchor absent — error carries a near-miss `closest` + `hint` |
| `find_not_unique` | anchor matches more than once — lengthen it |
| `frozen_zone_violation` | edit crosses a frozen zone (marker-form or `data-rwa-frozen`) — forbidden |
| `reserved_substring` | `find`/`replace` contains a runtime-reserved marker (`rwa:`, `data-rwa-id`, `data-rwa-frozen`, …) |
| `structural_shape_changed` | the edit changed structure the contract preserves |
| `missing_reason` | `replace_document` without a `reason` |
| `not_a_rewritable` | the file isn't a rewritable |

On any failure the file is left **untouched**. Read the subcode, fix the envelope, retry.
