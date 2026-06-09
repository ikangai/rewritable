# Rewritables on the web — hardening design

**Date:** 2026-05-15
**Author:** Martin + Claude
**Status:** Phase 1 scoped; later phases sketched

## Goal

Today a rewritable is a self-contained `.html` that lives on disk. The container's identity is the file. The runtime is hand-delivered (you sent me the file).

We want rewritables to be first-class citizens of the open web. Concretely: a rewritable hosted at `https://example.com/notes.html` should be addressable, fragment-linkable, and safely co-resident with other rewritables on the same origin. The motivating image is Berners-Lee's original: *you keep your own document on your own node; you link into a fragment of someone else's document on theirs; your commentary lives in your file, not by mutating theirs.*

The hardening work is the floor that makes this possible. The link-and-overlay work is the building on top.

## What "on the web" actually changes

The runtime stays entirely client-side. The agent calls go from the visitor's browser to OpenRouter directly. There is no server-side document state, no shared backend, no multi-tenant database. What changes between `file://` and `https://example.com/foo.html` is:

1. **Origin model.** All containers served from one origin share one storage bucket, one sessionStorage, one OPFS root, and one DOM context if iframed together. v0.7 closed the IDB half by namespacing the DB to `rwa_<DOC_UUID>`. sessionStorage and OPFS are still origin-wide.
2. **Identity.** On `file://` a container's name is the local path. On the web a container's name is its **URL**, including the fragment.
3. **Fragments.** A URL can carry `#some-id`. Today nothing in the runtime resolves it. The web wants `#frag` to mean "the same block, even after the surrounding text gets rewritten 50 times."

## Phase 1 — the floor

Three concrete, ship-this-session changes.

### 1.1 Stable block IDs (`data-rwa-id`)

The runtime auto-assigns a stable identifier to every anchorable block (the existing `ANCHORABLE_TAGS` set: `p, h1–h6, blockquote, li, figure, pre, aside`) that doesn't already have one. The ID is short, opaque, URL-safe (8 chars from `crypto.getRandomValues`, lower-base36). Format example: `data-rwa-id="7k3p2m9q"`.

**Lifecycle:**
- On bootstrap, after the first render, the runtime walks the mount for anchorable blocks lacking `data-rwa-id` and assigns fresh IDs.
- If any block needed an ID, the runtime serializes the new DOM, writes it back to `currentDoc`, and commits a single synthetic edit (`kind: 'id_assignment'` in `rwa_hist`). This is one-shot per container — subsequent renders see IDs already there.
- On every subsequent render (after an agent edit or undo), the runtime runs the same walk. If new blocks were introduced without IDs, they get fresh IDs and trigger a follow-up persistence (folded into the same commit when possible).
- IDs are part of the canonical document text. They round-trip through `apply_edits` / `replace_document` / `apply_dsl_plan` because the agent sees the full HTML.

**Agent contract:**
- The system prompt instructs the agent to preserve `data-rwa-id` attributes verbatim and never invent new ones.
- `rwa-edit/1` is unchanged at the protocol level. The contract is purely additive: the agent sees `data-rwa-id` in the doc text and is told to leave it alone.
- If the agent strips an ID (e.g. replacing an entire `<p data-rwa-id="abc">...</p>` block with just `<p>...</p>`), the runtime's per-render walk reassigns *some* ID — the old fragment link is silently broken. We accept that for Phase 1; a strict mode (reject the edit) can come in Phase 2.
  - **Resolved (2026-06-09) — opt-in strict mode.** A container opts in with `<meta name="rwa-id-strict">` (place it in a frozen zone — `data-rwa-frozen` or a marker zone — so the agent can't edit it away). When present in the current doc, `applyEdits` and `replaceDocument` (seed + the CLI mirrors `apply-edits.mjs`/`edit.mjs`) reject any edit whose result *loses* a `data-rwa-id` value present before the edit, with `rwa_id_stripped` (`{ id }`). Existing containers are unaffected (no meta ⇒ default reassign). **Known interaction:** this also gates a *delete* of an id-bearing block (its id disappears) — acceptable for an opt-in container that has declared its block ids load-bearing; refine to "edited-but-survived" semantics later if delete-under-strict proves needed. Pinned by `tests/seed-hardening.mjs` + `cli/tests/edit-plan.test.mjs`.

**Spec changes:**
- `re-write-able-spec.md` bumps to v0.9 with a new subsection: "Stable block identifiers (`data-rwa-id`)".
- The "Reserved namespaces" entry for `data-rwa-id` changes from "reserved for v2" to "runtime-assigned; preserved across edits; authors must not invent values."
- `rwa-edit-spec.md` gets a short addendum: `data-rwa-id` is part of the doc text the agent must respect.

**`findReservedIdViolation` flip:**
The seed currently *rejects* docs containing `data-rwa-id` (line 1660). That check predates the activation. Removed in Phase 1; the runtime now writes those attributes itself.

### 1.2 URL fragment scroll

A new tiny helper in the seed runtime:

```js
function scrollToFragment() {
  if (!location.hash) return;
  const raw = decodeURIComponent(location.hash.slice(1));
  const m = document.getElementById('rwa-doc-mount');
  const el = m.querySelector(`#${CSS.escape(raw)}, [data-rwa-id="${CSS.escape(raw)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('rwa-frag-pulse');
  setTimeout(() => el.classList.remove('rwa-frag-pulse'), 1500);
}
```

Wired to the initial load *and* `hashchange` (so in-page links work). A 1.5s CSS pulse highlight ensures the target is visually obvious after scrolling.

The handler resolves both author-supplied `id=` attributes and runtime-assigned `data-rwa-id` attributes. That gives backwards compatibility (docs with custom IDs keep working) and forwards utility (every block has an addressable name).

### 1.3 Bootstrap version metadata

Add `<meta name="rwa-bootstrap" content="0.9">` to the seed `<head>`. A visitor (or a future tool) can read it to learn what runtime contract this container is using. Not a security primitive yet — just a contract surface. A hash-based version (so you can verify the bootstrap matches a known build) comes later.

## Phase 2 — the next layer (sketched)

Not implemented in this pass; designed enough that Phase 1 doesn't block it.

### 2.1 `<rwa-include>` transclusion

```html
<rwa-include src="https://other.com/notes.html#7k3p2m9q">
  fallback content while fetching, or if the fetch fails
</rwa-include>
```

On bootstrap, the runtime walks for `<rwa-include>` elements, fetches each `src`, extracts the named block (by `id` or `data-rwa-id`), sanitizes ruthlessly (text + structural HTML only — no `<script>`, no external loads, no event handlers), and replaces the include's content. A small attribution pill shows the source URL and last-fetched timestamp.

The sanitizer is non-negotiable: we're rendering third-party content in our origin's DOM. Whitelist mode: only the safe subset of HTML elements, only safe attributes, only safe URL schemes for `href`.

### 2.2 Overlay / commentary metadata

```html
<meta name="rwa-overlay" content="https://other.com/notes.html">
```

Declares "this container is a commentary on / re-write of that URL." Not load-bearing; viewer tools can use it to render side-by-side, generate back-references, etc. Pure metadata.

### 2.3 Sandboxed-iframe wrapper for multi-tenant viewers

For a site that hosts many rewritables (a `rewritable.com`-style service), the strongest isolation is to wrap each container in a `<iframe sandbox="allow-scripts" srcdoc=...>`. Each iframe gets a unique null origin → distinct sessionStorage, IDB, OPFS. The fragment scroll handler needs to learn to translate parent-URL fragments into iframe `postMessage` calls. Not needed for static hosting; only for multi-tenant hosting where untrusted user-supplied rewritables co-exist.

## Out of scope (explicitly)

- **Server-side proxy for OpenRouter calls.** Visitors bring their own key (BYOK). The key lives in `sessionStorage` and is tab-shared by design — that's a UX feature (you don't re-enter your key per container). A multi-tenant service can replace this later.
- **Account model / collaboration.** Each rewritable is single-author. Sharing happens by URL. The transclusion layer (Phase 2.1) is how multi-author composition emerges.
- **Encrypted IDB.** The runtime trusts the browser's storage. A future "private" mode could encrypt at rest, but it's not Phase 1.
- **CSP headers / hashed bootstrap inline script.** Worth doing, but the threat it defends against (CDN compromise / MITM injecting a fake bootstrap) is more relevant once we have a hosted service. Deferred.

## Implementation order (Phase 1)

1. Write this design doc. ✓
2. Update `seeds/rewritable.html`: drop the `data-rwa-id` reserved-violation rule; add `assignDataRwaIds` + `persistAssignedIds`; call from `renderDoc` and from bootstrap-finish; add `scrollToFragment` and wire it up; add the CSS pulse rule; add the `rwa-bootstrap` meta tag.
3. Update `re-write-able-spec.md` (bump to v0.9; new subsection; reserved-namespace edit).
4. Update `rwa-edit-spec.md` (preservation addendum).
5. Update the seed's `SYSTEM_PROMPT` constant: one sentence on `data-rwa-id` preservation.
6. Regenerate `hello.html` and `re-write-able-spec.html` via `node tools/regenerate-refs.mjs`.
7. Add tests in `tests/` covering: fresh-container assignment, ID survival across `apply_edits`, hash-fragment resolution.
8. Open the demo in a browser; verify visually.

## Why this is the right slice

It's the minimum that turns a rewritable into a web citizen: the URL is its name, the fragments are its sub-names, and same-origin neighbors don't accidentally share runtime state. Everything in Phase 2 builds on this without rewriting it.
