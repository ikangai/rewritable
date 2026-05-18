# Runtime product-agnosticism audit

Date: 2026-05-18
Scope: read-only. No runtime, spec, or config changes.
Goal: evaluate whether the rwa runtime is product-agnostic across four product
types (document, workflow, app, multi-agent workspace), inventory the runtime,
list document-product assumptions, and recommend a prioritized path to
agnosticism.

Citation convention: every claim about the codebase carries a `file:line`
reference. Line numbers reflect the working tree at audit time.

## 1. Product types reference

The four product types under audit, as supplied for this evaluation:

1. **Document.** Pure prose. The agent applies surgical edits to text — typo
   fixes, prose rewrites, content additions, structural transforms of a
   continuous body. The user reads the document; the agent edits the
   document.

2. **Workflow.** A staged, item-driven process. Items move through phases
   (e.g. `inbox → in-progress → done`). Each phase may run an agent task on
   the item. Items have persistent per-item state; the workspace renders
   their current stage and history. Multiple agent invocations per item over
   the lifetime of the container.

3. **App.** An interactive artifact: a drop zone, form, list, board, or
   tracker rendered by inline JS. The agent does not edit prose; it appends,
   removes, or mutates structured rows or items inside one editable data
   region. The user interacts with the UI; the artifact calls the agent on
   the user's behalf.

4. **Multi-agent workspace.** Multiple agents collaborating inside one
   container, distinguished by role, prompt, and (where appropriate)
   capabilities. Edits attributed to a specific agent; per-agent state
   surfaces; inter-agent messaging or handoff.

Source notes:

- No current spec in this repo defines all four types as a single taxonomy.
  The framing here is forward-looking, supplied for this audit.
- In-repo precedents:
  - **(1) document** is the canonical product. `re-write-able-spec.md` v0.10
    (the spec's title is "re-write-able") and `seeds/rewritable.html` are
    written around prose containers. `hello.html` and
    `re-write-able-spec.html` are worked examples.
  - **(3) app** is documented as the "artifact dialect" of rwa in
    `docs/specs/rwa-artifact-conventions.md` v0.1 (draft, 2026-05-12). Worked
    example: `demo/invoice-tracker.html`. The conventions doc explicitly
    distinguishes documents from artifacts but treats both as variants of
    the same runtime.
  - **(2) workflow** and **(4) multi-agent workspace** have no spec and no
    worked example in-repo. The runtime offers primitives that can be
    composed toward them (see §3) but no first-class support.

## 2. Runtime feature inventory

Every feature below cites the file and a symbol/function. Where applicable,
multiple lines are listed because a feature is split across sites.

### Render target

- Single mount: `<div id="rwa-doc-mount"></div>` at `seeds/rewritable.html:154`.
- `renderDoc(html)` at `seeds/rewritable.html:735–778`. Body: captures
  id-keyed form state (`:749–754`), wipes `m.innerHTML = html` (`:755`),
  re-executes `<script>` tags by re-cloning them (`:756–761`), restores form
  state (`:762–767`), rebuilds source-position map (`:772`), rebuilds
  locked-range index (`:773`), re-binds click-to-anchor (`:777–778`).
- Default typography for the mount in `:where(#rwa-doc-mount)` selectors at
  `seeds/rewritable.html:110–135` — calibrated for prose blocks (`h1`–`h6`,
  `p`, `ul`/`ol`, `blockquote`, `pre`, `table`, etc.).
- Article width hard-coded: `seeds/rewritable.html:111` —
  `:where(#rwa-doc-mount) article{max-width:720px;margin:64px auto;padding:0 32px;}`.
- URL-fragment scroll: `scrollToFragment()` at `seeds/rewritable.html:787–805`,
  also wired to `hashchange` at `:3349`.

### Lens (input)

- DOM: `seeds/rewritable.html:858–864` —
  `<div id="rwa-lens" data-state="default">` containing
  `<textarea id="rwa-lens-input" rows="1" placeholder="Write, or describe what you want.">`.
- Dispatcher: `submitLens(text)` at `seeds/rewritable.html:1994–2031`, exposed
  on `window.submitLens` at `:2032`. Routes by `(state × mode)`:
  `default-text`, `default-command`, `anchored-text`, `anchored-command`.
- Click-to-anchor: `handleMountClick(e)` at `seeds/rewritable.html:1850–1879`;
  rebound on every render at `:777–778`.
- `ANCHORABLE_TAGS = new Set(['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','LI','FIGURE','PRE','ASIDE'])`
  at `seeds/rewritable.html:183`.
- Anchor state: `lensState` declared at `seeds/rewritable.html:1833`; helpers
  `anchorTo(entry)` at `:1926`, `releaseAnchor()` at `:1966`.
- Source-position map (used by anchoring): `buildSourcePositionMap(doc)` at
  `:1538`, `setSourceMap(doc)` at `:1612`, `getSourceMap()` at `:1616`.
- Direct-text synthesis: `synthesizeAnchoredInsert(anchor, text)` at
  `:2264`, `synthesizeDefaultAppend(text)` at `:2281`,
  `wrapDirectText(text, anchorTag)` at `:1822–1827`.
- Anchored command path: `runAnchoredCommand(anchor, instruction)` at
  `:2189`, `buildAnchoredContextWindow(anchor)` at `:1747`,
  `buildAnchoredPrompt(target, context, instruction)` at `:1771`.
- Post-commit re-anchor: `handlePostCommitAnchor(response, prevAnchor)` at
  `:2151`.
- Lens chrome rendered by `buildUI()` at `seeds/rewritable.html:831–865`.

### Agent invocation

- System prompt: `SYSTEM_PROMPT` at `seeds/rewritable.html:1248–1285`. Single
  module-scope constant. Opens with `You are editing a rewritable HTML
  document. Apply the user's request as a small set of surgical edits via
  tool calls.`
- Tool schemas: `TOOL_SCHEMAS` at `seeds/rewritable.html:1287` — three
  tools: `apply_dsl_plan`, `apply_edits`, `replace_document`.
- Main loop: `modify(instr, lensMeta)` at `seeds/rewritable.html:2932–3051`.
  Multi-turn tool-use loop with retry budget `RWA_EDIT.RETRIES` set in
  `RWA_EDIT` at `:1407`.
- Bridge transport: `modifyViaBridge(instr, lensMeta)` at
  `seeds/rewritable.html:3060`; envelope parser
  `parseBridgeEnvelope(text)` at `:3152`; bridge command line at `:3085`.
- Single-shot helpers: `callAgentSingleShot(prompt)` at
  `seeds/rewritable.html:2102`, `callBridgeSingleShot(prompt)` at `:2119`.
- User-prompt builder: `buildUserPrompt(instr, doc, frozenZones)` at
  `seeds/rewritable.html:2899–2923`. Wraps the full doc as
  `<DOC>\n + doc + \n</DOC>` at `:2922`.
- Transport: `resolveBackendConfig()` at `seeds/rewritable.html:2038–2071`,
  `openAiCompatChat(cfg, body)` at `:2072`, `listOpenAiCompatModels(cfg)` at
  `:2086`. Four backends: `openrouter`, `ollama`, `lmstudio`, `bridge`.
- Mutex: `modifyMutex` boolean at `seeds/rewritable.html:2944, 2948, 3049`;
  also acquired in `synthesizeAndCommit` at `:2309–2310, 2370`.
- DSL compile-down: `compileDslPlan(plan, doc)` at
  `seeds/rewritable.html:2723`; dispatched by `modify` at `:3005–3009`.

### Commit

- ⌘S handler: `commit()` at `seeds/rewritable.html:3200–3255`.
- FSA path (Chromium): `showSaveFilePicker` / `createWritable` /
  permission flow at `seeds/rewritable.html:3204–3236`. Handle persisted via
  `idbPut(RWA.FSA, h)` at `:3223`.
- Download fallback: `seeds/rewritable.html:3244–3248`.
- File assembly: `buildFile(doc)` at `seeds/rewritable.html:815–828`.
- Template-literal escape: `escapeTL` at `seeds/rewritable.html:810–814`.
- Atomic write of `(rwa_doc, rwa_undo, rwa_hist)`:
  `commitDoc(currentDoc, newDoc, histRecord)` at
  `seeds/rewritable.html:2533`.
- History record kinds: `kind: 'edit_batch'` written by `applyEdits` at
  `seeds/rewritable.html:2648`; `kind: 'replace_document'` written by
  `replaceDocument` at `:2701`.
- Keyboard binding: `seeds/rewritable.html:3262` — `e.key === 's'`.

### Undo

- ⌘Z handler: `undo()` at `seeds/rewritable.html:3183–3198`.
- Stack pop: `popUndo()` at `seeds/rewritable.html:713–733`.
- Cap: `RWA.UNDO_CAP: 10` at `seeds/rewritable.html:190`.
- Stack push happens inside `commitDoc` as part of the atomic IDB
  transaction (`seeds/rewritable.html:2533`+).
- Keyboard binding: `seeds/rewritable.html:3261` — `e.key === 'z'`.

### Storage adapter — IDB (`runtime.db.*`)

- Reserved-name guard: `RwaReservedError` class at
  `seeds/rewritable.html:332–334`; enforced by `assertRuntimeDbStore(name)`
  at `:336–339` (`/^rwa_/` is reserved).
- Read: `runtimeDbGet(store, key)` at `seeds/rewritable.html:359–362`.
- Write: `runtimeDbPut(store, key, value)` at `:363–395` (autoIncrement
  handling at `:371–389`).
- Delete: `runtimeDbDel(store, key)` at `:396–400`.
- All-keys-and-values: `runtimeDbAll(store)` at `:414–430`.
- Subscribe: `runtimeDbSubscribe(store, callback)` at `:402–413` — opens its
  own `BroadcastChannel` because the producer channel does not see its own
  posts.
- Dynamic store creation: `runtimeDbOpen(name, opts)` at `:462–504` —
  re-opens the DB with a version bump. Decls persisted via
  `loadUserStoreDecls()` at `:436–441` and `persistUserStoreDecls()` at
  `:442–450`; version-bump helper `bumpVersionAndCreateStore(name, opts)` at
  `:451–461`.
- Container-scoped DB name: `RWA.DB = 'rwa_' + DOC_UUID` at
  `seeds/rewritable.html:188`. `DOC_UUID` substituted at file creation time
  (sentinel at `:166`).

### Storage adapter — OPFS (`runtime.fs.*`)

- Path guard: `assertUserFsPath(path)` at `seeds/rewritable.html:505–532` —
  rejects reserved prefix `_rwa/`.
- Per-container root: `opfsRootForContainer()` at `:533–562` — auto-prefixes
  all paths with `_<DOC_UUID>/`.
- Internal helper: `walkToFile(path, { create })` at `:563–570`.
- Write: `runtimeFsWrite(path, blob)` at `:571–580`.
- Read: `runtimeFsRead(path)` at `:581–596`.
- Delete: `runtimeFsDel(path)` at `:597–614`.
- List: `runtimeFsList(prefix)` at `:615–645`.

### Bus

- Producer-side channel cache: `runtimeDbChannels = new Map()` at
  `seeds/rewritable.html:349`.
- `getStoreChannel(store)` at `:350–357` — channel name format
  `'rwa_' + DOC_UUID + ':' + store`.
- Producer fan-out happens inside `runtimeDbPut` at `:393` and
  `runtimeDbDel` at `:399`.
- Consumer side: separate channel opened per subscriber in
  `runtimeDbSubscribe` at `:402–413`.
- Scope: per-store, per-container. No multi-agent message bus, no
  cross-container bus (`runtime.shared.*` deferred per `re-write-able-spec.md:229`
  and absent from `runtime` at `seeds/rewritable.html:3312–3340`).

### Vault

- Does not exist as a runtime feature. API keys are stored in plain tab-
  scoped `sessionStorage`:
  - Key constants `K_API`, `K_MODEL`, `K_BACKEND`, `K_BASE_URL_OLLAMA`,
    `K_BASE_URL_LMSTUDIO` at `seeds/rewritable.html:191–194`.
  - Write site for the OpenRouter key: `seeds/rewritable.html:870`
    (`k.oninput = e => sessionStorage.setItem(RWA.K_API, e.target.value.trim());`).
  - Read site (URL-param lift, also tab-scoped): `seeds/rewritable.html:225–228`.
- No encryption, no key derivation, no per-agent credential scope.

### Permissions

- No agent-capability gate. The only "permission" surface in the runtime is
  the File System Access permission flow:
  - `queryPermission` / `requestPermission` at
    `seeds/rewritable.html:3208–3219`.
  - Permission-state field `_fsaState` mirrored at `:3212–3214, 3224, 3232`.
- The bridge backend explicitly bypasses CLI permissions:
  - `seeds/rewritable.html:2121` and `:3085` —
    `echo '...' | base64 -d | claude -p --output-format text --permission-mode bypassPermissions`.
- Region-scoped gating exists in the edit protocol — frozen zones — but
  that is content-scoped, not actor-scoped:
  - `extractFrozenZones(doc)` at `seeds/rewritable.html:1445–1476`.
  - `frozenZonesIntact(before, after)` at `:1477–1489`.
  - Class-declared locks: `lockedRangesIn(doc)` at `:1621–1635`,
    `markerZoneRangesIn(doc)` at `:1642–1681`,
    `rebuildLockedRanges(doc)` at `:1682–1684`.

### Skills infrastructure

- Runtime-side: none. The container has no concept of pluggable skills,
  agent personas, or capability packs.
- Service-side only:
  - `SKILL_PATH` derived at `service/server.js:36`;
    `skillBody = fs.readFileSync(SKILL_PATH, 'utf8')` at `:37–39`.
  - Inlined into landing page: `skillSafe` defensive escape at
    `service/server.js:42`; substitution `LANDING_TEMPLATE.replace(SKILL_MARKER, skillSafe)`
    at `:43`.
  - Skill zip bundle: `SKILL_DIR = path.join(PUBLIC_DIR, 'skill')` at
    `service/server.js:49`; `skillBundleFiles` accumulator at `:50`;
    deterministic STORED-only zip via `buildStoredZip(entries)` at `:68`,
    cached as `SKILL_ZIP` at `:61`.
  - Bundled assets on disk: `service/public/build-skill.md` (skill body),
    `service/public/skill/examples/*.html` (worked INLINE_DOC fragments).
- Delivery: out-of-band, via the landing page's "Copy the rewritable skill"
  button or `GET /skill.zip`. The container never fetches a skill at runtime.

### Status UI

- Chrome host: `<div id="rwa-runtime"></div>` at `seeds/rewritable.html:155`.
- Built by `buildUI()` at `seeds/rewritable.html:831–865`:
  - Status pill: `<button class="rwa-st-btn" id="rwa-st-status">● ready</button>`
    at `:834`.
  - Settings button `⚙`: `:835`. Commit button `⌘S` (primary): `:836`.
  - Settings panel `#rwa-set-panel`: `:838`; backend selector `:839`;
    OpenRouter key field `:840`; base-URL field + Test button `:841`;
    model field + datalist `:842`; per-backend hint `:843`.
  - Legacy command palette `#rwa-pal`: `:845–857`; secondary status
    `#rwa-pal-st` at `:853`.
  - Lens chrome: `:858–864` (covered above).
  - History pane host: `<div id="rwa-lens-hist-panel" hidden></div>` at `:865`.
- Status update helpers:
  - `setStatus(cls, msg)` at `seeds/rewritable.html:1088`.
  - `setPalSt(cls, msg)` at `:1089`.
  - Status snapshot for `runtime.status`: `getStatusSnapshot()` at
    `seeds/rewritable.html:692–701`, exposed via
    `Object.defineProperty(window.runtime, 'status', {get: getStatusSnapshot, ...})`
    at `:3336–3340`.
  - Event emitter: `runtimeOn(event, callback)` at `:652–664`,
    `emitRuntimeEvent(event, payload)` at `:665–691`. Events:
    `'modify'`, `'commit'`, `'status'`. Documented at `:646–650`.
- History pane: `renderHistoryPanel(panel)` at `seeds/rewritable.html:1205–1242`.
  Each row renders one `rwa-hist-surface` chip at `:1230`. Empty state copy
  at `:1222` — `"No history yet — make an edit and it will appear here."`
- Toasts / affordances:
  - `showAffordance(text)` at `seeds/rewritable.html:2174–2181`.
  - `showCommitNudge(n)` at `:1114–1123`; `clearCommitNudge()` at `:1124–1134`.
  - `showQuotaWarning(usedMB, quotaMB)` at `:1135–1144`;
    `clearQuotaWarning()` at `:1145–1147`.
- Private-mode banner: `rwaShowPrivateModeBanner()` at
  `seeds/rewritable.html:1180–1198`.

### Public runtime API (`window.runtime`)

For completeness — this is the surface composed from the features above:

- Construction: `seeds/rewritable.html:3312–3340`. Built only after
  private-mode detection and `openDB()` succeed.
- Fields: `id` (DOC_UUID), `db.{get,put,del,all,open,subscribe}`,
  `fs.{read,write,del,list}`, `modify` / `commit` / `undo`, `on`, and a
  computed `status` getter.
- Wrapped lifecycle: `runtimeModify(instruction)` at `seeds/rewritable.html:704`,
  `runtimeCommit()` at `:705`, `runtimeUndo()` at `:706`, `getDoc()` at `:708`.

## 3. Per-product analysis

### (1) Document

- **Needs.** Prose render surface; agent that edits prose; commit/undo;
  per-container storage; prose-anchor model.
- **Has.** All of it.
  - `#rwa-doc-mount` at `seeds/rewritable.html:154` with prose-typography
    defaults at `:110–135`.
  - `modify()` at `:2932` with `SYSTEM_PROMPT` at `:1248` (document-shaped).
  - `commit()` at `:3200`, `undo()` at `:3183`.
  - `runtime.db.*` at `:3314–3321`.
  - Click-to-anchor `handleMountClick` at `:1850` over the prose
    `ANCHORABLE_TAGS` set at `:183`.
- **Partial.** None.
- **Missing.** None — this is the runtime's home turf.

### (2) Workflow

- **Needs.** Stage / item model; per-item state; programmatic agent
  invocation per item (not just per ⌘K); progress UI; multi-step audit
  trail; queued or parallel execution.
- **Has.**
  - Programmatic `runtime.modify(instruction)` at `seeds/rewritable.html:704`
    exposes the agent loop to in-doc JS.
  - `runtime.db.{put,subscribe}` at `:363, :402` — reactive per-store state.
  - Audit trail via `commitDoc` at `:2533` writing into `rwa_hist`.
- **Partial.**
  - **Per-step audit attribution.** History records have one schema (`kind:
    'edit_batch'` at `:2648` and `kind: 'replace_document'` at `:2701`) plus
    a free-form `surface` string in `lensMeta` (built at `:2321`). The
    `surface` can be repurposed for a step name (the artifact-conventions
    doc recommends `artifact:<short-name>` at
    `docs/specs/rwa-artifact-conventions.md:174`), but the runtime never
    sets it and the history pane renders only one chip per record at
    `seeds/rewritable.html:1230`.
  - **Programmatic agent invocation.** It exists, but
    `buildUserPrompt(instr, doc, frozenZones)` at
    `seeds/rewritable.html:2899–2923` always sends the full doc and pairs
    it with the prose-document `SYSTEM_PROMPT` at `:1248`. A workflow item-
    extractor pays for the whole workspace on every call.
  - **Concurrency.** `modifyMutex` at `:2944` forces strict serial. The
    artifact-conventions doc lists this as a constraint at
    `docs/specs/rwa-artifact-conventions.md:84–87` ("Pre-serialise inside
    your artifact").
- **Missing.**
  - **Stage / item model as a first-class primitive.** Workflows have to
    invent their own (a custom IDB store, custom render, custom transitions).
  - **Per-step prompt.** One global `SYSTEM_PROMPT` at
    `seeds/rewritable.html:1248`.
  - **Per-step scope.** No way to say "this step may only insert into
    `processed_items`."
  - **Built-in queue / per-item observable state.** No `runtime.queue.*` or
    equivalent.

### (3) App

- **Needs.** Interactive UI; data region the agent mutates; UI state that
  survives commits; frozen zones for chrome; programmatic agent calls;
  per-item progress UI.
- **Has.**
  - `<script>` re-execution inside `renderDoc` at
    `seeds/rewritable.html:756–761` (artifact-conventions doc explains the
    contract at `docs/specs/rwa-artifact-conventions.md:36–41`).
  - Form-state capture/restore at `seeds/rewritable.html:749–767` (id-keyed
    inputs survive an unrelated edit).
  - Frozen-zone enforcement: `extractFrozenZones` at `:1445`,
    `frozenZonesIntact` at `:1477`. Three comment-fence forms and
    `data-rwa-frozen` per `rwa-edit-spec.md` §15.
  - Programmatic `window.modify(instruction, lensMeta)` exposed implicitly
    via the runtime API at `seeds/rewritable.html:3312` and used by the
    invoice-tracker pattern documented in artifact-conventions.
  - `runtime.db.*` / `runtime.fs.*` for app state and blobs.
  - Worked example: `demo/invoice-tracker.html` per `CHANGELOG.md`.
- **Partial.**
  - **Lens click-to-anchor leaks into app UIs.** `handleMountClick` at
    `seeds/rewritable.html:1850` walks every click in `#rwa-doc-mount`
    looking for an anchorable parent. App surfaces inherit it unless
    frozen or wrapped in `.rwa-locked`. Documented as a known limitation
    in `docs/specs/rwa-artifact-conventions.md` ("Click-to-anchor on
    artifact text").
  - **Single status surface.** One pill (`#rwa-st-status` at
    `seeds/rewritable.html:834`), one toast slot (`showAffordance` at
    `:2174`). Apps wanting per-item progress must build their own DOM.
  - **`data-rwa-id` backfill targets prose elements only.**
    `injectMissingBlockIds(doc)` at `seeds/rewritable.html:2497` walks the
    same `ANCHORABLE_TAGS` set at `:183`. App data rows (table rows,
    kanban cards) get no stable identifier from the runtime.
- **Missing.**
  - **App-typed lens copy.** Placeholder `"Write, or describe what you
    want."` at `seeds/rewritable.html:861` is wrong copy for an invoice
    tracker; there is no hook to override it.
  - **Built-in queue.** Same gap as workflows.
  - **First-class artifact lifecycle.** Conventions doc reads as patterns,
    not contracts.

### (4) Multi-agent workspace

- **Needs.** More than one agent identity; per-agent prompt and config;
  per-agent (or shared, but attributed) state; chat-style render surface;
  edit / message attribution; per-agent capability scope.
- **Has.**
  - Per-store BroadcastChannel bus at `seeds/rewritable.html:349–357`,
    usable as an event primitive between IIFEs inside one container.
  - `lensMeta.surface` field threaded through `submitLens` at
    `seeds/rewritable.html:1994–2031` and `synthesizeAndCommit` at
    `:2298–2372`. Persisted onto `rwa_hist` records via
    `commitDoc(currentDoc, newDoc, histRecord)` at `:2533`. Free-form
    string — could in principle carry an agent name, but the runtime never
    sets one.
- **Partial.**
  - **Audit attribution.** The `surface` chip in the history pane at
    `seeds/rewritable.html:1230` shows one string per row; with discipline
    it can carry an agent identity, but there is no UI affordance for
    "filter by agent" and no schema field for it.
- **Missing.**
  - **Agent identity.** One global `SYSTEM_PROMPT` at
    `seeds/rewritable.html:1248`; one selected model `RWA.K_MODEL` at
    `:191`; one backend `RWA.K_BACKEND` at `:191` resolved by
    `resolveBackendConfig()` at `:2038`. Switching agents = mutating
    `sessionStorage`.
  - **Vault / credentials per agent.** See §2 ("Vault") — does not exist.
  - **Capability scope per agent.** See §2 ("Permissions") — does not
    exist. Every agent that can call `modify()` can call every tool in
    `TOOL_SCHEMAS` at `:1287` against any non-frozen region.
  - **Chat-style render surface.** `#rwa-doc-mount` at
    `seeds/rewritable.html:154` is a single block whose content is wiped
    and replaced on every render (`renderDoc` at `:755`). There is no
    append-only message log.
  - **Multi-agent orchestration.** `modifyMutex` at `:2944` enforces one
    agent call at a time; the runtime has no notion of "agent A produced
    an artifact, hand to agent B."
  - **Cross-container surface.** `runtime.shared.*` is deferred per
    `re-write-able-spec.md:229` and absent from the public runtime API
    construction at `seeds/rewritable.html:3312–3340`.

## 4. Product-specific assumptions in the runtime

Every entry below pins the runtime to the document product. Each cites
the file:line and quotes the snippet that encodes the assumption.

1. **`SYSTEM_PROMPT` names the product "document."**
   `seeds/rewritable.html:1248` — `You are editing a rewritable HTML
   document. Apply the user's request as a small set of surgical edits via
   tool calls.` and at `:1252` — `apply_edits — preferred for CONTENT
   transforms. Submit (find, replace) pairs. ... Use for: prose rewrites,
   value updates, fine-grained text changes, translations, typo fixes.`
   The prompt is one module-scope constant; there is no mechanism to vary
   it per product, agent, or step.

2. **The render target is one mount with prose typography defaults.**
   `seeds/rewritable.html:154` — `<div id="rwa-doc-mount"></div>`. The
   default stylesheet block at `:110–135` styles prose-block elements
   (`h1`–`h6`, `p`, `ul`/`ol`, `blockquote`, `pre`, `table`, …). Article
   width at `:111` — `:where(#rwa-doc-mount) article{max-width:720px;margin:64px auto;padding:0 32px;}`.

3. **Lens copy is prose-author copy.** `seeds/rewritable.html:861` —
   `<textarea id="rwa-lens-input" rows="1" placeholder="Write, or describe
   what you want." spellcheck="false"></textarea>`. The legacy palette is
   similar at `:849` — `<input id="rwa-pal-inp" placeholder="modify this
   document..." autocomplete="off" spellcheck="false">`. There is no
   per-product placeholder hook.

4. **`ANCHORABLE_TAGS` is prose-only.** `seeds/rewritable.html:183` —
   `const ANCHORABLE_TAGS = new Set(['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','LI','FIGURE','PRE','ASIDE']);`
   Drives both click-to-anchor (`handleMountClick` at `:1850`) and stable-
   block-id backfill (`injectMissingBlockIds` at `:2497`). Tables, kanban
   cards, form rows are not anchorable as a unit; the user clicks a
   `<p>` inside them instead.

5. **Click-to-anchor walks every click in the mount.**
   `seeds/rewritable.html:777–778` — `m.removeEventListener('click',
   handleMountClick); m.addEventListener('click', handleMountClick);` is
   bound on every render. App and workspace surfaces inherit it unless
   they wrap themselves in a marker-form frozen zone or
   `.rwa-locked` (`docs/specs/rwa-artifact-conventions.md` "Click-to-anchor
   on artifact text"). The default behavior is "this is a document where
   every prose block is editable."

6. **`buildUserPrompt` ships the whole document on every call.**
   `seeds/rewritable.html:2922` — `'... <DOC>\n' + doc + '\n</DOC>'`.
   The cost is fine for prose documents (the spec doc renders fine inside
   one prompt) but punitive for workflows with many items or workspaces
   with long message logs. There is no scoping, no chunking, no window
   selection.

7. **`data-rwa-id` is backfilled on prose blocks only.**
   `seeds/rewritable.html:2497` — `injectMissingBlockIds(doc)` walks the
   `ANCHORABLE_TAGS` set at `:183`. Spec note at
   `seeds/rewritable.html:1280–1284`. Non-prose elements (table rows,
   kanban cards, message turns) carry no stable identifier from the
   runtime.

8. **History records have one schema and ship document-shaped copy.**
   `seeds/rewritable.html:2648` — `const histRecord = { ts: Date.now(),
   kind: 'edit_batch', envelope };` and `:2701` — `const histRecord = {
   ts: Date.now(), kind: 'replace_document', reason: envelope.reason };`.
   The history pane renders each record as one chip and one instruction
   string at `:1230` —
   `'<span class="rwa-hist-surface">' + escHtml(surface) + '</span>'`.
   Empty-state copy at `:1222` — `'No history yet — make an edit and it
   will appear here.'` — assumes a single chronological edit stream over
   a single document.

9. **Settings panel exposes exactly one backend, one model, one key.**
   `seeds/rewritable.html:838–844`:
   - One `<select id="rwa-backend">` at `:839`.
   - One `<input id="rwa-key">` at `:840`.
   - One `<input id="rwa-model">` at `:842`.
   Persisted under `RWA.K_API` / `RWA.K_MODEL` / `RWA.K_BACKEND` (constants
   at `:191`) in `sessionStorage`. Multi-agent workspaces would need
   per-agent config; the runtime is single-agent by design here.

10. **Modify mutex serializes everything.** `seeds/rewritable.html:2944`
    — `if (modifyMutex) { setPalSt('err', '✗ another modify in progress');
    throw new RwaEditError('concurrent_modify'); }`. Also enforced in
    `synthesizeAndCommit` at `:2309–2310`. A workflow processing 50 items,
    or a workspace where two agents reply concurrently, is forced into a
    strict serial queue — and the runtime offers no queue helper.

11. **Status surface is one pill.** `seeds/rewritable.html:834` —
    `<button class="rwa-st-btn" id="rwa-st-status">● ready</button>`,
    updated by `setStatus(cls, msg)` at `:1088`. There is one secondary
    surface for the palette at `:853, 1089`. Multi-step or multi-agent UIs
    cannot surface two concurrent statuses through the runtime — they
    must build their own indicator in the doc.

12. **Default `INLINE_DOC` ships a prose stub.**
    `seeds/rewritable.html:170–181` — `const INLINE_DOC = \`<style>...`
    followed by `<article><h1>Untitled</h1><p class="placeholder">Start
    writing, or ask the lens below to draft something for you.</p></article>\``.
    `rwa new` (per `cli/`) produces this. There is no
    `rwa new app` / `rwa new workflow` template surface from the seed
    itself; the templates plan at
    `docs/plans/2026-05-05-cli-templates-design.md:10` uses *user-supplied*
    files, not product-typed scaffolds.

13. **Reserved-store prefix is exactly one bucket.**
    `seeds/rewritable.html:336–339` — `if (/^rwa_/.test(name)) throw new
    RwaReservedError(name);` reserves one prefix for the runtime. There
    is no `agent_*` / `workflow_*` / `inbox_*` namespace. Per-agent or
    per-step storage scopes are the document author's problem.

14. **`runtime.shared.*` is deferred — no inter-container surface.**
    `re-write-able-spec.md:229` — `The detailed shape of \`runtime.shared.*\`
    ... is deferred to §11.5.`, and the public-API construction at
    `seeds/rewritable.html:3312–3340` does not include `shared`.
    Multi-agent workspaces that need cross-container state have no path.

15. **Spec vocabulary is document-centric throughout.** `re-write-able-spec.md`
    titles the runtime "re-write-able" and names the persisted body
    `rwa_doc` (`seeds/rewritable.html:189` — `DOC:'rwa_doc'`). The
    artifact-conventions doc (`docs/specs/rwa-artifact-conventions.md`)
    re-uses this naming for non-document products as a layered convention,
    but the canonical spec never abstracts "document" away.

## 5. Prioritized recommendations

Ranked by **return on agnosticism** — how much surface area each move
shifts toward equal support across the four product types, weighted by
runtime-rewrite cost. No code is changed in this audit.

### R1. Parameterize the system prompt. [HIGH return, MEDIUM cost]

Treat `SYSTEM_PROMPT` (`seeds/rewritable.html:1248`) as one entry in a
registry keyed by product mode or actor role. Lens / `runtime.modify` /
`runAnchoredCommand` call sites pass the mode; the registry returns the
prompt. **Why first.** The prompt is the most consequential leak — every
assumption in §4 flows downstream of *"You are editing a rewritable HTML
document."* A workflow extractor needs an extractor prompt; an app driving
sequential calls needs an artifact-aware prompt (a pattern
`docs/specs/rwa-artifact-conventions.md:185–192` already encodes inline in
user prompts as a workaround). Cost is medium because every call site that
constructs `messages` (`modify` at `:2957–2960`, `runAnchoredCommand` at
`:2189+`, bridge at `:3073`) must thread the mode through.

### R2. Thread an "agent / actor" field through `modify`, `commit`, `rwa_hist`. [HIGH return, MEDIUM cost]

Extend `lensMeta` (built at `seeds/rewritable.html:2321`) with an
`actor` field. Persist it onto history records at `:2648` and `:2701`.
Render it as a second chip in the history pane at `:1230`. **Why.**
Unblocks (4) multi-agent attribution and (2) workflow-step attribution
without touching the edit protocol. Backwards-compatible: empty `actor`
renders today's single-chip row.

### R3. Decouple lens UI copy and click-to-anchor from the document product. [HIGH return, HIGH cost]

The lens copy (placeholder at `seeds/rewritable.html:861`, badge text in
`anchorTo` at `:1926`, history empty-state at `:1222`) is prose-author
copy. Click-to-anchor (`handleMountClick` at `:1850`, bound in `renderDoc`
at `:777–778`) is a prose behavior an app or workspace usually wants
disabled. **Options.**
- (a) Add `runtime.ui.setLensCopy({...})` / `runtime.ui.setClickToAnchor(boolean)`
  hooks called from the document at boot, idempotently across re-renders.
- (b) Split the lens chrome into product variants (`lens-doc`,
  `lens-app`, …) chosen at boot from a `<meta name="rwa-product">` tag or
  similar.
Cost is high because the lens internals (`submitLens`, `anchorTo`,
`buildAnchoredPrompt`, `handlePostCommitAnchor`) co-evolved with the
document model.

### R4. Drop the "single mount, full-replace" assumption. [MEDIUM return, HIGH cost]

`#rwa-doc-mount` (`seeds/rewritable.html:154`) plus the
`m.innerHTML = html` swap in `renderDoc` at `:755` bake in "one document
body, replaced wholesale." For (2) workflows and (4) workspaces, a more
natural model is an append-only log alongside (or instead of) the doc
body. A second mount — e.g. `#rwa-event-mount` — plus an append helper
(`runtime.events.append(html, meta)`) would unlock chat-style UIs and
workflow-stage visualizations without breaking documents.

### R5. Add a concurrency model beyond `modifyMutex`. [MEDIUM return, MEDIUM cost]

`modifyMutex` at `seeds/rewritable.html:2944` forces strict serial agent
calls. A workflow processing N items wants either an in-runtime queue
(`runtime.modifyQueue.push(instr, meta)` with FIFO + per-item observable
state) or controlled parallelism with per-region locks. The artifact-
conventions doc already documents the manual workaround at
`docs/specs/rwa-artifact-conventions.md:84–87`; formalizing it in the
runtime is the natural next step.

### R6. Carve out an `agent_<name>_*` reserved IDB prefix. [LOW return, LOW cost]

`assertRuntimeDbStore` at `seeds/rewritable.html:336–339` blocks `^rwa_`
and leaves everything else as the document's pool. Add a second understood
prefix `agent_<name>_*` (or `workflow_<stage>_*`) the runtime can
introspect. Useful as a hook for per-agent storage even before vault /
permissions exist. Cheap because it is metadata.

### R7. Add an optional capability gate. [LOW return, HIGH cost]

Today the only gating is region-scoped (frozen zones at
`seeds/rewritable.html:1445, 1477`). A multi-agent workspace needs
*operation-scoped* gating: agent A may only `insert`, agent B may only
`set_attr`, neither may `replace_document`. Add a `lensMeta.capabilities`
allow-list validated at dispatch (`modify` at `:3005–3013`,
`synthesizeAndCommit` at `:2298`). Cost is high — touches the dispatch
table on the hot path — and priority is low because no current product
needs it.

### R8. Split `surface` (lens flow) from `actor` (agent/step). [LOW return, LOW cost]

The `surface` field currently overloads "lens flow" (`default-text`,
`anchored-command`) with "artifact name" (`artifact:invoice-tracker` per
`docs/specs/rwa-artifact-conventions.md:174`). Splitting into `surface`
(flow) and `actor` (R2) cleans up the data model; the history pane
becomes legible at higher fan-in. Cost is low: it is a rename + a schema
extension.

### R9. Product-typed `rwa new` scaffolds. [LOW return, LOW cost]

`docs/plans/2026-05-05-cli-templates-design.md:10` already supports
user-supplied templates. Extend with `rwa new app|workflow|workspace`
flags that pick a different lens placeholder text (today hard-coded at
`seeds/rewritable.html:861`) and a different `INLINE_DOC` stub (today at
`:170–181`), baked at file-creation time. Cheapest first step toward
visible product differentiation; touches the CLI and the seed substitution
sites, not the runtime.

### R10. Canonicalize the four product types in a spec. [LOW return, LOW cost]

No spec in this repo defines the four-type taxonomy. Lift §1 of this
audit into `docs/specs/rwa-product-types.md` (or fold it into
`rwa-artifact-conventions.md`) so future plans have a shared vocabulary
to anchor on. Low return on agnosticism directly, but a precondition for
R1–R5: parameterizing the prompt requires a name for what to parameterize
over.

---

## Addendum 2026-05-18 — the layer-cake reframe

The audit above assumed the substrate runtime was the whole picture.
Reading `docs/specs/re-write-able-actions-spec-v0.7.md` (added to the
repo after the audit was written) reveals that the rwa architecture
is three layers stacked, not one — and the audit covers only the
first. This addendum reframes the audit accordingly and re-grades the
recommendations whose grading changes when the upper layers come into
view. The §1–§5 body is preserved as a dated snapshot of the
substrate; the additions below are corrections layered on top.

### The reframe

The full architecture has three layers (full mapping at
`docs/specs/rwa-product-types.md`):

- **Substrate** — the seed and bootstrap. Renders, edits, commits,
  exports. Specs: `re-write-able-spec.md` (v0.10), `rwa-edit-spec.md`
  (v1.4), `rwa-edit-dsl-spec.md` (v0.1), `docs/specs/rwa-lens-spec.md`
  (v0.9). Implementation: `seeds/rewritable.html`.
- **Graph** — multi-step workflows over the substrate
  (`rwa-graph/1`, referenced by the actions spec §5.3, not yet committed).
- **Skill** — permission-gated skills with vault, bus, install dialog,
  Worker-mode isolation
  (`docs/specs/re-write-able-actions-spec-v0.7.md`, specified but not
  implemented in the substrate yet).

The four product types map onto these layers — they are not peers
on one axis. Document and app live at the substrate. Workflow lives
at the graph layer over the substrate. Multi-agent workspace lives
at the skill layer over the substrate, optionally also over the
graph layer. Asking whether the substrate is "agnostic" across all
four was the wrong question; the right question is whether the
substrate's defaults are overridable cleanly enough that products
needing graph or skill layers can build on top without fighting the
substrate. The right framing is **document-default substrate with
clean override hooks**, not full agnosticism.

This frame changes how the audit's §3 per-product analysis reads
(see re-grades below), retires R6, and re-grades R7. R1–R5, R8–R10
keep their substrate-layer grading.

### R6 — retired

R6 proposed an `agent_<name>_*` reserved IDB prefix. The actions
spec specifies a different, better model: `idb:<store>` is an
exact-match capability granted at install time
(`re-write-able-actions-spec-v0.7.md` §3.6), and `skills:*` is the
runtime-reserved bus prefix (§3.5). Namespacing is achieved by
permission grant, not by string-prefix convention. R6 is retired —
the actions spec's model supersedes it.

### R7 — re-graded

Original grade: **LOW return, HIGH cost** (capability gate as fresh
design surface). New grade: **HIGH return on (4) multi-agent
workspace, MEDIUM-HIGH cost, design exists — implementation is the
gap.** The actions spec specifies the full surface across the
permission grammar (§3.1 anti-escalation, §3.2–3.6 per-tier
syntax, §3.7 recognizable combinations) and the Worker-mode
isolation model (§4.1–4.7). What looked like greenfield was already
specified; the cost is implementing the contract, not designing it.
Priority is conditional on (4) becoming a real target; until then
the work remains queued.

### §3 (4) Multi-agent workspace — re-graded

The original §3 entry for product type (4) listed agent identity,
vault / credentials, capability scope, chat-style render surface,
and multi-agent orchestration as **Missing**. With the actions spec
in view, the first three are **Specified, not yet implemented**:

- **Agent identity.** Specified — Ed25519 public-key source identity
  (`re-write-able-actions-spec-v0.7.md` §2.2), per-invocation
  runtime-issued identity tags on Worker message channels (§4.4).
- **Vault / credentials per agent.** Specified —
  `vault_namespace` field on the skill envelope (§2.1) plus the
  `vault:<namespace>` permission grammar (§3.3).
- **Capability scope per agent.** Specified — per-tier permission
  grammar across `network:`, `vault:`, `fsa:`, `bus:`, `idb:` (§3),
  enforced via Worker-mode bridged proxies (§4.2, §4.4) and host
  CSP (§4.3).

Two items remain **Missing** even with the actions spec:

- **Chat-style render surface.** The actions spec defines how skills
  communicate (bus, `runtime.skills.invoke`, message channels with
  identity tags) but does not address rendering of multi-agent
  output. `#rwa-doc-mount` (`seeds/rewritable.html:154`) as the
  single replace-wholesale render target remains a substrate-layer
  gap. R4 stands.
- **Cross-container surface.** `runtime.shared.*` is still deferred
  per `re-write-able-spec.md:229`.

### R4 — unchanged, but framed correctly

R4 (drop the single-mount full-replace assumption) is **substrate-
layer**. It touches the bootstrap contract (what bytes are committed
to the file on ⌘S, what bytes are loaded on open). It is not a
render change; it is a question of *what is the durable artifact*.
The audit graded it MEDIUM-return / HIGH-cost; with the layer-cake
in view, this remains correct, but it now reads explicitly as "this
is the substrate-layer change that unblocks chat-style UIs at the
skill layer above." It should ship before serious multi-agent
workspace work.

### Versioning-lineage gap

`re-write-able-actions-spec-v0.7.md` is the v0.7 of a drafting cycle
whose earlier drafts (v0.6, v0.6.1, plus the v0.10 main spec's
lens-lock semantics) are not committed to the repo. The v0.7
spec references them at load-bearing points:

- v0.6 §2.1 (skill input/output schemas) — referenced at
  `re-write-able-actions-spec-v0.7.md` §2.1.
- v0.6 §2.2 (reserved namespaces, including `skills:*`) —
  referenced at §3.5.
- v0.6 §2.4 (defense-in-depth proxies, default mode) — referenced
  at §4.1, §6.1.
- v0.6 §4.1 (capability-scan curation pattern) — referenced at
  §3.7.
- v0.6 §5.4 (in-edit autonomous-trigger skip rules) — referenced
  at §5.3.
- v0.6 §8.2 (no cross-container access) — referenced at §3.6.
- v0.6.1 §4 (in-edit timeout disambiguation) — referenced at §5.3.
- v0.6 invariants 10 (install as privileged moment) and 12 (manual
  trigger + ⌘S persistence) — referenced at §7.
- v0.10 main-spec lens-lock — referenced at §5.3.

Until those antecedents are committed, any agent reading v0.7
encounters dangling section references. This is not a blocker for
the audit re-grades above (v0.7 stands on its own for the install
dialog, permission grammar, and Worker-mode design), but it is a
blocker for fully grounding R7's implementation work: §6.1's Shape A
attack-shape defense path refers to v0.6 §2.4's proxy mechanisms,
and an implementer needs that text to know what defense-in-depth
proxies are.

Recommended follow-up: land v0.6 and v0.6.1 antecedents under
`docs/specs/` alongside v0.7. The drafting cycle's working method
also lives in those earlier drafts and is worth preserving for
future audits.

### What the addendum does not change

The §1 product-types reference, the §2 substrate inventory, and the
§4 list of document-product assumptions are independent of the
actions spec — they are a snapshot of the substrate's state on
2026-05-18 and they remain accurate. The §5 recommendations R1–R5,
R8–R10 keep their substrate-layer grading. Only R6, R7, and the
§3(4) "missing" list change in light of the actions spec.

---

*Audit version 0.2 — layer-cake reframe + v0.7-actions-spec re-grades.
Substrate snapshot (§1–§5 body) preserved as-is from v0.1.*
