// `rwa create` end-to-end pipeline (design 2026-05-31 §4.6): scaffold → agent →
// apply in memory → assertSelfContained → write ONCE atomically. Driven against a
// stub OpenAI-compatible server so the real runAgentLoop + applyPlan + guard run,
// no network and no mocking of the unit under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCmd, parseCreateArgs } from '../src/create.mjs';
import { CliError } from '../src/edit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_CANDIDATES = [join(__dirname, '..', '..', 'seeds', 'rewritable.html')];

// A stub /chat/completions server. `docFor(reqBody)` returns the doc the model
// "authors"; the server wraps it in a replace_document tool_call. Records the
// last request so tests can assert what reached the backend.
function stubServer(docFor) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      calls.push({ headers: req.headers, body: parsed });
      const doc = docFor(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'replace_document',
                arguments: JSON.stringify({ version: 'rwa-edit/1', doc, reason: 'initial authoring from CLI task' }),
              },
            }],
          },
        }],
      }));
    });
  });
  return { server, calls };
}

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

// ollama backend takes no api key by default; override via parsed flags below.
function parsedFor(words, baseUrl, extra = []) {
  return parseCreateArgs([...words, '--backend', 'ollama', '--model', 'stub', '--base-url', baseUrl, ...extra]);
}

test('happy path: authors a self-contained document and writes it once', async () => {
  const { server } = stubServer(() => '<article><h1>Token report</h1><p>All inline, no CDN.</p></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-create-'));
  try {
    const out = join(dir, 'report.html');
    const parsed = parsedFor(['a', 'document', 'about', 'tokens'], baseUrl, ['--out', out]);
    await createCmd(parsed, { seedCandidates: SEED_CANDIDATES, cwd: dir });
    const text = await readFile(out, 'utf8');
    assert.match(text, /const PRODUCT_KIND = 'document'/);   // the resolved frame kind
    assert.match(text, /Token report/);                       // the authored body landed in INLINE_DOC
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('the self-containment guard rejects CDN output and writes NO file (exit 4)', async () => {
  // WHY: a created file with a runtime <script src> breaks "send the file, they
  // have everything" — it must fail loud and leave nothing on disk.
  const { server } = stubServer(() =>
    '<article><h1>Chart</h1><script src="https://cdnjs.cloudflare.com/d3.min.js"></script></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-create-'));
  try {
    const out = join(dir, 'chart.html');
    const parsed = parsedFor(['interactive', 'chart'], baseUrl, ['--out', out]);
    await assert.rejects(
      createCmd(parsed, { seedCandidates: SEED_CANDIDATES, cwd: dir }),
      (e) => {
        assert.ok(e instanceof CliError);
        assert.equal(e.exitCode, 4);
        assert.equal(e.subcode, 'not_self_contained');
        return true;
      },
    );
    await assert.rejects(stat(out), /ENOENT/, 'no file must be written when the guard fails');
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('the API key never appears in the emitted artifact (no stored credentials)', async () => {
  const { server, calls } = stubServer(() => '<article><p>clean</p></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-create-'));
  try {
    const out = join(dir, 'doc.html');
    // openrouter backend so the api key is actually used in the Authorization header.
    const parsed = parseCreateArgs(['hello', '--backend', 'openrouter', '--model', 'stub',
      '--base-url', baseUrl, '--api-key', 'SECRET_TOKEN_123', '--out', out]);
    await createCmd(parsed, { seedCandidates: SEED_CANDIDATES, cwd: dir });
    const text = await readFile(out, 'utf8');
    assert.doesNotMatch(text, /SECRET_TOKEN_123/, 'the credential must not be baked into the file');
    // …but it WAS sent to the backend (proves it was used transiently, not ignored).
    assert.equal(calls[0].headers.authorization, 'Bearer SECRET_TOKEN_123');
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('--data content is passed into the agent brief (baked, never fetched)', async () => {
  const { server, calls } = stubServer(() => '<article><p>charted</p></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-create-'));
  try {
    const dataPath = join(dir, 'tokens.json');
    await writeFile(dataPath, '{"euler":4200,"tesla":3700}');
    const out = join(dir, 'viz.html');
    const parsed = parsedFor(['visualize', 'usage'], baseUrl, ['--data', dataPath, '--out', out]);
    await createCmd(parsed, { seedCandidates: SEED_CANDIDATES, cwd: dir });
    // the dataset reached the model's context (in the user message), not a fetch.
    const sentToModel = JSON.stringify(calls[0].body.messages);
    assert.match(sentToModel, /euler/);
    assert.match(sentToModel, /3700/);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('--data on a missing file fails with exit 2 (file error), nothing written', async () => {
  const { server } = stubServer(() => '<article><p>x</p></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-create-'));
  try {
    const out = join(dir, 'x.html');
    const parsed = parsedFor(['topic'], baseUrl, ['--data', join(dir, 'nope.json'), '--out', out]);
    await assert.rejects(
      createCmd(parsed, { seedCandidates: SEED_CANDIDATES, cwd: dir }),
      (e) => { assert.equal(e.exitCode, 2); return true; },
    );
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('--from on a non-rewritable file fails with exit 2', async () => {
  const { server } = stubServer(() => '<article><p>x</p></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-create-'));
  try {
    const notRwa = join(dir, 'plain.html');
    await writeFile(notRwa, '<!doctype html><p>just html, no bootstrap</p>');
    const out = join(dir, 'x.html');
    const parsed = parsedFor(['topic'], baseUrl, ['--from', notRwa, '--out', out]);
    await assert.rejects(
      createCmd(parsed, { seedCandidates: SEED_CANDIDATES, cwd: dir }),
      (e) => { assert.equal(e.exitCode, 2); assert.equal(e.subcode, 'not_a_rewritable'); return true; },
    );
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
