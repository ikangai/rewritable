// I6 (v0.9 §11) — `rwa skill publish`. A thin client for POST /skills/publish: read a SIGNED
// envelope, fail-fast gate locally (the server re-validates), POST, return the registry URL.
// Transport is injected so this runs offline (like publish-site.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { signingMessage, skillId } from '../src/skill-manifest.mjs';
import { skillPublishCmd } from '../src/skill-publish.mjs';

const b64 = (u8) => Buffer.from(u8).toString('base64');
function writeEnv(env) { const p = join(mkdtempSync(join(tmpdir(), 'rwa-skpub-')), 's.rwa-skill.json'); writeFileSync(p, JSON.stringify(env)); return p; }
async function signed(name, kind, perms, code = 'async function run(i,r){return 1}') {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = b64(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
  const manifest = { name, version: '1.0.0', kind, permissions: perms, author_pubkey: pub };
  const sig = b64(new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, signingMessage(manifest, code))));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: sig };
}
const fakeFetch = (status, body) => { let calls = []; const f = async (url, opts) => { calls.push({ url, opts }); return { status, async text() { return JSON.stringify(body); } }; }; f.calls = calls; return f; };
const expectExit = (fn, code, sub) => assert.rejects(fn, (e) => { assert.equal(e.exitCode, code, `exit ${e.exitCode}≠${code}`); if (sub) assert.equal(e.subcode, sub); return true; });

test('publishes a signed tool → POSTs the envelope, returns an absolute registry URL', async () => {
  const env = await signed('gh-sync', 'tool', ['network:api.github.com']);
  const id = skillId('gh-sync', env.skill.author_pubkey);
  const fetchImpl = fakeFetch(201, { skillId: id, registryUrl: '/skills/index/' + id, verified: true });
  const res = await skillPublishCmd(writeEnv(env), { baseUrl: 'http://svc.local', fetchImpl });
  assert.equal(res.skillId, id);
  assert.equal(res.verified, true);
  assert.equal(res.registryUrl, 'http://svc.local/skills/index/' + id);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://svc.local/skills/publish');
});
test('an unsigned tool is refused locally (exit 3) without any network call', async () => {
  const env = { format: 'rwa-skill/1', skill: { name: 'evil', version: '1.0.0', kind: 'tool', permissions: ['network:x.com'], author_pubkey: 'AAAA', code: 'async function run(){}' } };
  const fetchImpl = fakeFetch(201, {});
  await expectExit(() => skillPublishCmd(writeEnv(env), { fetchImpl }), 3, 'unsigned_with_permissions');
  assert.equal(fetchImpl.calls.length, 0, 'no POST on a local gate failure');
});
test('a non-skill file is exit 2 (not_a_skill)', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'rwa-skpub-')), 'x.json'); writeFileSync(p, '{"hello":1}');
  await expectExit(() => skillPublishCmd(p, { fetchImpl: fakeFetch(201, {}) }), 2, 'not_a_skill');
});
test('a missing file is exit 2 (not_found)', async () => {
  await expectExit(() => skillPublishCmd('/no/such/file.json', { fetchImpl: fakeFetch(201, {}) }), 2, 'not_found');
});
test('a server 422 maps to exit 3; a network error maps to exit 4', async () => {
  const env = await signed('gh-sync', 'tool', ['network:api.github.com']);
  await expectExit(() => skillPublishCmd(writeEnv(env), { fetchImpl: fakeFetch(422, { error: 'unsigned_capability' }) }), 3, 'unsigned_capability');
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  await expectExit(() => skillPublishCmd(writeEnv(env), { fetchImpl: boom }), 4, 'network_error');
});
