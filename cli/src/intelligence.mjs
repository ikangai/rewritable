// I-C (intelligence/0.2 §6) — `rwa intelligence new <role>`: mint a signed rwa-agent/1 role and
// scaffold a CARRIER rewritable (a skill-host holding the record + a self-describing card). The
// carrier ships only the PUBLIC key + signature; the PRIVATE key is written to a sibling .key.json
// (keep it to publish updates under the same author identity). Offline; reuses the agent canon
// (skill-manifest) and the seed bootstrap (seed.mjs) — no new wire-type, no canon fork.
import fs from 'node:fs/promises';
import path from 'node:path';
import { webcrypto, randomUUID } from 'node:crypto';
import { SEED_CANDIDATES } from './commands.mjs';
import { loadSeed, applySeedSubs, kindOverrides, replaceInlineDoc } from './seed.mjs';
import { validateAgentReferences, MAX_AGENT_REFERENCES, MAX_AGENT_REFERENCE_BYTES } from './skill-manifest.mjs';
import { agentSigningMessage } from './skill-manifest.mjs';

const ROLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REC_MODEL_RE = /^[A-Za-z0-9._:\/-]{1,200}$/;
const REC_BACKENDS = ['openrouter', 'ollama', 'lmstudio', 'atomic', 'bridge', 'bridge-session'];
const b64 = (u8) => Buffer.from(u8).toString('base64');
const rel = (p) => path.relative(process.cwd(), p) || p;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fail = (msg, code = 2) => { const e = new Error(msg); e.exitCode = code; throw e; };

export async function intelligenceNewCmd(opts = {}) {
  const role = opts.role, prompt = opts.prompt;
  if (!role || !ROLE_RE.test(role)) fail('intelligence: <role> must be lowercase a-z0-9_- (≤64, leading alphanumeric)');
  if (!prompt || typeof prompt !== 'string') fail('intelligence: --prompt "<system prompt>" is required');
  if (prompt.includes('`') || prompt.includes('${') || /<\/?DOC>/i.test(prompt)) fail('intelligence: --prompt must not contain ` ${ or <DOC>');
  if (opts.model != null && !REC_MODEL_RE.test(String(opts.model))) fail('intelligence: --model is not a valid model id');
  if (opts.backend != null && !REC_BACKENDS.includes(String(opts.backend))) fail('intelligence: --backend must be one of ' + REC_BACKENDS.join('/'));
  const vault = (opts.vault || []).map(v => /^vault:/.test(v) ? v : 'vault:' + v);
  // #45 — carried references (Agent Skills' progressive disclosure). Read from
  // disk here so the carrier is genuinely self-contained: the recipient gets the
  // bytes, not a link that may be gone. Names are the BASENAME only — a reference
  // is a label, never a path.
  const references = [];
  for (const f of (opts.reference || [])) {
    const abs = path.resolve(String(f));
    let content;
    try { content = await fs.readFile(abs, 'utf8'); }
    catch (e) { fail('intelligence: cannot read --reference ' + rel(abs) + (e && e.code === 'ENOENT' ? ' (not found)' : '')); }
    references.push({ name: path.basename(abs), content });
  }
  const refErrors = validateAgentReferences(references);
  if (refErrors.length) {
    // Fail at AUTHORING, where the message can name the real problem — not at
    // some later commit as a target_size_exceeded nobody can trace back here.
    fail('intelligence: references rejected (' + refErrors.join(', ') + '). ' +
      'Limits: ' + MAX_AGENT_REFERENCES + ' files, ' + Math.round(MAX_AGENT_REFERENCE_BYTES / 1024) + ' KB total; ' +
      'names must be simple filenames. They ride inside the container and count against its document budget.');
  }
  const affinity = (opts.affinity || []).filter(Boolean);

  // Mint + sign the rwa-agent/1 record. The signature is over `agent` (the canon); the
  // recommendation/affinity ride OUTSIDE it (unsigned envelope fields, per I-A/I-D).
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const author_pubkey = b64(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
  // The record is v2 ONLY when it actually carries references. A carrier with
  // none stays rwa-agent/1, so nothing about existing carriers or their
  // signatures changes gratuitously — the version marks a real difference in what
  // is signed, not a release date.
  const agent = references.length
    ? { author_pubkey, description: opts.description || ('The ' + role + ' role.'), references, role, system_prompt: prompt, vault_namespace_set: vault, version: 'rwa-agent/2' }
    : { author_pubkey, description: opts.description || ('The ' + role + ' role.'), role, system_prompt: prompt, vault_namespace_set: vault, version: 'rwa-agent/1' };
  const signature = b64(new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, agentSigningMessage(agent))));
  const envelope = { agent, signature };
  if (opts.model) envelope.recommended_model = String(opts.model);
  if (opts.backend) envelope.recommended_backend = String(opts.backend);
  if (affinity.length) envelope.affinity = affinity;

  // Scaffold the carrier — a skill-host bootstrap + card + frozen #rwa-agents zone.
  const out = path.resolve(opts.outPath || ('./' + role + '.intelligence.html'));
  if (!opts.force) { let exists = false; try { await fs.access(out); exists = true; } catch (_) {} if (exists) fail('intelligence: ' + rel(out) + ' exists (use --force)'); }
  const seed = await loadSeed(SEED_CANDIDATES);
  const ov = kindOverrides('skill-host');
  let result = applySeedSubs(seed, { uuid: randomUUID(), title: 'Intelligence — ' + role, fileMeta: path.basename(out), productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  const zone = '<div data-rwa-frozen id="rwa-agents"><script type="application/rwa-agent+json">' + b64(Buffer.from(JSON.stringify(envelope))) + '</script></div>';
  result = replaceInlineDoc(result, buildCard({ role, prompt, model: opts.model, backend: opts.backend, affinity, vault }) + '\n' + zone);
  await fs.writeFile(out, result, 'utf8');

  // The private key — needed to re-sign updates under the same author identity. Sibling file, loud.
  const fingerprint = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(author_pubkey, 'base64'))).toString('hex').slice(0, 16);
  const keyOut = out.replace(/\.html?$/i, '') + '.key.json';
  // 0600: the file holds the PRIVATE key — owner read/write only, never world-readable.
  await fs.writeFile(keyOut, JSON.stringify({
    role, author_pubkey, fingerprint,
    private_key_pkcs8_b64: b64(new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey))),
    warning: 'SECRET. Keep this to publish updates to this intelligence under the same author identity. Never commit or share it. The carrier .html holds only the public key.',
  }, null, 2) + '\n', { mode: 0o600 });
  try { await fs.chmod(keyOut, 0o600); } catch (_) {} // guarantee owner-only even if the file pre-existed (writeFile mode applies only on create; best-effort on non-POSIX)

  console.log('wrote ' + rel(out) + ' (intelligence "' + role + '")');
  console.log('author ' + fingerprint + ' — private key saved to ' + rel(keyOut) + ' (keep secret; needed to update this intelligence)');
  return { out, keyOut, fingerprint, envelope };
}

function buildCard({ role, prompt, model, backend, affinity, vault }) {
  const recLine = model ? '\n<li><strong>Recommended model:</strong> <code>' + esc(model) + '</code>' + (backend ? ' on <code>' + esc(backend) + '</code>' : '') + ' — offered on activation, behind consent (your session only; key untouched).</li>' : '';
  const affLine = affinity.length ? '\n<li><strong>Affinity:</strong> ' + esc(affinity.join(', ')) + ' (advisory — a mismatch only warns).</li>' : '';
  const vaultLine = '\n<li><strong>Vault namespaces:</strong> ' + (vault.length ? esc(vault.join(', ')) : 'none') + '.</li>';
  return '<article>\n' +
    '<h1>Intelligence — &ldquo;' + esc(role) + '&rdquo;</h1>\n' +
    '<p class="lede">A droppable <strong>intelligence</strong> (intelligence/0.2): a signed <code>rwa-agent/1</code> role you can drop onto another rewritable to retune its &#8984;K editor. This file is the carrier — open it, read it, drop it.</p>\n' +
    '<h2>What it does</h2>\n<p>' + esc(prompt) + '</p>\n' +
    '<h2>What it carries</h2>\n<ul>\n<li><strong>Role:</strong> <code>' + esc(role) + '</code></li>' + recLine + affLine + vaultLine + '\n</ul>\n' +
    '<h2>How to use it</h2>\n<p>Drop this file onto another rewritable to install the role (behind the consent dialog), then activate it from the &ldquo;AI&rdquo; chip in the status bar. This carrier is itself a skill-host, so the role is already installed here — try it directly.</p>\n' +
    '</article>';
}
