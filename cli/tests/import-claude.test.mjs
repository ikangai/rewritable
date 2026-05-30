import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertViaClaudeCli } from '../src/import-claude.mjs';

// SECURITY — consent gate for `rwa import <file> --claude`.
//
// WHY this matters: `--claude` spawns an autonomous Claude Code agent that reads
// the input file's *contents* into its context to extract them. `import` is, by
// design, the one command you point at files you received from someone else — so
// the file is attacker-controlled. Running the agent with
// `--permission-mode bypassPermissions` (the old, silent default) turned a
// prompt-injection payload hidden in a third-party PDF/DOCX into remote code
// execution: injected text could run arbitrary shell, no prompt.
//
// The fix is informed consent: `--claude` refuses to run an agent on the file at
// all unless the user explicitly passes `--trust-input`, vouching for that file.
// These tests must FAIL if anyone reintroduces a path where an untrusted file
// reaches the agent — i.e. they encode the threat model, not the mechanism.

test('--claude refuses to run an agent on an untrusted file (no --trust-input)', async () => {
  await assert.rejects(
    convertViaClaudeCli('/some/third-party.pdf', 'pdf', { trustInput: false }),
    (err) => {
      assert.match(err.message, /--trust-input/, 'error tells the user how to consent');
      assert.equal(err.exitCode, 2, 'usage-class exit code so scripts can branch on it');
      return true;
    }
  );
});

test('--claude refuses by DEFAULT — consent is opt-in, never implicit', async () => {
  // Omitting trustInput entirely must be treated as "not trusted", not "unknown".
  await assert.rejects(
    convertViaClaudeCli('/some/third-party.pdf', 'pdf', {}),
    (err) => /--trust-input/.test(err.message) && err.exitCode === 2,
  );
});

test('the consent gate fires BEFORE any file read or subprocess spawn', async () => {
  // The path does not exist. If the gate runs first we get the consent error;
  // if any work (page-count read, spawn) happened first we'd get an ENOENT /
  // spawn error instead. Proves no agent ever touches an unconsented file.
  await assert.rejects(
    convertViaClaudeCli('/definitely/does/not/exist.pdf', 'pdf', { trustInput: false }),
    (err) => {
      assert.match(err.message, /--trust-input/, 'gate short-circuits before file IO');
      return true;
    },
  );
});

test('consent gate also guards the docx (non-chunked) path', async () => {
  // docx skips the PDF page-count branch and goes straight to the subprocess;
  // the gate must cover it too, not just the pdf path.
  await assert.rejects(
    convertViaClaudeCli('/some/third-party.docx', 'docx', { trustInput: false }),
    (err) => /--trust-input/.test(err.message) && err.exitCode === 2,
  );
});
