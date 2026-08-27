// Foundational skill-manifest logic for the v0.8 skill layer.
// Spec: docs/specs/re-write-able-actions-spec-v0.8.md §3 (skillId, signature, install gates), §4 (permission grammar), §8 (parseSkillZone).
// SYNCHRONOUS (node:crypto) so it slots into the sync self-description projection without rippling
// async through the deep-equal-pinned 4-site mirror. The seed mirrors this LOGIC with async WebCrypto,
// caching `verified` at boot so its sync describe() reports the cached result. No external deps.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

const enc = new TextEncoder();
const NUL = Buffer.from([0]);
// SPKI DER prefix for an Ed25519 public key (wraps a raw 32-byte key into a KeyObject-importable form).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/** §3.2 skillId = base64url(sha256(name ‖ 0x00 ‖ author_pubkey)). */
export function skillId(name, authorPubkey) {
  return sha256(Buffer.concat([Buffer.from(enc.encode(String(name))), NUL, Buffer.from(enc.encode(String(authorPubkey)))]))
    .toString('base64url');
}

/** §3.3 canonical manifest: stable-key-ordered over the signed fields; excludes signature + code. */
export function canonicalManifest(manifest) {
  const m = manifest || {};
  return JSON.stringify({
    author_pubkey: m.author_pubkey ?? null,
    kind: m.kind ?? null,
    name: m.name ?? null,
    permissions: Array.isArray(m.permissions) ? m.permissions : [],
    version: m.version ?? null,
  });
}

/** §3.3 signing message bytes = sha256(canonicalManifest ‖ 0x00 ‖ code). */
export function signingMessage(manifest, code) {
  return sha256(Buffer.concat([Buffer.from(enc.encode(canonicalManifest(manifest))), NUL, Buffer.from(enc.encode(String(code ?? '')))]));
}

const VAULT_NS = /^[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?$/;

/** §4 permission grammar — the two shipped tiers (network:, vault:). Throws on invalid/unknown. */
export function parsePermission(p) {
  const s = String(p);
  const i = s.indexOf(':');
  if (i < 0) throw new Error(`invalid permission (no tier): ${s}`);
  const tier = s.slice(0, i);
  const value = s.slice(i + 1);
  if (tier === 'network') {
    if (value === '*') return { tier, value };
    if (value.startsWith('**.') || value.startsWith('*.')) {
      if (value.slice(value.indexOf('.') + 1).includes('*')) throw new Error(`invalid network pattern: ${value}`);
      return { tier, value };
    }
    if (value.includes('*')) throw new Error(`invalid network pattern (left-unanchored wildcard): ${value}`);
    if (!value) throw new Error('invalid network pattern (empty)');
    return { tier, value };
  }
  if (tier === 'vault') {
    if (value.length > 64 || !VAULT_NS.test(value)) throw new Error(`invalid vault namespace: ${value}`);
    return { tier, value };
  }
  if (tier === 'bus') {
    // §5 (I1): topic 1–96 chars, must start alphanumeric, charset [A-Za-z0-9:_./%-], and NOT
    // a runtime-reserved prefix (rwa_/rwa:/skills:/workspace: are the substrate's own channels).
    if (!value || value.length > 96 || !/^[A-Za-z0-9][A-Za-z0-9:_./%-]*$/.test(value) || /^(?:rwa[:_]|skills:|workspace:)/.test(value))
      throw new Error(`invalid bus topic: ${value}`);
    return { tier, value };
  }
  if (tier === 'fsa') {
    // §6 (I3): relative OPFS scope — lowercase [a-z0-9_/-], start+end alphanumeric/underscore,
    // ≤128 chars, no leading/trailing slash, no '.'/'..' (excluded by charset), not _rwa/-prefixed.
    if (!value || value.length > 128 || /^_rwa(?:\/|$)/.test(value) || !/^[a-z0-9_](?:[a-z0-9_/-]*[a-z0-9_])?$/.test(value))
      throw new Error(`invalid fsa scope: ${value}`);
    return { tier, value };
  }
  if (tier === 'idb') {
    // §7 (I4): store name ^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$ (≤64 octets, no wildcards); never a
    // reserved rwa_* store, and never the vault store — distinct subcodes so the dialog can explain.
    if (/^rwa_/.test(value)) throw new Error(value === 'rwa_vault' ? 'idb_vault_store_forbidden' : 'idb_reserved_store');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(value)) throw new Error(`invalid idb store: ${value}`);
    return { tier, value };
  }
  if (tier === 'hook') {
    // §9 (I8): lifecycle event, exact-match enum, no wildcards. An UNKNOWN event is treated as an
    // unknown tier (unknown_permission_tier) per the spec, so install rejects it the same way.
    if (value === 'on-commit' || value === 'on-open' || value === 'on-mode-change') return { tier, value };
    throw new Error(`unknown_permission_tier: hook event ${value}`);
  }
  throw new Error(`unknown_permission_tier: ${tier}`);
}

/** §4/§5a — does a `network:` host pattern admit a request host? The bridge's per-call
 *  enforcement (mirrored verbatim in the seed). Left-anchored: `*.` = one label, `**.` =
 *  base + any depth, `*` = catch-all, else exact. Validate the pattern with parsePermission first. */
export function matchNetworkOrigin(pattern, host) {
  if (pattern === '*') return true;
  if (pattern.startsWith('**.')) {
    const base = pattern.slice(3);
    return host === base || host.endsWith('.' + base);
  }
  if (pattern.startsWith('*.')) {
    const label = pattern.slice(2);
    if (!host.endsWith('.' + label)) return false;
    const prefix = host.slice(0, host.length - label.length - 1);
    return prefix.length > 0 && !prefix.includes('.'); // exactly one label
  }
  return host === pattern;
}

/** §6 — does a skill's permission set grant a vault namespace? Exact vault:<ns> match.
 *  Pure; the bridge's per-call vault gate (mirrored in the seed). */
export function vaultNamespaceAllowed(permissions, ns) {
  const perms = Array.isArray(permissions) ? permissions : [];
  return perms.indexOf('vault:' + ns) !== -1;
}

/** §1/§3 — render one permission as plain-English dialog prose (the trust-anchor content). */
export function permissionToProse(perm) {
  const s = String(perm);
  if (s.startsWith('network:')) {
    const v = s.slice(8);
    if (v === '*') return 'Make network requests to ANY domain on the internet — the runtime cannot tell you where this skill sends data. Review the code carefully.';
    if (v.startsWith('**.')) return `Make network requests to ${v.slice(3)} and any subdomain at any depth — broad; review whether the skill needs this.`;
    if (v.startsWith('*.')) return `Make network requests to any direct subdomain of ${v.slice(2)} (such as api.${v.slice(2)}).`;
    return `Make network requests to ${v}.`;
  }
  if (s.startsWith('vault:')) {
    const v = s.slice(6);
    if (v === '*') return 'Read and write credentials stored under ANY vault namespace — every credential you have stored. Use only for vault administration.';
    return `Read and write credentials stored under \`${v}\`.`;
  }
  if (s.startsWith('bus:')) {
    return `Send and receive messages on the \`${s.slice(4)}\` channel shared with other rewritables on this machine.`;
  }
  if (s.startsWith('fsa:')) {
    return `Read and write files under \`${s.slice(4)}\` in this document's private storage.`;
  }
  if (s.startsWith('idb:')) {
    return `Read and write the \`${s.slice(4)}\` data store in this document's database.`;
  }
  if (s.startsWith('hook:')) {
    const ev = s.slice(5);
    const when = ev === 'on-commit' ? 'every time the document is saved' : ev === 'on-open' ? 'every time the document opens' : ev === 'on-mode-change' ? 'every time you switch modes' : ev;
    return `Run automatically ${when} (no network or credential access).`;
  }
  return s;
}

/** §3.7/E — the compound-risk callout when vault + network co-occur, else null. */
export function compoundRisk(permissions) {
  const perms = Array.isArray(permissions) ? permissions : [];
  const has = (t) => perms.some(p => String(p).startsWith(t + ':'));
  const hasVault = has('vault'), hasNetwork = has('network'), hasBus = has('bus'), hasFsa = has('fsa'), hasIdb = has('idb');
  if (hasVault && hasNetwork) return 'This skill can both read your stored credentials AND make network requests. A skill with this combination can send credentials to its allowed destination — intentionally or by mistake. Install only if you fully trust this author.';
  if (hasBus && (hasVault || hasNetwork)) return `This skill can message other rewritables on this machine AND ${hasVault ? 'read your stored credentials' : 'make network requests'}. Together these let it coordinate a multi-step action across your workspace — intentionally or by mistake. Install only if you fully trust this author.`;
  if ((hasFsa || hasIdb) && (hasNetwork || hasVault || hasBus)) {
    const store = hasFsa ? 'read and write files in this document' : 'read and write this document\'s stored data';
    const sink = hasNetwork ? 'make network requests' : hasVault ? 'read your stored credentials' : 'message other rewritables on this machine';
    return `This skill can ${store} AND ${sink}. Together these let it move your local data off this document — intentionally or by mistake. Install only if you fully trust this author.`;
  }
  return null;
}

/** §3/§4.1 — advisory capability-scan notes (NEVER an auto-reject; structural enforcement is the wall). */
export function capabilityScan(code) {
  const c = String(code || '');
  const notes = [];
  if (/\beval\s*\(/.test(c)) notes.push('Uses eval() — dynamic code execution. Review what is being evaluated.');
  if (/\bFunction\s*\(/.test(c)) notes.push('Uses the Function constructor — dynamic code execution. Review what is being constructed.');
  if (/\b(setTimeout|setInterval)\s*\(\s*['"`]/.test(c)) notes.push('Calls setTimeout/setInterval with a string argument — review what is being scheduled.');
  if (/\b(globalThis|self|window)\s*\[/.test(c)) notes.push('Uses dynamic property indexing on a global — can reach APIs the permission manifest does not constrain. Review the code.');
  if (/\bimport\s*\(/.test(c)) notes.push('Uses dynamic import() — can load remote code and reach the network outside the permission manifest.');
  return notes;
}

/** Levenshtein edit distance (Wagner-Fischer) — for §2.3 lookalike-source detection. */
export function levenshtein(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// I5 (v0.9 §4) — Unicode-confusable skeleton. NFKC + toLowerCase fold case, fullwidth forms,
// ligatures, and mathematical-alphanumeric letters to ASCII; this baked table folds the
// CROSS-SCRIPT homoglyphs NFKC leaves alone (Cyrillic, Greek, Armenian, a few Latin-extended).
// Deliberately CURATED, not the full UTS #39 confusables.txt: every entry maps a non-ASCII
// glyph that renders ~identically to an ASCII letter. ASCII→ASCII is NEVER folded (so legit
// distinct names like "tool"/"toml" stay distinct — no false collisions). Extensible: add a row.
// Keys are post-NFKC-lowercase codepoints. Mirror of the seed's _SK_CONFUSABLES.
const CONFUSABLES = {
  // Cyrillic → Latin
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
  'у': 'y', 'х': 'x', 'к': 'k', 'ѕ': 's', 'і': 'i',
  'ј': 'j', 'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w',
  'ѵ': 'v', 'ӏ': 'l', 'ɠ': 'g',
  // Greek → Latin
  'α': 'a', 'ο': 'o', 'ρ': 'p', 'ε': 'e', 'ι': 'i',
  'κ': 'k', 'ν': 'v', 'υ': 'u', 'χ': 'x', 'τ': 't',
  'ϲ': 'c', 'ϳ': 'j',
  // Armenian → Latin
  'օ': 'o', 'ո': 'n',
  // Latin-extended / IPA homoglyphs NFKC leaves alone
  'ı': 'i', 'ɑ': 'a', 'ɡ': 'g',
};

/** NFKC-fold + lowercase a name before any lookalike comparison (UTS #36). */
export function normalizeName(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase();
}

/** Confusable skeleton: normalize, then map each homoglyph to its ASCII prototype.
 *  Two names with an equal skeleton render identically to a human (the trust-anchor risk). */
export function skeleton(s) {
  let out = '';
  for (const ch of normalizeName(s)) out += (CONFUSABLES[ch] || ch);
  return out;
}

/** Edit distance between two names' skeletons. 0 = perfect homoglyph; ≤1 = homoglyph + one typo. */
export function skeletonDistance(a, b) {
  return levenshtein(skeleton(a), skeleton(b));
}

// ── I12 (v0.9 §12) — rwa-agent/1: a role-scoped, signed agent identity (role + system_prompt +
// vault_namespace_set; NO code field). Parallels the skill canon; the seed mirrors this logic.
const ROLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/; // ≤64, lowercase a-z0-9-_, leading alphanumeric

/** Canonical agent manifest: stable-key-ordered over the signed fields; excludes the signature. */
// Canonical agent manifest: stable-key-ordered over the signed fields; excludes
// the signature.
//
// #45 — VERSIONED. `version` is itself a signed field, so a v1 and a v2 record
// already sign structurally different messages; branching here therefore extends
// the canon with NO migration: every existing `rwa-agent/1` record keeps
// verifying byte-unchanged, forever.
//
// Each version is written out in full rather than spread from a shared base.
// The duplication is deliberate: the canon is mirrored byte-for-byte into
// service/public/ai/maker.html, and a canon that silently disagrees between
// signer and verifier is the worst failure available here — signatures that
// verify in one place and not the other, with no error to read. An explicit,
// independently-readable object per version is what makes that mirror auditable.
// Keys stay alphabetical in both branches.
function canonicalReferences(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.map((r) => ({ content: (r && r.content) ?? null, name: (r && r.name) ?? null }));
}
export function canonicalAgent(a) {
  a = a || {};
  if (a.version === 'rwa-agent/2') {
    return JSON.stringify({
      author_pubkey: a.author_pubkey ?? null,
      description: a.description ?? null,
      references: canonicalReferences(a.references),
      role: a.role ?? null,
      system_prompt: a.system_prompt ?? null,
      vault_namespace_set: Array.isArray(a.vault_namespace_set) ? a.vault_namespace_set : [],
      version: a.version ?? null,
    });
  }
  return JSON.stringify({
    author_pubkey: a.author_pubkey ?? null,
    description: a.description ?? null,
    role: a.role ?? null,
    system_prompt: a.system_prompt ?? null,
    vault_namespace_set: Array.isArray(a.vault_namespace_set) ? a.vault_namespace_set : [],
    version: a.version ?? null,
  });
}

/** Agent signing message bytes = sha256(canonicalAgent). Agents have no code field. */
export function agentSigningMessage(agent) {
  return sha256(Buffer.from(enc.encode(canonicalAgent(agent))));
}

/** agentId = base64url(sha256(role ‖ 0x00 ‖ author_pubkey)). Same role from different keys differ. */
export function agentId(role, authorPubkey) {
  return sha256(Buffer.concat([Buffer.from(enc.encode(String(role))), NUL, Buffer.from(enc.encode(String(authorPubkey)))]))
    .toString('base64url');
}

/** Ed25519 verify over agentSigningMessage. Mirrors verifyEnvelope; the seed uses async WebCrypto. */
export function verifyAgentEnvelope(envelope) {
  const sig = envelope && envelope.signature;
  if (!sig) return { signed: false, verified: false };
  const agent = envelope.agent || {};
  try {
    const raw = Buffer.from(agent.author_pubkey, 'base64');
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    const verified = edVerify(null, agentSigningMessage(agent), key, Buffer.from(sig, 'base64'));
    return { signed: true, verified: !!verified };
  } catch {
    return { signed: true, verified: false };
  }
}

// A system_prompt is a runtime literal — reject anything that could break out of the template or
// inject document markers (backtick, ${, <DOC>/<\/DOC>) → agent_prompt_injection_risk.
function agentPromptInjectionRisk(s) {
  const p = String(s ?? '');
  return p.includes('`') || p.includes('${') || /<\/?DOC>/i.test(p);
}


// #45 — carried-reference limits. The `#rwa-agents` zone lives INSIDE `INLINE_DOC`,
// so every carried byte counts against the container's own document budget
// (MAX_DOC, 1 MB on the virtualized form). A generous carrier can therefore crowd
// out the document it exists to help edit, and the failure surfaces late and
// confusingly — `target_size_exceeded` on an ordinary unrelated edit, with nothing
// pointing at the references as the cause. Enforce at authoring/install instead,
// where the message can name the real problem.
export const MAX_AGENT_REFERENCES = 16;
export const MAX_AGENT_REFERENCE_BYTES = 64 * 1024;   // ~6% of the 1 MB doc budget
// Reference names are labels, never paths: no separators, no traversal, no
// leading dot. They are only ever shown and matched, never opened.
const REFERENCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validate a v2 record's `references`. Returns an array of error codes.
 *
 * NOTE — content is NOT character-filtered, deliberately.
 *
 * `system_prompt` is screened by agentPromptInjectionRisk because it is
 * interpolated into a runtime template literal, where a backtick or `${` breaks
 * out. References are different on both counts: they are base64-encoded inside
 * the record (so they carry no syntactic hazard to the container at all), and
 * they are markdown — real Agent Skills references are FULL of backticks and
 * code fences. Applying the same screen would reject essentially every genuine
 * reference while buying nothing.
 *
 * What remains is SEMANTIC injection — text that tries to instruct the model
 * reading it. That is not solvable by a character blocklist; it is what the
 * signature and the consent gate are for, and what the provenance line already
 * frames. Do not "fix" this by adding a filter.
 *
 * The one hard requirement on consumers: a reference must be passed to a model
 * as DATA, never interpolated into a template literal.
 */
export function validateAgentReferences(refs) {
  const errors = [];
  if (refs == null) return errors;                    // absent is fine
  if (!Array.isArray(refs)) return ['invalid_reference'];
  if (refs.length > MAX_AGENT_REFERENCES) errors.push('too_many_references');
  let bytes = 0;
  for (const r of refs) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push('invalid_reference'); continue; }
    if (typeof r.name !== 'string' || !REFERENCE_NAME_RE.test(r.name)) errors.push('invalid_reference_name');
    if (typeof r.content !== 'string') { errors.push('invalid_reference'); continue; }
    bytes += Buffer.byteLength(r.content, 'utf8');
  }
  if (bytes > MAX_AGENT_REFERENCE_BYTES) errors.push('references_too_large');
  return [...new Set(errors)];
}

/** Total UTF-8 bytes of a record's carried references (0 when it has none). */
export function agentReferenceBytes(agent) {
  const refs = agent && agent.references;
  if (!Array.isArray(refs)) return 0;
  return refs.reduce((n, r) => n + (typeof r?.content === 'string' ? Buffer.byteLength(r.content, 'utf8') : 0), 0);
}

/** §12 agent install gates. Pure; takes the verification result so it stays synchronous. */
export function validateAgentInstall(envelope, { signed, verified } = {}) {
  const agent = (envelope && envelope.agent) || {};
  const errors = [];
  // A NUL in the role makes agentId(role‖0x00‖pubkey) ambiguous — reject (mirrors F8).
  if (/\0/.test(String(agent.role == null ? '' : agent.role))) errors.push('invalid_agent_id');
  if (typeof agent.role !== 'string' || !ROLE_RE.test(agent.role)) errors.push('invalid_role');
  // A missing/non-string OR injection-bearing prompt is rejected under the same gate.
  if (typeof agent.system_prompt !== 'string' || agentPromptInjectionRisk(agent.system_prompt)) errors.push('agent_prompt_injection_risk');
  const set = agent.vault_namespace_set;
  if (set != null && !Array.isArray(set)) errors.push('invalid_permission');
  for (const p of (Array.isArray(set) ? set : [])) {
    try {
      if (parsePermission(p).tier !== 'vault') errors.push('invalid_permission'); // vault_namespace_set is vault-only
    } catch (e) {
      errors.push(/unknown_permission_tier/.test(e.message) ? 'unknown_permission_tier' : 'invalid_permission');
    }
  }
  // #45 — references are a v2 field. A v1 record carrying them is rejected rather
  // than silently ignored: canonicalAgent does not sign them at v1, so accepting
  // one would mean honouring bytes the signature never covered.
  if (agent.references != null && agent.version !== 'rwa-agent/2') errors.push('references_require_v2');
  else errors.push(...validateAgentReferences(agent.references));
  if (!signed) errors.push('unsigned_agent'); // unsigned agents are rejected at install (verified gates activation)
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

// §12 inter-agent bus message: {type:'request'|'response', id, from_role, to_role, payload} on
// agents:* topics. Data-model only — the request→response choreography (wait/timeout) is the
// conductor's responsibility, correlated by `id` (the requester's UUID, echoed by the responder).
export function validateAgentMessage(m) {
  const errors = [];
  m = m || {};
  if (m.type !== 'request' && m.type !== 'response') errors.push('invalid_type');
  if (typeof m.id !== 'string' || !m.id) errors.push('invalid_id');
  if (typeof m.from_role !== 'string' || !ROLE_RE.test(m.from_role)) errors.push('invalid_from_role');
  if (typeof m.to_role !== 'string' || !ROLE_RE.test(m.to_role)) errors.push('invalid_to_role');
  if (!('payload' in m)) errors.push('missing_payload');
  return { ok: errors.length === 0, errors };
}

/** Build (and validate) an inter-agent bus message envelope. Throws invalid_agent_message if the
 *  shape is bad. The caller supplies the correlation id (a fresh UUID for a request; the request's
 *  id echoed for a response). */
export function agentMessage(type, fromRole, toRole, payload, id) {
  const m = { type, id, from_role: fromRole, to_role: toRole, payload };
  const v = validateAgentMessage(m);
  if (!v.ok) throw new Error('invalid_agent_message: ' + v.errors.join(','));
  return m;
}

/** §3.4 install gates. Pure; takes the verification result so it stays synchronous. */
export function validateInstall(envelope, { signed, verified } = {}) {
  const skill = (envelope && envelope.skill) || {};
  const perms = Array.isArray(skill.permissions) ? skill.permissions : [];
  const errors = [];
  // F9: reject a non-array permissions field rather than silently coercing to []
  // (the signing canon would normalize it to [] → confused-deputy signature).
  if (skill.permissions != null && !Array.isArray(skill.permissions)) errors.push('invalid_permission');
  // F8: a NUL in the name makes skillId(name‖0x00‖pubkey) ambiguous — reject it.
  if (/\0/.test(String(skill.name == null ? '' : skill.name))) errors.push('invalid_skill_id');
  for (const p of perms) {
    try { parsePermission(p); }
    catch (e) {
      const m = e.message;
      if (/unknown_permission_tier/.test(m)) errors.push('unknown_permission_tier');
      else if (m === 'idb_reserved_store' || m === 'idb_vault_store_forbidden') errors.push(m); // §7 distinct subcodes
      else errors.push('invalid_permission');
    }
  }
  if (skill.kind === 'compute' && perms.length > 0) errors.push('compute_with_permissions');
  // §9 (I8): a hook is compute-only — only hook:<event> perms are allowed; any other tier (a real
  // capability) is rejected as compute_with_permissions (no network/vault/escalation in a hook).
  if (skill.kind === 'hook' && perms.some((p) => { try { return parsePermission(p).tier !== 'hook'; } catch { return false; } })) errors.push('compute_with_permissions');
  // §8 (I7): view/edit-surface are zero-capability DOM authors — any permission is rejected (no
  // render→fetch encoding loop), and they MUST carry a matching typed output contract.
  if (skill.kind === 'view' || skill.kind === 'edit-surface') {
    if (perms.length > 0) errors.push('output_skill_with_permissions');
    const want = skill.kind === 'view' ? 'html-render' : 'dom-transform';
    if (!skill.output || skill.output.kind !== want) errors.push('invalid_output_kind');
  }
  if (!signed && perms.length > 0) errors.push('unsigned_with_permissions');
  // Tools AND hooks carry capability (a hook runs autonomously on events) → must be signed+verified.
  if ((skill.kind === 'tool' || skill.kind === 'hook') && !verified) errors.push('unsigned_capability');
  return { ok: errors.length === 0, errors };
}

/** §3.3 signature verification — Ed25519 over signingMessage(manifest‖code). Sync (node:crypto).
 *  Seed mirror uses async WebCrypto Ed25519 over the identical message; result is the same boolean. */
export function verifyEnvelope(envelope) {
  const sig = envelope && envelope.signature;
  if (!sig) return { signed: false, verified: false };
  const skill = envelope.skill || {};
  try {
    const raw = Buffer.from(skill.author_pubkey, 'base64');
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    const verified = edVerify(null, signingMessage(skill, skill.code), key, Buffer.from(sig, 'base64'));
    return { signed: true, verified: !!verified };
  } catch {
    return { signed: true, verified: false };
  }
}

/** Does an open tag carry `data-rwa-frozen` as a real attribute NAME (not a substring like
 *  data-rwa-frozen-note= or class="…data-rwa-frozen")? Mirrors the seed's tagHasFrozenAttr —
 *  trust-read MUST match the write-time frozen guard or a lookalike attribute forges trust. */
function tagHasFrozenAttr(openTag) {
  const am = /^<[a-zA-Z][a-zA-Z0-9]*((?:\s[^>]*)?)\/?>$/.exec(openTag);
  if (!am) return false;
  const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  let a;
  while ((a = attrRe.exec(am[1])) !== null) if (a[1] === 'data-rwa-frozen') return true;
  return false;
}

/** Locate the inner HTML of the agent-unreachable `<div data-rwa-frozen id="rwa-skills">` zone.
 *  Only this zone is trusted (§8): a skill <script> elsewhere in the editable doc is ignored.
 *  STRICT data-rwa-frozen attribute-name check (not substring) so a lookalike cannot forge trust.
 *  Safe with a flat scan because envelopes are base64 (no </div> in the content). */
function extractRwaSkillsZone(doc) {
  const open = /<div\b[^>]*\bid="rwa-skills"[^>]*>/i.exec(String(doc || ''));
  if (!open || !tagHasFrozenAttr(open[0])) return null;
  const start = open.index + open[0].length;
  const end = doc.indexOf('</div>', start);
  return end < 0 ? null : doc.slice(start, end);
}

/** §8 static projection: parse installed skills from the frozen zone, re-verify each signature.
 *  Each block is base64(JSON(envelope)). Returns [{skillId,kind,name,verified,provenance:'installed'}]. */
export function parseSkillZone(doc) {
  const zone = extractRwaSkillsZone(doc);
  if (!zone) return [];
  const blocks = [...zone.matchAll(/<script\s+type="application\/rwa-skill\+json">([\s\S]*?)<\/script>/g)];
  const out = [];
  for (const m of blocks) {
    let envelope;
    try { envelope = JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8')); }
    catch { continue; } // malformed block → skip (never blocks siblings)
    const skill = envelope && envelope.skill;
    if (!skill || typeof skill.name !== 'string') continue;
    const { verified } = verifyEnvelope(envelope);
    out.push({
      skillId: skillId(skill.name, skill.author_pubkey),
      kind: skill.kind,
      name: skill.name,
      verified,
      provenance: 'installed',
    });
  }
  return out;
}

/** Locate the frozen `<div data-rwa-frozen id="rwa-agents">` zone (mirrors extractRwaSkillsZone). */
function extractRwaAgentsZone(doc) {
  const open = /<div\b[^>]*\bid="rwa-agents"[^>]*>/i.exec(String(doc || ''));
  if (!open || !tagHasFrozenAttr(open[0])) return null;
  const start = open.index + open[0].length;
  const end = doc.indexOf('</div>', start);
  return end < 0 ? null : doc.slice(start, end);
}

/** §12 / SD-04: parse installed agents from the frozen zone, re-verify each signature. Returns
 *  [{agentId, kind:'agent', name:role, verified, provenance:'installed'}] — an installed agent is
 *  an affordance the container offers (a role you can act under), mirroring parseSkillZone. */
export function parseAgentZone(doc) {
  const zone = extractRwaAgentsZone(doc);
  if (!zone) return [];
  const blocks = [...zone.matchAll(/<script\s+type="application\/rwa-agent\+json">([\s\S]*?)<\/script>/g)];
  const out = [];
  for (const m of blocks) {
    let envelope;
    try { envelope = JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8')); }
    catch { continue; } // malformed block → skip (never blocks siblings)
    const agent = envelope && envelope.agent;
    if (!agent || typeof agent.role !== 'string') continue;
    const { verified } = verifyAgentEnvelope(envelope);
    out.push({
      agentId: agentId(agent.role, agent.author_pubkey),
      kind: 'agent',
      name: agent.role,
      verified,
      provenance: 'installed',
    });
  }
  return out;
}

/**
 * The role this container asks an EXTERNAL agent to act under (#37).
 *
 * `parseAgentZone` above answers "what agents are installed" as affordances.
 * This answers a different question, and the difference is the whole point of
 * the issue: an outside agent arrives with a model, a key and a task, and the
 * container arrives with the document, the render, the invariants — and the
 * SPECIALISATION. The rwa is not asking for a brain; it is handing over a job
 * description. `rwa-agent/1` already IS that job description, signed and frozen;
 * it just had no door facing outward.
 *
 * ## The refusal is the feature
 *
 * A role definition is a system prompt. Handing an unverified one to an agent
 * that holds a filesystem, a shell and a network is prompt injection promoted to
 * CONFIGURATION — strictly worse than injected document text, which at least
 * arrives fenced as data. So an unsigned or tampered record NEVER yields its
 * `systemPrompt`. It is reported as present-and-unusable instead of omitted,
 * because "there is something here you cannot trust" and "there is nothing here"
 * are different answers and only one of them is honest.
 *
 * ## Signed vs unsigned fields
 *
 * `affinity` and `recommended_model` ride the ENVELOPE, outside the signed
 * `agent` object (see docs/specs/rwa-intelligence-spec.md). They are therefore
 * author hints, not attested claims, and they are returned under `unsigned` so a
 * consumer cannot mistake one for the other.
 *
 * @param {string} doc — the container's editable body (the zone is frozen within it)
 * @returns {{status: 'none'|'ok'|'unverified'|'multiple', role: object|null, offered: object[]}}
 */
export function readOfferedRole(doc) {
  const zone = extractRwaAgentsZone(doc);
  if (!zone) return { status: 'none', role: null, offered: [] };
  const blocks = [...zone.matchAll(/<script\s+type="application\/rwa-agent\+json">([\s\S]*?)<\/script>/g)];
  const offered = [];
  for (const m of blocks) {
    let envelope;
    try { envelope = JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8')); }
    catch { continue; } // malformed block → skip, never blocks a sibling
    const agent = envelope && envelope.agent;
    if (!agent || typeof agent.role !== 'string') continue;
    const { signed, verified } = verifyAgentEnvelope(envelope);
    // Re-run the install gates, not just the signature: a record can be validly
    // signed by its author and still carry a prompt that breaks out of the
    // runtime template (agent_prompt_injection_risk). Signature proves WHO, the
    // gates prove WHAT.
    const gate = validateAgentInstall(envelope, { signed, verified });
    const usable = verified && gate.ok;
    offered.push({
      role: agent.role,
      agentId: agentId(agent.role, agent.author_pubkey),
      authorPubkey: agent.author_pubkey || null,
      signed: !!signed,
      verified: !!verified,
      usable,
      // `description` is WHEN to use this role; `systemPrompt` is HOW to behave
      // once chosen. An agent deciding whether to adopt a role at all reads the
      // first and does not need the second, so it is carried even for a record
      // whose prompt is withheld: "there is a concise-editor here you cannot
      // verify" is a more useful answer than an anonymous refusal. Both are
      // covered by the signature (canonicalAgent), so neither is an author claim
      // an attacker can rewrite independently.
      description: typeof agent.description === 'string' ? agent.description : null,
      // #45 — carried references, on the same rule as the prompt: the BYTES are
      // released only for a usable record, but their existence is reported either
      // way. "there are three references here you cannot verify" is a more useful
      // answer than silence, and it costs nothing to give.
      referenceCount: Array.isArray(agent.references) ? agent.references.length : 0,
      referenceBytes: agentReferenceBytes(agent),
      ...(usable ? { systemPrompt: agent.system_prompt } : { withheld: gate.ok ? 'unverified_signature' : gate.errors[0] }),
      ...(usable && Array.isArray(agent.references) && agent.references.length
        ? { references: agent.references.map((r) => ({ name: r.name, content: r.content })) }
        : {}),
      unsigned: {
        affinity: envelope.affinity || null,
        recommendedModel: envelope.recommended_model || null,
        recommendedBackend: envelope.recommended_backend || null,
      },
    });
  }
  if (offered.length === 0) return { status: 'none', role: null, offered };
  const usable = offered.filter(o => o.usable);
  if (usable.length === 0) return { status: 'unverified', role: null, offered };
  // More than one usable role is not a role the container "wants you to be" — it
  // is a menu, and picking for the caller would be guessing. Report all of them.
  if (usable.length > 1) return { status: 'multiple', role: null, offered };
  return { status: 'ok', role: usable[0], offered };
}
