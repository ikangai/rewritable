// TDD — foundational skill-manifest logic for the v0.8 skill layer.
// Spec: docs/specs/re-write-able-actions-spec-v0.8.md §3 (skillId, signature, gates), §4 (permission grammar).
// Pure/Node-testable; the seed will mirror this logic (4-site pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  skillId, canonicalManifest, signingMessage,
  parsePermission, validateInstall, verifyEnvelope,
} from '../src/skill-manifest.mjs';

const PK_A = 'QUFBQS1wdWJrZXktQQ=='; // opaque base64 stand-ins for identity comparison
const PK_B = 'QkJCQi1wdWJrZXktQg==';

// §3.2 skillId = base64url(sha256(name ‖ 0x00 ‖ author_pubkey))
test('skillId is deterministic for the same name+pubkey', async () => {
  const a = skillId('gh-stars', PK_A);
  const b = skillId('gh-stars', PK_A);
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url, no padding/+//
});

test('skillId differs by author pubkey (key is identity, not name)', async () => {
  assert.notEqual(skillId('gh-stars', PK_A), skillId('gh-stars', PK_B));
});

test('skillId differs by name', async () => {
  assert.notEqual(skillId('gh-stars', PK_A), skillId('word-count', PK_A));
});

// §3.3 canonical manifest: stable key order, excludes signature, order-independent
test('canonicalManifest is key-order independent and drops the signature field', () => {
  const m1 = { name: 'x', version: '1.0.0', kind: 'tool', permissions: ['network:api.x'], author_pubkey: PK_A, signature: 'SIG' };
  const m2 = { signature: 'DIFFERENT', author_pubkey: PK_A, permissions: ['network:api.x'], kind: 'tool', version: '1.0.0', name: 'x' };
  assert.equal(canonicalManifest(m1), canonicalManifest(m2));
  assert.ok(!canonicalManifest(m1).includes('signature'));
});

// signing message couples manifest+code atomically (§3.3 / Invariant 20)
test('signingMessage changes when code changes (manifest fixed)', async () => {
  const m = { name: 'x', version: '1.0.0', kind: 'tool', permissions: ['network:api.x'], author_pubkey: PK_A };
  const s1 = signingMessage(m, 'async function run(i,r){return 1}');
  const s2 = signingMessage(m, 'async function run(i,r){return 2}');
  assert.notDeepEqual([...s1], [...s2]);
});

// §4 permission grammar
test('parsePermission accepts the two shipped tiers', () => {
  assert.deepEqual(parsePermission('network:api.github.com'), { tier: 'network', value: 'api.github.com' });
  assert.deepEqual(parsePermission('vault:github-prod'), { tier: 'vault', value: 'github-prod' });
});

test('parsePermission accepts left-anchored network wildcards but rejects left-unanchored', () => {
  assert.equal(parsePermission('network:*.github.com').tier, 'network');
  assert.equal(parsePermission('network:**.github.com').tier, 'network');
  assert.throws(() => parsePermission('network:*github.com'), /left-unanchored|invalid/i);
});

test('parsePermission rejects an unshipped/unknown tier', () => {
  assert.throws(() => parsePermission('fsa:read:docs'), /unknown_permission_tier/);
  assert.throws(() => parsePermission('bus:topic:read'), /unknown_permission_tier/);
});

test('parsePermission enforces the vault namespace charset', () => {
  assert.throws(() => parsePermission('vault:GitHub-Prod'), /invalid/i); // uppercase not allowed
  assert.throws(() => parsePermission('vault:has space'), /invalid/i);
});

// §3.4 install gates
test('validateInstall rejects a compute skill that declares permissions', () => {
  const env = { skill: { name: 'c', kind: 'compute', permissions: ['network:api.x'], author_pubkey: PK_A } };
  const r = validateInstall(env, { signed: false, verified: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('compute_with_permissions'));
});

test('validateInstall rejects an unsigned envelope that declares permissions', () => {
  const env = { skill: { name: 't', kind: 'tool', permissions: ['network:api.x'], author_pubkey: PK_A } };
  const r = validateInstall(env, { signed: false, verified: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('unsigned_with_permissions'));
});

test('validateInstall rejects an unsigned/unverified capability (tool) skill', () => {
  const env = { skill: { name: 't', kind: 'tool', permissions: ['network:api.x'], author_pubkey: PK_A } };
  const r = validateInstall(env, { signed: false, verified: false });
  assert.ok(r.errors.includes('unsigned_capability'));
});

test('validateInstall rejects an unknown permission tier', () => {
  const env = { skill: { name: 't', kind: 'tool', permissions: ['fsa:read:x'], author_pubkey: PK_A } };
  const r = validateInstall(env, { signed: true, verified: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('unknown_permission_tier'));
});

test('validateInstall accepts a signed+verified network tool', () => {
  const env = { skill: { name: 't', kind: 'tool', permissions: ['network:api.github.com'], author_pubkey: PK_A } };
  const r = validateInstall(env, { signed: true, verified: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateInstall accepts an unsigned zero-permission compute skill', () => {
  const env = { skill: { name: 'wc', kind: 'compute', permissions: [], author_pubkey: PK_A } };
  const r = validateInstall(env, { signed: false, verified: false });
  assert.equal(r.ok, true);
});

// §3.3 signature: real Ed25519 round-trip (matches the seed's WebCrypto Ed25519)
test('verifyEnvelope verifies a correctly signed envelope and rejects tampering', async () => {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const pubB64 = Buffer.from(rawPub).toString('base64');
  const manifest = { name: 'gh-stars', version: '1.0.0', kind: 'tool', permissions: ['network:api.github.com'], author_pubkey: pubB64 };
  const code = 'async function run(input, runtime){ return await runtime.fetch("https://api.github.com"); }';
  const msg = signingMessage(manifest, code);
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, msg));
  const envelope = { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };

  const good = verifyEnvelope(envelope);
  assert.equal(good.signed, true);
  assert.equal(good.verified, true);

  // tamper the code → signature must no longer verify
  const tampered = { ...envelope, skill: { ...envelope.skill, code: code + '/* evil */' } };
  const bad = verifyEnvelope(tampered);
  assert.equal(bad.verified, false);
});

test('verifyEnvelope reports unsigned envelopes as signed:false verified:false', async () => {
  const env = { format: 'rwa-skill/1', skill: { name: 'wc', kind: 'compute', permissions: [], author_pubkey: PK_A, code: 'async function run(){}' } };
  const r = verifyEnvelope(env);
  assert.equal(r.signed, false);
  assert.equal(r.verified, false);
});

// §4/§5a network-origin enforcement (the bridge's per-call check; mirrored in the seed)
import { matchNetworkOrigin } from '../src/skill-manifest.mjs';

test('matchNetworkOrigin: exact host', () => {
  assert.equal(matchNetworkOrigin('api.github.com', 'api.github.com'), true);
  assert.equal(matchNetworkOrigin('api.github.com', 'evil.com'), false);
  assert.equal(matchNetworkOrigin('api.github.com', 'api.github.com.evil.com'), false);
});
test('matchNetworkOrigin: single-label wildcard binds exactly one label', () => {
  assert.equal(matchNetworkOrigin('*.github.com', 'api.github.com'), true);
  assert.equal(matchNetworkOrigin('*.github.com', 'a.b.github.com'), false); // two labels
  assert.equal(matchNetworkOrigin('*.github.com', 'github.com'), false);     // zero labels
});
test('matchNetworkOrigin: multi-label wildcard = base + any depth', () => {
  assert.equal(matchNetworkOrigin('**.github.com', 'github.com'), true);
  assert.equal(matchNetworkOrigin('**.github.com', 'api.github.com'), true);
  assert.equal(matchNetworkOrigin('**.github.com', 'a.b.github.com'), true);
  assert.equal(matchNetworkOrigin('**.github.com', 'githubXcom'), false);
  assert.equal(matchNetworkOrigin('**.github.com', 'notgithub.com'), false);
});
test('matchNetworkOrigin: catch-all', () => {
  assert.equal(matchNetworkOrigin('*', 'anything.example'), true);
});

// §6 vault namespace gate (the bridge's per-call vault check; mirrored in the seed)
import { vaultNamespaceAllowed } from '../src/skill-manifest.mjs';
test('vaultNamespaceAllowed: exact vault:<ns> match', () => {
  assert.equal(vaultNamespaceAllowed(['vault:github-prod'], 'github-prod'), true);
  assert.equal(vaultNamespaceAllowed(['vault:github-prod'], 'github-stage'), false);
  assert.equal(vaultNamespaceAllowed(['network:api.x'], 'github-prod'), false);
  assert.equal(vaultNamespaceAllowed(['vault:a', 'vault:b'], 'b'), true);
  assert.equal(vaultNamespaceAllowed([], 'x'), false);
});
