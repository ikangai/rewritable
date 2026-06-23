// `rwa skill publish <file.rwa-skill.json>` — publish a signed skill envelope to the marketplace
// index (`POST /skills/publish`, service/server.js, I6 §11) and return its registry URL.
//
// A THIN client: the envelope is ALREADY signed (no private key needed to publish — the signature
// travels in the envelope). The local verify here is fail-fast only; the server re-validates
// authoritatively (verifyEnvelope + validateInstall). Intentionally ONLINE (offline-first excludes
// it, like `rwa publish`/`clone`). Failure surface mirrors `rwa publish`: exit 2 file_error, exit 3
// for a gate failure (unsigned/compute_with_permissions), exit 4 for every remote/network failure.
import { readFile } from 'node:fs/promises';
import { CliError } from './edit.mjs';
import { verifyEnvelope, validateInstall } from './skill-manifest.mjs';

export const DEFAULT_SKILLS_URL = 'https://rewritable.ikangai.com';

/**
 * @param {string} filePath  a .rwa-skill.json envelope
 * @param {{ baseUrl?: string, fetchImpl?: Function }} [opts]  fetchImpl is injected in tests
 * @returns {Promise<{skillId:string, registryUrl:string, verified:boolean}>}
 * @throws {CliError} 2 file_error · 3 gate failure · 4 publish_error
 */
export async function skillPublishCmd(filePath, { baseUrl, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let bytes;
  try { bytes = await readFile(filePath, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }
  let env;
  try { env = JSON.parse(bytes); } catch { throw new CliError(2, 'not_a_skill', { path: filePath, reason: 'invalid_json' }); }
  if (!env || env.format !== 'rwa-skill/1' || !env.skill || typeof env.skill.name !== 'string') {
    throw new CliError(2, 'not_a_skill', { path: filePath });
  }
  // Local fail-fast gate — the same codes the server returns (avoids a wasted round trip + works offline).
  const { signed, verified } = verifyEnvelope(env);
  const gate = validateInstall(env, { signed, verified });
  if (!gate.ok) throw new CliError(3, gate.errors[0], { errors: gate.errors });

  const base = (baseUrl || DEFAULT_SKILLS_URL).replace(/\/+$/, '');
  const endpoint = `${base}/skills/publish`;
  let res;
  try { res = await doFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) }); }
  catch (e) { throw new CliError(4, 'network_error', { url: endpoint, message: (e && e.message) || String(e) }); }

  const text = await res.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }

  if (res.status === 201) {
    if (!payload || typeof payload.skillId !== 'string') throw new CliError(4, 'server_error', { status: 201, error: 'malformed_success_response' });
    return { skillId: payload.skillId, verified: !!payload.verified, registryUrl: base + (payload.registryUrl || '/skills/index/' + payload.skillId) };
  }
  const errName = payload && typeof payload.error === 'string' ? payload.error : null;
  if (res.status === 422) throw new CliError(3, errName || 'validation_failed', { errors: payload && payload.errors });
  if (res.status === 429 || errName === 'rate_limited') throw new CliError(4, 'rate_limited', { retryAfterSec: payload && payload.retryAfterSec });
  if (res.status === 410) throw new CliError(4, 'revoked', {});
  if (res.status >= 500) throw new CliError(4, 'server_error', { status: res.status, error: errName });
  throw new CliError(4, 'unexpected_status', { status: res.status, error: errName });
}
