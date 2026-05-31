// `rwa create` / `rwa draft` through the actual bin (argv → createCmd → exit code).
// create.test.mjs covers the createCmd pipeline directly; this covers the bin
// wiring: verb dispatch, the stub backend over a real subprocess, stdout/stderr,
// and the stable exit codes. Uses a stub /chat/completions server so no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'rwa.mjs');

function stubServer(doc) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'c1', type: 'function',
              function: { name: 'replace_document', arguments: JSON.stringify({ version: 'rwa-edit/1', doc, reason: 'authoring' }) },
            }],
          },
        }],
      }));
    });
  });
  return server;
}
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}/v1`)));

// Run the bin; resolve {code, stdout, stderr} without throwing on non-zero exit.
async function run(args, cwd) {
  try {
    const { stdout, stderr } = await execFileP('node', [BIN, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
const stubArgs = (baseUrl) => ['--backend', 'ollama', '--model', 'stub', '--base-url', baseUrl];

test('rwa create <task> writes a self-contained file and prints the path (exit 0)', async () => {
  const server = stubServer('<article><h1>Q3 deck</h1><p>Inline only.</p></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-cbin-'));
  try {
    const out = join(dir, 'deck.html');
    const r = await run(['create', 'a', 'deck', 'about', 'Q3', ...stubArgs(baseUrl), '--out', out], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wrote/);
    assert.match(await readFile(out, 'utf8'), /Q3 deck/);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('rwa draft is an alias of create', async () => {
  const server = stubServer('<article><p>drafted</p></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-cbin-'));
  try {
    const out = join(dir, 'd.html');
    const r = await run(['draft', 'something', ...stubArgs(baseUrl), '--out', out], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(await readFile(out, 'utf8'), /drafted/);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('rwa create with no task exits 2 (usage)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rwa-cbin-'));
  try {
    const r = await run(['create'], dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing <task>/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rwa create surfaces the self-containment failure as exit 4 with no file', async () => {
  const server = stubServer('<article><script src="https://cdnjs.cloudflare.com/x.js"></script></article>');
  const baseUrl = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'rwa-cbin-'));
  try {
    const out = join(dir, 'bad.html');
    const r = await run(['create', 'chart', ...stubArgs(baseUrl), '--out', out], dir);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /not_self_contained/);
    await assert.rejects(stat(out), /ENOENT/);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});
