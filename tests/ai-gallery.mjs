// AI Gallery carrier integrity (#26).
//
// WHY: the gallery ships SIGNED intelligences that people download and drop onto
// their own documents. Every carrier is also a rewritable, so it is re-bootstrapped
// by tools/regenerate-refs.mjs on every seed change — and that regeneration must
// preserve the signed record byte-for-byte. If it ever doesn't, the carrier still
// LOOKS fine (it opens, it renders, it downloads) and simply fails to verify on
// the receiving end, which is the worst possible failure shape for a trust
// artefact: silent, and only visible to the person who trusted it.
//
// So this verifies the actual Ed25519 signature of every carrier in the gallery,
// against the same canon the CLI signs with. Model-free, offline, fast.
//
// Run:  (cd tests && node ai-gallery.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractInlineDoc } from '../cli/src/seed.mjs';
import { agentSigningMessage } from '../cli/src/skill-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARRIERS = path.join(__dirname, '..', 'service', 'public', 'ai', 'carriers');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL', label); }
};

// The record lives base64'd in the frozen #rwa-agents zone, exactly as the
// runtime's readTrustworthyAgents finds it.
function readEnvelope(html) {
  const doc = extractInlineDoc(html);
  const m = doc.match(/<script type="application\/rwa-agent\+json">([A-Za-z0-9+/=]+)<\/script>/);
  if (!m) return null;
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

const files = fs.readdirSync(CARRIERS).filter(f => /\.intelligence\.html$/.test(f)).sort();

console.log('== G1: every gallery carrier carries a verifiable signature ==');
check('the gallery is not empty', files.length > 0);
console.log(`       ${files.length} carriers: ${files.map(f => f.replace('.intelligence.html', '')).join(', ')}`);

const roles = new Map();
for (const f of files) {
  const html = fs.readFileSync(path.join(CARRIERS, f), 'utf8');
  const env = readEnvelope(html);
  const name = f.replace('.intelligence.html', '');
  if (!env || !env.agent || !env.signature) { check(`${name}: has an rwa-agent/1 record`, false); continue; }

  // Re-derive the signed bytes from the record's own agent object and check the
  // signature against the author key it names. A regeneration that mangled ANY
  // signed field — role, prompt, description, pubkey — fails here.
  const key = await webcrypto.subtle.importKey(
    'raw', Buffer.from(env.agent.author_pubkey, 'base64'),
    { name: 'Ed25519' }, false, ['verify']);
  const okSig = await webcrypto.subtle.verify(
    { name: 'Ed25519' }, key,
    Buffer.from(env.signature, 'base64'),
    agentSigningMessage(env.agent));
  check(`${name}: Ed25519 signature verifies against its own author key`, okSig === true);
  check(`${name}: the filename matches the signed role`, env.agent.role === name);
  check(`${name}: has a description a person can read before trusting it`,
    typeof env.agent.description === 'string' && env.agent.description.length > 12);
  roles.set(name, env);
}

console.log('\n== G2: the two advisors recommend no model, on purpose ==');
// An advisor layers ON TOP of whichever AI is already driving the document, and
// the PRIMARY role owns the model choice. A carrier that both advises and pushes
// a model would silently retune the document's main editor as a side effect of
// adding a second opinion.
for (const name of ['print-aware', 'house-style']) {
  const env = roles.get(name);
  check(`${name}: present in the gallery`, !!env);
  if (!env) continue;
  check(`${name}: recommends no model (the primary owns that choice)`,
    env.recommended_model == null || env.recommended_model === '');
  check(`${name}: its prompt is substantive, not a slogan`,
    typeof env.agent.system_prompt === 'string' && env.agent.system_prompt.length > 400);
  check(`${name}: asks for no vault access`,
    Array.isArray(env.agent.vault_namespace_set) && env.agent.vault_namespace_set.length === 0);
}

console.log('\n== G3: the advisors teach what the runtime actually implements ==');
// The print advisor is only useful if the vocabulary it teaches exists. This is
// the same cross-site trap tests/print.mjs exists for, one step further out: a
// rename in the print CSS would leave this carrier teaching dead classes to
// every document it is dropped on.
const seed = fs.readFileSync(path.join(__dirname, '..', 'seeds', 'rewritable.html'), 'utf8');
const printPrompt = roles.get('print-aware')?.agent.system_prompt || '';
for (const cls of ['print-break', 'print-keep', 'no-print', 'print-only']) {
  check(`print-aware teaches "${cls}" and the seed's print CSS defines it`,
    printPrompt.includes(cls) && seed.includes('.' + cls + '{'));
}
check('print-aware repeats the runtime\'s own warning against position:fixed running headers',
  /position:fixed/.test(printPrompt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
