# Hosted + images — closing the 8 KB-cap gap

**Date:** 2026-06-10
**Status:** Design (bucket 2 of the deferred-hardening sweep)
**Owner:** torvalds
**Companions:** `rwa-edit-spec.md` §19 (image-asset virtualization), `docs/plans/2026-06-07-hosted-edit-foundation-*.md` (the `/r/` runtime), `docs/plans/2026-06-10-images-in-rewritables-design.md`

## The gap (verified end-to-end)

Image-bearing edits through the hosted `/r/:id/modify` path are rejected. The chain:

1. A user drops/pastes an image into the hosted **browser projection**. `insertImageAt` builds a token-form envelope + an `assets` map and commits through the non-agent path.
2. In hosted mode `commitDoc`'s `__rwaCommitSink` branch fires. Because `assets` is set, it **expands** the envelope to real bytes (`seeds/rewritable.html` commitDoc) — the design comment there says *"the server applies on the REAL stored doc, so a virtual-form envelope must be expanded before it leaves the page."*
3. `hosted-shim.js`'s sink POSTs that expanded envelope verbatim to `/r/:id/modify` (`{envelope, baseHash}`).
4. `service/server.js handleHostedModify` calls `applyPlan(tmpPath, envelope)` with **no opts**.
5. `service/lib/apply-edits.mjs applyEdits` now (post-bucket-1) enforces `MAX_REPLACE = 8 KB`. The ~200 KB data-URI `replace` → `replace_too_large` (HTTP 422).

Before bucket 1 the service had no per-edit cap, so this was a latent "deferred" note; bucket 1 made it a hard, correct rejection. Either way the hosted image insert never worked. There is **no assets side-channel** in the wire today; `MAX_BODY_BYTES = 25 MB` is the only server-side size bound.

## Approaches

### A — Server-side virtualize the incoming envelope (CHOSEN)

`/modify` virtualizes the stored doc **and** the incoming (expanded) envelope's `find`/`replace` into one shared `rwa-asset` map, applies on the token form (so `MAX_REPLACE`/`MAX_DOC` measure the text budget, exactly as the client does), then expands from the map. New image bytes arrive inside the envelope's own `data:` URIs and are registered into the map during virtualization, so expansion resolves them.

* **Pro:** no wire change — the client keeps sending expanded envelopes; `hosted-shim.js` untouched. Symmetric with the client `modify()` (same primitives: `virtualizeImages`/`expandImages`, already vendored). The fix is one new `applyPlan` opt + a few lines in `server.js`. Works for both a new image insert and a move/delete of an existing one.
* **Con:** virtualization removes the per-edit byte cap's DoS role for image data, so it needs a replacement bound (see "Expanded-size guard").

### B — Add an `assets` side-channel to the `/modify` wire

Client sends `{envelope (token form), baseHash, assets: {token: uri}}`; server applies with `virtualImages` + the supplied map.

* **Con:** changes the `/r/` wire protocol (godel's surface) and the client sink, for no behavioural gain over A. The client would also have to send the *full* assets map on every edit (not just the touched image), or track deltas — more coupling. Rejected.

**Decision: A.** B's only theoretical edge (server never sees raw bytes) is moot — the bytes must reach the server regardless to be stored; A carries them in the place they already live (the envelope), B duplicates them into a side field.

## Design (Option A)

### 1. `applyPlan` envelope-virtualization mode

`cli/src/edit.mjs applyPlan(file, envelope, opts)` gains `opts.virtualizeEnvelope` (distinct from the existing `opts.virtualImages`, which assumes the envelope is *already* token-form from the agent). When set:

```
const v = virtualizeImages(currentDoc);              // map seeded from stored doc's images
// tokenize the envelope's strings into the SAME map, registering new data: URIs
envelope = mapEnvelopeImages(envelope, s => virtualizeImages(s, v.assets).doc);
const workDoc = v.doc;
… existing apply on workDoc …
newDoc = expandImages(newDoc, v.assets, v.orphans);  // resolves existing + new tokens
```

`mapEnvelopeImages` walks `edits[].{find,replace}` (and the `doc` field for replace_document) applying the substitution. All reuses existing exported primitives — no new image logic, just a new call site. The `assertNoNewAssetTokens` guard is skipped on this path (tokens are expected and resolvable from the shared map).

`virtualImages` (agent/CLI path, envelope already token-form) and `virtualizeEnvelope` (hosted path, envelope expanded) are the two image modes; a plain call (neither) is the raw path with real-byte caps, unchanged.

### 2. Expanded-size guard (the replacement DoS bound)

After expansion, cap the **real** doc size at `MAX_DOC_EXPANDED = 10 MB` — the same number the GUI enforces client-side (`RWA_IMG.FILE_STOP`), now authoritative server-side. Over → `target_size_exceeded` (reuse the code; add `{ expanded: true, length, cap }` to distinguish in the detail). This restores a hard size bound for the image path that `MAX_REPLACE`/`MAX_DOC`-on-tokens no longer provides, and `MAX_BODY_BYTES = 25 MB` remains the outer request bound. The cap is a shared constant in `apply-edits.mjs` so the CLI and the vendored service agree.

### 3. `server.js` wiring

`handleHostedModify` calls `applyPlan(tmpPath, envelope, { virtualizeEnvelope: true })`. The `/modify` route is the only caller that sets it — the hosted projection is the only surface that relays an expanded image-bearing envelope from a browser. The existing `baseHash` precondition, atomic write, and `CliError → HTTP` mapping are unchanged.

### 4. Client note (no code change)

`commitDoc`'s expand-before-send stays: the server now expects an expanded envelope and re-virtualizes it. Update the stale comment there (it currently says hosted images are deferred) to point at this path.

## Surface parity & re-vendor

`cli/src/edit.mjs` + `cli/src/apply-edits.mjs` (the `MAX_DOC_EXPANDED` constant + `mapEnvelopeImages`) change → re-vendor `service/lib/*` (cmp-gated). `server.js` passes the opt.

## Testing

* `cli/tests/edit.*` / `image-assets`: `applyPlan({virtualizeEnvelope})` with an expanded ~200 KB image insert envelope → succeeds, file carries the real URI, caps not tripped; a >10 MB expanded result → `target_size_exceeded {expanded:true}`; a non-image edit through the mode is a no-op-equivalent (expands to itself).
* `service/tests/hosted.test.mjs`: POST `/r/:id/modify` with an expanded image-insert envelope → 200, `describe`/`doc` round-trip shows the image; an oversized one → 422 `target_size_exceeded`. (Reuses the existing hosted harness — jsdom/fake-idb via `benchRequire`.)
* `tests/` seed suites + conformance unaffected (no seed change in this bucket).

## Scope

**In:** the `/modify` image path (insert / move / delete of a `data:` image), the expanded-size guard, tests, re-vendor, the stale-comment fix.
**Out:** per-image recompression server-side (the client already did it on ingest); an `assets` wire field (Option B); raising `MAX_BODY_BYTES`. The CLI's raw piped/`--plan` path keeps real-byte caps (intentional — a hand-fed envelope with a giant data URI is correctly budget-bound; only the hosted browser-relay path virtualizes).
