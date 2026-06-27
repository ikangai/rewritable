// I-C (intelligence/0.2 §6) — `rwa intelligence new <role>` scaffolds a signed carrier.
// The carrier holds a genuinely-signed rwa-agent/1 record + the unsigned I-A/I-D fields; the
// private key goes to a sibling file and is NEVER in the carrier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intelligenceNewCmd } from '../src/intelligence.mjs';
import { verifyAgentEnvelope } from '../src/skill-manifest.mjs';

// Extract the agent envelope from a carrier's INLINE_DOC (un-escape, then parse the #rwa-agents zone).
function carrierEnvelope(html) {
  const m = 'const INLINE_DOC = `'; const i = html.indexOf(m);
  let j = i + m.length; for (; j < html.length; j++) { const c = html[j]; if (c === '\\') { j++; continue; } if (c === '`') break; }
  const doc = html.slice(i + m.length, j).replace(/\\([\s\S])/g, '$1');
  const b = doc.match(/<script\s+type="application\/rwa-agent\+json">([\s\S]*?)<\/script>/)[1].trim();
  return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
}
const tmp = () => mkdtempSync(join(tmpdir(), 'rwa-intel-'));

test('mints a signed carrier with recommendation + affinity + vault', async () => {
  const out = join(tmp(), 'concise.intelligence.html');
  const r = await intelligenceNewCmd({ role: 'concise', prompt: 'Be concise.', description: 'Tightens prose.', model: 'anthropic/claude-sonnet-4-6', backend: 'openrouter', affinity: ['document'], vault: ['secrets'], outPath: out });
  const html = readFileSync(out, 'utf8');
  const env = carrierEnvelope(html);

  assert.equal(env.agent.role, 'concise');
  assert.equal(env.agent.system_prompt, 'Be concise.');
  assert.deepEqual(env.agent.vault_namespace_set, ['vault:secrets']);   // bare ns prefixed to vault:
  assert.equal(env.recommended_model, 'anthropic/claude-sonnet-4-6');
  assert.equal(env.recommended_backend, 'openrouter');
  assert.deepEqual(env.affinity, ['document']);

  const v = verifyAgentEnvelope(env);
  assert.ok(v.signed && v.verified, 'the carried record is genuinely signed and verifies');

  assert.match(html, /PRODUCT_KIND = 'skill-host'/, 'carrier is a skill-host');
  assert.match(html, /Be concise\./, 'the card describes the role');

  const key = JSON.parse(readFileSync(r.keyOut, 'utf8'));
  assert.equal(key.role, 'concise');
  assert.equal(key.author_pubkey, env.agent.author_pubkey);
  assert.ok(key.private_key_pkcs8_b64 && /SECRET/.test(key.warning), 'key file carries the private key + a warning');
  assert.ok(!html.includes(key.private_key_pkcs8_b64), 'the private key is NEVER in the carrier');
});

test('minimal carrier (no model/affinity/vault) still verifies', async () => {
  const out = join(tmp(), 'plain.intelligence.html');
  await intelligenceNewCmd({ role: 'plain', prompt: 'Do the thing.', outPath: out });
  const env = carrierEnvelope(readFileSync(out, 'utf8'));
  assert.equal(env.recommended_model, undefined);
  assert.equal(env.affinity, undefined);
  assert.deepEqual(env.agent.vault_namespace_set, []);
  assert.ok(verifyAgentEnvelope(env).verified);
});

test('validation: missing prompt / bad role / injection / bad backend → exit 2', async () => {
  const d = tmp();
  await assert.rejects(() => intelligenceNewCmd({ role: 'x', outPath: join(d, 'a.html') }), /prompt/);
  await assert.rejects(() => intelligenceNewCmd({ role: 'Bad Role', prompt: 'p', outPath: join(d, 'b.html') }), /role/);
  await assert.rejects(() => intelligenceNewCmd({ role: 'x', prompt: 'has ${ bad', outPath: join(d, 'c.html') }), /\$\{/);
  await assert.rejects(() => intelligenceNewCmd({ role: 'x', prompt: 'ok', backend: 'evil', outPath: join(d, 'e.html') }), /backend/);
});
