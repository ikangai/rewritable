// Foundational skill-manifest logic for the v0.8 skill layer.
// Spec: docs/specs/re-write-able-actions-spec-v0.8.md §3 (skillId, signature, install gates), §4 (permission grammar).
// Pure/Node-side; the seed runtime mirrors this (4-site pattern). No external deps.
import { webcrypto } from 'node:crypto';

const enc = new TextEncoder();
const NUL = new Uint8Array([0]);

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
}

function b64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** §3.2 skillId = base64url(sha256(name ‖ 0x00 ‖ author_pubkey)). */
export async function skillId(name, authorPubkey) {
  const digest = await sha256(concatBytes(enc.encode(String(name)), NUL, enc.encode(String(authorPubkey))));
  return b64urlFromBytes(digest);
}

/** §3.3 canonical manifest: stable-key-ordered over the signed fields; excludes signature + code. */
export function canonicalManifest(manifest) {
  const m = manifest || {};
  const obj = {
    author_pubkey: m.author_pubkey ?? null,
    kind: m.kind ?? null,
    name: m.name ?? null,
    permissions: Array.isArray(m.permissions) ? m.permissions : [],
    version: m.version ?? null,
  };
  return JSON.stringify(obj); // keys already in sorted order; array order preserved
}

/** §3.3 signing message bytes = sha256(canonicalManifest ‖ 0x00 ‖ code). */
export async function signingMessage(manifest, code) {
  return sha256(concatBytes(enc.encode(canonicalManifest(manifest)), NUL, enc.encode(String(code ?? ''))));
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
  throw new Error(`unknown_permission_tier: ${tier}`);
}

/** §3.4 install gates. Pure; takes the verification result so it stays synchronous. */
export function validateInstall(envelope, { signed, verified } = {}) {
  const skill = (envelope && envelope.skill) || {};
  const perms = Array.isArray(skill.permissions) ? skill.permissions : [];
  const errors = [];
  for (const p of perms) {
    try { parsePermission(p); }
    catch (e) { errors.push(/unknown_permission_tier/.test(e.message) ? 'unknown_permission_tier' : 'invalid_permission'); }
  }
  if (skill.kind === 'compute' && perms.length > 0) errors.push('compute_with_permissions');
  if (!signed && perms.length > 0) errors.push('unsigned_with_permissions');
  if (skill.kind === 'tool' && !verified) errors.push('unsigned_capability');
  return { ok: errors.length === 0, errors };
}

/** §3.3 signature verification — Ed25519 over signingMessage(manifest‖code). Matches the seed's WebCrypto Ed25519. */
export async function verifyEnvelope(envelope) {
  const sig = envelope && envelope.signature;
  if (!sig) return { signed: false, verified: false };
  const skill = envelope.skill || {};
  try {
    const pub = await webcrypto.subtle.importKey('raw', bytesFromB64(skill.author_pubkey), { name: 'Ed25519' }, false, ['verify']);
    const msg = await signingMessage(skill, skill.code);
    const verified = await webcrypto.subtle.verify({ name: 'Ed25519' }, pub, bytesFromB64(sig), msg);
    return { signed: true, verified: !!verified };
  } catch {
    return { signed: true, verified: false };
  }
}
