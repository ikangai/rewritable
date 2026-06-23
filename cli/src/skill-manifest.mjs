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
export function canonicalAgent(agent) {
  const a = agent || {};
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
  if (!signed) errors.push('unsigned_agent'); // unsigned agents are rejected at install (verified gates activation)
  return { ok: errors.length === 0, errors };
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
  if (!signed && perms.length > 0) errors.push('unsigned_with_permissions');
  if (skill.kind === 'tool' && !verified) errors.push('unsigned_capability');
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
