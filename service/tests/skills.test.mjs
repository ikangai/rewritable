// I6 (v0.9 §11) — signed-skill marketplace routes (/skills/{publish,index,revoke,report}).
// WHY these matter (Rule 9): the index is a DISCOVERY channel, not a trust authority. The
// load-bearing invariants: only validly-signed capability skills are indexable (unsigned tool →
// rejected; unsigned compute MAY be indexed verified:false); the index is a read-only, queryable
// projection; revocation is author-signed + permanent (410 thereafter); reports queue without
// auto-block. Install-time human review remains the trust anchor — these routes only inform.
// Harness mirrors share.test.mjs: spawn the real server.js on an ephemeral port + drive over fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { signingMessage, skillId } from '../lib/skill-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(__dirname, '..');
const b64 = (u8) => Buffer.from(u8).toString('base64');

function freePort() {
  return new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-skills-srv-'));
  const port = await freePort();
  const child = spawn('node', [join(SERVICE, 'server.js')], { env: { ...process.env, PORT: String(port), RWA_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let buf = ''; const onData = (d) => { buf += d.toString(); if (/listening on :/.test(buf)) { child.stdout.off('data', onData); resolve(); } };
    child.stdout.on('data', onData); child.on('exit', (c) => reject(new Error('server exited early ' + c + '\n' + buf)));
    setTimeout(() => reject(new Error('server did not start\n' + buf)), 8000);
  });
  return { base: `http://127.0.0.1:${port}`, async stop() { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); rmSync(dataDir, { recursive: true, force: true }); } };
}
async function newKey() {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = b64(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
  return { kp, pub };
}
async function signEnvelope(k, name, kind, perms, code = 'async function run(i,r){return 1}') {
  const manifest = { name, version: '1.0.0', kind, permissions: perms, author_pubkey: k.pub };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, k.kp.privateKey, signingMessage(manifest, code)));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: b64(sig) };
}
const post = (base, path, obj) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

test('publish a signed tool → 201, then it appears in the index + detail (verified:true)', async () => {
  const srv = await startServer();
  try {
    const k = await newKey();
    const env = await signEnvelope(k, 'gh-sync', 'tool', ['network:api.github.com']);
    const pub = await post(srv.base, '/skills/publish', env);
    assert.equal(pub.status, 201);
    const pj = await pub.json();
    assert.equal(pj.skillId, skillId('gh-sync', k.pub));
    assert.equal(pj.verified, true);
    const idx = await (await fetch(srv.base + '/skills/index')).json();
    assert.equal(idx.total, 1);
    assert.equal(idx.entries[0].name, 'gh-sync');
    assert.deepEqual(idx.entries[0].permissions_summary, ['network']);
    const det = await (await fetch(srv.base + '/skills/index/' + pj.skillId)).json();
    assert.equal(det.envelope.skill.name, 'gh-sync');
    assert.equal(det.metadata.author_fingerprint.length, 16);
  } finally { await srv.stop(); }
});

test('an unsigned tool is rejected (422 unsigned_capability); an unsigned compute is indexable verified:false', async () => {
  const srv = await startServer();
  try {
    const unsignedTool = { format: 'rwa-skill/1', skill: { name: 'evil', version: '1.0.0', kind: 'tool', permissions: ['network:x.com'], author_pubkey: 'AAAA', code: 'async function run(){}' } };
    const r1 = await post(srv.base, '/skills/publish', unsignedTool);
    assert.equal(r1.status, 422);
    assert.match((await r1.json()).error, /unsigned/);
    const unsignedCompute = { format: 'rwa-skill/1', skill: { name: 'wc', version: '1.0.0', kind: 'compute', permissions: [], author_pubkey: 'AAAA', code: 'async function run(i){return i.length}' } };
    const r2 = await post(srv.base, '/skills/publish', unsignedCompute);
    assert.equal(r2.status, 201);
    assert.equal((await r2.json()).verified, false);
  } finally { await srv.stop(); }
});

test('index supports kind/search filters + pagination', async () => {
  const srv = await startServer();
  try {
    const k = await newKey();
    await post(srv.base, '/skills/publish', await signEnvelope(k, 'gh-sync', 'tool', ['network:api.github.com']));
    await post(srv.base, '/skills/publish', await signEnvelope(k, 'gh-stars', 'tool', ['network:api.github.com']));
    await post(srv.base, '/skills/publish', { format: 'rwa-skill/1', skill: { name: 'wordcount', version: '1.0.0', kind: 'compute', permissions: [], author_pubkey: 'AAAA', code: 'async function run(i){return 1}' } });
    const all = await (await fetch(srv.base + '/skills/index')).json();
    assert.equal(all.total, 3);
    const tools = await (await fetch(srv.base + '/skills/index?kind=tool')).json();
    assert.equal(tools.total, 2);
    const search = await (await fetch(srv.base + '/skills/index?search=word')).json();
    assert.equal(search.total, 1);
    const p1 = await (await fetch(srv.base + '/skills/index?limit=2&page=1')).json();
    assert.equal(p1.entries.length, 2); assert.equal(p1.total, 3);
    const p2 = await (await fetch(srv.base + '/skills/index?limit=2&page=2')).json();
    assert.equal(p2.entries.length, 1);
  } finally { await srv.stop(); }
});

test('revoke is author-signed + permanent (detail → 410); a bad signature is refused (403)', async () => {
  const srv = await startServer();
  try {
    const k = await newKey();
    const env = await signEnvelope(k, 'gh-sync', 'tool', ['network:api.github.com']);
    const id = (await (await post(srv.base, '/skills/publish', env)).json()).skillId;
    // a forged revoke (wrong key) is refused
    const bad = await newKey();
    const ts = Date.now();
    const badSig = b64(new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, bad.kp.privateKey, Buffer.from('REVOKE:' + id + ts))));
    const r403 = await post(srv.base, '/skills/revoke/' + id, { signature: badSig, timestamp: ts });
    assert.equal(r403.status, 403);
    assert.equal((await (await fetch(srv.base + '/skills/index/' + id)).json()).envelope.skill.name, 'gh-sync'); // still live
    // the real author revokes
    const sig = b64(new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, k.kp.privateKey, Buffer.from('REVOKE:' + id + ts))));
    const ok = await post(srv.base, '/skills/revoke/' + id, { signature: sig, timestamp: ts });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(srv.base + '/skills/index/' + id)).status, 410); // permanent
    assert.equal((await (await fetch(srv.base + '/skills/index')).json()).total, 0); // dropped from listing
  } finally { await srv.stop(); }
});

test('report queues without auto-block (201); the skill stays live', async () => {
  const srv = await startServer();
  try {
    const k = await newKey();
    const id = (await (await post(srv.base, '/skills/publish', await signEnvelope(k, 'gh-sync', 'tool', ['network:api.github.com']))).json()).skillId;
    const rep = await post(srv.base, '/skills/report/' + id, { reason: 'looks phishy' });
    assert.equal(rep.status, 201);
    assert.equal((await fetch(srv.base + '/skills/index/' + id)).status, 200); // NOT auto-blocked
  } finally { await srv.stop(); }
});

test('detail 404 for unknown skillId; index read carries nosniff', async () => {
  const srv = await startServer();
  try {
    assert.equal((await fetch(srv.base + '/skills/index/Zm9vYmFy')).status, 404);
    const idx = await fetch(srv.base + '/skills/index');
    assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  } finally { await srv.stop(); }
});
