# rwa-edit v1.5 — Anchor-based edit protocol for rewritable containers

**Status:** draft v1.5.
**Targets:** rwa container spec v0.8 and later.
**Position in the architecture:** Defines how the agent expresses changes to the document. Adopting rwa-edit v1 requires (a) replacing the modify pathway in the bootstrap with a multi-turn tool-use conversation, (b) updating the system prompt, and (c) adopting the typed-record shape for `rwa_hist` entries. It does **not** require changes to IDB store layouts, snapshot format, or the public `runtime.*` surface; the v0.8 disk format is preserved.

---

## 1. Motivation

In the original rwa modify flow the agent receives the document, returns a complete rewritten version, and the runtime swaps it in. This works, but format-stability is bound by model variance: different models reflow whitespace, reorder attributes, normalize quotes, "improve" class names, drop comments. Over many edits the document drifts away from anything the author would recognize, even when every individual edit was semantically correct. Diffs become noise; runtime invariants embedded in the document text become fragile.

rwa-edit v1 ensures the model never emits the unchanged regions of the document. The agent produces a list of `(find, replace)` pairs against the current document. The runtime applies them as exact string substitutions. The 99% of the document the agent did not need to change is byte-identical because the model never rewrote it.

HTML is code. The same `str_replace`-shaped tool LLMs already use to edit source files is the right shape for editing a document where the source *is* the artifact.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **doc** | The single string that is the editable document — the value at `rwa_doc.get('self')`. The body fragment that becomes `#rwa-doc-mount.innerHTML` plus the inline `<style>` and `<script>` blocks the document author authored. |
| **edit** | A single `(find, replace)` pair against the doc. The atomic unit of change. |
| **batch** | An ordered list of edits sent in one tool call. Applied as a unit — all succeed or none do. |
| **anchor** | The `find` string of an edit, viewed as a locator. An anchor must uniquely identify the position to be modified. |
| **frozen zone** | A region of the doc that the runtime refuses to edit, marked with paired comment fences or the `data-rwa-frozen` attribute. |
| **envelope** | The full JSON object sent through the tool call. Carries the batch plus protocol metadata. |
| **escape hatch** | The companion tool `replace_document`, used for wholesale rewrites where anchor edits don't fit. |
| **modify lifecycle** | The full sequence from ⌘K through render: lock acquired → prompt issued → tool conversation → commit → render → lock released. |
| **structural shape** | The pair `(<script> tag count, <style> tag count)` of the doc, parsed as an HTML body fragment. The post-apply check verifies this is unchanged for `apply_edits`. |

The existing rwa vocabulary (container, bootstrap, document, snapshot, DOC_UUID, render mount) is unchanged.

---

## 3. Document model

The doc is a single string. The runtime presents it to the agent as one field; the agent emits edits against it.

```json
{
  "doc_uuid": "8f3a4c1e-9d2b-4e7a-b6f5-1c2d3e4a5b6c",
  "doc": "<h1>Tasks</h1>\n<ul id=\"task-list\">…</ul>\n<style>\n#task-list { … }\n</style>\n<script>\n  document.getElementById('task-list')…\n</script>",
  "frozen_zones": [
    { "name": "theme-tokens", "begin": "/* rwa:frozen:begin theme-tokens */", "end": "/* rwa:frozen:end theme-tokens */" },
    { "name": "api-contract", "begin": "// rwa:frozen:begin api-contract",     "end": "// rwa:frozen:end api-contract" }
  ]
}
```

Frozen zones are presented as their marker strings, not as byte offsets. The agent locates them in the doc the same way it locates anything else — by searching for the text.

The agent does not see the bootstrap, the snapshot tag, the reserved stores, or any other container infrastructure.

---

## 4. The edit and the envelope

```ts
type Edit = {
  find:    string   // exact substring; must be non-empty and unique in the current doc
  replace: string   // replacement text; may be empty to delete a region
  reason?: string   // optional, per-edit human-readable note
}

type ApplyEditsEnvelope = {
  version: "rwa-edit/1"
  edits:   Edit[]   // 1..N edits
  reason?: string
}
```

Rules:

1. **`find` matches exactly.** Byte-for-byte. Whitespace, line endings, and casing all matter. The agent is expected to copy from the input, not retype.
2. **`find` must be unique within the doc.** Exactly one occurrence. If the natural anchor would be ambiguous, the agent extends it with surrounding context until uniqueness is restored.
3. **`find` must be non-empty.** Wholesale population goes through `replace_document` (§6).
4. **`replace` may be empty.** This deletes the matched region.
5. **No regex, no globs, no line numbers, no occurrence indices.** Anchors are literal strings, matched once. This is the load-bearing constraint that makes the protocol model-portable; ordinal selectors like "the second match" are explicitly out of scope (see §17).
6. **No reserved markers in either side.** Neither `find` nor `replace` may contain the substrings `rwa:frozen:begin`, `rwa:frozen:end`, `<!-- rwa:`, `/* rwa:`, `// rwa:`, or the attribute name `data-rwa-frozen`. Edits that need to span a frozen zone must anchor outside it.

---

## 5. apply_edits semantics

### 5.1 Two-phase application

The runtime applies a batch in two phases against an in-memory working copy of the doc. The modify lifecycle's mutex is held by the caller (§5.5); `apply_edits` does not acquire its own.

**Phase 1 — Validate (no mutation):**

1. Parse the envelope. Reject if `version` is not `rwa-edit/1`, or `edits` is empty or malformed.
2. Read the current doc from `rwa_doc.get('self')` into the working copy. Canonicalize line endings to LF (§5.4).
3. Compute the **structural shape** of the original doc (§5.6).
4. For each edit in order:
   - `find` non-empty (else `empty_find`)
   - Neither `find` nor `replace` contains a reserved marker substring (else `frozen_zone_violation`)
   - `replace` length is within the per-edit cap (else `replace_too_large`)
   - After LF canonicalization of the edit's `find`, it appears in the working copy (else `find_not_found`, returned with a near-miss `closest` per §10)
   - It appears exactly once (else `find_not_unique`)
   - Apply the replacement to the working copy so subsequent edits see the new state.
5. After all edits are applied to the working copy:
   - Every frozen-zone name from the original doc is present in the working copy, with intact begin/end markers and byte-identical inner content (else `frozen_zone_corrupted`).
   - The working copy parses cleanly via `DOMParser` in `text/html` mode (else `parse_error_post_apply`).
   - The working copy's structural shape matches the original (else `structural_shape_changed`). See §5.6.
   - The working copy is within the size budget (else `target_size_exceeded`).

If any check fails, the batch is rejected. Nothing is persisted. The runtime returns the failure code, the index of the offending edit when applicable, and helper context (the closest actually-present text for `find_not_found`; occurrence count and surrounding-context snippets for `find_not_unique`; the parse error message for `parse_error_post_apply`; before/after shape pairs for `structural_shape_changed`).

**Phase 2 — Commit (single IDB transaction, matching v0.8 layout):**

```js
const tx = db.transaction(['rwa_doc','rwa_undo','rwa_hist'], 'readwrite')

tx.objectStore('rwa_doc').put(workingCopy, 'self')

const undoArr = (await reqAsync(tx.objectStore('rwa_undo').get('self'))) || []
undoArr.push(currentDoc)
while (undoArr.length > 10) undoArr.shift()
tx.objectStore('rwa_undo').put(undoArr, 'self')

const histArr = (await reqAsync(tx.objectStore('rwa_hist').get('self'))) || []
histArr.unshift({ ts: Date.now(), kind: 'edit_batch', envelope })
tx.objectStore('rwa_hist').put(histArr.slice(0, 15), 'self')

await tx.done
```

Either every store reflects the new state or none do. After commit, the modify-lifecycle wrapper triggers re-render (§11) and releases the mutex.

### 5.2 Duplicate-batch protection

A successful batch applied a second time will fail at the first edit's `find_not_found` (validation is total before partial apply, so the remaining edits are not evaluated). This catches duplicate tool calls and accidental double-sends. It is not idempotency in the algebraic sense (`f(f(x)) ≠ f(x)`); it is *replay protection*, achieved as a free side-effect of unique-find. The runtime should surface duplicate detection clearly rather than silently re-applying.

### 5.3 Sequential application against a working copy

Edits are applied in array order. Each edit operates on the doc *as modified by* earlier edits in the same batch. This lets a later edit anchor on text produced by an earlier edit, which is occasionally useful. The cost is that order matters, and the agent is responsible for getting it right.

### 5.4 Encoding and line-ending canonicalization

`find` and `replace` are interpreted as their JSON-decoded UTF-8 strings. The runtime performs no normalization beyond the line-ending step below: no Unicode NFC, no whitespace trimming, no quote canonicalization.

Line endings are a known source of model and provider variance. The runtime canonicalizes to LF (`\n`) at three points:

1. **At read-time:** when the doc is loaded from `rwa_doc` for the validation working copy.
2. **At edit-validation-time:** the canonicalized `find` and `replace` are matched against the LF-canonical working copy.
3. **At commit-time:** the working copy is written back LF-canonical, both into `rwa_doc` and (on save) into the bootstrap's `INLINE_DOC` template literal. The seed's existing template-literal escaper must be updated to LF-normalize as well; commits that round-trip a CRLF doc through the seed without normalization will reintroduce the variance the protocol is trying to eliminate.

After v1 adoption, on-disk containers carry LF-only docs as an invariant.

### 5.5 Concurrency: caller-held mutex

The modify lifecycle is wrapped by a single in-memory mutex held by a higher-level `modify()` function:

```
acquire mutex
  → issue prompt to agent (with current doc + tools)
  → drive multi-turn tool conversation (§9.2)
  → on apply_edits or replace_document tool call: validate + commit
  → re-render
release mutex
```

A second ⌘K issued while the mutex is held returns `concurrent_modify` immediately, before any model round-trip is wasted. `apply_edits` and `replace_document` themselves do not acquire the mutex; they assume it is already held by the caller.

This is single-tab concurrency. Cross-tab modify on the same container is already not supported by v0.7/v0.8.

### 5.6 The post-apply parse check, in detail

A naïve "parses as valid HTML" check is the wrong shape: HTML5 parsing is intentionally lenient and accepts almost everything, including inputs where an edit accidentally swallowed enormous amounts of content into an unclosed `<script>` or `<style>`. A strict-validity check is also wrong shape: it rejects many things browsers handle fine (e.g. `<div><span>hello</div>` — implicitly closed spans are valid HTML5 parsing). v1 specifies a third option: **structural-shape preservation**.

The check has two layers:

1. **Parse cleanly.** `new DOMParser().parseFromString(doc, 'text/html')` produces a document with no `<parsererror>` element. This catches catastrophically broken inputs.

2. **Structural shape preserved.** Compute the shape pair `(N_script, N_style)` where:
   - `N_script` = count of `<script>` elements anywhere in the parsed tree
   - `N_style` = count of `<style>` elements anywhere in the parsed tree

   The shape pair of the post-apply doc must equal the shape pair of the original doc.

This catches the realistic accidental-damage signal — splitting a `<script>` tag drops `N_script` from K to K-1; fusing two `<style>` blocks drops `N_style`; an edit that accidentally introduces a stray `<script>` raises the count. Top-level element count is **not** part of the shape check: adding a new top-level section (e.g. a footer) or splitting one section into two are common, intentional edits that should remain in `apply_edits` territory rather than being forced through the wholesale-rewrite path.

Edits that *intend* to add or remove a `<script>` or `<style>` tag must use `replace_document` (§6). This is a deliberate constraint: such changes are structural and rare, and routing them through the wholesale-rewrite path keeps `apply_edits` for surgical changes within the existing scripting/styling skeleton.

---

## 6. replace_document — the escape hatch

Anchor edits are wrong for two cases: scaffolding a fresh document where there is nothing to anchor against, and wholesale redesigns the user explicitly asked for. For these, the agent calls `replace_document` instead.

```ts
type ReplaceDocumentEnvelope = {
  version: "rwa-edit/1"
  doc:     string   // the entire new doc
  reason:  string   // required, not optional
}
```

Validation rules for `replace_document`:

1. `version` is `rwa-edit/1`.
2. The new doc parses cleanly via `DOMParser` in `text/html` mode (else `parse_error_post_apply`). Note: `replace_document` does **not** check structural-shape preservation — wholesale rewrites legitimately change the shape.
3. The set of frozen-zone names in the new doc equals the set in the prior doc — every prior name is still present *and* no new names are introduced — with intact begin/end markers and byte-identical content between them (else `frozen_zone_corrupted`). The escape hatch can rewrite anything *except* frozen zones; it can neither remove nor introduce them.
4. New doc is within the size budget (else `target_size_exceeded`, same cap as `apply_edits`).

Commit semantics are identical to `apply_edits`: single IDB transaction across `rwa_doc`, `rwa_undo`, `rwa_hist`. The audit-log entry is `{ ts, kind: 'replace_document', reason }` — the new doc body is not duplicated into history.

The system prompt biases strongly toward `apply_edits`. `replace_document` is the conscious escape; `reason` is required so the audit log captures *why* the agent reached for it. **The runtime does not auto-fallback from `apply_edits` to `replace_document` after retry exhaustion** (§9.2) — silent escalation from surgical to wholesale would defeat the format-stability goal the protocol exists to deliver.

---

## 7. Frozen zones

Frozen zones are author-declared regions the runtime refuses to modify. They protect runtime contracts that surface inside the document text — schema hashes, theme tokens, API anchors, anything the document needs to keep stable across edits.

### 7.1 Marker grammar

Markers are literal substrings the agent must never produce. Three forms cover the syntactic contexts in the doc:

```html
<!-- rwa:frozen:begin <name> -->
…HTML content…
<!-- rwa:frozen:end <name> -->
```

```css
/* rwa:frozen:begin <name> */
…CSS content…
/* rwa:frozen:end <name> */
```

```js
// rwa:frozen:begin <name>
…JS content…
// rwa:frozen:end <name>
```

`<name>` is `[A-Za-z0-9_-]+` and pairs the begin and end markers. The validator parses these by literal substring scan — no regex over arbitrary HTML, no DOM walk. This is fast, deterministic, and unaffected by minification.

CSS-block markers (`/* … */`) are valid in JS too; line-comment markers (`// …`) are JS-only.

### 7.2 Enforcement

- Edits cannot contain marker substrings or `data-rwa-frozen` in `find` or `replace` (rule 6 in §4).
- After a batch applies, the set of frozen-zone names must be unchanged — every prior name is still present, paired, with byte-identical inner content, *and* no new names are introduced. The post-apply check extracts the substring between each `begin <name>` / `end <name>` pair before and after, and compares the full sets. Adding a new frozen zone via concatenated edits is rejected for the same reason as removing one.
- Nested or mismatched markers (`begin foo` … `begin foo` … `end foo`) are a `frozen_zone_corrupted` failure regardless of cause.

**Adding, modifying, or removing frozen-zone markers and content requires external editing of the container file.** Neither `apply_edits` nor `replace_document` can introduce, alter, or delete them — `apply_edits` is forbidden by rule 6 from producing the marker text at all, and `replace_document` is required by §6 rule 3 to preserve every prior frozen zone byte-identically.

This is intentional and absolute. A "frozen zone the agent can opt out of editing" is just a strong suggestion, and would be reached for the moment a user expressed impatience. Frozen zones exist for invariants that should require a human at a text editor to change — schema hashes, API contracts, theme tokens, embedded credentials' shape. The friction of "open the .html file in your editor" is the feature, not the bug.

### 7.3 Inline element opt-in

For document authors who want a whole `<script>` or `<style>` element frozen without using comment fences inside it:

```html
<script data-rwa-frozen>
  // entire script is frozen
</script>
```

`data-rwa-frozen` is a reserved attribute. Rule 6 in §4 forbids it in any `find` or `replace`. The runtime additionally diffs the content of all `[data-rwa-frozen]` elements pre/post and rejects on any change.

---

## 8. Tool schemas

The runtime exposes two functions to the agent. The schemas below are canonical; provider-specific serializations follow their own conventions.

```json
{
  "name": "apply_edits",
  "description": "Apply anchor-based string edits to the rewritable document. Each edit specifies a literal substring to find (which must be unique in the current doc) and a replacement. Edits are applied in order, atomically — all succeed or none do. Frozen zones (regions with rwa:frozen:begin/rwa:frozen:end markers, or elements with the data-rwa-frozen attribute) are off-limits: never include those marker substrings or that attribute name in find or replace. Edits must preserve the document's structural shape: the count of <script> tags and <style> tags must not change. Use replace_document for changes that add or remove these. Prefer this tool for all document changes.",
  "input_schema": {
    "type": "object",
    "required": ["version", "edits"],
    "properties": {
      "version": { "const": "rwa-edit/1" },
      "reason":  { "type": "string" },
      "edits": {
        "type": "array", "minItems": 1,
        "items": {
          "type": "object",
          "required": ["find", "replace"],
          "properties": {
            "find":    { "type": "string", "minLength": 1 },
            "replace": { "type": "string" },
            "reason":  { "type": "string" }
          }
        }
      }
    }
  }
}
```

```json
{
  "name": "replace_document",
  "description": "Wholesale-replace the document. Use only when scaffolding a fresh document, or when the user explicitly requested a redesign that anchor edits cannot express cleanly. Frozen zones (rwa:frozen:begin/rwa:frozen:end pairs and data-rwa-frozen elements) must be preserved byte-identically in the new doc. Provide a reason explaining why anchor edits were not appropriate.",
  "input_schema": {
    "type": "object",
    "required": ["version", "doc", "reason"],
    "properties": {
      "version": { "const": "rwa-edit/1" },
      "doc":     { "type": "string" },
      "reason":  { "type": "string", "minLength": 1 }
    }
  }
}
```

The schema descriptions repeat the frozen-zone constraint because some providers surface tool descriptions to the model independently of the system prompt.

---

## 9. Modify pathway

This section specifies what changes in the bootstrap when adopting v1. There are two pieces: the system prompt and the multi-turn tool conversation.

### 9.1 System prompt

The new system prompt frames the agent as an editor of an existing document, not an author of a new one. Without it, the model will continue to emit whole documents in the `replace` field of a single edit and call it conforming.

Skeleton:

```
You are editing a rewritable HTML document. The document is a single string,
shown below between <DOC> and </DOC>. Your job is to apply the user's
requested change as a small set of surgical edits.

You have two tools:
  • apply_edits — preferred. Submit (find, replace) pairs. Each find must be
    a non-empty literal substring that appears exactly once in the doc.
  • replace_document — escape hatch. Use only for scaffolding or when the
    user explicitly asked for a wholesale redesign.

Rules for edits:
  • Copy anchors from the doc verbatim. Do not retype them.
  • Whitespace and line endings in find must match the doc exactly.
  • If your natural anchor is not unique, extend it with surrounding context
    until it is.
  • Never include rwa:frozen:begin, rwa:frozen:end, <!-- rwa:, /* rwa:,
    // rwa:, or data-rwa-frozen in find or replace. Frozen zones are listed
    below; anchor outside them.
  • Preserve data-rwa-id attributes verbatim — they are runtime-assigned
    stable block names that URLs link to. When you replace a block's text,
    copy the existing data-rwa-id through. Never invent new values.
  • Do not add or remove <script> or <style> tags via apply_edits — that
    requires replace_document.
  • If your edit's anchor would be longer than the changed region itself,
    consider whether replace_document is more appropriate.

Frozen zones in the current doc:
<FROZEN_ZONES>
…names and marker strings…
</FROZEN_ZONES>

The user request:
<REQUEST>…</REQUEST>

The current doc:
<DOC>…</DOC>
```

The exact wording is implementation-defined; the constraints listed are the load-bearing ones.

### 9.2 Multi-turn tool conversation

The modify pathway is a tool-use loop, not a single-shot completion:

```
1. modify() acquires the mutex (§5.5).
2. Send messages = [{ role: "user", content: <prompt with doc> }]
       with tools = [apply_edits, replace_document].
3. Receive an assistant turn.
   a. If it contains a tool_use block:
      - Validate (§5.1 phase 1 or §6).
      - On success: commit, return tool_result success, exit the loop.
      - On failure: return a tool_result containing the failure code and
        helper context. Append both turns to the messages array. Send the
        conversation back to the model.
   b. If it contains only text and no tool_use, the model has declined to
      edit. Surface the text to the user and exit the loop without
      committing.
4. Cap the number of failed tool_use rounds at 3. After the third failure,
   surface the last failure code and helper context to the user without
   re-prompting and without falling back to replace_document.
5. modify() triggers re-render (§11) and releases the mutex.
```

**Post-budget UX.** When the retry budget is exhausted, the runtime returns the structured failure to the user with the same helper context the agent saw on its last attempt: the near-miss `closest` for `find_not_found`, occurrence count and snippets for `find_not_unique`, the affected element/region for `frozen_zone_violation`, the shape diff for `structural_shape_changed`, etc. The user can rephrase, narrow the request, or open the file externally. **The runtime does not silently fall back to `replace_document`.** Silent escalation from surgical to wholesale would deliver exactly the format drift the protocol exists to prevent — three failed surgical attempts becoming a complete rewrite is a worse outcome than honest failure.

The retry budget is per-modify, not lifetime. Each ⌘K starts a fresh conversation with a fresh budget.

---

## 10. Failure modes

| Code | Meaning |
|---|---|
| `version_unsupported` | Envelope `version` is not `rwa-edit/1`. |
| `malformed_envelope` | Required fields missing or wrong type. |
| `empty_find` | An edit has `find: ""`. |
| `find_not_found` | `find` does not appear in the working copy. When a near-miss exists, returned with `closest` (the closest text actually present, verbatim and copy-pasteable) and `match` (`whitespace` — collapse-whitespace match; `case` — case-insensitive match; `partial` — longest distinctive prefix), computed deterministically without a model call. |
| `find_not_unique` | `find` appears more than once. Returned with occurrence count and surrounding-context snippets. |
| `frozen_zone_violation` | An edit's `find` or `replace` contains a reserved marker substring or `data-rwa-frozen`. |
| `frozen_zone_corrupted` | After applying, frozen-zone names, pairing, or inner content do not match the original. |
| `parse_error_post_apply` | The resulting doc fails `DOMParser` (`text/html`) — a `<parsererror>` element appears in the parsed tree. |
| `structural_shape_changed` | `<script>` count or `<style>` count differs between the original and post-apply doc. Returned with before/after pairs. `apply_edits` only; `replace_document` is exempt. |
| `replace_too_large` | An individual edit's `replace` field exceeds the per-edit size cap (default 8 KB). |
| `target_size_exceeded` | Resulting doc exceeds the implementation-defined whole-document size cap. |
| `concurrent_modify` | A modify is already in progress. Returned by the modify-lifecycle wrapper, not by `apply_edits`. |

Failures during the tool-use loop are returned as `tool_result` blocks with structured payload `{ code, edit_index?, count?, hints?, closest?, match?, message?, shape_before?, shape_after?, hint? }` so the model can act on them in the next turn. `closest`/`match` carry the `find_not_found` near-miss (§10). The runtime MAY add a plain-English `hint` — a one-line, code-keyed recovery instruction — to steer weaker/local models toward a fix; it is advisory and additive, never a substitute for the structured fields.

---

## 11. Re-rendering and side effects

After commit, the runtime re-renders by the existing `renderDoc` path: `#rwa-doc-mount.innerHTML` is set to the new doc string. Inline `<style>` tags inside the doc take effect via DOM parsing automatically. Inline `<script>` tags do **not** execute on innerHTML insertion (per HTML spec), so the runtime walks the inserted scripts and replaces each with a freshly-created `<script>` element carrying the same attributes and `textContent`:

```js
function renderDoc(html) {
  const m = document.getElementById('rwa-doc-mount');
  m.innerHTML = html;
  m.querySelectorAll('script').forEach(o => {
    const s = document.createElement('script');
    for (const a of o.attributes) s.setAttribute(a.name, a.value);
    s.textContent = o.textContent;
    o.parentNode.replaceChild(s, o);
  });
}
```

Anchor edits do **not** change this. JS embedded in the document still runs from the top after every modify. Event listeners attached inside `#rwa-doc-mount` are torn down with the innerHTML; intervals, timers, and module-scoped state in document scripts are reset. The discipline ("document JS must be idempotent," skill-rule 6) is the same as the v0.7/v0.8 wholesale-rewrite path. Anchor edits make the source diff smaller, not the side-effect surface narrower.

The element ID `rwa-doc-mount` should be added to the rwa container spec's reserved-namespaces table.

---

## 12. Audit log

`rwa_hist` is the existing reserved store from v0.7/v0.8. Its layout is unchanged: a single array under key `'self'`, cap 15, newest-first via `unshift`. v1 changes the *content* of array entries.

Pre-v1 `rwa_hist` entries are free-form prompt strings. v1 entries are typed records:

```ts
type EditBatchRecord = {
  ts:       number               // ms since epoch
  kind:     "edit_batch"
  envelope: ApplyEditsEnvelope   // verbatim, including reasons
}
type ReplaceDocumentRecord = {
  ts:       number
  kind:     "replace_document"
  reason:   string
}
```

**Migration.** Legacy string entries coexist with v1 typed records; the runtime treats them as opaque on read and pushes new records onto the front of the same array. Within ~15 modifies the legacy strings cycle out naturally.

**Ordering.** Newest-first.

**Size pressure.** Worst case: 15 entries × ~8 KB `replace` cap × N edits per batch can put `rwa_hist` into the hundreds of KB in IDB. The cap of 15 is the load-bearing protection. As an additional defence against IDB quota pressure, implementations should elide envelope bodies for entries beyond the most recent 5, keeping `{ ts, kind, reason }` only. This is advisory — implementations are free to keep all 15 envelopes if quota is not a concern. `rwa_hist` is not part of the snapshot/file-on-disk format; elision strategies do not affect cross-implementation file compatibility.

---

## 13. Hard rules

1. **Never modify the bootstrap, the snapshot, or any reserved store via this protocol.**
2. **Anchors are exact.** No fuzzy matching, no whitespace normalization beyond LF canonicalization, no case folding, no occurrence indexing. This is how variance is bounded.
3. **Validation is total before apply is partial.** All writes go through one IDB transaction.
4. **Frozen markers are never produced by the agent.** Substring presence in `find` or `replace` is a hard reject. Frozen-zone content is also checked byte-identical post-apply as a backstop.
5. **The agent emits edits, not documents.** A model that returns a wholesale-rewritten document inside a single `replace` field is technically conforming but architecturally defeating the protocol. The runtime caps individual `replace` length to nudge the model toward smaller edits (default 8 KB; cap enforced as `replace_too_large` failure).
6. **`find` uniqueness is checked against the working copy at the time of that edit.**
7. **Empty find is forbidden.**
8. **The mutex is held by the modify-lifecycle caller.**
9. **Structural shape preservation for `apply_edits`.** Adding or removing `<script>` or `<style>` tags requires `replace_document`. Top-level element count is **not** part of the shape check.
10. **No silent escalation.** The runtime never falls back from `apply_edits` to `replace_document` automatically.

---

## 14. When NOT to use anchor-based edits

- **The document is being scaffolded.** Use `replace_document`.
- **The user explicitly asked for a redesign.** `replace_document` with `reason: "user requested wholesale redesign"`.
- **Adding/removing `<script>` or `<style>` tags.** Constrained by rule 9; use `replace_document`.
- **Mass refactor.** Renaming a class used in 40 places via 40 anchor edits is mechanical drudgery. v1 has no `rename_identifier` op (deferred to v2). Use `replace_document`.
- **Heuristic for the agent.** If the smallest unique anchor is longer than the changed region itself, `replace_document` is probably the right tool.

---

## 15. Reserved namespace additions

| Marker | Context | Reserved for |
|---|---|---|
| `<!-- rwa:frozen:begin <name> -->` / `<!-- rwa:frozen:end <name> -->` | HTML | Frozen-zone fences in HTML content |
| `/* rwa:frozen:begin <name> */` / `/* rwa:frozen:end <name> */` | CSS, JS | Frozen-zone fences in CSS or JS content |
| `// rwa:frozen:begin <name>` / `// rwa:frozen:end <name>` | JS | Line-comment frozen-zone fences in JS |
| `<!-- rwa: … -->` / `/* rwa: … */` / `// rwa: …` | All | Reserved for runtime use; documents must not author. |
| `data-rwa-frozen` attribute | HTML | Inline frozen-zone declaration on `<script>` / `<style>` elements. |
| `data-rwa-id` attribute | HTML | **Runtime-assigned, document-wide.** Backfilled to every anchorable block (`p`, `h1`–`h6`, `blockquote`, `li`, `figure`, `pre`, `aside`) at bootstrap and at every commit. Skipped inside frozen zones. The agent must preserve existing values verbatim when editing — they are the stable name a URL fragment resolves to. Never invent new values. See container spec §5.9. |
| `rwa_hist` record `kind` field | IDB | rwa-edit reserves `"edit_batch"` and `"replace_document"`. |
| `#rwa-doc-mount` | HTML element ID | Render mount, used by the runtime. |

---

## 16. Source-format expectations

Anchor-based edits assume the document is reasonably formatted source. Minified or single-line documents work but produce long anchors. Densely repetitive structure with byte-identical content (e.g. server-generated tables of identical rows) is hostile to anchor edits — every row is the same string, no unique anchor exists, and `replace_document` is the right tool. Documents with repetitive *structure* but distinct *content* (e.g. task lists where each item has different text) are fine: the content provides uniqueness without the agent needing to count occurrences.

These are working-condition observations, not protocol issues.

---

## 17. Versioning and evolution

`rwa-edit/1` is the current version. Future revisions increment the integer. The runtime refuses envelopes whose `version` it does not recognize.

Plausible v2 additions, explicitly out of scope for v1:

- **Op types beyond `replace`:** `insert_before` / `insert_after` against an anchor; `rename_identifier` for cross-region refactor; structural ops that change the script/style shape pair.
- **AST-level edits** for the embedded `<script>` and `<style>` content, opt-in.
- **Capability negotiation.**
- **`data-rwa-id` as a first-class anchor.** As of bootstrap 0.9 (container spec §5.9) the runtime backfills `data-rwa-id` on every anchorable block — they exist in every v1 document. A future op could target a block by ID directly (e.g. `{ "data_rwa_id": "7k3p2m9q", "replace": "…" }`) instead of by surrounding-text anchor. v1 does not add this op; the surrounding-text anchor is still the protocol surface. **Note:** this addresses repetitive-content cases the existing protocol handles via `replace_document`; it is a quality-of-life addition, not a fix for an unspecified concept of "anchor erosion." Within a single batch, anchors are evaluated against the current state and do not degrade across the batch.
- **Occurrence indexing.** Considered for v1 and rejected: it makes off-by-one errors silent (matches the wrong region instead of failing loud), requires the model to count occurrences (a known weak spot), and interacts badly with sequential application against a working copy where earlier edits change occurrence counts. The unique-anchor approach with `find_not_unique` failures and surrounding-context retries is more robust. `data-rwa-id` is the v2 path for the cases occurrence indexing was proposed to solve.

v1 stays small on purpose: two ops, one target, exact strings, atomic batches.

---

## 18. Reference: validator core

Validator + applier together are roughly 200–300 lines including frozen-zone scanning, marker pairing, context-hint generation, the parse + shape check, and LF canonicalization. The core apply loop assumes the modify-lifecycle mutex is already held by the caller:

```js
async function applyEdits(envelope, db) {
  if (envelope.version !== 'rwa-edit/1') throw new RwaEditError('version_unsupported')
  if (!Array.isArray(envelope.edits) || envelope.edits.length === 0) throw new RwaEditError('malformed_envelope')

  const currentDoc = canonicalizeLineEndings(
    await reqAsync(db.transaction('rwa_doc').objectStore('rwa_doc').get('self'))
  )
  const originalFrozen = extractFrozenZones(currentDoc)
  const originalShape  = computeShape(currentDoc)

  let work = currentDoc
  for (const [i, edit] of envelope.edits.entries()) {
    if (!edit.find) throw new RwaEditError('empty_find', i)
    if (containsReservedMarker(edit.find) || containsReservedMarker(edit.replace))
      throw new RwaEditError('frozen_zone_violation', i)
    if ((edit.replace?.length ?? 0) > MAX_REPLACE_BYTES)
      throw new RwaEditError('replace_too_large', i)
    const find    = canonicalizeLineEndings(edit.find)
    const replace = canonicalizeLineEndings(edit.replace ?? '')
    const occ = countOccurrences(work, find)
    if (occ === 0) throw new RwaEditError('find_not_found', i)
    if (occ > 1)   throw new RwaEditError('find_not_unique', i, { count: occ, hints: nearbySnippets(work, find) })
    work = work.replace(find, replace)
  }

  const newFrozen = extractFrozenZones(work)
  if (!frozenZonesIntact(originalFrozen, newFrozen)) throw new RwaEditError('frozen_zone_corrupted')

  const parseResult = parseHtmlFragment(work)
  if (!parseResult.ok) throw new RwaEditError('parse_error_post_apply', null, { message: parseResult.error })

  const newShape = computeShape(work, parseResult.doc)
  if (!shapesEqual(originalShape, newShape))
    throw new RwaEditError('structural_shape_changed', null, { shape_before: originalShape, shape_after: newShape })

  if (work.length > MAX_DOC_BYTES) throw new RwaEditError('target_size_exceeded')

  // Single transaction across all three stores, matching v0.8 layout.
  const tx = db.transaction(['rwa_doc','rwa_undo','rwa_hist'], 'readwrite')
  tx.objectStore('rwa_doc').put(work, 'self')

  const undoArr = (await reqAsync(tx.objectStore('rwa_undo').get('self'))) || []
  undoArr.push(currentDoc)
  while (undoArr.length > 10) undoArr.shift()
  tx.objectStore('rwa_undo').put(undoArr, 'self')

  const histArr = (await reqAsync(tx.objectStore('rwa_hist').get('self'))) || []
  histArr.unshift({ ts: Date.now(), kind: 'edit_batch', envelope })
  tx.objectStore('rwa_hist').put(histArr.slice(0, 15), 'self')

  await tx.done
}
```

`computeShape(doc, optionalParsedDoc)` returns `{ scripts, styles }` by parsing the doc once with `DOMParser` and counting. `shapesEqual` is a pair-equality comparison. The remaining helpers are `canonicalizeLineEndings`, `containsReservedMarker`, `countOccurrences`, `nearbySnippets`, `findClosestAnchor` (the `find_not_found` near-miss; §10), `extractFrozenZones`, `frozenZonesIntact`, `parseHtmlFragment`, `reqAsync`.

---

## Appendix A — Changes from v1.4 to v1.5

- **`find_not_found` near-miss.** The dominant failure now carries a deterministic, code-derived recovery aid: `closest` (the closest text actually present in the working copy, verbatim and copy-pasteable) and `match` (`whitespace` / `case` / `partial`) — so an agent fixes its own anchor inside the existing retry budget and a human sees a legible reason. No model call (Rule 5: code answers). Self-correcting failure, not just a louder code. Updated: §5.1 step 4, §5.1 rejection paragraph, §9.2 post-budget UX, §10 table + payload shape, §18 helper list.
- **Optional plain-English `hint`.** The tool-use `tool_result` payload MAY include a one-line, failure-code-keyed `hint` to steer weaker/local models toward a fix. Advisory and additive — never a substitute for the structured fields. §10.
- **`find_not_unique` snippets clarified as mandatory helper context** alongside the new `find_not_found` near-miss (already emitted by the runtime; spec text now enumerates both consistently in §5.1 and §9.2).
- Wire version unchanged (`rwa-edit/1`): all additions are optional, backward-compatible context fields; a consumer that ignores them behaves exactly as under v1.4.

## Appendix B — Changes from v1.3 to v1.4

- **Structural shape narrowed** from triple `(top-level, script, style)` to pair `(script, style)`. Top-level element count is no longer constrained, because adding a top-level section (e.g. a footer) is a common, intentional edit that should remain in `apply_edits` territory. Script/style count drift remains the realistic accidental-damage signal. Updated: §2 vocab, §5.1 step 5, §5.6, §8 `apply_edits` schema description, §9.1 prompt, §10 `structural_shape_changed`, §13 rule 9, §14, §17, §18 pseudocode.
- **`replace_too_large` added to §10** as an explicit failure code with default cap of 8 KB. Was referenced in §13 rule 5 and §18 pseudocode but missing from the failure-modes table in v1.3.
- **§12 size-pressure rationale corrected.** Eliding envelope bodies past the most recent 5 entries is now framed as advisory (IDB quota defence), not normative for "snapshot-format compatibility" — `rwa_hist` is in IndexedDB, not in the snapshot, so elision strategies cannot affect file format.
- **§6 rule 3 and §7.2 tightened** to require set-equality (not subset) of frozen-zone names post-apply. Adding a new frozen-zone name is a `frozen_zone_corrupted` failure, the same way removing one is. Closes a gap where `replace_document` could introduce new author-only invariants. Implementation already enforces this; the spec text now matches.

## Appendix C — Changes from v1.2 to v1.3

(Preserved for review continuity.)

- Parse check semantics specified concretely (DOMParser + `<parsererror>` plus structural shape preservation).
- `structural_shape_changed` failure code added.
- §5.2 renamed and reframed as "Duplicate-batch protection."
- §5.6 added.
- §6 explicitly rejects auto-fallback from `apply_edits` to `replace_document`.
- §9.2 post-budget UX clarified (no silent escalation).
- §17 expanded with explicit rejections for occurrence indexing and `data-rwa-id` reservation.
- Rule 5 updated to reference `replace_too_large` (now properly in §10 as of v1.4).
- Rule 9 added (structural shape preservation).
- Rule 10 added (no silent escalation).
- §16 source-format expectations refined.
- System prompt and tool-schema descriptions updated for shape constraint.

## Appendix D — Changes from v1.1 to v1.2

(Preserved.)

- §0 compatibility claim revised.
- §3 example uses a real UUID.
- §5.1 phase 2 commit pseudocode rewritten to match v0.8's actual IDB schema.
- §5.2 idempotency wording corrected.
- §5.4 LF canonicalization scope made explicit.
- §5.5 mutex scope clarified.
- §6 cross-references the failure codes.
- §7.2 adds explicit double-immutability statement.
- §8 tool-schema descriptions include `data-rwa-frozen`.
- §9 split into §9.1 (system prompt) and §9.2 (multi-turn tool conversation).
- §11 rewritten against the actual `renderDoc` in the seed.
- §12 audit-log section spells out `rwa_hist`'s pre-existing layout and migration.
- §13 hard rules add rule 8 about caller-held mutex.
- §15 adds legacy-comment migration note and `#rwa-doc-mount` reservation.
- §18 pseudocode updated.

## Appendix E — Changes from v1 to v1.1

(Preserved.)

- Single doc target replaced the three-target decomposition.
- `replace_document` schema specified.
- Atomicity via single IDB transaction.
- HTML well-formedness check required.
- Frozen-zone violation rejected by reserved-substring presence.
- Frozen zones presented as marker text.
- Empty-find case removed.
- Concurrency mutex.
- Encoding/normalization rules.
- System prompt sketch.
- Audit log schema.
- Source-format expectations.
- Idempotency note.
- JS re-execution acknowledgement.
- LOC estimate revised to 200–300.
- Target version v0.8.
