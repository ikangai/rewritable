import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractInlineDoc, replaceInlineDoc } from '../src/seed.mjs';

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const RWA = join(here, '..', 'bin', 'rwa.mjs');

const mkTmp = () => mkdtemp(join(tmpdir(), 'rwa-workspace-'));
const run = (args, cwd) => execFileP('node', [RWA, ...args], { cwd });

function manifestFrom(html) {
  const body = extractInlineDoc(html);
  const m = body.match(/<script\b[^>]*\bid=["']rwa-workspace["'][^>]*>([\s\S]*?)<\/script\s*>/i);
  assert.ok(m, 'workspace manifest script should exist');
  return JSON.parse(m[1]);
}

test('rwa workspace create writes a workspace index for a new directory', async () => {
  const dir = await mkTmp();
  try {
    const ws = join(dir, 'notes');
    const { stdout } = await run(['workspace', 'create', ws], dir);
    assert.match(stdout, /rwa-index\.html/);
    assert.match(stdout, /\(0 documents\)/);

    const index = await readFile(join(ws, 'rwa-index.html'), 'utf8');
    assert.match(index, /const PRODUCT_KIND = 'workspace'/);
    const body = extractInlineDoc(index);
    assert.match(body, /class="rwa-workspace"/);
    assert.match(body, /data-rwa-workspace-context/);
    assert.match(body, /Workspace memory/);
    assert.match(body, /Guidelines/);
    assert.match(body, /Examples/);
    assert.match(body, /workspace-manifest/);
    const manifest = manifestFrom(index);
    assert.equal(manifest.version, 'rwa-workspace/1');
    assert.equal(manifest.name, 'Notes');
    assert.deepEqual(manifest.documents, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rwa workspace sync indexes sibling rewritables and skips plain html', async () => {
  const dir = await mkTmp();
  try {
    await run(['new', join(dir, 'brief.html')], dir);
    await run(['new', join(dir, 'deck.html'), '--kind', 'presentation'], dir);
    await writeFile(join(dir, 'plain.html'), '<!doctype html><p>not a rewritable</p>', 'utf8');

    const { stdout } = await run(['workspace', 'sync', dir], dir);
    assert.match(stdout, /\(2 documents\)/);

    const indexPath = join(dir, 'rwa-index.html');
    const index = await readFile(indexPath, 'utf8');
    const manifest = manifestFrom(index);
    assert.deepEqual(manifest.documents.map(d => d.file), ['brief.html', 'deck.html']);
    assert.deepEqual(manifest.documents.map(d => d.kind), ['document', 'presentation']);
    assert.ok(manifest.documents.every(d => /^[0-9a-f-]{36}$/.test(d.uuid)), 'indexed docs should carry uuids');
    const body = extractInlineDoc(index);
    assert.match(body, /href="\.\/brief\.html"/);
    assert.match(body, /href="\.\/deck\.html"/);
    assert.doesNotMatch(body, /plain\.html/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rwa workspace sync preserves editable workspace context', async () => {
  const dir = await mkTmp();
  try {
    await run(['workspace', 'create', dir], dir);
    const indexPath = join(dir, 'rwa-index.html');
    const original = await readFile(indexPath, 'utf8');
    const editedContext = `<section class="rwa-ws-context" data-rwa-workspace-context>
<h2>Workspace memory</h2>
<p>Voice: concrete, calm, and example-led.</p>
<h2>Examples</h2>
<p>Canonical post: Start with the practical problem, then show the smallest useful demo.</p>
</section>`;
    const editedBody = extractInlineDoc(original).replace(/<section\b[^>]*\bdata-rwa-workspace-context\b[^>]*>[\s\S]*?<\/section>/i, editedContext);
    await writeFile(indexPath, replaceInlineDoc(original, editedBody), 'utf8');

    await run(['new', join(dir, 'draft.html')], dir);
    await run(['workspace', 'sync', dir], dir);
    const synced = await readFile(indexPath, 'utf8');
    const body = extractInlineDoc(synced);
    assert.match(body, /Voice: concrete, calm, and example-led/);
    assert.match(body, /draft\.html/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rwa workspace create refuses to overwrite an existing index without --force', async () => {
  const dir = await mkTmp();
  try {
    await run(['workspace', 'create', dir], dir);
    await assert.rejects(
      run(['workspace', 'create', dir], dir),
      err => {
        assert.equal(err.code, 2);
        assert.match(String(err.stderr), /workspace index exists/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rwa new workspace creates the built-in workspace scaffold', async () => {
  const dir = await mkTmp();
  try {
    await run(['new', 'workspace'], dir);
    const names = (await readdir(dir)).filter(n => /\.html?$/i.test(n));
    assert.equal(names.length, 1);
    const html = await readFile(join(dir, names[0]), 'utf8');
    assert.match(html, /const PRODUCT_KIND = 'workspace'/);
    const manifest = manifestFrom(html);
    assert.equal(manifest.version, 'rwa-workspace/1');
    assert.deepEqual(manifest.documents, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
