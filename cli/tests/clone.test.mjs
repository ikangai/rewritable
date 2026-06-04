import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { cloneFromHtml } from '../src/clone.mjs';
import { inspectDoc } from '../src/doc.mjs';

const fixture = readFileSync(new URL('./fixtures/ikangai-post.html', import.meta.url), 'utf8');

test('cloneFromHtml produces a valid rewritable with the post title + content', async () => {
  const out = '/tmp/clone-test-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'https://www.ikangai.com/post/');
  const info = await inspectDoc(out);
  assert.equal(info.self.kind, 'document');
  assert.match(info.self.title, /No Orchestration Required/);
  assert.ok(info.doc.includes('<article'), 'wraps content in an article');
  assert.ok(info.doc.includes('<h1'), 'has a title heading');
  assert.ok(!/<script[\s>]/i.test(info.doc), 'no scripts survive into the body');
  assert.ok(info.doc.includes('ikangai.com/post'), 'records provenance link');
  rmSync(out, { force: true });
});

test('cloneFromHtml is a valid rewritable per the edit contract (uuid present)', async () => {
  const out = '/tmp/clone-test2-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'https://www.ikangai.com/post/');
  const info = await inspectDoc(out);
  assert.equal(info.rewritable ?? true, true);
  assert.ok(info.uuid && /[0-9a-f-]{36}/.test(info.uuid), 'has a DOC_UUID');
  rmSync(out, { force: true });
});
