// Tests for rwa-exec.mjs — the `rwa` CLI shell-out helpers.
//
// SECURITY is the point of this module: every byte from Telegram is attacker-
// controlled and we spawn subprocesses, so the load-bearing invariant is "no
// shell, ever — argv arrays only". Untrusted file paths and prompts must reach
// `execFile` as ONE element of the argument array, never concatenated into a
// command string, and no call may use a shell (`shell:true` / `/bin/sh`).
//
// Every test injects a fake `execFile` that RECORDS each call as
// `{ cmd, args, options }` and replays a scripted result. That recording is what
// lets the security tests actually PROVE the property — a test that merely
// checked "didn't throw" couldn't fail when someone reintroduces string-concat
// (Rule 9). The whole suite runs offline: no real `rwa`, no network, no real disk
// (a `tmpDir`/`rm` seam stands in for the temp directory).

import test from 'node:test';
import assert from 'node:assert/strict';
import { rwaImportPublish, rwaCreatePublish, resolveRwaCmd } from './rwa-exec.mjs';

// A fake execFile that records every invocation and replays a scripted result.
// Each script is keyed by the VERB (args[baseArgs.length] effectively — but since
// our cmd is deterministic we just match on the verb appearing in args). Simpler:
// a queue of results, each `{ stdout, stderr }` to resolve OR an Error to reject.
function makeFakeExec(byVerb) {
  const calls = [];
  const execFile = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    // The verb is the first NON-flag arg after any leading script path. When
    // RWA_BIN is used the args are [<binPath>, <verb>, …]; on PATH they are
    // [<verb>, …]. Find the first arg that matches a known verb.
    const verb = args.find((a) => byVerb[a] !== undefined);
    const scripted = verb != null ? byVerb[verb] : undefined;
    if (scripted === undefined) {
      throw new Error(`fake execFile: no script for verb in ${JSON.stringify(args)}`);
    }
    if (scripted instanceof Error) throw scripted;
    if (typeof scripted === 'function') return scripted();
    return scripted;
  };
  return { execFile, calls };
}

// A rejection shaped like node's promisified execFile: an Error with .code /
// .stderr attached (node sets .code to the exit code, .stderr to captured bytes).
function execFailure(code, stderr) {
  const e = new Error(`Command failed (exit ${code})`);
  e.code = code;
  e.stderr = stderr;
  return e;
}

// A deterministic temp-dir seam: hands back a fixed path and records removal so a
// test can assert cleanup happened. No real disk touched.
function makeTmpSeam() {
  const removed = [];
  const created = [];
  let n = 0;
  const tmpDir = async () => {
    const dir = `/fake-tmp/rwa-tg-${n++}`;
    created.push(dir);
    return dir;
  };
  const rm = async (dir) => { removed.push(dir); };
  return { tmpDir, rm, removed, created };
}

const PUBLISH_STDOUT =
  '✓ Published!\n' +
  '  URL:     https://abc.rewritable.ikangai.com/\n' +
  '  Expires: in 24 hours (anonymous share)\n';

// A baseline deps set for the happy wrap path.
function happyWrapDeps() {
  const seam = makeTmpSeam();
  const { execFile, calls } = makeFakeExec({
    import: { stdout: 'wrote out.html', stderr: '' },
    publish: { stdout: PUBLISH_STDOUT, stderr: '' },
  });
  return { deps: { execFile, ...seam }, calls, seam };
}

// ── resolveRwaCmd ──────────────────────────────────────────────────────────

test('resolveRwaCmd: RWA_BIN runs `node <bin>`; PATH falls back to the rwa binary', () => {
  const viaBin = resolveRwaCmd({ RWA_BIN: '/opt/rwa/bin/rwa.mjs' });
  assert.equal(viaBin.cmd, process.execPath);
  assert.deepEqual(viaBin.baseArgs, ['/opt/rwa/bin/rwa.mjs']);

  const viaPath = resolveRwaCmd({});
  assert.equal(viaPath.cmd, 'rwa');
  assert.deepEqual(viaPath.baseArgs, []);

  // Never a shell, on either branch.
  for (const r of [viaBin, viaPath]) {
    assert.ok(!/sh$|bash$|\bsh\b/.test(r.cmd), `cmd must not be a shell: ${r.cmd}`);
  }
});

// ── rwaImportPublish: happy path + URL parse ────────────────────────────────

test('rwaImportPublish: runs import then publish and parses the share URL', async () => {
  const { deps, calls } = happyWrapDeps();

  const result = await rwaImportPublish('/some/note.md', deps);

  assert.deepEqual(result, { ok: true, url: 'https://abc.rewritable.ikangai.com/' });

  // Two subprocess calls: import, then publish.
  assert.equal(calls.length, 2);
  const importCall = calls[0];
  const publishCall = calls[1];
  assert.ok(importCall.args.includes('import'), 'first call is import');
  assert.ok(publishCall.args.includes('publish'), 'second call is publish');
});

// ── SECURITY: argv-array, no shell, no string-concat ────────────────────────

test('SECURITY rwaImportPublish: a metacharacter-laden filePath is ONE argv element, never concatenated', async () => {
  const { deps, calls } = happyWrapDeps();
  const evil = '/tmp/a b;rm -rf ~.md';

  await rwaImportPublish(evil, deps);

  const importCall = calls[0];
  // The whole evil path is a SINGLE element of the args array — not split on the
  // space, not split on the `;`, not interpolated into a command string. THIS is
  // the security property: if someone reintroduces string-building, the evil
  // path stops being its own array element and this assertion fails.
  assert.ok(
    importCall.args.includes(evil),
    `filePath must be one argv element verbatim; got args=${JSON.stringify(importCall.args)}`,
  );
  // And it appears exactly once, as itself — not embedded in a larger string.
  assert.equal(importCall.args.filter((a) => a === evil).length, 1);
  // No arg is a built command string smuggling the path in.
  for (const a of importCall.args) {
    if (a !== evil) assert.ok(!a.includes(evil), `path leaked into another arg: ${a}`);
  }
});

test('SECURITY: no call uses a shell — cmd is never sh/bash and options.shell is falsy', async () => {
  const { deps, calls } = happyWrapDeps();
  await rwaImportPublish('/tmp/x.md', deps);

  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.ok(!/(^|\/)(sh|bash|zsh|dash)$/.test(c.cmd), `cmd is a shell: ${c.cmd}`);
    // options.shell must be falsy or absent — execFile defaults to no shell, and
    // we must never opt into one.
    const shell = c.options && c.options.shell;
    assert.ok(!shell, `a call enabled shell:true (options=${JSON.stringify(c.options)})`);
  }
});

test('SECURITY rwaCreatePublish: a shell-injection prompt is ONE argv element to create', async () => {
  const seam = makeTmpSeam();
  const { execFile, calls } = makeFakeExec({
    create: { stdout: 'wrote out.html', stderr: '' },
    publish: { stdout: PUBLISH_STDOUT, stderr: '' },
  });
  const evilPrompt = '; rm -rf ~ && echo pwned';

  const result = await rwaCreatePublish(evilPrompt, { execFile, hasBackendKey: true, ...seam });

  assert.equal(result.ok, true);
  const createCall = calls.find((c) => c.args.includes('create'));
  assert.ok(createCall, 'expected a create call');
  // The full prompt is a single argv element — never split, never interpolated.
  assert.ok(
    createCall.args.includes(evilPrompt),
    `prompt must be one argv element verbatim; got args=${JSON.stringify(createCall.args)}`,
  );
  assert.equal(createCall.args.filter((a) => a === evilPrompt).length, 1);
  // No shell anywhere.
  for (const c of calls) {
    assert.ok(!/(^|\/)(sh|bash|zsh|dash)$/.test(c.cmd));
    assert.ok(!(c.options && c.options.shell));
  }
});

// ── agent-fill gate ─────────────────────────────────────────────────────────

test('rwaCreatePublish: no backend key → agent_not_configured and execFile NEVER called', async () => {
  const seam = makeTmpSeam();
  let callCount = 0;
  const execFile = async () => { callCount++; return { stdout: '', stderr: '' }; };

  const result = await rwaCreatePublish('write me a doc', { execFile, hasBackendKey: false, ...seam });

  assert.deepEqual(result, { ok: false, code: 'agent_not_configured' });
  assert.equal(callCount, 0, 'execFile must not be spawned when the agent is not configured');
  // And no temp dir was even created — we bail before any work.
  assert.equal(seam.created.length, 0, 'must not create a temp dir when gated out');
});

// ── failure capture (never throw on a CLI failure) ──────────────────────────

test('rwaImportPublish: non-zero import exit is captured, not thrown', async () => {
  const seam = makeTmpSeam();
  const { execFile } = makeFakeExec({
    import: execFailure(2, 'not a rewritable'),
    publish: { stdout: PUBLISH_STDOUT, stderr: '' },
  });

  const result = await rwaImportPublish('/tmp/bad.xyz', { execFile, ...seam });

  assert.deepEqual(result, {
    ok: false, step: 'import', code: 2, stderr: 'not a rewritable',
  });
});

test('rwaImportPublish: non-zero publish exit is captured with step=publish', async () => {
  const seam = makeTmpSeam();
  const { execFile } = makeFakeExec({
    import: { stdout: 'wrote out.html', stderr: '' },
    publish: execFailure(4, 'service unreachable'),
  });

  const result = await rwaImportPublish('/tmp/note.md', { execFile, ...seam });

  assert.deepEqual(result, {
    ok: false, step: 'publish', code: 4, stderr: 'service unreachable',
  });
});

test('rwaCreatePublish: non-zero create exit is captured with step=create', async () => {
  const seam = makeTmpSeam();
  const { execFile } = makeFakeExec({
    create: execFailure(4, 'backend refused'),
    publish: { stdout: PUBLISH_STDOUT, stderr: '' },
  });

  const result = await rwaCreatePublish('a deck about Q3', { execFile, hasBackendKey: true, ...seam });

  assert.deepEqual(result, {
    ok: false, step: 'create', code: 4, stderr: 'backend refused',
  });
});

// ── temp-file cleanup ───────────────────────────────────────────────────────

test('rwaImportPublish: temp dir is created then removed (cleanup in finally) — on success', async () => {
  const { deps, seam } = happyWrapDeps();
  await rwaImportPublish('/tmp/note.md', deps);
  assert.equal(seam.created.length, 1);
  assert.deepEqual(seam.removed, seam.created, 'every created temp dir must be removed');
});

test('rwaImportPublish: temp dir is removed even when a step fails', async () => {
  const seam = makeTmpSeam();
  const { execFile } = makeFakeExec({
    import: execFailure(2, 'boom'),
    publish: { stdout: PUBLISH_STDOUT, stderr: '' },
  });
  await rwaImportPublish('/tmp/bad.xyz', { execFile, ...seam });
  assert.equal(seam.created.length, 1);
  assert.deepEqual(seam.removed, seam.created, 'temp dir must be cleaned up on failure too');
});

test('rwaCreatePublish: temp dir is removed after a successful create+publish', async () => {
  const seam = makeTmpSeam();
  const { execFile } = makeFakeExec({
    create: { stdout: 'wrote out.html', stderr: '' },
    publish: { stdout: PUBLISH_STDOUT, stderr: '' },
  });
  await rwaCreatePublish('a doc', { execFile, hasBackendKey: true, ...seam });
  assert.equal(seam.created.length, 1);
  assert.deepEqual(seam.removed, seam.created);
});

// ── URL parse robustness ────────────────────────────────────────────────────

test('publish URL parse: extracts the first https URL from human stdout', async () => {
  const seam = makeTmpSeam();
  const { execFile } = makeFakeExec({
    import: { stdout: '', stderr: '' },
    publish: {
      stdout: 'noise\n  URL:     https://zzz9.rewritable.ikangai.com/\nmore noise',
      stderr: '',
    },
  });
  const result = await rwaImportPublish('/tmp/n.md', { execFile, ...seam });
  assert.equal(result.url, 'https://zzz9.rewritable.ikangai.com/');
});

test('publish URL parse: no URL in stdout → ok:false with a parse code (not a crash)', async () => {
  const seam = makeTmpSeam();
  const { execFile } = makeFakeExec({
    import: { stdout: '', stderr: '' },
    publish: { stdout: 'published but I forgot to print the link', stderr: '' },
  });
  const result = await rwaImportPublish('/tmp/n.md', { execFile, ...seam });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'publish');
  assert.equal(result.code, 'no_url');
});
