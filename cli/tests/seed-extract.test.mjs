import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFromSeed } from '../src/seed-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = join(__dirname, '..', '..', 'seeds', 'rewritable.html');
const seedText = readFileSync(seedPath, 'utf8');

test('extracts SYSTEM_PROMPTS with document + workflow keys', () => {
  const { SYSTEM_PROMPTS } = extractFromSeed(seedText);
  assert.equal(typeof SYSTEM_PROMPTS, 'object');
  assert.ok('document' in SYSTEM_PROMPTS);
  assert.ok('workflow' in SYSTEM_PROMPTS);
  assert.equal(typeof SYSTEM_PROMPTS.document, 'string');
  assert.ok(SYSTEM_PROMPTS.document.length > 100);
});

test('extracts TOOL_SCHEMAS as an array of 3 tools', () => {
  const { TOOL_SCHEMAS } = extractFromSeed(seedText);
  assert.ok(Array.isArray(TOOL_SCHEMAS));
  assert.equal(TOOL_SCHEMAS.length, 3);
  const names = TOOL_SCHEMAS.map(t => t.function.name).sort();
  assert.deepEqual(names, ['apply_dsl_plan', 'apply_edits', 'replace_document']);
});

test('extracts SYSTEM_PROMPT_RULES as a non-empty string', () => {
  const { SYSTEM_PROMPT_RULES } = extractFromSeed(seedText);
  assert.equal(typeof SYSTEM_PROMPT_RULES, 'string');
  assert.ok(SYSTEM_PROMPT_RULES.length > 0);
});

test('throws when a marker pair is missing', () => {
  const broken = seedText.replace('// rwa:extract:end TOOL_SCHEMAS', '// removed');
  assert.throws(
    () => extractFromSeed(broken),
    err => /missing.*TOOL_SCHEMAS/i.test(err.message)
  );
});
