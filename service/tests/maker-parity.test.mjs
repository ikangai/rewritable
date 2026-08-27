// Parity test — the AI Maker's client-side signing canon MUST match the CLI/seed canon
// byte-for-byte (plan T3.3).
//
// WHY this matters (Rule 9): the maker mints + signs an rwa-agent/1 record in the
// visitor's browser (WebCrypto Ed25519), the private key never leaving the page. The
// carrier it downloads is later dropped onto a rewritable and RE-VERIFIED by the seed's
// `_agVerify` and, for `rwa doc`, the CLI's `verifyAgentEnvelope` — both of which sign/
// verify over `sha256(canonicalAgent(agent))`. If the maker's `canonicalAgent` differs
// from the lib's by even one byte (a reordered key, a coerced null, an unguarded array),
// the digest differs, the signature is over the wrong bytes, and every carrier the maker
// ships fails to verify — silently, only discovered when a user drops one. This test
// pins the maker's canon to the lib's so that class of bug fails HERE, at build time.
//
// It extracts the maker's delimited canon block (`// rwa:maker-canon:begin/end`) from
// service/public/ai/maker.html, evaluates it standalone in node:vm (DOM-free by design),
// and checks (a) byte-identical canonicalization across fixtures and (b) a full
// sign→verify round trip whose signature the LIB accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { canonicalAgent, agentSigningMessage, verifyAgentEnvelope } from '../lib/skill-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAKER_HTML = join(__dirname, '..', 'public', 'ai', 'maker.html');

// Extract the delimited canon block and evaluate it in an isolated context that
// exposes ONLY the browser globals the block is allowed to use (crypto/TextEncoder/
// btoa/atob). The epilogue lifts the block's lexical bindings (const/function alike)
// onto the sandbox so the test can call them — this also proves the block is free of
// any DOM reference (it would throw here otherwise).
function loadMakerCanon() {
  const src = readFileSync(MAKER_HTML, 'utf8');
  const BEGIN = '// rwa:maker-canon:begin';
  const END = '// rwa:maker-canon:end';
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  assert.ok(i >= 0, 'maker.html must contain the canon begin marker');
  assert.ok(j > i, 'maker.html must contain the canon end marker after begin');
  const block = src.slice(i + BEGIN.length, j);
  const sandbox = {
    crypto: globalThis.crypto,
    TextEncoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
  };
  vm.createContext(sandbox);
  const epilogue = '\n;globalThis.__makerCanon = { canonicalAgent, agentSigningMessageBytes, b64, u8FromB64, escapeTL, assembleCarrier, ROLE_RE, REC_MODEL_RE, REC_BACKENDS };\n';
  vm.runInContext(block + epilogue, sandbox, { filename: 'maker-canon.js' });
  return sandbox.__makerCanon;
}

const maker = loadMakerCanon();

// ─── (a) canonicalAgent byte-for-byte parity across fixtures ─────────────────
//
// Each fixture exercises a distinct clause of the canon: null-coalescing on a
// missing field, the vault array guard, unicode/punctuation escaping, and the
// stable key order regardless of the input object's key order.
const FIXTURES = [
  {
    name: 'empty description → null',
    agent: { author_pubkey: 'QUJD', role: 'proofreader', system_prompt: 'Fix errors only.', vault_namespace_set: [], version: 'rwa-agent/1' },
  },
  {
    name: 'a vault set',
    agent: { author_pubkey: 'QUJD', description: 'Reads creds.', role: 'notion-sync', system_prompt: 'Sync it.', vault_namespace_set: ['vault:notion', 'vault:shared'], version: 'rwa-agent/1' },
  },
  {
    name: 'unicode + punctuation in system_prompt',
    agent: { author_pubkey: 'QUJD', description: 'Ünïcödé desc — "q"', role: 'translator', system_prompt: 'Translate de↔en, keep tone. Backslash \\ slash / newline\nand\ttab. 日本語も。', vault_namespace_set: [], version: 'rwa-agent/1' },
  },
  {
    name: 'missing optional fields (author_pubkey/description/version absent, no vault)',
    agent: { role: 'r', system_prompt: 'p' },
  },
  // #45 — the canon is VERSIONED, so it needs a fixture at EACH version. A suite
  // that only exercised the current one would let v1 verification rot silently
  // behind the branch, which is the exact failure the branch exists to prevent:
  // every already-signed carrier in the wild is v1, and a canon that stops
  // reproducing their bytes does not raise an error — their signatures simply
  // stop matching, with nothing to read.
  {
    name: 'v2 — carried references (signed)',
    agent: { author_pubkey: 'QUJD', description: 'Applies the house style.', references: [{ name: 'style.md', content: '# Style\n\nUse `npx rwa doc`.\n\n```js\nconst t = `x ${y}`;\n```' }], role: 'house-editor', system_prompt: 'Edit to house style.', vault_namespace_set: [], version: 'rwa-agent/2' },
  },
  {
    name: 'v2 — empty references array',
    agent: { author_pubkey: 'QUJD', description: 'd', references: [], role: 'r', system_prompt: 'p', vault_namespace_set: [], version: 'rwa-agent/2' },
  },
  {
    name: 'v2 — references absent (the field is optional even at v2)',
    agent: { author_pubkey: 'QUJD', description: 'd', role: 'r', system_prompt: 'p', vault_namespace_set: [], version: 'rwa-agent/2' },
  },
  {
    // The property the version branch protects: a v1 record must canonicalize
    // IDENTICALLY with and without a references field, or an attacker could
    // smuggle unsigned bytes past a v1 signature via a verifier that reads them.
    name: 'v1 — a stray references field is NOT signed',
    agent: { author_pubkey: 'QUJD', description: 'd', references: [{ name: 'x.md', content: 'smuggled' }], role: 'r', system_prompt: 'p', vault_namespace_set: [], version: 'rwa-agent/1' },
  },
  {
    name: 'an unknown future version falls back to the v1 canon',
    agent: { author_pubkey: 'QUJD', description: 'd', role: 'r', system_prompt: 'p', vault_namespace_set: [], version: 'rwa-agent/9' },
  },
  {
    name: 'scrambled input key order still canonicalizes identically',
    agent: { version: 'rwa-agent/1', system_prompt: 'later key first', role: 'x', vault_namespace_set: ['vault:a'], description: 'd', author_pubkey: 'QUJD' },
  },
  {
    name: 'non-array vault_namespace_set is guarded to []',
    agent: { author_pubkey: 'QUJD', description: null, role: 'x', system_prompt: 'p', vault_namespace_set: 'not-an-array', version: 'rwa-agent/1' },
  },
];

for (const f of FIXTURES) {
  test(`canonicalAgent parity — ${f.name}`, () => {
    const mine = maker.canonicalAgent(f.agent);
    const lib = canonicalAgent(f.agent);
    assert.equal(typeof mine, 'string');
    assert.equal(mine, lib, 'maker canonicalAgent must be byte-identical to the lib');
  });
}

// ─── (b) full sign → verify round trip the LIB accepts ───────────────────────
//
// Generate a real Ed25519 keypair (node webcrypto, the same primitive the browser
// exposes), build an agent whose author_pubkey is base64 via the MAKER's b64, compute
// the digest via the MAKER's agentSigningMessageBytes, sign the DIGEST with node's
// subtle.sign, wrap {agent, signature}, and verify with the LIB. A green here means a
// browser-minted carrier verifies under the seed's/CLI's own code.
test('maker digest → node sign → lib verifyAgentEnvelope = {signed, verified}', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const author_pubkey = maker.b64(rawPub);
  const agent = {
    author_pubkey,
    description: 'Round-trip fixture.',
    role: 'round-trip',
    system_prompt: 'Verify me under the lib.',
    vault_namespace_set: ['vault:rt'],
    version: 'rwa-agent/1',
  };
  const digest = await maker.agentSigningMessageBytes(agent);
  assert.equal(digest.length, 32, 'sha-256 digest is 32 bytes');
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, digest));
  const envelope = { agent, signature: maker.b64(sig) };
  const result = verifyAgentEnvelope(envelope);
  assert.deepEqual(result, { signed: true, verified: true }, 'the lib must accept the maker-signed envelope');
});

// The reverse: the LIB's digest bytes for a given agent MUST equal the maker's, so the
// two sign over identical messages. (This is the parity that (a) proves at the string
// level, re-checked at the digest-byte level.)
test('maker agentSigningMessageBytes === lib agentSigningMessage (byte-for-byte)', async () => {
  const agent = {
    author_pubkey: 'QUJD',
    description: 'digest parity',
    role: 'digester',
    system_prompt: 'same bytes both sides',
    vault_namespace_set: ['vault:x'],
    version: 'rwa-agent/1',
  };
  const mine = await maker.agentSigningMessageBytes(agent);
  const lib = agentSigningMessage(agent); // node:crypto Buffer, 32 bytes
  assert.deepEqual(Buffer.from(mine), Buffer.from(lib), 'digest bytes must match the lib');
});

// A tamper check gives the round trip teeth: mutating a signed field after signing
// must break verification (else the signature isn't actually binding the canon).
test('tampering a signed field after signing breaks lib verification', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const agent = {
    author_pubkey: maker.b64(rawPub),
    description: 'original',
    role: 'tamper',
    system_prompt: 'original prompt',
    vault_namespace_set: [],
    version: 'rwa-agent/1',
  };
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, await maker.agentSigningMessageBytes(agent)));
  const tampered = { agent: { ...agent, system_prompt: 'INJECTED prompt' }, signature: maker.b64(sig) };
  assert.deepEqual(verifyAgentEnvelope(tampered), { signed: true, verified: false }, 'a post-sign edit must fail verification');
});

// ─── (c) assembleCarrier — the pure injection step, extracted for testability ─
//
// WHY (Rule 9): assembleCarrier is what turns the server template into the shipped
// carrier. Two failure modes are load-bearing: (1) a happy path must actually LAND
// the signed record + role (escapeTL-escaped, function-form replace so a literal $ is
// not read as a backreference); (2) template DRIFT (a renamed/removed marker) must
// THROW, not silently ship a blank carrier that boots but installs nothing while the
// done panel claims success.

test('assembleCarrier lands role + card + zone (escapeTL applied; $ not a backref)', () => {
  const cardIn = 'A `t` ${x} $& end';                 // exercises escapeTL (backtick, ${) + function-form ($&)
  const zoneIn = '<div data-rwa-frozen id="rwa-agents">ZONE</div>';
  const tpl = 'HEAD RWA_MAKER_ROLE <!--RWA_MAKER_CARD-->\n<!--RWA_MAKER_ZONE--> TAIL RWA_MAKER_ROLE';
  const out = maker.assembleCarrier(tpl, 'my-role', cardIn, zoneIn);
  assert.ok(!out.includes('RWA_MAKER_ROLE'), 'role placeholder fully substituted');
  assert.ok(!out.includes('<!--RWA_MAKER_CARD-->') && !out.includes('<!--RWA_MAKER_ZONE-->'), 'both markers consumed');
  assert.equal((out.match(/my-role/g) || []).length, 2, 'both role sites substituted');
  assert.ok(out.includes(maker.escapeTL(cardIn)), 'card injected escapeTL-escaped');
  assert.ok(out.includes(maker.escapeTL(zoneIn)), 'zone injected escapeTL-escaped');
  // The literal $& must survive verbatim (function-form replace, not a $-substitution).
  assert.ok(out.includes('$& end'), 'a literal $ in content is not read as a replace backreference');
});

test('assembleCarrier THROWS on template drift (a missing marker)', () => {
  const good = 'RWA_MAKER_ROLE <!--RWA_MAKER_CARD--> <!--RWA_MAKER_ZONE-->';
  assert.throws(() => maker.assembleCarrier(good.replace('<!--RWA_MAKER_CARD-->', ''), 'r', 'c', 'z'), /missing marker/, 'missing card marker throws');
  assert.throws(() => maker.assembleCarrier(good.replace('<!--RWA_MAKER_ZONE-->', ''), 'r', 'c', 'z'), /missing marker/, 'missing zone marker throws');
  assert.throws(() => maker.assembleCarrier(good.replace('RWA_MAKER_ROLE', ''), 'r', 'c', 'z'), /missing RWA_MAKER_ROLE/, 'missing role placeholder throws');
});

// ─── (d) validation regexes pinned to cli/src/intelligence.mjs ───────────────
//
// WHY (Rule 9): these three gate what the maker accepts. A role/model the maker
// admits but the CLI/seed rejects is a carrier that won't install — so they must be
// byte-identical to the CLI's own literals, not merely "look similar".
test('ROLE_RE / REC_MODEL_RE / REC_BACKENDS are byte-identical to cli/src/intelligence.mjs', () => {
  const intel = readFileSync(join(__dirname, '..', '..', 'cli', 'src', 'intelligence.mjs'), 'utf8');
  const roleLit = intel.match(/const ROLE_RE = (\/.*\/);/);
  const modelLit = intel.match(/const REC_MODEL_RE = (\/.*\/);/);
  const backendsLit = intel.match(/const REC_BACKENDS = (\[[^\]]*\]);/);
  assert.ok(roleLit && modelLit && backendsLit, 'intelligence.mjs still declares all three literals');
  assert.equal(maker.ROLE_RE.toString(), roleLit[1], 'ROLE_RE matches intelligence.mjs');
  assert.equal(maker.REC_MODEL_RE.toString(), modelLit[1], 'REC_MODEL_RE matches intelligence.mjs');
  // Spread into a main-realm array: maker.REC_BACKENDS is a vm-realm Array, and
  // node:assert/strict deepEqual compares [[Prototype]] identity across realms.
  assert.deepEqual([...maker.REC_BACKENDS], JSON.parse(backendsLit[1].replace(/'/g, '"')), 'REC_BACKENDS matches intelligence.mjs');
});
