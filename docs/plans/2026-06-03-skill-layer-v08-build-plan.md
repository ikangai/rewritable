# Skill layer v0.8 — build order (TDD, dependency-sequenced)

Spec: `docs/specs/re-write-able-actions-spec-v0.8.md`. Built on branch `feat/skill-layer-v08`
(worktree `.worktrees/skill-layer-v08`, off `main`). TDD throughout. Seed-free increments first
(additive, collision-free on a shared merge); seed edits are **coordinated** with dirac/kepler.

## Increments

1. **[DONE — `00ebee9`] skill-manifest foundation** — `cli/src/skill-manifest.mjs` + test (17/17).
   skillId, canonicalManifest, signingMessage, parsePermission (grammar), validateInstall (gates),
   verifyEnvelope (Ed25519). Seed-free. The seed will mirror this in JS (WebCrypto identical).

2. **[DONE — `02b7103`, sync `7dec6b2`] parseSkillZone** — `cli/src/skill-manifest.mjs` parses base64(JSON(envelope))
   `<script>` blocks from ONLY the frozen `#rwa-skills` div, re-verifies, returns
   `[{skillId,kind,name,verified,provenance:'installed'}]`. Security: a skill `<script>` outside the zone is
   ignored. Made synchronous (node:crypto Ed25519) so it slots into the sync projection. skill-zone 8/8.

3. **[DONE — `ad04061`] self-description union (4-site)** — `computeSelfDescription` (oracle) AND
   `buildSelfDescription` (CLI mirror) union first-party affordances with `parseSkillZone(doc)`; both IMPORT
   the single `parseSkillZone` from `cli/src/skill-manifest.mjs` (the oracle already imports from cli/src) →
   no duplication, deep-equal pin holds. Explicit `KIND_PROVIDERS['skill-host']=[]` both sites. `rwa doc --json`
   reports installed skills, agrees with the oracle (SD-04). Full cli + oracle suites green.

4. **[DONE — `26aee84`] `skill-host` PRODUCT_KIND** — `KIND_TABLE` entry (`cli/src/seed.mjs`) + help/README.
   INLINE_DOC stub: intro article + empty `<div data-rwa-frozen id="rwa-skills"></div>`. **CLI-only/additive**
   (no seed edit — `SYSTEM_PROMPTS['skill-host']` deferred to the document fallback / the seed slice). `rwa new
   --kind skill-host` + `rwa doc` (kind:'skill-host', [] affordances) green. ⇐ end of the additive, mergeable foundation.

5. **[DONE — see commit] Seed runtime: registry + describe union — `installedSkills` Map, `runtime.installSkill/uninstall/
   invoke/listSkills`; `runtimeProvide` accept `'tool'`; `runtimeDescribe` add `'tool'` + union installed
   skills. Mirror the skill-manifest logic into the seed. **SEED EDIT.** Tests: `tests/` (jsdom) +
   re-pin the 4-site mirror tests.

6. **[DONE — browser-proven] Worker spawn & bridge (§5a)** — blob Worker, synchronous global removal (Object.defineProperty
   non-writable undefined ×10), bridged `fetch`/`vault` w/ `identity_tag`, `Promise.race` 5s + terminate.
   Bridgeless for compute. **SEED EDIT.** **Browser-tested** (chrome-devtools): assert a compute Worker
   cannot read sessionStorage/IDB/document (Invariant 18 / §12.4), and fetch allowed/denied (§12.3).

7. Split into 7a (persistence — the gated piece) and 7b (CSP — independent backstop):
   - **7a. [DONE — browser-proven] registry-aware persistence (§7)** — `buildSkillZone(installedSkills)`
     (canonical, sorted by skillId) + `runtimeInstallSkill`/`uninstallSkill` persist the frozen `#rwa-skills`
     zone via dirac's **`runtimeRegionCommit`** (`reachability:'frozen'`) at INSTALL time (durable in IDB before
     ⌘S; `commit()` unchanged). Boot-parse aligned to utf-8 base64 (matches CLI `parseSkillZone`); records keep
     the full envelope. Inv 19a/19b upheld by the primitive (scoped bypass + post-commit re-frozen re-assert).
     `tests/skill-persistence` 12/0 + **browser-proven**: install → real page reload → skill still listed +
     verified (IDB round-trip). v0.8 §7 + Inv 19b updated to reference the primitive.
   - **7b. CSP boot-inject (§7)** — boot: union *signed* skills' `network:` origins → inject `<meta>`
     connect-src into `<head>` before any skill runs. **Ungated** (no primitive needed). CARE: the union must
     also include the agent-backend origins (openrouter/ollama/lmstudio/bridge) or it breaks ⌘K — browser-test
     both (agent fetch still works WITH CSP; a skill's undeclared origin blocked as a 2nd wall behind the bridge).

8. **[DONE — `12b297d`, browser-proven] Vault (§6)** — PBKDF2-200k/AES-GCM, IDB `rwa_vault`, namespaces,
   session key in sessionStorage, error vocab (`null`/`vault_locked`/`vault_namespace_denied`/
   `vault_bad_passphrase`/`vault_decrypt_failed`/storage). bridge:vault per-skill namespace gate. **SEED EDIT.**
   `tests/vault` 16/0 + browser (tool skill set/get its declared ns; undeclared→`vault_namespace_denied`).

9. **[DONE — browser-proven] Install dialog + scan + provenance (§1/§3.5)** — `runtime.reviewSkill`
   (structured trust info) + `runtime.installSkill` (gates + Ed25519 verify + register in-memory) +
   `showInstallDialog`/`promptInstall` + the consent DOM with normative prose, permission→prose,
   capability-scan note, compound-risk callout, lookalike (Levenshtein≤2), the "can vs should" framing,
   plus an "Install a skill…" trigger in the skill-host starter body. **SEED EDIT + UI + cli helpers.**
   `tests/skill-install` 13/0 + browser-verified (dialog renders all sections; affirm→install→worker runs).
   **DEFERRED:** update-diff + re-affirm flow; `rwa_sources`-at-boot (lookalike currently scans the live
   `installedSkills`); persistence of installs to the frozen zone is increment 7 (gated on dirac).

10. **[DONE — browser-proven] MVP acceptance (§12)** — the 7-step end-to-end run in real Chrome on a
    generated `skill-host` with word-count (unsigned compute) + gh-stars (signed, `network:api.github.com`):
    1 install unsigned compute (verified:false) ✓ · 2 install signed tool (verified:true) ✓ · 3 invoke
    gh-stars → `api.github.com` **200**, `evil.com` **permission_denied** (bridge) ✓ · 4 invoke word-count
    bridgeless → `{words:N}` ✓ · 5 update gh-stars (+`network:tracker.y`) → same skillId, persisted new perms ✓ ·
    6 uninstall → reload → gone, compute survives ✓ · 7 2nd machine (no session key) → vault **locked**, secret
    **null**, signed skill re-verifies from bytes ✓. Codified as `tests/skill-mvp` 7/0 (jsdom steps 1,2,5,6;
    steps 3/4/7 are browser-only and browser-proven). **DEFERRED (not MVP-blocking):** the CSP half of §12.2/3/6
    (increment 7b — defense-in-depth behind the proven bridge wall); the §12.5 prose-diff *dialog* (mechanism
    proven, Shape-C UI deferred from incr 9).

## Coordination
- Incrs 1–3 are additive (new files + mirrors) → land on `main` via explicit-path commits anytime.
- Incrs 4–9 edit `seeds/rewritable.html` (and `cli/src/seed.mjs`) — the hot, shared files. Sequence one-at-a-time
  with dirac/kepler; the **runtime-owned-region commit primitive (incr 7)** is shared with kepler's skinning v2
  — design it once, both ride it. Announce each seed edit in the group chat before it lands.
- Merge `feat/skill-layer-v08` → `main` per the shared-tree protocol when an increment is green.
