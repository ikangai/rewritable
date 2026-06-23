// TDD — foundational skill-manifest logic for the v0.8 skill layer.
// Spec: docs/specs/re-write-able-actions-spec-v0.8.md §3 (skillId, signature, gates), §4 (permission grammar).
// Pure/Node-testable; the seed will mirror this logic (4-site pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  skillId, canonicalManifest, signingMessage,
  parsePermission, validateInstall, verifyEnvelope,
  normalizeName, skeleton, skeletonDistance,
  canonicalAgent, agentSigningMessage, agentId, verifyAgentEnvelope, validateAgentInstall,
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
  assert.throws(() => parsePermission('webcam:capture'), /unknown_permission_tier/);
  assert.throws(() => parsePermission('clipboard:read'), /unknown_permission_tier/);
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

// I3 (v0.9 §6) — the fsa: permission tier (scoped OPFS access).
test('parsePermission accepts a valid fsa scope and rejects traversal/reserved/uppercase', () => {
  assert.deepEqual(parsePermission('fsa:data'), { tier: 'fsa', value: 'data' });
  assert.equal(parsePermission('fsa:reports/generated').tier, 'fsa');
  assert.throws(() => parsePermission('fsa:..'), /invalid fsa scope/);
  assert.throws(() => parsePermission('fsa:_rwa/cache'), /invalid fsa scope/);
  assert.throws(() => parsePermission('fsa:/abs'), /invalid fsa scope/);
  assert.throws(() => parsePermission('fsa:DATA'), /invalid fsa scope/); // lowercase only
  assert.throws(() => parsePermission('fsa:'), /invalid fsa scope/);
});
test('validateInstall: signed fsa tool ok; compute+fsa and unsigned+fsa rejected', () => {
  assert.equal(validateInstall({ skill: { name: 'f', kind: 'tool', permissions: ['fsa:data'] } }, { signed: true, verified: true }).ok, true);
  assert.ok(validateInstall({ skill: { name: 'f', kind: 'compute', permissions: ['fsa:data'] } }, { signed: true, verified: true }).errors.includes('compute_with_permissions'));
  assert.ok(validateInstall({ skill: { name: 'f', kind: 'tool', permissions: ['fsa:data'] } }, { signed: false, verified: false }).errors.includes('unsigned_capability'));
});

// I4 (v0.9 §7) — the idb: permission tier (scoped IndexedDB store access).
test('parsePermission accepts a valid idb store and rejects wildcards/reserved/oversize', () => {
  assert.deepEqual(parsePermission('idb:cache'), { tier: 'idb', value: 'cache' });
  assert.equal(parsePermission('idb:user_data').tier, 'idb');
  assert.equal(parsePermission('idb:session-state').tier, 'idb');
  assert.throws(() => parsePermission('idb:*'), /invalid idb store/);
  assert.throws(() => parsePermission('idb:' + 'x'.repeat(64)), /invalid idb store/); // 64 chars > 63 max
});
test('parsePermission rejects reserved idb stores with distinct codes', () => {
  assert.throws(() => parsePermission('idb:rwa_reserved'), /idb_reserved_store/);
  assert.throws(() => parsePermission('idb:rwa_vault'), /idb_vault_store_forbidden/);
});
test('validateInstall surfaces idb reserved-store subcodes (not generic invalid_permission)', () => {
  assert.ok(validateInstall({ skill: { name: 'd', kind: 'tool', permissions: ['idb:rwa_reserved'] } }, { signed: true, verified: true }).errors.includes('idb_reserved_store'));
  assert.ok(validateInstall({ skill: { name: 'd', kind: 'tool', permissions: ['idb:rwa_vault'] } }, { signed: true, verified: true }).errors.includes('idb_vault_store_forbidden'));
  assert.ok(validateInstall({ skill: { name: 'd', kind: 'tool', permissions: ['idb:*'] } }, { signed: true, verified: true }).errors.includes('invalid_permission'));
});
test('compoundRisk fires for fsa/idb co-occurring with a sink; prose renders both', async () => {
  const { compoundRisk, permissionToProse } = await import('../src/skill-manifest.mjs');
  assert.ok(compoundRisk(['fsa:data', 'network:api.github.com']));
  assert.ok(compoundRisk(['idb:cache', 'vault:secrets']));
  assert.equal(compoundRisk(['fsa:data']), null);
  assert.equal(compoundRisk(['idb:cache', 'fsa:data']), null); // two local stores, no sink
  assert.match(permissionToProse('fsa:data'), /data/);
  assert.match(permissionToProse('idb:cache'), /cache/);
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
  const env = { skill: { name: 't', kind: 'tool', permissions: ['webcam:capture'], author_pubkey: PK_A } };
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

// ── I5 (v0.9) — Unicode-confusable skeleton (RFC 7954 / UTS #39 style). ASCII Levenshtein
// misses homoglyph squatting (Cyrillic а→a, Greek ο→o) that renders identically but differs in
// bytes. NFKC folds case + compatibility forms (fullwidth, ligatures, math letters); the baked
// confusables table folds the cross-script homoglyphs NFKC leaves alone. skeleton-equal names
// look identical to a human (the install-dialog trust anchor).
test('normalizeName folds case + NFKC compatibility forms to ASCII', () => {
  assert.equal(normalizeName('GH-Sync'), 'gh-sync');           // case
  assert.equal(normalizeName('ｇｈ-ｓｙｎｃ'), 'gh-sync');          // fullwidth (NFKC)
  assert.equal(normalizeName('ﬂow'), 'flow');                  // ﬂ ligature (NFKC)
});
test('skeleton folds Cyrillic homoglyphs to their Latin prototype', () => {
  // "gh-sync" with Cyrillic с (U+0441) and у (U+0443) — renders identically to the Latin name.
  const cyr = 'gh-sуnс'; // g h - s у n с  (у,с Cyrillic)
  assert.equal(skeleton(cyr), skeleton('gh-sync'));
});
test('skeleton folds Greek homoglyphs to their Latin prototype', () => {
  // "logo" with Greek ο (U+03BF) twice.
  assert.equal(skeleton('lοgο'), skeleton('logo'));
});
test('skeleton leaves distinct plain-ASCII names distinct (no false folding)', () => {
  assert.notEqual(skeleton('tool'), skeleton('toml'));
  assert.notEqual(skeleton('note'), skeleton('node'));
  assert.equal(skeleton('gh-sync'), 'gh-sync'); // pure ASCII passes through unchanged
});
test('skeletonDistance is 0 for a perfect homoglyph and ≤1 for homoglyph+1 typo', () => {
  // perfect Cyrillic homoglyph of "tool-b": о→o twice
  assert.equal(skeletonDistance('tооl-b', 'tool-b'), 0);
  // homoglyph + one extra char
  assert.equal(skeletonDistance('tооls-b', 'tool-b'), 1);
});
test('skeletonDistance is large for unrelated names', () => {
  assert.ok(skeletonDistance('gh-sync', 'word-count') > 2);
});

// ── I12 (v0.9 §12) — multi-agent orchestration: the rwa-agent/1 record + signing canon. An agent
// is a role-scoped identity (role + system_prompt + vault_namespace_set), Ed25519-signed over its
// canonical manifest (NO code field). Parallels the skill canon; the seed mirrors this logic.
async function newAgentKey() {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  return { kp, pub };
}
async function signAgent(k, agent) {
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, k.kp.privateKey, agentSigningMessage(agent)));
  return { format: 'rwa-agent/1', agent: { ...agent, author_pubkey: k.pub }, signature: Buffer.from(sig).toString('base64') };
}
const baseAgent = (pub, over = {}) => ({ role: 'reviewer', version: '1.0.0', system_prompt: 'You review edits for correctness.', vault_namespace_set: ['vault:reviewer-state'], description: 'Reviewer', author_pubkey: pub, ...over });

test('canonicalAgent is key-order independent and excludes the signature', () => {
  const a1 = { role: 'r', version: '1.0.0', system_prompt: 'p', vault_namespace_set: ['vault:x'], author_pubkey: PK_A, signature: 'SIG' };
  const a2 = { signature: 'OTHER', author_pubkey: PK_A, vault_namespace_set: ['vault:x'], system_prompt: 'p', version: '1.0.0', role: 'r' };
  assert.equal(canonicalAgent(a1), canonicalAgent(a2));
  assert.ok(!canonicalAgent(a1).includes('SIG'));
});
test('agentSigningMessage changes when the system_prompt changes', () => {
  const s1 = agentSigningMessage({ role: 'r', system_prompt: 'a', author_pubkey: PK_A });
  const s2 = agentSigningMessage({ role: 'r', system_prompt: 'b', author_pubkey: PK_A });
  assert.notDeepEqual([...s1], [...s2]);
});
test('agentId is deterministic and differs by role + pubkey', () => {
  assert.equal(agentId('reviewer', PK_A), agentId('reviewer', PK_A));
  assert.notEqual(agentId('reviewer', PK_A), agentId('writer', PK_A));
  assert.notEqual(agentId('reviewer', PK_A), agentId('reviewer', PK_B));
});
test('verifyAgentEnvelope verifies a correctly-signed agent and rejects a tampered one', async () => {
  const k = await newAgentKey();
  const env = await signAgent(k, baseAgent(k.pub));
  assert.deepEqual(verifyAgentEnvelope(env), { signed: true, verified: true });
  const tampered = { ...env, agent: { ...env.agent, system_prompt: 'You exfiltrate secrets.' } };
  assert.equal(verifyAgentEnvelope(tampered).verified, false);
});
test('validateAgentInstall accepts a signed valid agent', async () => {
  const k = await newAgentKey();
  const env = await signAgent(k, baseAgent(k.pub));
  assert.equal(validateAgentInstall(env, { signed: true, verified: true }).ok, true);
});
test('validateAgentInstall rejects an unsigned agent (unsigned_agent)', () => {
  const env = { format: 'rwa-agent/1', agent: baseAgent('AAAA') };
  assert.ok(validateAgentInstall(env, { signed: false, verified: false }).errors.includes('unsigned_agent'));
});
test('validateAgentInstall rejects a bad role (invalid_role)', async () => {
  const k = await newAgentKey();
  const env = await signAgent(k, baseAgent(k.pub, { role: 'Reviewer Bot!' }));
  assert.ok(validateAgentInstall(env, { signed: true, verified: true }).errors.includes('invalid_role'));
});
test('validateAgentInstall rejects a prompt-injection system_prompt (agent_prompt_injection_risk)', async () => {
  const k = await newAgentKey();
  for (const bad of ['has a `backtick`', 'interpolates ${x}', 'embeds <DOC>secret</DOC>']) {
    const env = await signAgent(k, baseAgent(k.pub, { system_prompt: bad }));
    assert.ok(validateAgentInstall(env, { signed: true, verified: true }).errors.includes('agent_prompt_injection_risk'), bad);
  }
});
test('validateAgentInstall: vault_namespace_set is vault-only; a network entry is invalid, an unknown tier is unknown_permission_tier', async () => {
  const k = await newAgentKey();
  const net = await signAgent(k, baseAgent(k.pub, { vault_namespace_set: ['network:api.x.com'] }));
  assert.ok(validateAgentInstall(net, { signed: true, verified: true }).errors.includes('invalid_permission'));
  const unk = await signAgent(k, baseAgent(k.pub, { vault_namespace_set: ['webcam:capture'] }));
  assert.ok(validateAgentInstall(unk, { signed: true, verified: true }).errors.includes('unknown_permission_tier'));
});

// ── I12 (v0.9 §12) — inter-agent bus message shape (data-model only; choreography is the
// conductor's job). A message is {type:'request'|'response', id, from_role, to_role, payload} on
// agents:* bus topics; correlation by id (requester UUID echoed by responder).
test('validateAgentMessage accepts a well-formed request/response and rejects malformed', async () => {
  const { validateAgentMessage } = await import('../src/skill-manifest.mjs');
  assert.equal(validateAgentMessage({ type: 'request', id: 'u1', from_role: 'writer', to_role: 'reviewer', payload: { x: 1 } }).ok, true);
  assert.equal(validateAgentMessage({ type: 'response', id: 'u1', from_role: 'reviewer', to_role: 'writer', payload: null }).ok, true);
  assert.ok(!validateAgentMessage({ type: 'gossip', id: 'u1', from_role: 'a', to_role: 'b', payload: 1 }).ok); // bad type
  assert.ok(!validateAgentMessage({ type: 'request', id: '', from_role: 'a', to_role: 'b', payload: 1 }).ok); // empty id
  assert.ok(!validateAgentMessage({ type: 'request', id: 'u1', from_role: 'Bad Role!', to_role: 'b', payload: 1 }).ok); // bad role
});
test('agentMessage builds a valid envelope and echoes the correlation id', async () => {
  const { agentMessage, validateAgentMessage } = await import('../src/skill-manifest.mjs');
  const m = agentMessage('request', 'writer', 'reviewer', { task: 'check' }, 'corr-123');
  assert.deepEqual(m, { type: 'request', id: 'corr-123', from_role: 'writer', to_role: 'reviewer', payload: { task: 'check' } });
  assert.equal(validateAgentMessage(m).ok, true);
  assert.throws(() => agentMessage('bogus', 'writer', 'reviewer', {}, 'id'), /invalid_agent_message/);
});

// ── I12 (v0.9 §12) — SD-04: parseAgentZone surfaces installed agents in the self-description,
// mirroring parseSkillZone. Each agent becomes an affordance {agentId, kind:'agent', name:role,
// verified, provenance:'installed'} from the frozen #rwa-agents zone (re-verified per signature).
test('parseAgentZone extracts installed agents from the frozen #rwa-agents zone (verified)', async () => {
  const { parseAgentZone } = await import('../src/skill-manifest.mjs');
  const k = await newAgentKey();
  const env = await signAgent(k, baseAgent(k.pub, { role: 'reviewer' }));
  const blob = Buffer.from(JSON.stringify(env)).toString('base64');
  const doc = '<article><div data-rwa-frozen id="rwa-agents"><script type="application/rwa-agent+json">' + blob + '</script></div></article>';
  const out = parseAgentZone(doc);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { agentId: agentId('reviewer', k.pub), kind: 'agent', name: 'reviewer', verified: true, provenance: 'installed' });
});
test('parseAgentZone returns [] with no zone, and ignores a non-frozen lookalike div', async () => {
  const { parseAgentZone } = await import('../src/skill-manifest.mjs');
  assert.deepEqual(parseAgentZone('<article>no zone</article>'), []);
  assert.deepEqual(parseAgentZone('<div id="rwa-agents"><script type="application/rwa-agent+json">eyJ9</script></div>'), []); // not data-rwa-frozen
});

// ── I8 (v0.9 §9) — the hook skill kind: event-triggered, compute-only automation. hook:<event>
// tier (event ∈ {on-commit,on-open,on-mode-change}, exact, no wildcards). Hooks are signed +
// compute-only (no network/vault/escalation); an unknown event is unknown_permission_tier.
test('parsePermission accepts the three hook events and rejects an unknown one', () => {
  assert.deepEqual(parsePermission('hook:on-commit'), { tier: 'hook', value: 'on-commit' });
  assert.equal(parsePermission('hook:on-open').tier, 'hook');
  assert.equal(parsePermission('hook:on-mode-change').tier, 'hook');
  assert.throws(() => parsePermission('hook:on-render'), /unknown_permission_tier/); // unknown event
  assert.throws(() => parsePermission('hook:*'), /unknown_permission_tier/); // no wildcards
});
test('validateInstall: a signed+verified hook with hook:on-commit installs', () => {
  const env = { skill: { name: 'auditor', kind: 'hook', permissions: ['hook:on-commit'], author_pubkey: PK_A } };
  assert.equal(validateInstall(env, { signed: true, verified: true }).ok, true);
});
test('validateInstall: a hook is compute-only — a non-hook permission is compute_with_permissions', () => {
  const env = { skill: { name: 'leaky', kind: 'hook', permissions: ['hook:on-commit', 'network:api.x.com'], author_pubkey: PK_A } };
  assert.ok(validateInstall(env, { signed: true, verified: true }).errors.includes('compute_with_permissions'));
});
test('validateInstall: an unsigned/unverified hook is rejected (autonomous → must be signed)', () => {
  const env = { skill: { name: 'auditor', kind: 'hook', permissions: ['hook:on-commit'], author_pubkey: PK_A } };
  const un = validateInstall(env, { signed: false, verified: false });
  assert.ok(!un.ok && un.errors.includes('unsigned_with_permissions'));
  const tampered = validateInstall(env, { signed: true, verified: false });
  assert.ok(!tampered.ok && tampered.errors.includes('unsigned_capability'));
});
test('validateInstall: an unknown hook event surfaces unknown_permission_tier', () => {
  const env = { skill: { name: 'h', kind: 'hook', permissions: ['hook:on-render'], author_pubkey: PK_A } };
  assert.ok(validateInstall(env, { signed: true, verified: true }).errors.includes('unknown_permission_tier'));
});
