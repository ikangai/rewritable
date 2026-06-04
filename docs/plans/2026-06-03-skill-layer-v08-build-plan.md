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

7. **CSP boot-inject + registry-aware commit (§7)** — boot: union signed skills' `network:` → inject
   `<meta>` connect-src into `<head>`. Commit: `buildSkillZone(installedSkills)` before `buildFile`
   (the runtime-owned-region rewrite; Inv 19a/19b). **SEED EDIT + the SHARED "runtime-owned-region commit"
   primitive with kepler — write the mini-spec with dirac first** (kepler's skin compose-then-commit == this).

8. **Vault (§6)** — PBKDF2-200k/AES-GCM, IDB `rwa_vault`, namespaces, session key in sessionStorage,
   error vocab (`null`/`vault_locked`/`vault_namespace_denied`/`vault_decrypt_failed`/quota/storage). **SEED EDIT.**

9. **Install dialog + scan + provenance (§1/§3.5)** — the dialog (kept from v0.7) with the normative prose,
   capability-scan note, compound callout, lookalike (Levenshtein≤2, `rwa_sources` rebuilt at boot), update
   diff + re-affirm. **SEED EDIT + UI.**

10. **MVP acceptance (§12)** — the 7-step end-to-end in real Chrome on a generated `skill-host`:
    word-count (compute) + gh-stars (network, Worker-isolated) → install/invoke/update/uninstall/email.

## Coordination
- Incrs 1–3 are additive (new files + mirrors) → land on `main` via explicit-path commits anytime.
- Incrs 4–9 edit `seeds/rewritable.html` (and `cli/src/seed.mjs`) — the hot, shared files. Sequence one-at-a-time
  with dirac/kepler; the **runtime-owned-region commit primitive (incr 7)** is shared with kepler's skinning v2
  — design it once, both ride it. Announce each seed edit in the group chat before it lands.
- Merge `feat/skill-layer-v08` → `main` per the shared-tree protocol when an increment is green.
