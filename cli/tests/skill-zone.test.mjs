// TDD — parseSkillZone: static read of installed skills from the frozen #rwa-skills zone.
// Spec: docs/specs/re-write-able-actions-spec-v0.8.md §8 (static projection) + §7 (zone form).
// Refinement: each envelope is base64-encoded inside its <script> block so it round-trips through
// escapeForTL / frozen-snapshot / div-scoping with no </script>|</div>|backtick|${ landmines (X1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { parseSkillZone, skillId, signingMessage } from '../src/skill-manifest.mjs';

async function makeSigned(name, kind, permissions, code) {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const author_pubkey = Buffer.from(rawPub).toString('base64');
  const manifest = { name, version: '1.0.0', kind, permissions, author_pubkey };
  const msg = signingMessage(manifest, code);
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, msg));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };
}

function scriptBlock(envelope) {
  return `<script type="application/rwa-skill+json">${Buffer.from(JSON.stringify(envelope)).toString('base64')}</script>`;
}
function docWithZone(...blocks) {
  return `<article><h1>Skills</h1></article>\n<div data-rwa-frozen id="rwa-skills">${blocks.join('')}</div>`;
}

test('absent zone → empty list', async () => {
  assert.deepEqual(parseSkillZone('<article><h1>no skills here</h1></article>'), []);
});

test('empty zone → empty list', async () => {
  assert.deepEqual(parseSkillZone(docWithZone()), []);
});

test('a signed tool is reported verified, with skillId + provenance', async () => {
  const env = await makeSigned('gh-stars', 'tool', ['network:api.github.com'], 'async function run(i,r){return r.fetch("https://api.github.com")}');
  const list = parseSkillZone(docWithZone(scriptBlock(env)));
  assert.equal(list.length, 1);
  const expectedId = skillId('gh-stars', env.skill.author_pubkey);
  assert.deepEqual(list[0], {
    skillId: expectedId, kind: 'tool', name: 'gh-stars', verified: true, provenance: 'installed',
  });
});

test('an unsigned compute skill is reported verified:false', async () => {
  const env = { format: 'rwa-skill/1', skill: { name: 'word-count', version: '1.0.0', kind: 'compute', permissions: [], author_pubkey: 'UEsx', code: 'async function run(i){return i.length}' } };
  const list = parseSkillZone(docWithZone(scriptBlock(env)));
  assert.equal(list.length, 1);
  assert.equal(list[0].verified, false);
  assert.equal(list[0].kind, 'compute');
});

test('tampering the stored code after signing flips verified to false', async () => {
  const env = await makeSigned('gh-stars', 'tool', ['network:api.github.com'], 'async function run(i,r){return 1}');
  const tampered = { ...env, skill: { ...env.skill, code: env.skill.code + '/* evil */' } };
  const list = parseSkillZone(docWithZone(scriptBlock(tampered)));
  assert.equal(list[0].verified, false);
});

test('a malformed block is skipped; valid siblings still parse', async () => {
  const good = await makeSigned('a', 'compute', [], 'async function run(){}');
  const bad = '<script type="application/rwa-skill+json">!!!not-base64-or-json!!!</script>';
  const list = parseSkillZone(docWithZone(bad, scriptBlock(good)));
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'a');
});

test('SECURITY: a skill <script> OUTSIDE the frozen zone is ignored (agent cannot forge via doc text)', async () => {
  const inside = await makeSigned('real', 'compute', [], 'async function run(){}');
  const forged = await makeSigned('forged', 'tool', ['network:api.evil.com'], 'async function run(){}');
  // forged block sits in the editable article, NOT in the #rwa-skills frozen div
  const doc = `<article><h1>doc</h1>${scriptBlock(forged)}</article>\n<div data-rwa-frozen id="rwa-skills">${scriptBlock(inside)}</div>`;
  const list = parseSkillZone(doc);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'real');
});

test('multiple skills in the zone are all returned', async () => {
  const a = await makeSigned('a', 'compute', [], 'async function run(){return 1}');
  const b = await makeSigned('b', 'tool', ['vault:x'], 'async function run(i,r){return r.vault.get("x")}');
  const list = parseSkillZone(docWithZone(scriptBlock(a), scriptBlock(b)));
  assert.deepEqual(list.map(s => s.name).sort(), ['a', 'b']);
});
