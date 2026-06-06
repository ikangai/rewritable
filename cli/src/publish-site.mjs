// `rwa publish-site <file>` — copy a self-contained rewritable VERBATIM onto a
// static site over scp, and print the live URL. The durable counterpart to
// `rwa publish` (an ephemeral 24h service share). Because a rewritable is already
// one self-contained .html, we publish the bytes unchanged — no hosted projection.
//
// Design: docs/plans/2026-06-06-ikangai-custom-publish-design.md.
//
// Online by design (the offline-first invariant of new/import does not apply to
// a publish action). Failure surface mirrors publish.mjs: local file problems
// reuse the CliError `file_error` codes (exit 2); missing config / bad name are
// usage-class (exit 1); every transport failure is exit 4 (the bin labels exit 4
// `publish_error`). The transport is injected ({execFile}) so tests run offline.

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractInlineDoc } from './seed.mjs';
import { CliError } from './edit.mjs';

// A publishable remote name: a plain filename ending in .html. basename() already
// strips any directory, so this only has to reject names that survive basename and
// could still inject shell tokens or be otherwise unsafe. No leading dot, no
// path/space/metacharacters. (basename of '../../x.html' is 'x.html' — safe.)
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

/**
 * @param {string} filePath
 * @param {{host?:string, path?:string, url?:string}} [opts] flag overrides
 * @param {{execFile?:Function, env?:object}} [deps] injection seam for tests
 * @returns {Promise<{name:string, url:string, remoteSpec:string}>}
 * @throws {CliError} 2 file_error · 1 config_error/invalid_name · 4 transport
 */
export async function publishSite(filePath, opts = {}, deps = {}) {
  const env = deps.env || process.env;
  const execFile = deps.execFile || promisify(_execFile);

  // 1. Read + validate — identical CliError file_error surface to publish.mjs.
  let bytes;
  try {
    bytes = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }
  try {
    extractInlineDoc(bytes);
  } catch {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  // 2. Config: flags override env; nothing is baked into the package.
  const host = opts.host || env.RWA_SITE_HOST;
  const remotePath = opts.path || env.RWA_SITE_PATH;
  const urlBase = opts.url || env.RWA_SITE_URL;
  const missing = [];
  if (!host) missing.push('RWA_SITE_HOST');
  if (!remotePath) missing.push('RWA_SITE_PATH');
  if (!urlBase) missing.push('RWA_SITE_URL');
  if (missing.length) throw new CliError(1, 'config_error', { missing });

  // 3. Remote name: basename only, then allowlist. Stops path traversal AND
  //    shell-token injection at the same gate.
  const name = basename(filePath);
  if (!SAFE_NAME.test(name)) throw new CliError(1, 'invalid_name', { name });

  // 4. Transport — added in a later task. For now, assemble the spec + result.
  const remoteDir = remotePath.replace(/\/+$/, '');
  const remoteSpec = `${host}:${remoteDir}/${name}`;

  // 5. Result.
  const url = `${urlBase.replace(/\/+$/, '')}/${name}`;
  return { name, url, remoteSpec };
}
