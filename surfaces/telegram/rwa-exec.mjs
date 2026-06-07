// `rwa` CLI shell-out helpers for the Telegram adapter.
//
// The bot reimplements NO rewritable logic — it shells out to the installed `rwa`
// CLI (the operations-API rule: route to the contract). This module wraps those
// subprocess calls for the two create paths:
//   - wrap:       a file → `rwa import` → `rwa publish`        (rwaImportPublish)
//   - agent-fill: a prompt → `rwa create` → `rwa publish`      (rwaCreatePublish)
//
// SECURITY — no shell, ever. Every byte from Telegram is attacker-controlled, so
// the single load-bearing invariant here (mirroring `cli/src/publish-site.mjs`)
// is: ALL subprocess calls go through `execFile(cmd, [argsArray], options)` with
// an ARGUMENT ARRAY — never a built command string, never `shell:true`. A user's
// file path or `/new` prompt is therefore a literal argv element, never parsed by
// a shell, so `; rm -rf ~` can only ever be the *name* of a file or the *text* of
// a prompt — never a command. The argv-array assertions in the test ARE this
// property; if anyone reintroduces string-concatenation they fail loudly.
//
// Both functions take `deps = { execFile, ... }` and return a RESULT OBJECT —
// they never throw on a CLI failure, they capture it ({ ok:false, step, code,
// stderr }) so the caller can turn it into a friendly Telegram reply (Rule 12:
// fail loud, but as data, not an exception that kills the poll loop).

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm as _rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const defaultExecFile = promisify(_execFile);

/**
 * Resolve the `rwa` invocation ONCE, from the environment.
 *
 * - `RWA_BIN` set → run it as `node <RWA_BIN> <verb> …` (so a checked-out repo /
 *   non-global install works without a PATH entry). `cmd` is the current node.
 * - else → the `rwa` binary on PATH.
 *
 * Returned as `{ cmd, baseArgs }` so the verb-specific args append to `baseArgs`.
 * Exposed (and injectable via `deps.rwaCmd`) so tests see a deterministic `cmd`.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ cmd: string, baseArgs: string[] }}
 */
export function resolveRwaCmd(env = process.env) {
  if (env && env.RWA_BIN) {
    return { cmd: process.execPath, baseArgs: [env.RWA_BIN] };
  }
  return { cmd: 'rwa', baseArgs: [] };
}

// Parse the share URL out of `rwa publish` stdout. The human output prints a line
// like `  URL:     https://abc.rewritable.ikangai.com/`; we take the first http(s)
// URL we see. (The `--json` shape is avoided on purpose — one approach, tested.)
function parsePublishUrl(stdout) {
  const m = /(https?:\/\/\S+)/.exec(stdout || '');
  return m ? m[1] : null;
}

// Normalize a thrown execFile rejection into the failure object's fields. node's
// promisified execFile rejects with an Error carrying `.code` (the exit code) and
// `.stderr` (captured bytes). We pass them through verbatim — full stderr is the
// caller's to log host-side; it is NEVER thrown.
function failure(step, err) {
  return {
    ok: false,
    step,
    code: err && err.code !== undefined ? err.code : null,
    stderr: (err && err.stderr) || '',
  };
}

// Run `rwa publish <container>` and parse the URL. Shared by both paths. Returns
// `{ ok:true, url }` or a failure object (step:'publish'). `no_url` is its own
// code: the publish succeeded but we couldn't find a link to reply with.
async function runPublish(execFile, cmd, baseArgs, container) {
  let out;
  try {
    out = await execFile(cmd, [...baseArgs, 'publish', container], {});
  } catch (err) {
    return failure('publish', err);
  }
  const url = parsePublishUrl(out && out.stdout);
  if (!url) return { ok: false, step: 'publish', code: 'no_url', stderr: '' };
  return { ok: true, url };
}

/**
 * Wrap path: import a local file into a rewritable, then publish it.
 *
 * `rwa import <filePath> <tmpOut>` then `rwa publish <tmpOut>`. The output
 * container is written to a fresh temp dir under `os.tmpdir()` and removed in a
 * `finally`, so nothing accumulates on the host.
 *
 * @param {string} filePath  attacker-controlled — passed as ONE argv element.
 * @param {{execFile?:Function, rwaCmd?:Function, env?:object, tmpDir?:Function, rm?:Function}} [deps]
 * @returns {Promise<{ok:true,url:string}|{ok:false,step:'import'|'publish',code:any,stderr:string}>}
 */
export async function rwaImportPublish(filePath, deps = {}) {
  const execFile = deps.execFile || defaultExecFile;
  const { cmd, baseArgs } = (deps.rwaCmd || resolveRwaCmd)(deps.env || process.env);
  const makeTmp = deps.tmpDir || (() => mkdtemp(join(tmpdir(), 'rwa-tg-')));
  const rm = deps.rm || ((dir) => _rm(dir, { recursive: true, force: true }));

  const dir = await makeTmp();
  try {
    const container = join(dir, `${randomUUID()}.html`);
    try {
      await execFile(cmd, [...baseArgs, 'import', filePath, container], {});
    } catch (err) {
      return failure('import', err);
    }
    return await runPublish(execFile, cmd, baseArgs, container);
  } finally {
    await rm(dir);
  }
}

/**
 * Agent-fill path: generate a rewritable from a prompt, then publish it.
 *
 * GATED on a backend key (`deps.hasBackendKey`). With no key we return
 * `{ ok:false, code:'agent_not_configured' }` WITHOUT spawning anything — the
 * test asserts execFile is never called and no temp dir is created.
 *
 * `rwa create "<prompt>" --out <tmpOut>` then `rwa publish <tmpOut>`. The prompt
 * is ONE argv element (the security property); `--out` controls the output path
 * deterministically into our temp dir.
 *
 * @param {string} prompt  attacker-controlled — passed as ONE argv element.
 * @param {{execFile?:Function, hasBackendKey?:boolean, rwaCmd?:Function, env?:object, tmpDir?:Function, rm?:Function}} deps
 * @returns {Promise<{ok:true,url:string}|{ok:false,code?:string,step?:'create'|'publish',stderr?:string}>}
 */
export async function rwaCreatePublish(prompt, deps = {}) {
  // The gate FIRST — before any temp dir or subprocess. No key → no spawn.
  if (!deps.hasBackendKey) {
    return { ok: false, code: 'agent_not_configured' };
  }

  const execFile = deps.execFile || defaultExecFile;
  const { cmd, baseArgs } = (deps.rwaCmd || resolveRwaCmd)(deps.env || process.env);
  const makeTmp = deps.tmpDir || (() => mkdtemp(join(tmpdir(), 'rwa-tg-')));
  const rm = deps.rm || ((dir) => _rm(dir, { recursive: true, force: true }));

  const dir = await makeTmp();
  try {
    const container = join(dir, `${randomUUID()}.html`);
    try {
      await execFile(cmd, [...baseArgs, 'create', prompt, '--out', container], {});
    } catch (err) {
      return failure('create', err);
    }
    return await runPublish(execFile, cmd, baseArgs, container);
  } finally {
    await rm(dir);
  }
}
