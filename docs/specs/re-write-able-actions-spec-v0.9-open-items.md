# re-write-able actions skill layer — v0.9 open-items specification

This document specifies the thirteen items that v0.8 §11 deferred. It **extends** the v0.8 actions/skill/permission/Worker-mode spec and **never breaks** it: every wire format, permission grammar string, invariant number (18–20), and bridge error vocabulary in v0.8 stays byte-stable, and all additions are forward-compatible. v0.8 §11 is the canonical source list; this draft turns each deferred line into a normative definition the build can be lifted from. **This is a v0.9 DRAFT awaiting prioritization and ratification** — section ordering, parameter constants (Argon2 cost, idle timeouts, caps), and the open questions per item are not yet final.

The reader is assumed to know v0.8 cold. This spec does not restate the Worker bridge, the install dialog, the frozen skill zone, the signing model, or the Shape B ceiling — it cites them.

---

## §0 Scope & forward-compatibility

Every item in this spec honors the following shared constraints. An item that violates any of these is out of scope for v0.9.

- **Single-file / no-build / no-npm-runtime.** Nothing here introduces a build step, an npm runtime dependency, or a second file. New code is inline in `seeds/rewritable.html` (runtime) or hand-mirrored in `cli/src` / `service/lib` per the existing vendoring discipline. The one binary artifact admitted (Argon2id WASM, I9) MUST be embedded base64 / `data:` URL, never fetched.
- **CSP unchanged.** The static frozen-`<head>` `script-src 'unsafe-inline' blob:` policy (v0.8 §7, 7b) is NOT modified by any item. No new directive is introduced; where a directive is required (e.g., `'wasm-unsafe-eval'` for I9) it MUST already be present in the v0.8 policy. There is no `connect-src` (the v0.8 deviation holds).
- **Runtime-sole-writer of the frozen zone (Invariant 19).** The `<div data-rwa-frozen id="rwa-skills">` (and the new sibling `id="rwa-agents"`, I12) is written ONLY by the runtime via `runtimeRegionCommit({reachability:'frozen'})`. The agent's edit path (lens / `apply_edits` / `replace_document`) rejects any change to frozen zones. The CLI install path (I11) is a declared, audited exception (offline, local, user-controlled), and writes the identical zone form.
- **The Shape B ceiling.** No item claims runtime defense against a skill (or agent) misusing the capabilities it *declared* and the human *approved* at install. The install dialog is the wall; the human's review is the sole defense against in-bounds abuse. Every per-call gate added here enforces only the declared boundary (no escalation after install) — it never adjudicates intent.
- **Format forward-compat with v0.8.** The `.rwa-skill.json` envelope (`format`/`skill`/`signature`), the signing message (`canonicalJSON(manifest) || 0x00 || code`), the permission grammar (left-anchored, typed, no wildcards, reserved-prefix guard), and the self-description/1 shape are extended only additively. A v0.8 reader encountering a v0.9 field MUST NOT break: it ignores unknown manifest fields and rejects unknown permission tiers cleanly at install (`unknown_permission_tier`), never silently.

Invariant numbering: v0.8 fixed 1–20. This spec proposes new invariants per item starting at 21; because items were drafted independently they collide on numbers. The **consolidated, deduped, renumbered** invariant set is in §15. Per-item invariant lists below are kept verbatim-as-drafted for traceability; §15 is normative.

---

## §1 Dependency graph & suggested sequencing

The thirteen items are not independent. The real couplings:

- **I10 (update re-affirm UI)** is standalone, highest-value, smallest. It closes the only *unguarded* permission-escalation window (silent perm change on update). The data path is already built; only the consent UI is missing. Ship first.
- **I1 (bus tier)** underpins **I12 (multi-agent orchestration)**: I12's inter-agent messaging IS the bus tier with `agents:*` topics and per-agent gating. Build I1 first; I12 consumes `_skBusAllowed`/`_skBusMessageAllowed` and wires peer-discovery into the latter.
- **I3 (fsa tier)** and **I4 (idb tier)** share the bridge+gate pattern with the shipped `network:`/`vault:` tiers — three near-identical `_skParsePermission` extensions, `_sk*Allowed` gates, and `bridge:<tier>` handlers. Build them together; cross-reference rather than duplicate the pattern.
- **I7 (view / edit-surface skills)** and **I8 (hook kind)** both need a **safe DOM/lifecycle channel**: I7 needs the `bridge:render`/`bridge:transform` safe-DOM channel (no raw innerHTML from the Worker); I8 needs the lifecycle-event firing channel. Both ride region-commit and the event bus.
- **I9 (Argon2id)** and **I13 (account identity)** carry the heaviest constraint tension (single-file WASM with no fetch; opt-in escrow without making a server the trust anchor). I13's export format reuses the vault KDF; if I9 lands first, exports inherit Argon2id.
- **I2 (worker pool)**, **I5 (confusables + name history)**, **I6 (marketplace)**, **I11 (CLI install)** are loosely coupled. I6 and I11 both depend on the signing/zone machinery only. I5 sharpens the I6 TOFU dialog.

**Suggested sequence:** I10 → I1 → {I3, I4} → {I7, I8} → I5 → I2 → I11 → I6 → I12 → {I9, I13}.

**Build status (2026-06-22).** The P0 tier is shipped: **I10** (`runtimeReviewSkill` update delta + the dialog's added/removed diff and re-affirmation button — seed; jsdom `tests/skill-install.mjs` + Chromium `tests/skill-exec-probe.mjs`) and **I11** (`rwa install` — `cli/src/install.mjs`, `cli/tests/install.test.mjs`, cross-tool browser-verified). **I1 is partially built — I1a** (the `bus:` grammar + the Worker *publish* bridge) shipped: grammar/prose/compound mirrored seed↔CLI, `RUNTIME.bus.publish` gated by `_skBusAllowed`, browser-proven (a skill publishes on its declared topic; an undeclared topic is `bus_topic_denied`). **I1b** (skill-side *subscribe*) is deferred — it is only useful within an invoke's lifetime under the spawn→invoke→terminate model (see §5 line 262/283; forward-compat with I2's long-lived workers); publish + the existing document-side subscribe already cover the agent-emits / workspace-listens case. **I3 + I4** (P1) shipped together (they share the bridge+gate skeleton): the `fsa:` (scoped OPFS) and `idb:` (scoped IndexedDB store) tiers — grammar mirrored seed↔CLI, `RUNTIME.fs`/`RUNTIME.db` Worker proxies gated by `_skFsAllowed`/`_skIdbAllowed`, closed error vocab. Browser-proven (`skill-exec-probe` 23/0): idb round-trip + denial at `file://`; fsa gate at `file://` + a real OPFS round-trip over `http://localhost`. **Refinement:** I3 uses a **full-path** model (the skill addresses `data/x` and it must fall under a declared `fsa:` scope) rather than §6's scope-prepend example — unambiguous with multiple scopes; §6 below describes scope-prepend, the code is full-path. **I5** (P1) shipped in two parts: the **homoglyph block** (NFKC + a curated cross-script confusables skeleton; a signed homoglyph of a different author's installed skill → `lookalike_skeleton_blocked`) and **name_history** (per-author `rwa_sources` in IDB, reconciled at boot from the in-file manifests; the dialog surfaces a same-key rename). Seed + CLI mirror; browser-proven `skill-exec-probe` 27/0 incl. a name_history round-trip against **real IndexedDB**. Two refinements vs. the §4 text below: (1) the install block fires on `skeleton ≤1 AND skeleton < normalized-Levenshtein` — i.e. confusable folding must have *collapsed* a real byte difference — so an honest ASCII near-miss (skeleton == Levenshtein) still only WARNS, reconciling §4's "skeleton ≤1 blocks" with its own acceptance "ASCII exact name, diff key → warning, install allowed"; (2) `first_seen_at_name` dates are **best-effort** — the deterministic frozen-zone bytes carry no timestamps, so an IDB-cleared reload reconciles names with the reconcile time as the date (identity itself is always the key, never the date). The CLI mirror of name_history is registry-derived + dateless (no persistent IDB per-invocation).

Both honor the §0 constraints; none lifts the Shape B ceiling. The remaining items (I1b, I2, I5–I9, I12, I13) are open as specified below.

**Priority tiers** (P0 quick-win / P1 capability / P2 frontier):

| Item | Title | Tier | Effort |
|---|---|---|---|
| I10 | Update prose-diff + re-affirm UI | **P0 — ✅ BUILT** | M (small) |
| I11 | CLI `rwa install` verb | **P0 — ✅ BUILT** | M |
| I5 | Confusables + name_history | **P1 — ✅ BUILT** | M |
| I1 | Bus permission tier | **P1 — publish ✅ (I1a); subscribe (I1b) pending** | M |
| I3 | `fsa:` tier | **P1 — ✅ BUILT** | M |
| I4 | `idb:` tier | **P1 — ✅ BUILT** | M |
| I7 | view / edit-surface skills | **P1** | M |
| I8 | `hook` kind | **P1** | M |
| I2 | Worker pool & lifecycle | **P1** | M |
| I6 | Signed-skill marketplace | **P2** | L |
| I12 | Multi-agent orchestration | **P2** | L |
| I9 | Argon2id vault KDF | **P2** | M |
| I13 | Account-linked identity | **P2** | M |

---

## §2 I10 — Update prose-diff + permission re-affirmation UI (Shape C)

**One line:** On skill update with changed permissions, show added/removed permission prose diff and gate installation on explicit re-affirmation before new perms persist.

### Current state
Transport & data path are fully built and browser-proven. `seeds/rewritable.html:6757` detects update via `const prev = installedSkills.get(id)`; line 6760 branches `actor` on `prev ? 'skill:update' : 'skill:install'`; line 6758 installs the new manifest. `tests/skill-mvp.mjs §12.5` verifies updated perms persist. **Gated out:** `showSkillInstallDialog` (6781–6810) treats fresh install and update identically — it shows new permissions with no diff to old, and no re-affirmation gate. Shape C (v0.8 §9.C) is the single missing piece.

### Motivation
Invariant 10 (install is the trust anchor) requires a consent moment. On update, silent permission escalation violates the Shape B ceiling: a human who installed with `network:api.github.com` must explicitly see and approve a new version adding `network:tracker.y` *before* it takes effect. This is the highest-value, smallest deferred item — it closes the only unguarded escalation window.

### Normative contract
- **MUST** detect update when the incoming skillId already exists in `installedSkills`, computing added/removed permission sets by comparing `envelope.skill.permissions` to `prev.manifest.permissions` (both coerced to arrays).
- **MUST** display a prose permission diff before the affirmation buttons when perms changed: ADDED (via `_skPermProse()` per new perm) and REMOVED (same), with clear `+`/`−` headings.
- **MUST** change the re-affirmation button text on permission change to make clear new capabilities are granted (e.g., *"I have reviewed the new permissions and want to update this skill"*).
- **MUST NOT** call `runtimeInstallSkill()` automatically on update detection — the dialog waits for explicit user choice. A network stall, typo, or malicious manifest swap MUST NOT escalate silently.
- **MUST** handle edge cases: fresh install shows no diff; downgrade (removals only) shows removals without an Added section; diffs use strict, case-sensitive, order-invariant set equality.
- **SHOULD** allow a lightweight `Update` affirmation (no full consent replay) when permissions are unchanged.
- **MUST** honor all existing Shape B/C/E safeguards (compound-risk callout, lookalike warning, capability-scan notes, `_skValidateInstall`, `_skCodeForbidden`) before the dialog is shown.
- **MUST** leave `installedSkills` and the frozen zone unchanged on cancel/rejection.
- **MUST** reuse `_skPermProse()` for both added and removed perms, so v0.9 tiers (`bus:`/`fsa:`/`idb:`/`hook:`) get consistent prose for free.

### New grammar / wire
```javascript
const newPerms = Array.isArray(envelope.skill.permissions) ? envelope.skill.permissions : [];
const oldPerms = (prev && Array.isArray(prev.manifest.permissions)) ? prev.manifest.permissions : [];
const oldSet = new Set(oldPerms), newSet = new Set(newPerms);
const addedPerms   = newPerms.filter(p => !oldSet.has(p));
const removedPerms = oldPerms.filter(p => !newSet.has(p));
const permChanged  = addedPerms.length > 0 || removedPerms.length > 0;
const buttonText = (isUpdate && permChanged)
  ? 'I have reviewed the new permissions and want to update this skill'
  : isUpdate ? 'Update' : 'I have reviewed this skill and want to install it';
```

### Behavior
`showSkillInstallDialog(envelope, prev)` calls `runtimeReviewSkill`, computes skillId, looks up `prev`, computes the diff. If update + perm change: insert an added (green `+`) / removed (red `−`) section, swap button text, retain all safeguards. On affirm: `await runtimeInstallSkill(envelope)` persists with `actor='skill:update'`. On cancel/error: no registry update, no region commit.

### Acceptance
- Update `gh-stars` v1 (`network:api.github.com`) → v2 (`+network:tracker.y`): dialog shows Added section, button says "review the new permissions", affirm persists both.
- Downgrade (drop `vault:secrets`): dialog shows Removed section; bridge later denies vault.
- Unchanged-perms update: lightweight `Update` button, no full replay.
- Unknown tier added in v2 (`fsa:`): `_skValidateInstall` rejects `unknown_permission_tier`; no update.
- Same file picked twice in one session: dialog pops twice with identical diff; both require explicit affirm (no silent re-escalation).

### Dependencies
v0.8 foundation (Invariant 18, SKILL_WORKER_PROLOGUE, bridge enforcement, region-commit); existing `runtimeReviewSkill`, `_skPermProse`, `_skParsePermission`, `_skValidateInstall`, `_skSkillId`, `showSkillInstallDialog`, `runtimeInstallSkill`.

### Security
The only attack surface is escalated-perm update. Mitigations: human review via prose diff (reuses adversarially-vetted `_skPermProse`); explicit affirmation gate; atomic rollback on persist failure; all Shape B/C/E safeguards retained. **Shape B:** the diff shows what the author *declared*, not what the code *does* — in-bounds misuse remains undefendable (Invariant 10 frame). No new attack surface: diff is a deterministic set-difference over manifest arrays, fully auditable before commit.

### New invariants (as drafted)
- **21** — On update (skillId matches), permission escalation requires re-affirmation; the dialog MUST show added/removed prose diffs; only `runtimeInstallSkill` after explicit click persists. Closes the Shape C ceiling.
- **22** — Diff is computed via case-sensitive, order-invariant string set ops; prose reuses `_skPermProse()` (all tiers benefit).
- **23** — Unchanged-perm updates MAY elide the full diff (lightweight `Update`), grounded in prior review + key-authentication.

### Effort
M (small in code: ~15 lines diff logic, ~20 lines dialog HTML, ~5 lines button branching; intricate template touch-points + 3–4 acceptance steps in `tests/skill-mvp.mjs`).

### Open questions
Re-show full perm list on unchanged update (trust reinforcement) vs lightweight button? Removed-perms visual prominence (recommend red, aligned with compound-risk)? Diff before or after the full "What it can do" list (recommend before — show the delta at the decision point)? i18n of headings (deferred). Should pure downgrades bypass re-affirmation (recommend no — keep accidental downgrades non-silent)?

---

## §3 I11 — CLI verb: `rwa install <skill.rwa-skill.json> <skill-host.html>`

**One line:** Greenfield CLI install verb that verifies skill envelopes, gates them through the same trust checks as the seed, and splices them into the frozen `#rwa-skills` zone atomically.

### Current state
`cli/src/skill-manifest.mjs` has all trust mechanics (skillId, sync Ed25519 verify, `parsePermission`, `capabilityScan`, `validateInstall`, Levenshtein lookalike, `parseSkillZone`). `cli/tests/skill-zone.test.mjs` covers parse + tamper + frozen-zone scoping. `edit.mjs` has `CliError(exit, subcode, details)` + atomic write + frozen preservation. **Gated out:** no `rwa install` verb in `bin/rwa.mjs`; no `install.mjs`; the CLI writes the zone directly (no `runtimeRegionCommit` in the CLI). The CLI is the offline counterpart to the seed's interactive dialog — a headless way to stage skills into a skill-host before opening it in the browser.

### Motivation
v0.8 §11 defers `rwa install`. With the skill layer browser-proven, the CLI offline install path is the natural counterpart: deterministic, trust-gated identically to the seed (§3 envelope gates + §1 dialog prose triggers), atomic into the frozen zone. Enables `rwa install skills/*.rwa-skill.json myhost.html --yes` without opening the browser.

### Normative contract
- **MUST** read the envelope (valid JSON, `rwa-skill/1`, well-formed UTF-8) and the host file (kind `skill-host` via `PRODUCT_KIND`).
- **MUST** verify the signature (sync `node:crypto` Ed25519) and run `validateInstall` gates: reject `unsigned_with_permissions`, `compute_with_permissions`, `unsigned_capability`, `invalid_permission`, `unknown_permission_tier`.
- **MUST** run `capabilityScan`; hard-reject `dynamic_import_forbidden` (matching the seed's dual enforcement).
- **MUST** require `--yes` / `--trust` (the CLI has no dialog); absent → exit 1 `interactive_install_deferred`. `--yes` signifies the user reviewed the envelope offline.
- **MUST NOT** let `--yes` override trust-gate failures (`unsigned_capability` etc. are final, exit 3).
- **MUST** derive skillId, detect collision: same skillId+same code → "already installed" (exit 0); same skillId+different code → update (Shape C diff to stderr; unsigned-compute update rejected).
- **MUST** emit (non-blocking) a lookalike warning (Levenshtein ≤2, different key) to stderr / JSON details — Invariant 10 stand.
- **MUST** rebuild the zone via a CLI hand-mirror of the seed's `buildSkillZone` (no CLI zone-builder exists today — same mirror discipline as `cli/src/apply-edits.mjs` mirrors the seed apply path) **deterministically sorted by skillId**, base64-encode each envelope inside `<script type="application/rwa-skill+json">`, splice into the host's `<head>` byte-surgically.
- **MUST** write atomically (temp → fsync → rename) and **re-parse post-write** (`install_not_durable` on failure).
- **MUST** support `--json` (one JSON line: stdout success `{skillId,name,kind,verified,provenance:'installed'}`, stderr error `{code,subcode,details}`).
- **MUST NOT** trust any zone outside `<div data-rwa-frozen id="rwa-skills">` (strict attribute-name check; doc-text skills ignored), and **MUST NOT** do network I/O.

### New grammar / wire
```
rwa install <envelope-file> <skill-host.html> [--yes | --trust] [--json]

exit 0 success
exit 1 usage_error:   missing_file_args | missing_consent_flag | interactive_install_deferred | bad_flag_value
exit 2 file_error:    not_found | read_error | not_a_rewritable | wrong_kind | write_error | install_not_durable
exit 3 envelope_error: malformed_envelope | version_mismatch | invalid_json | missing_skill_field |
                       unsigned_with_permissions | compute_with_permissions | unsigned_capability |
                       invalid_permission | unknown_permission_tier | dynamic_import_forbidden |
                       tampered_signature | update_requires_consent
exit 4 reserved (unused by install)
```

### Behavior
All gates run synchronously, offline: parse args → read+validate envelope → read host + check kind → verify signature → `validateInstall` → consent gate → parse existing zone → skillId collision check → lookalike scan → rebuild+sort+write atomically → durability re-parse. The CLI is a *sibling writer* to the seed's runtime install: both write the same zone form; both agree on skillId, signature verification, permission grammar, and gate codes. The seed re-verifies each signature at boot.

### Acceptance
Signed tool → exit 0, `verified:true`, durable. Unsigned tool → exit 3 `unsigned_capability`, file unchanged. Compute+perms → exit 3. `import(` in code → exit 3 `dynamic_import_forbidden`. No `--yes` → exit 1. Missing envelope → exit 2 `not_found`. Wrong kind (`document.html`) → exit 2 `wrong_kind`. Tampered signature → exit 3. Lookalike (distance ≤2, diff key) → exit 0 + stderr warning. Re-install same → "already installed". Update (same key, `+network:tracker.y`) → exit 0, zone updated. Mid-write fsync failure → file unchanged, temp cleaned, exit 2 `write_error`.

### Dependencies
`skill-manifest.mjs` (complete), `edit.mjs` `CliError`, `atomic-write.mjs`, `host.mjs` (structure model), `seed.mjs` (`PRODUCT_KIND` detection), `bin/rwa.mjs` verb dispatch (publish/host pattern → `emitInstall`).

### Security
Capability scan is advisory; the structural wall is the `import(` hard-reject + the runtime's bridge gates. **Shape B** (in-bounds misuse) is undefendable — `--yes` is the human's review signal, not a credential. Lookalike (Levenshtein, different key) informs not blocks (Invariant 16). Compound vault+network and unknown tiers are rejected cleanly (forward-compat). The frozen-zone tamper surface is closed by boot-time re-verify (post-write zone tamper flips `verified:false`). **Invariant 19a relaxation:** the CLI is a trusted, audited writer of the zone; it writes the identical form the seed produces.

### New invariants (as drafted)
- **21** — CLI install gates match seed install gates (identical codes; unified reporting).
- **22** — Frozen zone is deterministically sorted by skillId (install-order-independent, reproducible bytes). *(The seed runtime does not sort; the CLI batch path must.)*
- **23** — Lookalike warning does not block (Invariant 10 stand).
- **24** — Unsigned compute requires `--yes`; unsigned tool is a hard reject even with `--yes`.

### Effort
M — orchestration over proven mechanics. ~300 lines `install.mjs` + ~80 lines verb dispatch + ~15 lines `FAILURE_HINTS`. ~2–3 impl hrs + 1 hr TDD.

### Open questions
Multi-envelope batching in one call (vs shell's job)? Update auto-detect+reject vs "already installed"? Permission-diff prose format parity with the seed dialog? `--yes`/`--trust` both vs canonical one? Refuse if host has unsaved bootstrap edits (likely out of scope — CLI sees bytes only)?

---

## §4 I5 — Unicode-confusable detection + name_history

**One line:** Sharpen the install-dialog trust anchor by detecting Unicode-skeleton homoglyphs and surfacing per-author name-change history, replacing ASCII-only Levenshtein.

### Current state
v0.8 §3.5 ships Levenshtein-only lookalike (`_skLevenshtein` 6643–6649; `runtimeReviewSkill` 6700–6706 flags exact/near-miss vs different authors). IDB `rwa_sources` is *defined* as `pubkey → {count, first_seen}` but NOT yet persisted in the seed. **Gated out:** Unicode skeleton/NFKC folding; per-author `name_history`; name-change detection; historical-name dialog prose.

### Motivation
ASCII Levenshtein misses homoglyph squatting (cyrillic `а` vs latin `a`, ligatures) that render identically but differ in bytes. Same-author renames (tool.v1 → tool.v2) aren't surfaced, obscuring continuity. Name history anchors author identity (per public key) across renames — lowering friction for legitimate updates while flagging impersonation more precisely. Strengthens the Shape B human-review anchor (Invariant 10) without claiming runtime defense.

### Normative contract
- **MUST** NFKC-fold both incoming and installed names before any lookalike comparison.
- **MUST** compute skeleton-distance (RFC 7954 confusables) in addition to Levenshtein; flag fires if `skeleton ≤1` OR (`Levenshtein ≤2` AND `name-length ≥4`) against a *different* author.
- **MUST** extend `rwa_sources` to `{count, first_seen, name_history:[{name, first_seen_at_name}]}` (ordered, one entry per distinct name per pubkey).
- **MUST** append a `name_history` entry at install when the incoming name differs from the latest for that pubkey, before registration.
- **MUST** display name_history on a detected name change ("This author previously published a skill named *[old]* on *[date]*. The current name is *[new]*. The author is identified by the key, not the name.").
- **SHOULD** keep skeleton + history retrieval < 100ms on the in-memory snapshot (non-blocking).
- **MUST** fire no warning when skeleton matches the *same* author (re-branding ≠ impersonation).
- **MUST** treat same-author rename + new signature as a re-verify + name_history update; the update dialog shows the rename as a non-permission, informational delta.
- **MUST** reject install with `lookalike_skeleton_blocked` when `skeleton ≤1` vs a different author, before any code is registered.
- **SHOULD** never skeleton-*block* unsigned skills (no capability to escalate); the Levenshtein ≤2 warning still renders.

### New grammar / wire
```
rwa_sources (IDB, extended):
{ pubkey, count, first_seen, name_history:[{ name, first_seen_at_name }] }

Dialog prose:
- skeleton match, same key   → no warning
- skeleton match, diff key   → "⚠️ This name uses characters that look identical to '<trusted>' (DIFFERENT author). Review the key."
- Levenshtein + name change  → "⚠️ closely matches '<previous>' from the same author, installed <date>. Verify the key: <snippet>."
- Levenshtein, diff key      → "⚠️ closely matches '<installed>' (key <snippet>, installed <date>). Identity is the key, not the name."
```

### Behavior
At boot, `runtimeBuildSourceIndex` rebuilds `rwa_sources` (incl. name_history) from the frozen zone bytes. `runtimeReviewSkill` calls `_skCompareNames` → NFKC-normalize, Levenshtein, `_skSkeletonDistance` (RFC 7954 baked table), and retrieve name_history → `{skeletonMatch, levenshteinDist, priorNames}`. Dialog renders in severity order: skeleton → block/warn (by author match) → name-change note. On install, `runtimeInstallSkill` appends a new name_history entry before `runtimeRegionCommit`. **name_history lives in IDB, rebuilt every boot from in-file manifests — never persisted to file bytes** (matches v0.8 §7).

### Acceptance
Install `tool-A` (key X) → name_history seeded. Same key publishes `tool-B` (rename) → "previously published tool-A", allow without gate. Different key publishes homograph `tool-B` (cyrillic) → `skeleton ≤1` → `lookalike_skeleton_blocked`. Author Z publishes ASCII `tool-A` (Levenshtein=0, diff key) → warning, install allowed. Five renames → full chronological name_history; each dialog shows only the immediately prior name. IDB-cleared reload → `runtimeBuildSourceIndex` restores from bytes (rebuild correctness). Unsigned homoglyph → warning only, no block.

### Dependencies
`_skLevenshtein`, `runtimeReviewSkill`, `rwa_sources` (schema expansion), new `runtimeBuildSourceIndex`/`_skNormalize`/`_skSkeletonDistance`, `showSkillInstallDialog` (history rendering), Invariants 10 + 19b.

### Security
Skeleton-distance reduces impersonation surface (homoglyphs trick human review). Shape B unchanged — a valid-skeleton skill can still misuse declared perms. Static confusables table (ship-time baked), deterministic NFKC (no injection), append-only name_history rebuilt from signed manifests. O(1)–O(n-confusables) per pair, <100ms for ~100 skills. name_history is unforgeable without forging signatures.

### New invariants (as drafted)
- **21** — Name identity is anchored on Unicode skeleton (RFC 7954) + author pubkey, not ASCII string.
- **22** — Per-author name_history is append-only, IDB-persisted, rebuilt at boot from in-file manifests, chronological.
- **23** — Lookalike warning fires in strict precedence: skeleton ≤1 diff-author → block/severe; Levenshtein ≤2 diff-author len≥4 → warn; name-change same-author → informational note.

### Effort
M — small skeleton algorithm (~200 lines RFC 7954 lookup), native NFKC, backward-compatible schema expansion, additive dialog rendering. No Worker/CSP changes.

### Open questions
Embed vs generate confusables table (recommend baked)? NFKC + toLowerCase vs NFKC only (recommend lowercase per UTS 36)? name_history truncation (recommend none in v0.9)? Skeleton block vs warn for signed same-key re-brands (recommend no block on key match)? Track `manifest.version` in entries (out of scope — name-centric)?

---

## §5 I1 — Bus permission tier & inter-skill messaging

**One line:** Define the `bus:<topic>` permission tier grammar, Worker-bridge message channel, and per-call gating to enable signed multi-agent orchestration.

### Current state
**Transport exists, browser-proven:** BroadcastChannel pub/sub via `workspace:presence` (lines 930–967, 1265–1350); `runtime.bus.{publish,subscribe}` for document code (8142–8145); `assertRuntimeBusTopic()` blocks `rwa_:`/`skills:` prefixes; fixed envelope `{topic, from:DOC_UUID, at, message}`. **Gating partial:** `_skParsePermission()` (6655–6674) handles only `network:`/`vault:`; line 6673 throws `unknown_permission_tier` for `bus:`. Per-call gate pattern exists for network (origin) / vault (namespace) via the Worker bridge (6899–6927). **Greenfield:** `bus:` grammar, `bridge:bus:publish`/`bridge:bus:subscribe` handlers, manifest parse/validate, per-call subscribe gating, payload shape, topic-allowlist wiring.

### Motivation
`workspace:presence` and I12 require skills (not just document code) to publish/subscribe to inter-container channels. Skills must declare bus topics at install, validate against a grammar, and have the bridge gate each publish/subscribe against declared `bus:` perms — mirroring the proven network/vault model. The per-call gate is the enforcement boundary; this unblocks agent-driven coordination without per-topic install-time code review.

### Normative contract
- **MUST** parse `bus:<topic>` to `{tier:'bus', value:topic}` in `_skParsePermission()`.
- **MUST** validate topic: non-empty, 1–96 UTF-8 bytes, `/^[A-Za-z0-9][A-Za-z0-9:_./%-]*$/`, NOT matching reserved `/^(?:rwa[:_]|skills:|workspace:)/`.
- **MUST** emit `invalid_permission` for a topic failing the grammar.
- **MUST** require `vr.signed === true` for any `bus:` permission (`unsigned_with_permissions`).
- **MUST** show a compound install-dialog callout when `bus:` co-occurs with `network:`/`vault:` (multi-step cross-container attack warning).
- **MUST** recognize `bridge:bus:publish` and `bridge:bus:subscribe` (payload `{topic,[message]}`).
- **MUST** gate publish via `_skBusAllowed(skill, topic)` (exact-string, no wildcards); deny → `bus_topic_denied`; on allow, validate structured-clone-safe + ≤65536 bytes, then `runtimeBusPublish`.
- **MUST** gate subscribe via `_skBusAllowed`; on allow, create a BroadcastChannel listener filtered through `_skBusMessageAllowed(skill, envelope)` (returns true for all today; I12 wires peer-allowlist), strip envelope to `{topic,from,at,message}`, post `{type:'bus:message',id,envelope}`.
- **MUST NOT** change the identity_tag protocol or the 5s per-invocation timeout (the timeout bounds the subscribe *call*, not the subscription lifetime).
- **MUST** install a Worker-side `runtime.bus.{publish,subscribe}` proxy in SKILL_WORKER_PROLOGUE mirroring the document-side API.
- **MUST** reject publish/subscribe to undeclared topics with `bus_topic_denied` (proxy rejects `Error('bus_topic_denied')`).
- **MAY** omit `bus:` perms from `runtimeDescribe()` affordances (permission exposure deferred to v0.10).
- **SHOULD** list new bus topics in the update prose diff (I10) human-readably.

### New grammar / wire
```
bus:<topic>  — topic 1–96 UTF-8 bytes, /^[A-Za-z0-9][A-Za-z0-9:_./%-]*$/, not /^(?:rwa[:_]|skills:|workspace:)/

Worker→Main: { "type":"bridge:bus:publish",   "id":N, "identity_tag":"uuid", "payload":{ "topic":"...", "message":{...} } }
Worker→Main: { "type":"bridge:bus:subscribe", "id":N, "identity_tag":"uuid", "payload":{ "topic":"..." } }
Main→Worker: { "type":"bridge:response", "id":N, "identity_tag":"uuid", "ok":true,  "result":true }
Main→Worker: { "type":"bridge:response", "id":N, "identity_tag":"uuid", "ok":false, "error":"bus_topic_denied" }
Main→Worker: { "type":"bus:message", "id":N, "identity_tag":"uuid", "envelope":{ "topic","from","at","message" } }

runtime.bus.publish(topic, message): Promise<true>            // reject: Error('bus_topic_denied' | 'bus_error')
runtime.bus.subscribe(topic, cb): Promise<()=>void>           // cb({topic,from,at,message})
```

### Behavior
On install, each `bus:<topic>` is validated; invalid → `invalid_permission`. The skill record retains the full permissions array. On invoke, the prologue installs `runtime.bus` proxies. **Publish:** proxy posts `bridge:bus:publish`; main thread `_skBusAllowed` + structured-clone/size guard → `runtimeBusPublish` → reply. **Subscribe:** main thread checks permission, creates a BroadcastChannel listener filtered through `_skBusMessageAllowed`, forwards each envelope; the 5s timeout applies to the subscribe call only; messages flow until Worker termination/manual unsub. Listeners live in the message-handler closure (no long-lived identity_tag map). The static prologue base hash is unchanged (proxy methods are computed at invoke time, not in the frozen base).

### Acceptance
Install signed `echo-agent` with `bus:agent:pings` → frozen-zone persists. Invoke → `publish('agent:pings',…)` succeeds on the channel. `publish('undeclared',…)` → `bus_topic_denied` rejection. Document `subscribe('agent:pings',cb)` → receives echo. Subscribe to undeclared → `bus_topic_denied`. Unsigned compute + `bus:` → `unsigned_with_permissions`. `bus:` + `vault:` → compound callout. Update adding `bus:agent:status` → prose diff → re-affirm → both stored. Uninstall → document bus still works; new invocations can't reach. `rwa_internal:admin` → `invalid_permission`. `agent/pings/v2` → valid.

### Dependencies
v0.8 §1 dialog, §5a Worker bridge (6851–6932), §8 manifest validation, §3 identity, BroadcastChannel (930–967). **I12** consumes `bus:` + wires peer-discovery into `_skBusMessageAllowed`.

### Security
A `bus:` skill can broadcast to same-origin subscribers; a compromised skill can spoof status. **Mitigations:** install dialog surfaces the permission (Shape B informed consent); per-call gating bars undeclared topics; payloads are origin-bound (BroadcastChannel same-origin); the `from` DOC_UUID enables receiver-side filtering (documented best-practice, not runtime-enforced); future I12 peer-allowlists are defense-in-depth (Shape B holds — a declared allowlist can't be further runtime-restricted). **No new escalation:** a skill misusing declared `bus:` perms is undefendable; human install review is the sole defense.

### New invariants (as drafted)
- **21** — A skill MUST NOT reach a bus topic outside its declared `bus:` perms (main-thread gate is sole enforcement).
- **22** — Reserved prefixes (`rwa_`, `skills:`, `workspace:`) MUST NOT be enrolled (`invalid_permission`).
- **23** — A bus message MUST NOT exceed 65536 bytes (structured-clone encoded).
- **24** — Bus messages are unencrypted and origin-bound; receiver-side filtering is the application's responsibility.

### Effort
M — transport proven; ~250 lines extending the network/vault pattern (parse +30, `_skBusAllowed` +10, bridge handlers +80, prologue proxies +60, dialog +20, tests +50). No new deps.

### Open questions
Expose `bus:` perms in `runtimeDescribe()` (deferred to v0.10)? Default payload encryption (deferred — manifest schema change)? Subscriber filtering (I12 peer-discovery; interim receiver-side `from`)? Timeout on subscribe call vs lifetime (spec: call — forward-compatible with long-lived agent Workers)?

---

## §6 I3 — `fsa:` permission tier (scoped OPFS access)

**One line:** Define `fsa:<scope>` granting skill read/write to per-scope OPFS paths through a bridged `runtime.fs` surface, scoped per-call like vault namespaces.

> I3 and I4 (§7) share the bridge+gate pattern with v0.8's `network:`/`vault:` tiers and with each other. The pattern is described here; §7 cross-references it.

### Current state
Transport exists: `runtime.fs.{read,write,del,list}` over OPFS (L745–811, per-container `_<UUID>/` prefix, path validation: no leading slash, no `_rwa/`, no `.`/`..`); `_fsaState` (L1082); `bridge:fetch`/`bridge:vault` per-call pattern (L6903–6927); `_skVaultAllowed`/`_skNetworkAllowed` gates. **Gated out:** `_skParsePermission` rejects `fsa:` as `unknown_permission_tier`; no `bridge:fs` handler; no `runtime.fs` proxy in the prologue; no `_skFsAllowed`; no `fsa` dialog prose.

### Motivation
v0.8 deferred `fsa:` to keep the MVP lean. Tools need to manipulate files (indexing, report generation, config workflows) within sandbox limits. OPFS is the only filesystem available to Workers (no FSA direct handles; works on https://, not `file://` Chromium). The tier follows the vault bridge pattern: manifest declares `fsa:<scope>`, main thread enforces per-call via path-matching, the Worker sees only the bridged proxy, errors throw a closed vocabulary.

### Normative contract
- **MUST** fail install (`unknown_permission_tier`/`invalid_permission`) for a `fsa:<scope>` failing the grammar.
- **MUST** reach OPFS only via a bridged `runtime.fs` proxy installed in the prologue; **MUST NOT** grant any raw `FileSystem*Handle`.
- **MUST** validate every `bridge:fs` op against the manifest, checking the *resolved* (normalized) path against the declared scope before any OPFS op.
- **MUST** error (`permission_denied`/`fs_permission_denied`) when a skill without `fsa:` calls `runtime.fs.read()`.
- **MUST NOT** allow traversal out of scope via `..`/symlink (runtime normalizes + validates the full resolved path).
- **MUST** throw a readable `fs_unsupported` at first fs call when OPFS is unavailable (`file://` Chromium, older Safari/FF) — never silently degrade.
- **MUST** trigger a compound callout for `fsa:` + `vault:` (or `fsa:` + `network:`).
- **MUST** reject unsigned compute declaring `fsa:` (`compute_with_permissions`) and unsigned tool declaring `fsa:` (`unsigned_capability`).

### New grammar / wire
```
fsa:<scope> — relative path, lowercase [a-z0-9_/-], no leading/trailing slash, no . or .., ≤128 chars, no _rwa/ prefix
              ^[a-z0-9_][a-z0-9_/\-]*[a-z0-9_]$  or  ^[a-z0-9_]$
              Examples: fsa:data, fsa:reports/generated, fsa:cache/index

Worker→Main: { "type":"bridge:fs", "id","identity_tag", "payload":{ "op":"read|write|del|list", "path", "data?":Blob } }
Main→Worker: { "type":"bridge:response", "id","identity_tag", "ok", "result?" | "error?" }

Closed error vocabulary:
  fs_permission_denied | fs_path_not_found | fs_path_invalid | fs_path_denied |
  fs_write_failed | fs_quota_exceeded | fs_unsupported
```

### Behavior
At install, `_skValidateInstall` parses each `fsa:` via `_skParsePermission` and validates the scope. At invoke, the prologue installs the bridged `runtime.fs` proxy for tool skills. On each `bridge:fs`: (1) extract `fsa:` perms; (2) normalize the user path (null/empty/leading-slash/`.`/`..`); (3) `resolvedPath = opfsResolve(scope + '/' + userPath)`; (4) reject `fs_path_denied` if not under `normalizePath(scope+'/')`; (5) prefix-match against declared scopes → `fs_permission_denied` if none; (6) attempt OPFS op; (7) map errors (QuotaExceeded→`fs_quota_exceeded`, NotFound→`fs_path_not_found`, Security→`fs_unsupported`); (8) reply.

### Acceptance
Signed tool `fsa:data`,`vault:github-prod`,`network:api.github.com` → compound callouts, all three persist + reported by `rwa doc --json`. `read('config.json')` → `data/config.json`. `read('../secret.txt')` → `fs_path_denied`. No-network skill calling `fetch` → `permission_denied`. Compute + `fsa:data` → `compute_with_permissions`. Unsigned tool + `fsa:data` → `unsigned_capability`. `fsa:..`/`fsa:_rwa/cache` → `invalid_permission`. `file://` Chromium → `fs_unsupported`. `list('dir/')` → `[{name,kind}]`. `write` quota error → `fs_quota_exceeded`.

### Dependencies
v0.8 bridge:fetch/vault pattern, OPFS surface (L745–811), `_skParsePermission`, `runtimeInvokeSkill` dispatch, dialog (`_skPermProse`/`_skCompoundRisk`), `runtimeRegionCommit` (frozen-zone writes), v0.9 test harness. **Shares its gate/bridge skeleton with I4 (§7).**

### Security
An `fsa:<scope>` skill can read/write/delete under that path. Mitigations: main-thread path validation/normalization (Worker never sees raw FSA); scope check blocks `..`/symlink traversal; `_fsaState` reflects the browser grant (skill can't upgrade); closed error vocabulary (no raw OPFS/OS leaks). **Shape B:** a skill misusing declared `fsa:<scope>` (exfiltrating via `network:`, writing malicious code) is undefendable — human install review is the anchor; the dialog highlights `fsa`+network/vault risk. `file://` Chromium OPFS unavailability is a platform fact surfaced as `fs_unsupported`.

### New invariants (as drafted)
- **21** — `fsa:` reaches OPFS only via the bridged proxy; main-thread per-call scope check before any OPFS op; no raw handle; scope validated at install, resolved path at invoke; closed error vocabulary.
- **22** — `fsa:` is per-scope (not global); strict left-anchored prefix, no wildcards (extends Invariant 17).
- **23** — Compute cannot declare `fsa:` (any permission); unsigned tool cannot declare `fsa:` (tightens Invariant 20).

### Effort
M (3–4 days): extend `_skParsePermission` (1d), `_skFsAllowed` (0.5d), prologue proxy (1d), `bridge:fs` handler + normalization + OPFS error mapping (1.5d), dialog prose (0.5d), e2e tests (1d).

### Open questions
Wildcards (`fsa:data/*`) vs strict prefix (recommend prefix)? Mid-invoke FSA re-prompt vs throw-once `fs_unsupported` (recommend throw-once)? Uppercase scopes (recommend lowercase, like vault)? v0.10 FSA direct-write handles (deferred — v0.9 is OPFS-only)?

---

## §7 I4 — `idb:` permission tier (scoped IndexedDB access)

**One line:** Scoped IndexedDB store access via `idb:<store>`, enforced by a `bridge:idb` surface mirroring the network/vault/fsa pattern (§6).

> I4 shares the per-call gate + `bridge:<tier>` skeleton with I3 (§6) and the shipped network/vault tiers. Only the store-name grammar, reserved-store guards, and `runtime.db.*` proxying differ.

### Current state
Transport + data path present: `idbGet/idbPut/idbDel` (L551–573), per-container `rwa_<DOC_UUID>`; reserved-store guard `assertRuntimeDbStore()` + `RwaReservedError` (rejects `^rwa_`, L582–593); public `runtime.db.{get,put,del,subscribe,all}` (L613–684); user stores in `rwa_state['user_stores']`. **Gated out:** no `idb:` tier (L6673 `unknown_permission_tier`); no `bridge:idb`; no `_skIdbAllowed`; no IDB bridge in the Worker RUNTIME.

### Motivation
v0.8 §11 deferred `idb:` with formats forward-compatible. v0.9 mirrors the network/vault pattern: left-anchored typed grammar, per-call main-thread gate, no escalation beyond declared stores. Normalizes IDB access (today every bridge-enabled tool can reach any non-reserved store via `runtime.db.*`) and enables install-time transparency about which skill touches which persistent data.

### Normative contract
- **MUST** accept `idb:<store>` matching `^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$` (≤64 octets, no wildcards).
- **MUST NOT** accept `^rwa_*` (`idb_reserved_store`) or the vault store `rwa_vault` (`idb_vault_store_forbidden`) at validation.
- **MUST** extend `_skParsePermission()` → `{tier:'idb', value:store}`; unknown tier still `unknown_permission_tier`.
- **MUST** define `_skIdbAllowed(skill, store)` (exact-string membership of `'idb:'+store`).
- **MUST** add `bridge:idb` to the prologue for tool skills only (compute gets no bridge); shape `{op:'get|put|del|subscribe|all', store, key?, value?}`.
- **MUST** gate per-call on the main thread; deny → `idb_store_denied`; allow → proxy to `runtime.db.*`, wrap result/error.
- **MUST NOT** accept `idb:*` or any wildcard.
- **MUST** include `idb` in install-gate validation (unknown/undeclared tiers rejected).
- **SHOULD** render `idb:` rows in the dialog grid + compound callout for `idb:` + `network:`/`vault:`.
- **MUST** report installed `idb:` perms via self-description/1 (`provenance:'installed'`, no new affordance kind).

### New grammar / wire
```
idb:<store> — ^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$ (≤64 octets, no wildcards)
              Legal: idb:cache, idb:user_data, idb:session-state
              Illegal: idb:*, idb:rwa_*, idb:rwa_vault, idb:my-store! (>64)

Worker→Main: { "type":"bridge:idb", "id","identity_tag", "payload":{ "op":"get|put|del|subscribe|all", "store", "key?", "value?" } }
Main→Worker: { "id","identity_tag", "ok":true, "result" }  |  { "id","identity_tag", "ok":false, "error":"idb_store_denied" }
```

**Scope decision (chosen): per-container store.** `idb:mystore` accesses exactly `mystore` in `rwa_<DOC_UUID>`. No cross-container/cross-skill composition store in v0.9 (deferred to v0.10, needs the bus tier + coordination protocol).

### Behavior
**Install gate:** `_skValidateInstall` regex-validates the store, rejects `rwa_*`/`rwa_vault`, accepts otherwise; unknown tier → `unknown_permission_tier`. **Bridge install:** tool-skill invoke installs the idb bridge alongside fetch/vault. **Per-call gate:** validate identity_tag → `_skIdbAllowed` → deny `idb_store_denied` / allow proxy to `runtime.db.*` (errors surface as `{ok:false,error}`). **Compute:** no bridge, can't declare `idb:` (`compute_with_permissions`). **No auto-create:** `idb:mystore` assumes the store exists (via prior `runtime.db.open`); else the IDB tx fails with `ObjectStoreError` surfaced to the skill. The 5s timeout applies (no special-casing).

### Acceptance
Tool + `idb:cache` → grid row "IndexedDB store: cache", persists, reported. `idb:mystore`+`network:` → compound callout. `idb:rwa_reserved` → `idb_reserved_store`. `idb:rwa_vault` → `idb_vault_store_forbidden`. `idb:*` → `invalid_permission`. Invoke `idb:cache`,`idb:data` → `get('cache',key)` allowed. `put('other_store',…)` → `idb_store_denied`. Compute → `runtime.idb` is `ReferenceError`. Unsigned tool + `idb:store` → `unsigned_with_permissions`. Declare via `runtime.db.open('mystore')` then `idb:mystore` → reads/writes succeed (no auto-create). `parseSkillZone` extracts `idb:cache` → self-description reports it.

### Dependencies
v0.8 skill runtime + bridge; extended `_skParsePermission`/`_skIdbAllowed`; prologue `bridge:idb`; `runtimeInvokeSkill` dispatch; dialog grid + compound callout; `parseSkillZone` (already extracts permissions — no change). **Shares its gate/bridge skeleton with I3 (§6).**

### Security
Escalation (`idb:A` reads `B`) blocked by the per-call gate (no direct IDB API). Lateral leakage (two skills, same store) is by-design shared per-container data — the dialog shows each skill's perms separately. Signature forgery flips `verified:false` at boot. No auto-create privilege. CSP-independent (no code-loading channel). Cross-container isolation via unique `rwa_<DOC_UUID>`. **Shape B:** the runtime guarantees declared-stores-only; the dialog makes the declaration visible; in-bounds misuse is the human's call.

### New invariants (as drafted)
- **21** — Every `idb:` perm names a non-reserved, non-vault store, validated at install (`rwa_*`/`rwa_vault`/wildcards rejected).
- **22** — `bridge:idb` is gated per-call by `_skIdbAllowed`; a Worker can't reach an undeclared store.
- **23** — `idb:` perms don't auto-create stores; a missing store fails with `ObjectStoreError`.
- **24** — Compute receives no idb bridge and can't declare `idb:` (`compute_with_permissions`).
- **25** — `idb:` perms are inside the manifest‖code signature coverage; tampering flips `verified:false`.

### Effort
M — extend the established tier infra; one `bridge:idb` handler + gate (vault-sized footprint); dialog grid + callout. No new stores/data structures/CSP. ~200–300 lines + tests.

### Open questions
`runtime.shared` composition stores (deferred to v0.10)? `subscribe()` support (likely yes — mirrors `runtime.db.subscribe`; test burden)? Quota error vocabulary parity with vault? Dynamic `runtime.idb.open` auto-create (no in v0.9)? Audit-trail logging in `rwa_hist` (deferred — opaque user data)?

---

## §8 I7 — Installable view / edit-surface (DOM-authoring) skills

**One line:** Skills that register as `view` or `edit-surface` providers to render or transform the document surface, via a structured transform-description language (no raw innerHTML from the Worker).

### Current state
Provider slots `{view, 'edit-surface', compute, tool}` exist (`:6310`); `runtimeProvide` registers first-party providers (`:6363–6378`); first-party `view` execution validates via `sanitizeViewOutput`/`validateViewOutput` and applies through `renderDoc` (`:6383–6405`); `runtimeDescribe()` unions all four kinds + declared + installed affordances (`:6950–6972`); region-commit + skill-zone writes + Worker isolation are built. **Gated out:** there is no logic to *execute* an installed-skill `view`/`edit-surface` provider — no manifest field permitting it, no `setView`/invoke path. The affordance is declared and reported but the skill can't be *activated* or *invoked* as a DOM author. v0.8 kinds are only `{compute,tool}`.

### Motivation
The hard problem: a Worker can't touch the DOM, but an installed skill's output must land safely. The task is a **safe channel** — skills return a deterministic render or transform *description* (JSON-serializable, schema-validated), applied through region-commit (region-only, frozen-scoped, atomic history). This makes first-party and installed providers symmetric in `runtimeDescribe()`, both under the Shape B trust model.

### Normative contract
- **MUST** permit `kind ∈ {view, edit-surface}` (new) alongside `{compute, tool}`; unsigned view/edit-surface permitted (like unsigned compute).
- **MUST** define a view manifest field (`output:{kind:'html-render'}`) declaring the skill returns HTML matching the first-party render contract (string, valid HTML, no `<script>`, no reserved ids, idempotent).
- **MUST** define an edit-surface field (`output:{kind:'dom-transform', transform_schema}`) — the skill returns a JSON object matching the declared schema; the runtime validates before applying.
- **MUST** add Worker-bridge `render(doc,ctx) → Promise<html>` (validated/sanitized identically to first-party) and `transform(description) → Promise<doc>` (validated against `transform_schema`, applied via `runtimeRegionCommit({reachability:'edit-reachable'})`).
- **MUST** gate by `output.kind`: `render` only from `html-render`; `transform` only from `dom-transform`; reject unknown output at install.
- **MUST NOT** permit an `output` skill to declare any `network:`/`vault:` (DOM-authoring is compute-like — zero-capability; prevents render→fetch encoding loops).
- **MUST** make view activation idempotent (`setView(skillId)` twice ⇒ same doc state). Edit-surface skills are invoked, not toggled.
- **MUST** report installed view/edit-surface skills in `runtimeDescribe()` with `kind`, `provenance:'installed'`, `verified` from boot re-check.
- **MUST** extend `runtimeSetView` to accept a first-party name OR an installed-skill skillId, routing the skill case through `runtimeInvokeSkill` and the same sanitize/validate path.
- **MUST NOT** let an installed view/edit-surface skill read/mutate `sessionStorage`/`indexedDB`/any frozen zone outside its transform region (enforced by Worker isolation + region-commit).
- **MUST** capability-scan at install (forbidden patterns: `eval`/`Function`/dynamic `import()`).
- **MUST** reject (at install) any *unsigned* edit-surface/view skill with an expensive-to-validate schema (unbounded recursion/exponential); signed schemas are trusted.
- **SHOULD** make edit-surface invocation atomic w.r.t. undo (one ⌘Z per invoke).
- **SHOULD** permit view skills to opt into update-on-navigate (`observe:['lens-anchor','data-rwa-id-selection']`) to avoid silent re-render loops.
- **MUST** keep the envelope byte-identical to v0.8 (new fields OPTIONAL; v0.8 readers ignore or reject-at-install, never break-on-parse).

### New grammar / wire
```
.rwa-skill.json (v0.9 extension):
{ "format":"rwa-skill/1",
  "skill":{ "name","version","kind":"view|edit-surface|compute|tool",
    "output":{ "kind":"html-render", "observe":["lens-anchor","data-rwa-id-selection"]? }
          | { "kind":"dom-transform", "transform_schema":<JSON-Schema-v7-subset> },
    "permissions":[],   // MUST be empty for view/edit-surface (zero-capability)
    "author_pubkey","code" },
  "signature":<Ed25519, optional for view/edit-surface, REQUIRED for tool> }

Worker bridge:
  RUNTIME.render(doc, ctx)       → _bridge('bridge:render',    {doc,ctx})        → Promise<html>
  RUNTIME.transform(description) → _bridge('bridge:transform', {description})    → Promise<doc>

Main-thread handlers:
  bridge:render    → spec.render(doc,ctx) → sanitizeViewOutput + validateViewOutput → reply html
  bridge:transform → validateTransformDescription(desc, schema)
                   → runtimeRegionCommit({ regions:[…], actor:'skill:transform:'+id8, reachability:'edit-reachable' })
                   → reply doc
```

### Behavior
**Boot:** `readTrustworthySkills` parses optional `output`; view/edit-surface skills register but don't auto-activate. **Install:** reject non-empty permissions for `output` skills; capability-scan; reject expensive unsigned schemas; re-verify signature (unsigned → `verified:false`, OK). **View activation:** `runtimeSetView(skillId)` → invoke → Worker `run()` calls `runtime.render(doc,ctx)` → main thread validates HTML → `renderDoc` applies → `activeView={skillId,…,provenance:'installed'}`. **Edit-surface invoke:** `run(input,runtime)` calls `runtime.transform(desc)` → main thread validates against `transform_schema` → `runtimeRegionCommit('edit-reachable')` (region-only, frozen guards intact) → one undo step. **Persist/uninstall:** frozen-zone rewrite via `runtimeRegionCommit('frozen')`; active uninstalled view → `setView(null)`.

### Acceptance
Unsigned `grid-view` install → lightweight consent → `verified:false`, `kind:'view'`. Signed `annotate` (`network:` rejected) → `verified:true`, `kind:'edit-surface'`. Activate view → Worker render → validate HTML → apply → ⌘Z rolls back. Invoke edit-surface → validate desc → region splice → one undo. View skill can't reach `sessionStorage`/`indexedDB`/`fetch`. Edit-surface region can't touch frozen/skill zone. Update view → re-verify → rewrite. Uninstall active view → `setView(null)`. Cross-machine reload → re-verify (unsigned still invokes, `verified:false`). Idempotent render. Capability-scan rejects `eval`/`import()`. Expensive unsigned schema rejected.

### Dependencies
v0.8 skill runtime, **rwa-runtime-region-commit/1** (the safe scoped-bypass + region-only primitive), self-description union, rwa-edit/1 modify path, first-party view contract (§5.10), affordance kernel, v0.8 permission gates (+ new: reject non-empty perms for view/edit-surface), CLI self-description emission (parse `output` for installed skills). **Shares the safe-DOM/lifecycle channel concern with I8 (§9).**

### Security
A malicious view can deterministically side-channel document content into render output; a malicious transform could corrupt data. **Mitigations (defense-in-depth):** capability-scan at install; Worker isolation (no fetch/indexedDB/eval); worker-scoped CSP (blocks remote `import()`); transform-schema complexity rejection; region-commit post-apply checks (region-only, frozen re-assertion, overlap detection); boot-time re-verify. **Ceiling (Shape B):** the runtime cannot distinguish a benign view from a malicious one; the install dialog discloses *"the skill can read and transform your entire document"*; human review is the sole defense. Forward-compat: a v0.8 reader ignores `output` or rejects-at-install (no silent breakage).

### New invariants (as drafted)
- **21** — view/edit-surface skills are zero-capability (`permissions:[]`; non-empty rejected at install; no fetch/vault bridge).
- **22** — edit-surface region-only mutation: every byte outside the declared region is identical before/after; corrupting frozen zones or out-of-region body is rejected.
- **23** — view output is deterministic and HTML-shaped (`Promise<string>`, sanitized — no `<script>`/reserved ids — before DOM application).

### Effort
M — new provider-kind pathway over the existing isolated-skill foundation. Two bridge message types + handlers (~80 lines), `runtimeSetView` refactor to accept skillId (~40), capability-scan reuse (~20), unsigned-permit gate (~5), CLI emission (~10). No new architecture / permission model. Ceiling well-understood.

### Open questions
Require signing for view/edit-surface (proposal: view unsigned-OK, edit-surface signed-encouraged-not-required)? Multi-region batched transform (proposal: one description, build() may splice multiple)? Observe-state re-render (proposal: opt-in `observe` flag)? Minimal schema subset for unsigned (proposal: no pattern/format, no recursive `$ref`)? `output_label` vs `skill.name` (proposal: name)? view skills in base kinds (proposal: not in v0.9, installed-only)? transform-fail UX (proposal: `setStatus('err',…)`, no retry)? Shared key scheme (proposal: yes)? Store `transform_schema` in frozen zone (proposal: yes).

---

## §9 I8 — Hook skill kind (event-triggered automation)

**One line:** Introduce the `hook` kind — installed skills that fire on declared lifecycle events (`on-commit`/`on-open`/`on-mode-change`) in isolated Workers, with re-entrancy guards and failure isolation.

### Current state
Event bus exists: `runtime.on(event, cb)` for `commit`/`modify`/`mode`/`status` with whitelist-gate (L907–914); `emitRuntimeEvent` (L920–927); `commit`/`mode` emitted post-mutex via `queueMicrotask` (L1033–1047, L5463–5564). Self-description already lists `hook` as a provider kind (`rwa-self-description-spec.md:L80`). `_skParsePermission` accepts only `network:`/`vault:`. **Gated out:** no `hook` envelope support; no `hook:<event>` grammar; no hook registry/spawn; no re-entrancy guard; no hook provider in `KIND_PROVIDERS`.

### Motivation
Hooks are the automation layer: a skill that runs when the document commits/opens/switches mode, without the document or human invoking it — for monitoring/auditing, derivative computation, external-state sync (push-on-save). The event bus is built; the gaps are the event grammar for permissions, the hook-in-manifest declaration, the re-entrancy contract, and the failure model (a throwing hook must not break the commit).

### Normative contract
- **MUST** accept `kind='hook'` with `hook:<event>` permissions where `event ∈ {on-commit, on-open, on-mode-change}` (left-anchored, exact, no wildcards; future events MAY extend).
- **MUST** validate at install via `_skParsePermission`; unknown event → `unknown_permission_tier`.
- **MUST** add `hook` to `KIND_PROVIDERS` (self-description with `provenance:installed`).
- **MUST** spawn in a Worker (compute-only execution model).
- **MUST** fire synchronously after the event and mutex release: `on-commit`/`on-mode-change` queueMicrotask-deferred fire-and-forget; `on-open` during boot before `renderDoc`.
- **MUST NOT** block the commit on hook completion (fire-and-forget, result logged).
- **MUST** terminate on completion/timeout (5s → `{error:timeout}`, no re-trigger).
- **MUST** isolate failures: a throwing/timing-out hook is logged, never propagated to the emitter.
- **MUST** implement re-entrancy guards: a hook's own modify/commit does NOT re-fire its own event.
- **MUST** order firing deterministically (sorted by skillId).
- **MUST NOT** permit any tier beyond `hook:<event>` (hook is compute-only — no network/vault/escalation); a hook with non-hook perms → `compute_with_permissions`.
- **MUST** pass `{event, …payload}` to `run()` (e.g., on-commit → `{event,instruction,lensMeta}`).
- **MUST** log every invocation (success/error) to `rwa_hook_log` (skillId, event, timestamp, input, result/error, duration).
- **MUST** preserve Invariants 18–20 for hook manifests.

### New grammar / wire
```
.rwa-skill.json: kind:"hook", permissions:["hook:on-commit"], signature:<Ed25519, required — hooks run autonomously>

hook:<event>  event ∈ {on-commit, on-open, on-mode-change}   (left-anchored, exact, no wildcards)

Payloads:
  on-commit:      { event:"on-commit", instruction, lensMeta:{surface,instruction,scope,actor} }
  on-open:        { event:"on-open", docUuid }
  on-mode-change: { event:"on-mode-change", mode, previous }

Firing: sorted-skillId order; spawn compute Worker; pass input; 5s timeout; log; terminate; DO NOT await (on-commit fire-and-forget).
```

### Behavior
At boot, build `hooksByEvent = {event → [skillId]}` (cached, updated on install/uninstall). **on-commit:** `commitCore` releases mutex → `queueMicrotask(emit('commit'))` → standard listeners → iterate `hooksByEvent['on-commit']` skipping `isHookActive(skillId)` (re-entrancy), `invokeSkillAsync(skillId, {event:'on-commit',instruction,lensMeta})` fire-and-forget, log result/error; `commitCore` resolves immediately. **on-open:** during boot after `renderDoc`, `await invokeSkillAsync` (blocking, part of boot; errors logged, don't stop bootstrap). **on-mode-change:** in `runtimeSetMode` after `emit('mode')`, fire-and-forget. **Re-entrancy:** `activeHooks` Set added/removed in `invokeSkillAsync`'s try/finally. **Logging:** append to IDB `rwa_hook_log`; prune (>1000 or >30d) at boot.

### Acceptance
Install signed `hook:on-commit` → `provenance:installed`, `kind:hook`. Commit → hook fires fire-and-forget with correct input → db entry written; commit returns immediately. Two on-commit hooks → both fire in skillId order, two log entries. Hook calling `runtime.modify()` in its handler → own on-commit does NOT re-fire. Throwing hook → `runtime_error` logged, commit succeeds. on-open hook → fires during boot, completes before render. Mode switch → on-mode-change fires `{mode:'edit',previous:'document'}`. `hook:on-render` (unknown) → `unknown_permission_tier`. `network:` + `hook:on-commit` → `compute_with_permissions`. Uninstall → no longer fires.

### Dependencies
v0.8 skill substrate; `runtime.on`/`emitRuntimeEvent`/lifecycle events; `_skParsePermission`/`_skValidateInstall`; `KIND_PROVIDERS`; installed-skills registry; new minimal IDB `rwa_hook_log`; Ed25519 verification (hooks MUST be signed). **Shares the safe-channel concern with I7 (§8).**

### Security
Hooks are compute-only (no bridge → zero network/vault; confined to algorithm + `runtime.db` user stores; global-removal + worker-CSP close `import()`). Infinite loops blocked by the deterministic re-entrancy guard. Timeout DoS bounded by 5s + fire-and-forget (commit unaffected). Compound risk impossible (compute-only). **Shape B:** a hook misusing compute (reading IDB, consuming time) is undefendable; human install review is the anchor; the dialog shows the code + listened events.

### New invariants (as drafted)
- **21** — Hook skills are compute-only (no bridge, no network/vault, no escalation).
- **22** — `hook:<event>` is a disjoint tier (exact-match enum; unknown events rejected at install).
- **23** — Re-entrancy guard: a hook's own modify/commit does not re-fire its own event.
- **24** — `on-commit`/`on-mode-change` fire-and-forget (don't block the emit); `on-open` blocking (errors don't stop bootstrap).
- **25** — Every hook firing is logged to `rwa_hook_log` (audit trail).

### Effort
M — lightweight grammar/kind/validator additions; complexity in re-entrancy + fire-and-forget sequencing around the queueMicrotask/emit boundary. Append-only log. ~500 lines impl + ~300 tests.

### Open questions
on-open blocking vs async (proposal: blocking, errors don't stop boot)? Allow controlled event re-trigger with depth limit (proposal: no re-entrancy)? Signed vs unsigned hooks (proposal: signed-required — autonomous)? Hook access to structured metadata (proposal: no — event input only)? Log size/eviction (proposal: prune >1000/>30d)? IDB vs sessionStorage log (proposal: IDB, durable)?

---

## §10 I2 — Worker pool & lifecycle

**One line:** Optional pooled Worker lifecycle for compute skills, keyed by skillId+code-hash, with idle eviction, concurrency-pressure cap, and shutdown-ack handshake, preserving per-invocation isolation and the 5s timeout.

### Current state
Per-invoke spawn→invoke→terminate (`runtimeInvokeSkill` 6873–6932); identity_tag binds responses (`:6887`); 5s timeout (`:6897`); `terminate()` on settle (`:6896`). SKILL_WORKER_PROLOGUE (6844–6867) establishes the message lifecycle. v0.8 §5a documents "no pool". **Greenfield:** no pool registry, idle tracking, pressure metrics, or shutdown-ack — all runtime-side additions; the bootstrap is frozen (Invariant 1).

### Motivation
Fresh-Worker-per-invoke guarantees isolation but incurs allocation cost. Warm reuse cuts latency/churn for high-frequency invocations — but pooling introduces statefulness that breaks isolation unless strictly bounded (a pooled Worker may retain closure variables, listeners, timers). Pooling MUST therefore be optional, compute-only, memory-pressure-gated, and explicitly shut down.

### Normative contract
- **MUST** pool only `compute` (bridgeless) skills; tool skills always spawn fresh.
- **MUST** key the pool on `Hash(skillId + canonicalJSON(manifest.code))`; a code change invalidates all Workers for that skillId.
- **MUST** keep per-invocation identity_tag unique/isolated (pooling the resource does not relax message-routing isolation).
- **MUST** apply the 5s timeout per-invocation (not per-tenure); on timeout, terminate (don't return to pool).
- **MUST** evict + terminate a Worker idle ≥N seconds (recommended N=60); the timer resets on each invoke completion.
- **MUST** cap live pooled Workers at `min(4, hardwareConcurrency||1)`; at capacity, either spawn a fresh temporary Worker or evict-oldest-idle (either conformant; MAY be configurable).
- **MUST** send each live pooled Worker `{type:'shutdown', identity_tag:null}` on runtime shutdown/unload, await ≤500ms grace, then `terminate()`.
- **MUST NOT** reset Worker globals between invocations — pool reuse is transparent; statelessness is the author's responsibility (optional reset hooks deferred).
- **MUST** keep compute pooled Workers zero-capability (no bridge; same worker-scoped CSP as fresh).
- **MAY** specify pool config (idle timeout, cap, opt-in) in host config or a manifest field (deferred); pooling is **disabled by default** in the MVP.
- **MUST** immediately evict+terminate a Worker on uncaught exception / runtime_error / bridge corruption (never return to pool).

### New grammar / wire
```
const SKILL_POOLS = new Map();   // skillId → { codeHash, workers:[Worker], lastEvicted }

Worker←Main: { type:'shutdown', identity_tag:null }
Worker→Main: { type:'shutdown_ack', identity_tag:null }   // optional, observability

runtimeInvokeSkill(skillId, input, poolingHint?:{ pooling?:'enabled'|'disabled', computeOnly?:true })

Lifecycle: FRESH → [invoke] → BUSY → [settle] → IDLE → [timeout|cap] → EVICTED
                                              ↓ [shutdown]
                                       SHUTDOWN_DRAINING → TERMINATED
```
No manifest/envelope grammar additions — pooling is a runtime affordance, not a skill-declared capability.

### Behavior
When pooling is enabled: verify `kind==='compute'` + matching code-hash → pop an idle Worker or spawn fresh. First spawn computes+stores `codeHash`. Execute invoke (init, invoke, 5s race, identity_tag validation); on timeout/error, terminate (don't pool). On success, update `lastUsed`, enforce cap (evict-oldest until under cap), push to pool. Background idle eviction (~30s timer) terminates Workers idle ≥60s. On shutdown, send `shutdown`, 500ms grace, terminate. On install/update/uninstall code-hash change, evict all Workers for that skillId.

### Acceptance
Pooled compute invoked twice <60s → same Worker reused, no state leak. 10 rapid invocations → all complete, cap never exceeded, ~ceil(10/poolSize) allocations. Idle timeout 2s → evict after 3s idle, fresh on re-invoke. 1/s for 90s → memory plateaus, no leak/leftover tx. Code update → all pooled Workers evicted, fresh next, reused after. Tool skill pooling attempt → rejected, fresh per invoke, warning. Shutdown with 3 live → each gets `shutdown` + grace → all terminated cleanly. Uncaught error → evicted (not pooled), fresh follow-up succeeds. Cap=2, 3 parallel skills → ≤2 live, 3rd waits or temp-fresh, none starved. Tool skills unaffected (two spawns, both honored).

### Dependencies
v0.8 execution model (spawn, identity_tag, 5s timeout, bridge), installation/registry (`installedSkills`, skillId, code-hash), kind distinction, `runtimeInvokeSkill`/`SKILL_WORKER_PROLOGUE`/install verification, shutdown semantics (host hook or unload binding).

### Security
Pooled-Worker state retention (closure/listeners/timers) could leak across invocations — mitigated by compute-only (no secrets by design) + author determinism + optional reset hooks (deferred). Pool overflow bounded by a hard cap (2–16). Shutdown race mitigated by `shutdown` message + 500ms grace + idempotent `terminate()`. Code-hash invalidation MUST evict on install/update/uninstall. Identity_tag isolation unchanged in pooled Workers (prologue drops mismatches). **Shape B:** a pooled skill misusing pooling to accumulate closure state is an author bug undetectable without a full reset (deferred). Recommendations: disabled-by-default MVP; document "pool only if stateless/pure"; optional reset hooks; surface pool metrics in the debugger.

### New invariants (as drafted)
- **21** — Every pooled Worker is a compute skill; tools never pooled; pooling opt-in, disabled by default (host decision).
- **22** — Pooled identity_tag is unique-per-invocation and isolated; mismatched/stale messages dropped.
- **23** — Pooled lifetime bounded by idle timeout (≥60s) and cap (≤hardwareConcurrency, rec. min(4,hc)).
- **24** — Code-hash changes invalidate the pool immediately (no stale code after update).
- **25** — Pooled compute remains zero-capability (no bridge; inherits worker-scoped CSP).

### Effort
M — pool registry (module Map), codeHash tracking, idle eviction loop, cap enforcement, shutdown-ack in the prologue, eviction hooks in install/update/uninstall. No schema changes; orthogonal to the cold path; gated by host config. Needs a multi-invoke + timing harness.

### Open questions
Pool config in manifest `pooling:` vs host config only (MVP: host config)? 500ms grace tunable? Standardize `run_pool_reset(runtime)` hooks in v0.9 (deferred)? Per-container vs global pool (rec. per-container)? Expose `runtimePoolStats()` (deferred)?

---

## §11 I6 — Signed-skill marketplace / discovery & distribution

**One line:** Add a signed-skill index (`/skills/index`), fetch→verify→install flow, TOFU author-key trust tracking (IDB `rwa_sources`), and cryptographically-anchored revocation, preserving install-time human review as the trust anchor.

### Current state
`cli/src/skill-manifest.mjs` has `verifyEnvelope`/`signingMessage`/`parseSkillZone`; v0.8 §3.3 fixes atomic manifest‖code coverage; `service/server.js` has `/share` (Bearer-durable) + `/publish` (ephemeral 24h). **Greenfield:** no `/skills/*` routes; no index storage/query; no TOFU author-key tracking; no revocation format/check; no report queue; no client-side index fetch+verify in the seed; no install-from-index UX. v0.8 §11 lists "signed-skill marketplace/distribution" as v0.9+. **Forward-compat:** the envelope (`format`/`skill`/`signature`) is unchanged; signatures already canonical+versionless; index metadata is additive.

### Motivation
v0.8 built signing + per-container storage; v0.9 enables **discovery and distribution** so authors publish for reuse without manual file transfer. The TOFU author-key model (first-install fingerprint + per-key trust count) is practical security: humans trust by identity, not centralized attestation. The index is read-only (no federation), discovery is opt-in, and install-time review remains the trust anchor (Shape B). Distinct from `/publish` snapshots (ephemeral document shares); this is skill-specific, signed, durable, queryable.

### Normative contract
- **MUST** `POST /skills/publish` validate the signature per §3.3 (`unsigned_capability`/`compute_with_permissions`), store `{envelope, metadata{publishedAt, author_fingerprint:sha256(pubkey).hex[:16], verified_count:0, installations_visible:0}}` in `DATA_DIR/skills/`, return `{skillId, registryUrl, verified}` (indexable in 10s).
- **MUST** `GET /skills/index` return paginated entries `{skillId, name, version, author_pubkey, kind, permissions_summary, verified_count, created_at, updated_at}` sorted by `(name, version, author_pubkey)`, with query params `kind`/`author`/`search`/`verified_only`/`page`/`limit` (default 50, max 200).
- **MUST** `GET /skills/index/:skillId` return the full envelope + metadata; 404 unknown; **410 Gone** if revoked.
- **MUST** `POST /skills/revoke/:skillId` accept an Ed25519 signature over `'REVOKE:'||skillId||timestampMs` by the registered author key; persist `{revoked_at, revocation_signature}`; revocation is **permanent** (no un-revoke), audit-logged.
- **MUST** track TOFU on first install: IDB `rwa_sources` `{pubkey, first_seen, trust_level, fingerprint_shown_ts}`; on re-install show `install_count` (incremented), `first_seen` never mutates.
- **MUST** verify the envelope signature **client-side** (WebCrypto Ed25519) before install; show signature-verified/unverified state.
- **MUST** show TOFU dialog prose: first install *"🔑 Author fingerprint: <hex16>. First time seeing this author."*; repeat *"…(trusted, <N> installs)."*; different key, same name → lookalike warning (v0.8 §1).
- **MUST** `POST /skills/report/:skillId` queue anonymous `{reason, evidence_url}` (rate-limited 10/h) without auto-block (human review gate, Shape B).
- **MUST** treat v0.8 pre-signed skills as `verified=true` iff signature verifies; unsigned compute MAY be indexed `verified=false` (warned/flagged).
- **MUST NOT** enumerate per-container install locations (`installations_visible` is a non-identifying counter, never a list).
- **MUST** preserve v0.8 invariants: every install human-reviewed at the trust anchor; the index is one discovery channel (file-picker still works); the per-container frozen zone is the durable artifact, the index is ephemeral metadata.
- **SHOULD** set `X-Content-Type-Options:nosniff` + `Cache-Control:max-age=300` on index reads.

### New grammar / wire
```
POST /skills/publish      → 201 { skillId: base64url(sha256(name||0x00||pubkey)), registryUrl, verified }
                            | 400/422 { error: unsigned_capability | compute_with_permissions | ... }
GET  /skills/index?kind=&author=&search=&verified_only=&page=&limit=
                          → 200 { entries:[…], total, page, limit }
GET  /skills/index/:skillId → 200 { envelope, metadata:{ verified_by_count, installations_visible,
                                     first_published_at, current_author_pubkey, revocation_status } }
                            | 410 Gone { error:"revoked", revoked_at }
POST /skills/revoke/:skillId → 200 { revoked_at }   req { signature: Ed25519('REVOKE:'||skillId||tsMs) }
POST /skills/report/:skillId → 201 { reported_at }  req { reason≤256, evidence_url? }
```

### Behavior
**Publish:** `rwa skill publish <file>` verifies → POSTs → service stores + indexes → returns `registryUrl`. **Browse:** "Discover skills" → seed `GET /skills/index?…` → render → select → `GET /skills/index/:skillId` → client-side WebCrypto verify → TOFU dialog (fingerprint + first-time/N-installs) → affirm → install to frozen zone (v0.8 flow). **TOFU:** first install captures `rwa_sources`; re-install increments `install_count`; different key, same name → lookalike warning. **Revocation:** `rwa skill revoke <skillId>` signs → POSTs → future fetches 410 → clients warn on next invoke. **Durable state:** the frozen zone (unchanged) holds installed manifest+code+signature; the index is ephemeral. Revoking does NOT auto-uninstall existing containers; each decides on the 410.

### Acceptance
Publish signed → appears in index ≤10s → client fetches+verifies → prompts with TOFU fingerprint + trust-count → install to frozen zone → invoke via bridge. Index pagination + `?kind=tool&author=&search=`. Full envelope + metadata; revoked → 410. Anonymous report queued, no auto-block. Pre-v0.8 skills discoverable `verified=false`. Provenance via self-description `provenance:'installed'` + `verified`. E2E publish→index→fetch→verify→install→invoke.

### Dependencies
v0.8 signature format + frozen-zone storage + install dialog/lookalike; WebCrypto Ed25519 async verify in the seed; IDB `rwa_sources` TOFU table; `/skills/index` route family + query storage; per-IP rate-limit (reuse `checkRateLimit`); `DATA_DIR/skills/`; `rwa skill publish` CLI.

### Security
Malicious entries are signed + verified client-side (unverified shown as such — Shape B). TOFU key substitution: first-install fingerprint visible; per-key count + first-seen deter rotation. Report spam rate-limited + human-reviewed. Index scraping intentional (open discovery; no per-user data — counters are aggregates). Revocation signed by author, permanent, checked at fetch. TOCTOU: a revocation at T+1s doesn't affect a container holding the skill at T (revocation is prevention, not remediation). **Trust anchor:** human review at install (Shape B — the index informs, the dialog walls).

### New invariants (as drafted)
- **21** — Indexed skills carry canonical Ed25519 manifest‖code signatures (§3.3); unsigned tools MUST NOT be indexed; unsigned compute MAY be (`verified=false`).
- **22** — TOFU author identity is `sha256(pubkey)`, per-key in IDB `rwa_sources`; the index makes no identity claims beyond the key; lookalike applies to names.
- **23** — The index is a read-only projection; the per-container frozen zone is durable; indexing doesn't rewrite containers; revocation doesn't auto-remove installs.
- **24** — Revocation is permanent + cryptographically signed (`REVOKE:||skillId||timestamp`); no un-revoke (a new key republishes under a new skillId).

### Effort
L — `/skills/{publish,index,revoke,report}` + query backend (~200 LOC server), `rwa skill publish` (~100), seed index fetch + WebCrypto verify + TOFU dialog (~300), IDB `rwa_sources` + install-from-index (~150), tests (~400). ~1150 LOC. Complexity is orchestration (TOFU into the existing install flow), not new crypto.

### Open questions
Confusion-resistant fingerprint encoding (deferred to v0.9b)? Threshold/team keys (v0.9 single-key TOFU; deferred)? Deprecation-without-revocation (v0.9 full revocation only)? Federation (v0.9 single apex index)? WebCrypto verify scaling for 1000+ entries (paginate + 5min cache)? Versioning: bump preserves skillId (name+pubkey hash), index keeps latest+historical, install picks version.

---

## §12 I12 — Multi-agent workspace orchestration

**One line:** Per-agent roles with isolated vault namespaces, role-keyed system prompts, and inter-skill messaging over the bus tier (I1) to coordinate multi-agent edits and handoff.

> I12 builds directly on **I1 (§5)**: inter-agent messaging IS the bus tier with `agents:*` topics; per-agent gating wires peer-discovery into `_skBusMessageAllowed`. It also leans on **I8 (§9)** as the trigger mechanism for orchestrator skills.

### Current state
Substrate bus (BroadcastChannel, per-store, single-container, read-only) built (`workspace.mjs:349–357`, seed `:349–357`); `rwa_hist.actor` is free-form (`getActiveActor()` returns backend/model string `:5105–5117`), written at `:6021–6022`, rendered as a chip at `:1230`. `workspace:presence` is documented (`rwa-product-types.md §4`) but unimplemented. `SYSTEM_PROMPT` is a singleton (`:1248`). **Greenfield:** per-agent roles, role-keyed prompts, vault-namespace scoping per agent, message choreography for artifact handoff.

### Motivation
Multi-agent workspace (product type 4) needs more than transport: roles that isolate capabilities, per-agent prompts, vault scoping, and message choreography to hand artifacts between agents without exposing all capabilities to all actors. Today a workspace can run multiple invokes over the bus but can't name roles, bind role-specific prompts/permissions, or keep credentials in namespace. This blocks reviewer-agent/writer-agent workflows. I12 is the frontier: it lands on v0.8 installed-skill infrastructure + I1's bus tier.

### Normative contract
- **MUST** carry per agent-record: `role` (≤64 lowercase `a-z0-9-_`), `system_prompt`, `vault_namespace_set` (array of `vault:` patterns), optional metadata. Identity is role-scoped.
- **MUST** store agent-records in the frozen zone (`data-rwa-frozen`) as part of the installed manifest, rebuilt at boot via `parseAgentZone()`.
- **MUST** expose `runtime.agents.list()` / `.active()` / `.setActive(role)`.
- **MUST** make `getActiveActor()` return `agents:${role}` when an agent is active (else the backend string — backward compat).
- **MUST** bind a role-scoped vault bridge on `invokeSkill(skillId, input, {agentRole})`: vault ops check the namespace is in the agent's `vault_namespace_set`.
- **MUST** key the `modify()` system prompt by the active agent's role (lookup `system_prompt` at invoke; else the singleton).
- **MUST** use the bus tier (I1) for inter-agent messaging: `{type:'request'|'response', id, from_role, to_role, payload}` on `agents:*` topics.
- **MUST** carry correlation ids (requester UUID echoed by responder); timeouts are the conductor's responsibility, not the runtime's.
- **MUST** invoke the frozen agent-zone build via `runtimeRegionCommit` on install/update/uninstall; base64-encode per-entry.
- **MUST** carry an Ed25519 signature (manifest‖, §3.2–§3.3); unsigned agents rejected (`unsigned_agent`); boot re-verify; tampering → `verified:false`, cannot activate.
- **MUST** reject a `system_prompt` containing backticks, `${`, or literal `<DOC>…</DOC>` (`agent_prompt_injection_risk`).
- **SHOULD** attribute `modify()` edits under an active edit-role agent to `rwa_hist.actor='agents:${role}'`, rendered as a history badge.
- **MUST** reject any unknown permission tier in an agent-record (`unknown_permission_tier`, Invariant 17 / §9 Attack E).
- **MUST NOT** carry agent credentials/vault keys in plaintext over bus messages (use the shared vault or a bridge-tunneled conductor call).
- **MUST** extend the 4-site self-description invariant (SD-04): `parseAgentZone()` in `tools/self-description.mjs` (source) + `cli/src/identity.mjs` (pinned).
- **SHOULD** display agent-records in the install dialog (role, author-key, vault namespaces, system-prompt preview ≤200 chars).
- **MUST** extend Invariant 19b (runtime-sole-writer) to `rwa-agents`; the agent + skill zones coexist; region-commit handles both atomically.

### New grammar / wire
```
rwa-agent/1:
{ "format":"rwa-agent/1",
  "agent":{ "role":"reviewer", "version", "system_prompt", "vault_namespace_set":["vault:github-creds","vault:shared-reviewer-state"],
            "description", "author_pubkey" },
  "signature":"<Ed25519>" }

Bus message (agents:* topics):  { "type":"request|response", "id":"<uuid>", "from_role", "to_role", "payload" }

Frozen zones coexist:
  <div data-rwa-frozen id="rwa-skills"> <script type="application/rwa-skill+json">base64(skillEnvelope)</script> </div>
  <div data-rwa-frozen id="rwa-agents"> <script type="application/rwa-agent+json">base64(agentEnvelope)</script> </div>

runtime.agents.list()  → [{role, author_pubkey, verified}]
runtime.agents.active() → {role, author_pubkey} | null
runtime.agents.setActive(role) → void | throw (agent_not_found, unverified_agent)
```

### Behavior
At boot, after `parseSkillZone()`, `parseAgentZone()` reads `rwa-agents`, verifies signatures, rebuilds the registry. No agent active by default; `setActive('reviewer')` switches roles. When active, `modify()`/`invokeSkill()` use the agent's prompt + role-scoped vault. Bus messages stamped `from_role`/`to_role` enable handoff: writer-skill publishes `agents:reviewer/request`; a listening conductor invokes reviewer-skill with `agentRole='reviewer'` (vault namespace enforced by the bridge). Full choreography (request→wait→timeout/response) is the conductor's job. Edits attributed `agents:${role}`. The frozen zone survives ⌘S atomically (region-commit co-manages skills + agents). On a second machine, `parseAgentZone` re-verifies; unsigned/unverified agents can't activate.

### Acceptance
Install signed agent-record → verifies → registry populates → `list()` `verified:true`. Second agent → both reported (4-site invariant). `setActive('reviewer')` → `active()` returns it → `modify()` uses reviewer's prompt → history `actor=agents:reviewer`. `invokeSkill(…,{agentRole:reviewer})` → vault in-set succeeds, out-of-set `vault_namespace_denied`. Publish `{type:request,to_role:reviewer,from_role:writer}` → conductor correlates by id → invokes reviewer → response on `agents:writer/response`. Uninstall → region-commit removes from `rwa-agents` → reload → gone, can't activate. Unsigned agent → `unsigned_agent`. Prompt with backticks/`${`/`<DOC>` → `agent_prompt_injection_risk`. Cross-machine open → re-verify; tampered → `verified:false`, `setActive` → `unverified_agent`.

### Dependencies
**I1 (bus tier)**, **I8 (hook kind, trigger)**, v0.8 skill layer (dialog, Ed25519, Worker spawn, vault bridge), v0.8 §8 self-description (parseSkillZone pattern), §7 `runtimeRegionCommit` (atomic multi-zone).

### Security
Agent-declared vault namespaces mitigated by signature verify at install + boot re-verify. Embedded-credential prompts caught by injection-pattern check. Spoofed `from_role` — role names are descriptive; trust anchor is install review (spoofing requires installing a malicious agent, caught by dialog + signature). Cross-agent vault access enforced namespace-isolated in the main-thread bridge (same as skill-level). Per-agent metadata travels with the file; working state lives in vault/IDB (uninstall removes metadata, not state). **Shape B:** an agent author misusing declared permissions is undefendable; human install review is the anchor.

### New invariants (as drafted)
- **21** — Every installed agent is role-scoped and author-identified; same role from different authors coexist (distinguished by pubkey); no anonymous action.
- **22** — Agent vault namespaces are precise; the bridge enforces per-call by checking the argument against the manifest (no runtime widening).
- **23** — Agent system prompts are isolated per role; switching swaps atomically; a prompt can't read/modify another agent's state or reference the agent-record schema.

### Effort
L — layer per-agent records over v0.8 skill installation (`parseAgentZone` mirrors `parseSkillZone`); small `lensMeta` + vault-bridge changes; data-model-only bus message shape. High-surface: install dialog (agent affordance) + history pane (role badges). ~200–300 new lines + ~150–200 refactor. No new crypto/storage beyond `rwa-agents`.

### Open questions
Conductor timeout/retry in-skill vs a `runtime.bus.request(to_role,payload,timeoutMs)` helper in v0.9.1 (today: orchestrator implements)? Per-agent IDB store naming convention for uninstall cleanup vs free-form? Prompt inheritance (`extends:role`) (deferred to v0.9.1)? Warn on overlapping `vault_namespace_set` (leaning human-review surface)?

---

## §13 I9 — Argon2id vault KDF (versioned, with fallback)

**One line:** Migrate vault key derivation from PBKDF2-200k(SHA-256) to Argon2id(m=64 MiB, t=3, p=4), with a `kdf_version` field for transparent re-derivation on next unlock and no new external dependencies.

### Current state
Vault (L6529–6610): record `{salt, check:{iv,ct}, entries:{}}`; `_vaultDeriveKey` (L6543–6546) = PBKDF2-200k(SHA-256) via WebCrypto; session caching in sessionStorage; per-entry AES-256-GCM. **Gated out:** no Argon2id; no KDF version field (no algorithm-migration forward-compat). **Greenfield:** Argon2id WASM binding (vendored, no npm/build) + versioned re-derivation.

### Motivation
PBKDF2-200k is fast but GPU/ASIC-brute-forceable offline (the attacker has the salt). Argon2id is memory-hard (OWASP-recommended). Tension: WebCrypto has no native Argon2id → a vendored single-file WASM is required (no fetch). A `kdf_version` field signals which KDF was used; on next unlock, a stale version is re-derived + re-stored under the new KDF (transparent migration), preserving v0.8 forward-compat while enforcing the stronger KDF for new users.

### Normative contract
- **MUST** extend the record to `{salt, kdf_version:int, check, entries}` (0=PBKDF2-200k, 1=Argon2id); a v0.8 record lacking the field is version 0.
- **MUST** accept `runtimeVaultUnlock(passphrase, options?:{targetKdfVersion?})`; if `targetKdfVersion` is newer, (1) derive under current KDF, (2) decrypt check, (3) re-derive under the new KDF, (4) re-encrypt all entries incl. check, (5) bump `kdf_version`, (6) persist before returning. Atomic w.r.t. Worker vault ops.
- **MUST** fix Argon2id params: m=64 MiB, t=3, p=4, 256-bit output (no per-record tuning), documented in spec + code.
- **MUST** vendor Argon2id as a single-file WASM/inline module — base64-embedded or `data:` URL, never npm/build/fetch (CSP-safe `blob:`/`'unsafe-inline'`).
- **MUST** extend `_vaultDeriveKey(passphrase, saltB64, kdfVersion=0)` (default PBKDF2 for v0.8 callers); v0.9 passes `kdfVersion=1` explicitly.
- **MUST** set `kdf_version` to the latest supported version (1) on new vault creation.
- **MUST NOT** break the envelope/permission grammar or the bridge error vocabulary (single IDB entry, same sealed structure).
- **MUST NOT** modify the CSP; if `'wasm-unsafe-eval'` is needed it MUST already be present in v0.8's frozen policy.
- **SHOULD** offer an optional "upgrade vault KDF" settings button (`{targetKdfVersion:1}`).
- **SHOULD** document the Argon2id latency (~50–100 ms).
- **MAY** auto-upgrade on first unlock only when `kdf_version==0` AND there's no existing data (`check==null`); vaults with data require explicit migration.

### New grammar / wire
```
record  v0.8: { salt, check, entries }
        v0.9: { salt, kdf_version:0|1, check, entries }

_vaultDeriveKey(passphrase, saltB64, kdfVersion=0):
  0 → PBKDF2-200k(SHA-256) → AES-GCM-256
  1 → _argon2id(passphrase, salt, {memory:64, iterations:3, parallelism:4}) → importKey('raw', hash[:32]) → AES-GCM-256
  else → throw 'vault_unknown_kdf_version'

runtimeVaultUnlock(passphrase, options?:{targetKdfVersion}):
  derive(current) → decrypt(check) → if target>current: derive(target), re-encrypt(check+all entries), bump kdf_version
  → idbPut(rec) (fail → _vaultKey=null + 'vault_storage_error') → cache session key → true

Argon2id: m=64 MiB, t=3, p=4, output=32 bytes (Argon2id hybrid)
```

### Behavior
At boot, `_vaultLoadRec` loads/creates. `runtimeVaultUnlock` without `targetKdfVersion` derives under the record's `kdf_version` (0 if missing) — v0.8 vaults stay on PBKDF2 unless upgraded. With `{targetKdfVersion:1}`: derive-old → decrypt-all → derive-new (Argon2id) → re-encrypt-all → bump → persist; all before caching the session key (a mid-migration failure leaves the vault locked, never inconsistent). New vaults default to version 1. Workers can't call `runtimeVaultUnlock`/`_vaultDeriveKey` (unlock is a main-thread human action); they reach the vault only via the bridge once cached. Argon2id ~50–100 ms (vs ~5 ms PBKDF2) — acceptable for a per-session unlock. A `kdf_version>1` (future) throws `vault_unknown_kdf_version` (no silent downgrade).

### Acceptance
v0.8 vault unlock (no field) succeeds, store+retrieve round-trips across reload. `{targetKdfVersion:1}` → all entries re-encrypted, `kdf_version=1` persisted; subsequent unlock uses Argon2id (~50–100 ms measurable), creds readable. New vault → `kdf_version=1` on first unlock. v0.8 vault unchanged without options; migrates with options. `kdf_version:99` → `vault_unknown_kdf_version`, `_vaultKey=null`. Worker can't call unlock/derive; `runtime.vault.{get,set}` post-cache respects `vault:` perms. CSP `<meta>` unchanged; WASM embedded/`data:`. Migration atomic — no Worker vault op during the lock; IDB put failure → null + thrown, vault stays locked.

### Dependencies
v0.8 vault architecture + Worker isolation + bridge; single-file WASM Argon2id binding; WebCrypto `importKey`/`deriveKey`; IDB atomic put; sessionStorage.

### Security
Offline-brute-force attacker with IDB ciphertext + check: PBKDF2-200k is fast (millions of GPU/ASIC attempts); Argon2id(64 MiB) requires ~64 TiB for 1M parallel guesses — single-machine brute-force impractical. Params chosen to be memory-hard without OOM on low-memory devices (m=64), conservative latency (t=3), default p=4. Vault ciphertext stays machine-local (unchanged). Session key in sessionStorage (same surface as v0.8). Migration is atomic (attacker sees old-or-new, never hybrid). WASM from a trusted, peer-reviewed source, embedded/`data:` (tampering requires editing the HTML → caught by the frozen-zone guard + human install review). **Shape B:** a `vault:` skill can still abuse the bridge (store exfiltrated data in its namespace); the KDF upgrade grants no new capability. Forward-compat: a v0.9 client rejects a v1.0 vault (`vault_unknown_kdf_version`) — no silent downgrade.

### New invariants (as drafted)
- **21** — Record versioned via `kdf_version`; missing→0; future→`vault_unknown_kdf_version`.
- **22** — KDF-migration re-encryption is atomic w.r.t. IDB persistence (all-or-none; no observable partial state).
- **23** — Argon2id params fixed across all v0.9 instances (m=64, t=3, p=4, 256-bit) — no per-vault tuning, no per-record param metadata.
- **24** — New vaults default to `kdf_version:1`; existing v0.8 vaults stay 0 until explicit migration.
- **25** — Argon2id is single-file, vendored, no npm/build, embedded base64/`data:`, never fetched (CSP compliant).
- **26** — The static frozen CSP is unchanged; any required directive (`'wasm-unsafe-eval'`) must already be present (Invariant 18 holds).

### Effort
M (~9–14 hrs): record schema (1–2), Argon2id WASM binding + `_vaultDeriveKey` (2–3, dominated by vendoring/testing), re-derivation logic + atomicity (2–3), optional UI button (1–2), backward-compat + migration e2e (3–4). Risk localized to the vault subsystem.

### Open questions
WASM vendor (argon2-wasm / libsodium.wasm / minimal Rust→WASM — affects ~100–300 KB base64 size + trust profile)? t=2 to cut latency (weaker)? Offer auto-migration (security vs surprise latency)? Upgrade UI progress bar/confirmation? Telemetry/logging of Argon2id latency (privacy)?

---

## §14 I13 — Account-linked portable identity (opt-in escrow/export)

**One line:** Optional per-user account service enabling vault/skill re-hydration across machines via encrypted escrow or explicit export, without breaking the single-file/no-server default.

### Current state
Vault ciphertext transport is absent **by design**: PBKDF2-200k per-container session key in sessionStorage (never persisted), ciphertext only in IDB `rwa_vault` (`:6529–6610`); v0.8 §6 declares "machine-local — it never travels"; §12 step 7 tests the portability-honesty (2nd machine → vault `null`). Public-key identity is live (§3.3/§3.5); `rwa_sources` tracks `pubkey → {count, first_seen}`. **Gated out:** no account binding/escrow/token, no portable keyring schema. **Greenfield** but forward-compatible.

### Motivation
A user installs `github-api` (vault `github-prod`) on Machine A; on Machine B the vault returns `null` (honest, safe — but ergonomically blocked). Resolution: an *optional* account-linked tier — **encrypted escrow** (account service holds per-namespace encrypted snapshots; rehydration needs passphrase + account token) or explicit **export/import** (`.rwa-vault-export.json` under a transport passphrase). The single-file default is preserved (opt-in; no account required; offline). Skills/manifests already travel with the file; vault data crosses only when explicitly authorized.

### Normative contract
- **MUST** provide an opt-in flow (Settings › Account) absent from the default UI, with no bootstrap bloat; the opt-in choice is per-container/per-machine, sessionStorage-only, cleared on lock/tab-close.
- **MUST** support two modes: (A) encrypted escrow, (B) explicit export/import (`.rwa-vault-export.json`). A user may choose neither (default) or one per container.
- **MUST NOT** extend the `.html` bootstrap size; account logic is lazy-loaded at first account action.
- **MUST NOT** break Invariant 1 (base bootstrap carries no account logic; a skill-host MAY carry a lazy shim).
- **MUST NOT** use the escrow server as a trust anchor: re-hydration requires passphrase (PBKDF2 key) **and** account token; neither alone decrypts (defense-in-depth).
- **MUST** re-verify skill signatures after escrow re-hydration (skills travel with the file, not the account).
- **SHOULD NOT** require an account service in v0.9 (export/import MUST work fully offline; escrow MAY defer to v1 — spec the interface, the service is optional).
- **SHOULD** support account deletion + vault-snapshot purge.
- **MUST** define a version-tagged, self-contained export format (`rwa-vault-export/1`) decryptable offline (no service dependency).
- **MUST** extend self-description/1 with an optional **live-only** `accountIdentity` (`{mode, accountId, lastSync}` or null), never stamped.
- **MUST NOT** expose passphrase/token in logs/errors/stack traces.
- **MUST NOT** expose account-auth state (token/accountId/lastSync) to skill code (UI-only, not via bridge/`runtime.vault`).
- **MUST** define an error vocabulary: `account_not_linked`, `account_auth_failed`, `account_sync_conflict`, `account_export_malformed`.
- **MUST** gate account linking behind a `settings.json` flag (false by default in v0.9).

### New grammar / wire
```
rwa-vault-export/1:
{ "rwa":"rwa-vault-export/1", "containerUuid", "exportedAt", "namespaces":["github-prod"],
  "entries":{ "github-prod":{ "salt", "check":{iv,ct}, "items":[{key,iv,ct}] } } }
  // export passphrase (distinct) → PBKDF2-200k over per-namespace salt → AES-GCM. No server interaction.

sessionStorage (volatile, cleared on lock/tab-close/logout):
  rwa_account: { mode:"escrow"|"export"|null, accountId, token, lastSync, lastError }

Account escrow API (optional, deferred to v1):
  POST /api/v1/vault/sync                      → { ok, synced, deferred, lastSync }  (409 on hash mismatch)
  GET  /api/v1/vault/{containerUuid}/{namespace} → { snapshot, hash, lastSync }       (401 expired)

self-description/1 (live-only; omitted when mode===null; never stamped):
  "accountIdentity": { "mode":"escrow"|"export"|null, "accountId", "lastSync" }
```

### Behavior
**Escrow (A):** Link/sign-in → derive account token (sessionStorage) → "Sync Now" picks namespaces → fetch escrow snapshot → compare local vs escrow hash → on mismatch prompt Keep Local / Replace from Account → upload encrypted namespaces (server never sees plaintext). Machine B: sign in same account → "Restore Vault" → fetch + re-hydrate IDB. **Export (B, offline):** "Export Vault" → select namespaces → export passphrase → timestamped `.rwa-vault-export.json` (per-namespace salt + AES-GCM) → transport manually. Machine B: Import → passphrase → validate `containerUuid` (warn on mismatch) → decrypt → import into IDB (existing entries not overwritten without confirm). **Default:** neither mode → machine-local (v0.8 behavior). **Account deletion:** server purges snapshots; local token cleared next boot. **Skill integrity:** after re-hydration/import, `runtimeDescribe()` re-verifies all signatures; a failed signature → `verified:false`, blocked (`skill_verification_failed`).

### Acceptance
Settings › Account hidden until `accountIdentity:true`; then shows Link / Export-Import. Link to a mock service → `rwa_account.token` non-empty. Export `{github-prod,api-key}` with passphrase → valid `rwa-vault-export/1`, `containerUuid` matches, ciphertext ≠ plaintext. Import on 2nd machine with passphrase → re-hydrates; `vault.get` returns original token. Wrong passphrase → `vault_decrypt_failed`/`account_export_malformed`. `containerUuid` mismatch → warning. Self-description `accountIdentity` live-only (static omits). Post-rehydration signature re-verify; failed → `verified:false`, blocked. Sync conflict → Keep Local / Replace / Cancel. Vault lock clears `rwa_account`. Passphrase/token never in logs/errors. Offline decrypt in airplane mode with only the export passphrase.

### Dependencies
Self-description/1 (live; extended live-only), vault bridge (export/import wraps idbPut/idbGet), skill verification (boot re-verify), settings panel UI (+ Account section), `settings.json` feature flag.

### Security
Leaked export file is encrypted (user-chosen passphrase, PBKDF2-200k; entropy is the user's responsibility — UI guidance). Account-token leakage (XSS/extension) bounded by short lifetime (cleared on lock/tab-close) + no log exposure. Untrusted-server snapshot integrity: AES-GCM auth tag fails on modification; replay detected by local/server hash comparison (Shape B — user decides which to trust). Cross-machine skill tampering caught by boot signature re-verify (`verified:false`, blocked). Export-format injection mitigated by version-gated validation (`account_export_malformed`). **Ceiling (Shape B):** an account operator/token holder can exfiltrate encrypted snapshots (can't decrypt without the passphrase) or DoS sync — no runtime defense; escrow requires *trust* in the provider (honestly disclosed). Export mode (offline) and default (machine-local) incur no service trust. Invariant 1 + 19 held (lazy account shim; runtime stays sole zone writer).

### New invariants (as drafted)
- **21** — Machine-local vault is the default; account-linking is strictly opt-in (feature-flag + explicit action).
- **22** — Portable exports are self-contained + version-tagged (`rwa-vault-export/1`); forward-compatible (unknown fields ignored).
- **23** — Passphrase entropy is not runtime-managed (UI guidance only; PBKDF2-200k applied uniformly).
- **24** — Account token is volatile (sessionStorage-only); escrow re-authentication is required per tab load (bounds theft window).

### Effort
M — export/import ~200 LOC (schema validation, per-namespace encryption, file I/O); escrow adds account-auth UI (~150) + a mock-server harness (~200, deferrable); self-description extension ~30. Main effort is design coherence + edge-case testing (conflicts, malformed exports, retry limits). No new crypto.

### Open questions
Ship a mock account service for v0.9 e2e, or defer escrow e2e to v1 (only export/import proven in v0.9)? Escrow sync direction (one-way / last-write-wins / per-namespace)? Export-and-keep-local vs export-only? On account deletion, auto-clear escrow-linked entries or manual? OAuth vs email/password (out of scope for v0.9 harness)? self-description `synced` boolean vs `lastSync` only?

---

## §15 New invariants (21+) — consolidated & deduped

The per-item lists above are drafted independently and collide on numbers. The following is the **normative, renumbered, deduped** v0.9 invariant set, continuing from v0.8's 1–20. Each carries its owning item(s).

### Permission tiers & per-call gating
- **21** *(I1)* — A skill MUST NOT reach a `bus:` topic outside its declared permissions; the main-thread per-call gate is the sole enforcement (no Worker exemption).
- **22** *(I1)* — Reserved bus prefixes (`rwa_`, `skills:`, `workspace:`) MUST NOT be enrolled in skill permissions (`invalid_permission` at install).
- **23** *(I1)* — A skill-published bus message MUST NOT exceed 65536 bytes (structured-clone encoded; `bus_error`).
- **24** *(I1)* — Bus messages are unencrypted and origin-bound; receiver-side filtering is the application's responsibility.
- **25** *(I3)* — `fsa:` reaches OPFS only via the bridged proxy; the main thread enforces a per-call scope check (scope validated at install, resolved path at invoke) before any OPFS op; no skill receives a raw `FileSystem*Handle`; errors are a closed vocabulary.
- **26** *(I3, I4)* — Scoped tiers are left-anchored and wildcard-free: `fsa:<scope>` is a relative-path prefix; `idb:<store>` is an exact store name (extends Invariant 17).
- **27** *(I4)* — `idb:` names a non-reserved, non-vault store (rejects `rwa_*`, `rwa_vault`, wildcards at install); `bridge:idb` is gated per-call by `_skIdbAllowed`.
- **28** *(I4)* — `idb:` permissions do not auto-create stores; a missing store fails with `ObjectStoreError` surfaced to the skill.
- **29** *(I3, I4, I8)* — Compute is zero-capability and may declare no permission tier (`fsa:`/`idb:`/`network:`/`vault:`/`hook:` beyond its own kind grammar); unsigned tools declaring a capability tier are rejected (tightens Invariant 20).
- **30** *(I8)* — `hook:<event>` is a disjoint, compute-only tier (`event ∈ {on-commit, on-open, on-mode-change}`, exact-match, no wildcards; unknown events → `unknown_permission_tier`).

### Execution model
- **31** *(I8)* — Re-entrancy guard: a hook's own modify/commit does not re-fire its own event.
- **32** *(I8)* — `on-commit`/`on-mode-change` hooks are fire-and-forget (never block the emit); `on-open` is blocking but its errors never stop the bootstrap. Every firing is logged to `rwa_hook_log`.
- **33** *(I2)* — Only compute skills may be pooled; tools always spawn fresh; pooling is opt-in and disabled by default. A pooled Worker keeps a unique, isolated per-invocation identity_tag; its lifetime is bounded by idle timeout (≥60s) and a concurrency cap (≤hardwareConcurrency); a code-hash change invalidates the pool immediately; it remains zero-capability under the worker-scoped CSP.

### DOM-authoring skills (I7)
- **34** *(I7)* — view/edit-surface skills are zero-capability (`permissions:[]`; non-empty rejected at install; no fetch/vault bridge).
- **35** *(I7)* — An edit-surface transform mutates only its declared region(s); every byte outside is identical before/after; touching a frozen zone or out-of-region body is rejected.
- **36** *(I7)* — A view skill's output is deterministic and HTML-shaped (`Promise<string>`, sanitized — no `<script>`/reserved ids — before DOM application).

### Trust anchor, identity & distribution (I5, I6, I10, I11, I12)
- **37** *(I5, I6, I12)* — Author/agent identity is anchored on the public key (and Unicode skeleton, RFC 7954, for names), never an ASCII name string. Skeleton ≤1 vs a different author blocks (`lookalike_skeleton_blocked`); same-author renames are traced via per-author append-only `name_history` (IDB, rebuilt at boot from in-file manifests).
- **38** *(I10, I11)* — Permission escalation on update requires explicit re-affirmation: the seed dialog shows added/removed prose diffs; the CLI `--yes` is the offline review signal. Unchanged-perm updates MAY use a lightweight affirmation. The diff is a case-sensitive, order-invariant string set difference.
- **39** *(I11)* — The CLI install path is the sole audited exception to runtime-sole-writer (Invariant 19): it writes the identical zone form, deterministically sorted by skillId (reproducible bytes), and gates identically to the seed (same error codes). The seed re-verifies every signature at boot.
- **40** *(I6)* — Indexed skills carry canonical Ed25519 manifest‖code signatures; unsigned tools MUST NOT be indexed; unsigned compute MAY be (`verified=false`). The index is a read-only projection; the per-container frozen zone is the durable artifact; revocation is permanent, author-signed (`REVOKE:||skillId||timestamp`), and does not auto-remove existing installs.
- **41** *(I12)* — Every installed agent is role-scoped and author-identified (same role from different authors coexist by pubkey; no anonymous action). Agent vault namespaces are precise (per-call bridge check, no runtime widening); agent system prompts are isolated per role and swap atomically. The `rwa-agents` zone is runtime-sole-written (extends Invariant 19), co-committed atomically with `rwa-skills`.

### Vault & portability (I9, I13)
- **42** *(I9)* — The vault record is versioned via `kdf_version` (0=PBKDF2-200k, 1=Argon2id; missing→0; unknown→`vault_unknown_kdf_version`, no silent downgrade). New vaults default to the latest version; existing vaults stay until explicit migration.
- **43** *(I9)* — KDF-migration re-encryption is atomic w.r.t. IDB persistence (all-or-none; no observable partial state). Argon2id params are fixed across all v0.9 instances (m=64 MiB, t=3, p=4, 256-bit) with no per-record metadata.
- **44** *(I9)* — The Argon2id implementation is single-file, vendored, embedded (base64/`data:`), never fetched; the static frozen CSP is unchanged (any required directive must already be present — Invariant 18 holds).
- **45** *(I13)* — Machine-local vault is the default; account-linking is strictly opt-in (feature-flag + explicit action); the account token is volatile (sessionStorage-only, re-auth per tab load); the escrow server is never a trust anchor (re-hydration requires passphrase **and** token).
- **46** *(I13)* — Portable vault exports are self-contained, version-tagged (`rwa-vault-export/1`), offline-decryptable, and forward-compatible (unknown fields ignored); passphrase entropy is not runtime-managed (UI guidance only).

---

## §16 Consolidated v0.9 acceptance

A v0.9 build is conformant when, on a real `rwa new --kind skill-host` container (and the CLI/service where noted), the following hold per item. (Per-item acceptance lists in §2–§14 are normative in full; this is the cross-item checklist.)

- **I10** — Update with `+perm` shows an Added prose diff + escalation button text + persists only on explicit affirm; downgrade shows Removed; unchanged-perm update offers a lightweight button; unknown added tier is rejected pre-dialog; double-pick re-shows the diff (no silent re-escalation).
- **I11** — `rwa install` exits 0 for signed/unsigned-compute (with `--yes`), 1 without `--yes`, 2 for file/kind errors, 3 for every gate (`unsigned_capability`/`compute_with_permissions`/`dynamic_import_forbidden`/`tampered_signature`/…); the zone is deterministically skillId-sorted, written atomically, re-parsed for durability; lookalike warns without blocking; `--json` emits one line.
- **I5** — Skeleton ≤1 vs a different author blocks; same-author rename surfaces name_history; ASCII Levenshtein still warns; IDB-cleared reload rebuilds `rwa_sources` from bytes; unsigned homoglyph warns without block.
- **I1** — Signed skill publishes/subscribes only to declared `bus:` topics (`bus_topic_denied` otherwise); unsigned+`bus:` rejected; `bus:`+`vault:` compound callout; reserved-prefix topic rejected `invalid_permission`; >64 KiB message rejected.
- **I3** — `fsa:data` reads `data/*`; `../` escape → `fs_path_denied`; no-`fsa:` call denied; compute+`fsa:` → `compute_with_permissions`; `file://` Chromium → `fs_unsupported`; quota → `fs_quota_exceeded`.
- **I4** — `idb:cache` reaches only `cache` (`idb_store_denied` otherwise); `rwa_*`/`rwa_vault`/wildcard rejected at install; compute has no `runtime.idb`; no auto-create.
- **I7** — view skill activates (validated HTML, idempotent, ⌘Z-reversible); edit-surface transform applies region-only via region-commit (one undo, frozen zones untouched); `permissions:[]` enforced; capability-scan rejects `eval`/`import()`; cross-machine re-verify.
- **I8** — Signed hook fires fire-and-forget on its declared event (deterministic skillId order), commit returns immediately, throwing hook logged not propagated, own-event re-entrancy blocked, on-open blocking, unknown event/extra tier rejected, uninstall stops firing.
- **I2** — Pooled compute reuses a warm Worker with no state leak, respects the cap, evicts on idle/code-change/error, drains on shutdown (≤500ms grace); tools always fresh; pooling disabled by default.
- **I6** — Publish→index (≤10s)→client WebCrypto verify→TOFU dialog (fingerprint + install count)→frozen-zone install→invoke; revoked → 410 + invoke warning; report queued without auto-block; `installations_visible` never enumerates containers.
- **I12** — Signed agents register + report (4-site); `setActive(role)` keys the prompt + actor; `invokeSkill({agentRole})` enforces the vault namespace set; bus request/response correlates by id across roles; unsigned/injection-prompt agents rejected; cross-machine re-verify gates `setActive`.
- **I9** — v0.8 vault unlocks unchanged; `{targetKdfVersion:1}` migrates atomically + measurably (~50–100 ms Argon2id); new vaults default to v1; `kdf_version:99` → `vault_unknown_kdf_version`; CSP unchanged; WASM embedded.
- **I13** — Account section hidden until flagged; export → valid `rwa-vault-export/1` (ciphertext ≠ plaintext) → import on a 2nd machine re-hydrates; wrong passphrase fails cleanly; `containerUuid` mismatch warns; `accountIdentity` is live-only; post-rehydration signature re-verify blocks tampered skills; passphrase/token never logged; offline decrypt works.

---

*v0.9 takes the thirteen lines v0.8 §11 deferred and turns each into a liftable normative contract — three new permission tiers (`bus:`/`fsa:`/`idb:`) and two new kinds (`view`/`edit-surface`, `hook`) that all ride the proven network/vault per-call gate and the region-commit safe channel; a worker pool, a confusables-sharpened install anchor, a CLI install verb, a signed-skill index with TOFU + revocation, multi-agent roles over the bus, a memory-hard Argon2id KDF, and an opt-in portable identity — every one of them additive to v0.8, none of them lifting the Shape B ceiling, and all of them gated on a draft awaiting prioritization and ratification.*
