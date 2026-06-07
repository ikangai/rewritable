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
import { rwaImportPublish, rwaCreatePublish, rwaEdit, resolveRwaCmd } from './rwa-exec.mjs';

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

// ── SECURITY: argv flag-smuggling (CLI option injection) ────────────────────
//
// An argv array stops SHELL injection but not CLI OPTION injection. The genuine
// vector is the `/new` prompt: a leading-dash token (e.g. `--base-url`) would be
// read by `rwa create`'s exact-match flag parser (cli/src/create.mjs
// parseCreateArgs) as a backend flag and could redirect the agent's backend
// base-url/api-key — credential-exfil. The `rwa` parsers do NOT honor a `--`
// terminator (verified: they filter `a.startsWith('-')`, dropping `--` silently),
// so the fix is boundary rejection: a leading-dash prompt returns
// `{ok:false, code:'bad_prompt'}` WITHOUT spawning. These tests fail loudly if
// that wall is removed — a smuggled flag would then reach `rwa create`.

for (const evil of ['--base-url', '--api-key', '--model', '--backend', '--help', '-f']) {
  test(`SECURITY rwaCreatePublish: a leading-dash prompt ${JSON.stringify(evil)} is rejected as bad_prompt — never spawned`, async () => {
    const seam = makeTmpSeam();
    let callCount = 0;
    const execFile = async () => { callCount++; return { stdout: '', stderr: '' }; };

    const result = await rwaCreatePublish(evil, { execFile, hasBackendKey: true, ...seam });

    // Rejected as DATA, before any subprocess — the smuggled flag can never reach
    // `rwa create` to be parsed as a backend option.
    assert.deepEqual(result, { ok: false, code: 'bad_prompt' });
    assert.equal(callCount, 0, 'a flag-shaped prompt must not spawn rwa create');
    assert.equal(seam.created.length, 0, 'must not create a temp dir for a rejected prompt');
  });
}

test('SECURITY rwaCreatePublish: leading-dash check ignores surrounding whitespace (" --base-url" still rejected)', async () => {
  const seam = makeTmpSeam();
  let callCount = 0;
  const execFile = async () => { callCount++; return { stdout: '', stderr: '' }; };

  const result = await rwaCreatePublish('   --api-key sk-evil', { execFile, hasBackendKey: true, ...seam });

  assert.deepEqual(result, { ok: false, code: 'bad_prompt' });
  assert.equal(callCount, 0);
});

test('SECURITY rwaCreatePublish: a MID-prompt dash is SAFE — the whole prompt is one argv element that does not start with `-`', async () => {
  const seam = makeTmpSeam();
  const { execFile, calls } = makeFakeExec({
    create: { stdout: 'wrote out.html', stderr: '' },
    publish: { stdout: PUBLISH_STDOUT, stderr: '' },
  });
  // `--base-url` appears mid-prompt: it is part of ONE argv element that begins
  // with a letter, so exact-match flag parsing never sees it. This must NOT be
  // rejected — over-rejecting would block legitimate prompts (Rule 9: the test
  // pins WHY only the leading-dash case is dangerous).
  const prompt = 'a doc explaining the --base-url flag and -f shorthand';

  const result = await rwaCreatePublish(prompt, { execFile, hasBackendKey: true, ...seam });

  assert.equal(result.ok, true);
  const createCall = calls.find((c) => c.args.includes('create'));
  assert.ok(createCall.args.includes(prompt), 'mid-dash prompt passes through as one argv element');
});

test('SECURITY rwaCreatePublish: a non-rejected prompt can never land in a flag-consuming position (precedes --out)', async () => {
  const seam = makeTmpSeam();
  const { execFile, calls } = makeFakeExec({
    create: { stdout: 'wrote out.html', stderr: '' },
    publish: { stdout: PUBLISH_STDOUT, stderr: '' },
  });
  const prompt = 'a presentation about Q3';

  await rwaCreatePublish(prompt, { execFile, hasBackendKey: true, ...seam });

  const createCall = calls.find((c) => c.args.includes('create'));
  const verbIdx = createCall.args.indexOf('create');
  // Wire shape: [...base, 'create', <prompt>, '--out', <container>]. The prompt is
  // the verb's positional and is itself never a flag (the bad_prompt wall), so it
  // cannot consume a following token as a flag value.
  assert.equal(createCall.args[verbIdx + 1], prompt, 'prompt sits directly after the verb');
  assert.ok(!createCall.args[verbIdx + 1].startsWith('-'), 'prompt is never a flag');
});

test('SECURITY rwaImportPublish: a leading-dash filePath is neutralized to `./`-relative (never read as a flag)', async () => {
  const { deps, calls } = happyWrapDeps();
  // A path that begins with `-` would be read as a flag by the import positional
  // filter. Defense-in-depth: prefix `./` so it is unambiguously a path.
  const dashy = '-rf.md';

  await rwaImportPublish(dashy, deps);

  const importCall = calls[0];
  assert.ok(
    importCall.args.includes('./-rf.md'),
    'dash-leading path must be ./-prefixed; got args=' + JSON.stringify(importCall.args),
  );
  assert.ok(!importCall.args.includes(dashy), 'the raw dash-leading path must not be passed verbatim');
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

// ── rwaEdit: edit a HOSTED doc on a caller-owned temp container ──────────────
//
// Phase B edits a hosted doc by exporting it to a temp container, running
// `rwa edit` on that temp, then reading the new body back with `rwa doc`. The
// caller OWNS the temp file (creates + cleans it); rwaEdit operates in place and
// must never delete it (so no tmpDir/rm seam here — unlike the publish paths).
//
// SECURITY — the instruction is raw Telegram text. Same two walls as the prompt:
// argv-array (no shell, instruction is ONE element so metacharacters are inert)
// AND leading-dash rejection (a `--api-key`/`--base-url` instruction would be
// read by `rwa edit`'s flag parser and could redirect the agent backend —
// credential-exfil). The leading-dash test asserts execFile is NEVER spawned.

const DOC_STDOUT = '# My doc\n\nThe edited body.\n';

test('SECURITY rwaEdit: a leading-dash instruction is rejected as bad_instruction — never spawned', async () => {
  for (const evil of ['--api-key x', '-f', '--base-url']) {
    let callCount = 0;
    const execFile = async () => { callCount++; return { stdout: '', stderr: '' }; };

    const result = await rwaEdit('/owned/tmp/c.html', evil, { execFile });

    // Rejected as DATA, before any subprocess — the smuggled flag can never reach
    // `rwa edit` to be parsed as a backend option. THIS is the flag-smuggling wall.
    assert.deepEqual(result, { ok: false, code: 'bad_instruction' },
      `instruction ${JSON.stringify(evil)} must be rejected`);
    assert.equal(callCount, 0,
      `a flag-shaped instruction must not spawn rwa edit (got ${callCount} calls)`);
  }
});

test('rwaEdit: runs `rwa edit <file> <instruction>` then `rwa doc <file>` and returns the new body', async () => {
  const filePath = '/owned/tmp/c.html';
  const instruction = 'make the intro punchier';
  const { execFile, calls } = makeFakeExec({
    edit: { stdout: 'applied 1 edit', stderr: '' },
    doc: { stdout: DOC_STDOUT, stderr: '' },
  });

  const result = await rwaEdit(filePath, instruction, { execFile });

  assert.deepEqual(result, { ok: true, doc: DOC_STDOUT });

  // Exactly two calls: edit then doc.
  assert.equal(calls.length, 2);
  const editCall = calls[0];
  const docCall = calls[1];

  // Wire shape: filePath and instruction are SEPARATE single argv elements —
  // never split, never concatenated. On PATH baseArgs is [], so the full args
  // array is exactly [verb, filePath, instruction]. If anyone reintroduces
  // string-building, this exact-deepEqual fails loudly.
  assert.deepEqual(editCall.args, ['edit', filePath, instruction]);
  assert.deepEqual(docCall.args, ['doc', filePath]);

  // No shell, on either call.
  for (const c of calls) {
    assert.ok(!/(^|\/)(sh|bash|zsh|dash)$/.test(c.cmd), `cmd is a shell: ${c.cmd}`);
    assert.ok(!(c.options && c.options.shell), 'a call enabled shell:true');
  }
});

test('SECURITY rwaEdit: a leading-dash filePath is neutralized to `./`-relative in BOTH edit and doc argv', async () => {
  // Defense-in-depth, matching the sibling rwaImportPublish: a dash-leading
  // filePath would be dropped/misread by `rwa edit`/`rwa doc`'s positional flag
  // filter (it discards a.startsWith('-')), sliding the instruction into the
  // file-path slot or smuggling a flag. The `./` prefix makes it positional.
  const filePath = '-rf.html';
  const instruction = 'make the intro punchier';
  const { execFile, calls } = makeFakeExec({
    edit: { stdout: 'applied 1 edit', stderr: '' },
    doc: { stdout: DOC_STDOUT, stderr: '' },
  });

  const result = await rwaEdit(filePath, instruction, { execFile });

  assert.deepEqual(result, { ok: true, doc: DOC_STDOUT });
  assert.equal(calls.length, 2);
  const editCall = calls[0];
  const docCall = calls[1];

  // The neutralized `./`-prefixed path reaches BOTH calls — never the raw dash form.
  assert.deepEqual(editCall.args, ['edit', './-rf.html', instruction]);
  assert.deepEqual(docCall.args, ['doc', './-rf.html']);
  assert.ok(!editCall.args.includes('-rf.html'), 'raw dash-leading path must not reach edit');
  assert.ok(!docCall.args.includes('-rf.html'), 'raw dash-leading path must not reach doc');
});

test('SECURITY rwaEdit: a shell-metacharacter instruction (not dash-leading) is ONE argv element, never split', async () => {
  const filePath = '/owned/tmp/c.html';
  const evil = 'make it ; rm -rf ~';
  const { execFile, calls } = makeFakeExec({
    edit: { stdout: 'applied', stderr: '' },
    doc: { stdout: DOC_STDOUT, stderr: '' },
  });

  const result = await rwaEdit(filePath, evil, { execFile });

  assert.equal(result.ok, true);
  const editCall = calls.find((c) => c.args.includes('edit'));
  // The whole instruction is a SINGLE argv element — the `;` and `rm -rf ~` are
  // inert text, never parsed by a shell. (Mid-token dash is safe: the element
  // begins with a letter, so flag parsing never sees `-rf`.)
  assert.ok(
    editCall.args.includes(evil),
    `instruction must be one argv element verbatim; got args=${JSON.stringify(editCall.args)}`,
  );
  assert.equal(editCall.args.filter((a) => a === evil).length, 1);
});

test('rwaEdit: non-zero `rwa edit` exit is captured (step:edit) and `rwa doc` is NOT run', async () => {
  const filePath = '/owned/tmp/c.html';
  const { execFile, calls } = makeFakeExec({
    edit: execFailure(4, 'agent gave up after 3 attempts'),
    doc: { stdout: DOC_STDOUT, stderr: '' },
  });

  const result = await rwaEdit(filePath, 'do a thing', { execFile });

  assert.deepEqual(result, {
    ok: false, step: 'edit', code: 4, stderr: 'agent gave up after 3 attempts',
  });
  // A failed edit means the body is unchanged garbage-or-original; reading it
  // back is pointless and could mislead — so `rwa doc` must NOT run.
  assert.ok(!calls.some((c) => c.args.includes('doc')), 'rwa doc must not run after a failed edit');
});

test('rwaEdit: edit succeeds but `rwa doc` exits non-zero → captured with step:doc', async () => {
  const filePath = '/owned/tmp/c.html';
  const { execFile } = makeFakeExec({
    edit: { stdout: 'applied 1 edit', stderr: '' },
    doc: execFailure(2, 'not a rewritable'),
  });

  const result = await rwaEdit(filePath, 'do a thing', { execFile });

  assert.deepEqual(result, {
    ok: false, step: 'doc', code: 2, stderr: 'not a rewritable',
  });
});
