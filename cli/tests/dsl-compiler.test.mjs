import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDslPlan } from '../src/dsl-compiler.mjs';

// NOTE on signature: compileDslPlan(plan, doc) returns { tool, envelope }.
// `envelope` is an rwa-edit/1 envelope: { version: 'rwa-edit/1', edits: [...] }
// for apply_edits, or { version: 'rwa-edit/1', doc, reason } for replace_document.

test('compiles a single replace op to apply_edits', () => {
  const doc = '<article><h1>Title</h1></article>';
  const plan = {
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'replace', find: 'Title', replace: 'New Title' }]
  };
  const result = compileDslPlan(plan, doc);
  assert.equal(result.tool, 'apply_edits');
  assert.equal(result.envelope.version, 'rwa-edit/1');
  assert.ok(Array.isArray(result.envelope.edits));
  assert.equal(result.envelope.edits.length, 1);
  assert.deepEqual(result.envelope.edits[0], { find: 'Title', replace: 'New Title' });
});

test('compiles insert/before to apply_edits with find+replace', () => {
  const doc = '<article><!-- end --></article>';
  const plan = {
    version: 'rwa-edit-dsl/1',
    ops: [{ op: 'insert', before: '<!-- end -->', content: '<p>Hello</p>' }]
  };
  const result = compileDslPlan(plan, doc);
  assert.equal(result.tool, 'apply_edits');
  assert.equal(result.envelope.edits.length, 1);
  assert.equal(result.envelope.edits[0].find, '<!-- end -->');
  assert.equal(result.envelope.edits[0].replace, '<p>Hello</p><!-- end -->');
});

test('throws on unknown op', () => {
  const doc = '<article></article>';
  const plan = { version: 'rwa-edit-dsl/1', ops: [{ op: 'unknown_op' }] };
  assert.throws(() => compileDslPlan(plan, doc), { code: 'op_unknown' });
});
