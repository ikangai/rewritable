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
  assert.throws(() => parsePermission('idb:cache'), /unknown_permission_tier/);
});

test('parsePermission enforces the vault namespace charset', () => {
  assert.throws(() => parsePermission('vault:GitHub-Prod'), /invalid/i); // uppercase not allowed
  assert.throws(() => parsePermission('vault:has space'), /invalid/i);
});

// I1 (v0.9 §5) — the bus: permission tier. Topic grammar + reserved-prefix guard.
test('parsePermission accepts a valid bus topic', () => {
  assert.deepEqual(parsePermission('bus:agent:pings'), { tier: 'bus', value: 'agent:pings' });
  assert.equal(parsePermission('agent/pings/v2'.replace(/^/, 'bus:')).tier, 'bus');
});
test('parsePermission rejects reserved bus topic prefixes', () => {
  assert.throws(() => parsePermission('bus:rwa_admin'), /invalid bus topic/);
  assert.throws(() => parsePermission('bus:skills:x'), /invalid bus topic/);
  assert.throws(() => parsePermission('bus:workspace:presence'), /invalid bus topic/);
});
test('parsePermission rejects a malformed bus topic (charset, empty, leading punctuation)', () => {
  assert.throws(() => parsePermission('bus:has space'), /invalid bus topic/);
  assert.throws(() => parsePermission('bus:'), /invalid bus topic/);
  assert.throws(() => parsePermission('bus::leading'), /invalid bus topic/); // must start alphanumeric
});
test('validateInstall accepts a signed+verified bus tool and rejects an unsigned one', () => {
  const env = { skill: { name: 'echo', kind: 'tool', permissions: ['bus:agent:pings'] } };
  assert.equal(validateInstall(env, { signed: true, verified: true }).ok, true);
  assert.ok(validateInstall(env, { signed: false, verified: false }).errors.includes('unsigned_with_permissions'));
});
test('compoundRisk fires when bus: co-occurs with network: or vault:', async () => {
  const { compoundRisk } = await import('../src/skill-manifest.mjs');
  assert.ok(compoundRisk(['bus:agent:pings', 'network:api.github.com']));
  assert.ok(compoundRisk(['bus:agent:pings', 'vault:secrets']));
  assert.equal(compoundRisk(['bus:agent:pings']), null); // bus alone is not compound
});
test('permissionToProse renders a bus permission', async () => {
  const { permissionToProse } = await import('../src/skill-manifest.mjs');
  assert.match(permissionToProse('bus:agent:pings'), /agent:pings/);
  assert.match(permissionToProse('bus:agent:pings'), /channel|message/i);
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

// §1/§3 install-dialog content helpers (the trust-anchor prose; mirrored in the seed)
import { permissionToProse, compoundRisk, capabilityScan, levenshtein } from '../src/skill-manifest.mjs';
test('permissionToProse renders network tiers honestly', () => {
  assert.match(permissionToProse('network:api.github.com'), /network requests to api\.github\.com/i);
  assert.match(permissionToProse('network:*.github.com'), /direct subdomain of github\.com/i);
  assert.match(permissionToProse('network:**.github.com'), /any subdomain|any depth/i);
  assert.match(permissionToProse('network:*'), /any (domain|origin)/i);
  assert.match(permissionToProse('vault:github-prod'), /credentials stored under .?github-prod/i);
});
test('compoundRisk fires only on vault + network together', () => {
  assert.equal(compoundRisk(['vault:x', 'network:api.y']) !== null, true);
  assert.equal(compoundRisk(['network:api.y']), null);
  assert.equal(compoundRisk(['vault:x']), null);
  assert.match(compoundRisk(['vault:x', 'network:api.y']), /credential|send your secrets|combination/i);
});
test('capabilityScan flags dynamic-code patterns, clean code → []', () => {
  assert.ok(capabilityScan("var x = eval('1');").some(n => /eval/.test(n)));
  assert.ok(capabilityScan("setTimeout('alert(1)', 0)").some(n => /setTimeout|string/i.test(n)));
  assert.ok(capabilityScan("new Function('return 1')").some(n => /Function/.test(n)));
  assert.deepEqual(capabilityScan("async function run(i){ return i.length; }"), []);
});
test('levenshtein edit distance (for lookalike)', () => {
  assert.equal(levenshtein('Acme Skills', 'Acme Skills'), 0);
  assert.equal(levenshtein('Acme Skills', 'Acme Skils'), 1); // missing l
  assert.equal(levenshtein('abc', 'xyz'), 3);
});

// F7/F8/F9 install-gate hardening (parity with the seed _skValidateInstall).
test('F9: validateInstall rejects a non-array permissions field (no silent coerce to [])', () => {
  const r = validateInstall({ skill: { name: 'x', kind: 'compute', permissions: 'network:*' } }, { signed: false, verified: false });
  assert.ok(!r.ok && r.errors.includes('invalid_permission'));
});
test('F8: validateInstall rejects a NUL byte in the skill name (skillId ambiguity)', () => {
  const r = validateInstall({ skill: { name: 'a' + String.fromCharCode(0) + 'b', kind: 'compute', permissions: [] } }, { signed: false, verified: false });
  assert.ok(!r.ok && r.errors.includes('invalid_skill_id'));
});
test('F7: validateInstall rejects an invalid permission VALUE, not just the tier', () => {
  const r = validateInstall({ skill: { name: 'x', kind: 'tool', permissions: ['network:*evil.com'] } }, { signed: true, verified: true });
  assert.ok(!r.ok && r.errors.includes('invalid_permission'));
});
