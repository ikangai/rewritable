// `rwa skill import` — an Agent Skill becomes a signed carrier (#47).
//
// The point of the feature is that "install any skill that is out there" stops
// being an architecture problem and becomes a conversion problem. So the test
// that matters is the end-to-end one against a REAL Agent Skill — this repo
// ships one at skills/authoring-rewritables/ — rather than against a fixture
// shaped to succeed.
//
// The second thing pinned here is the constraint that decided the design, as an
// executable fact rather than a comment: a SKILL.md body CANNOT go in
// `system_prompt`, because the install gate rejects backticks
// (`agent_prompt_injection_risk`, a normative MUST in actions-v0.9 §13, enforced
// in three mirrored sites). If that ever changes, the negative control below
// fails and tells whoever changed it to revisit this mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, roleFromName, readSkillDir, synthesizePrompt, formatDropped } from '../src/skill-import.mjs';
import { readOfferedRole, validateAgentInstall, MAX_AGENT_REFERENCE_BYTES } from '../src/skill-manifest.mjs';
import { extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');
const REPO = join(__dirname, '..', '..');
const REAL_SKILL = join(REPO, 'skills', 'authoring-rewritables');

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-skimp-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
const run = (args, cwd) => spawnSync(process.execPath, [RWA_BIN, ...args], { encoding: 'utf8', cwd, input: '' });
const bodyOf = (p) => extractInlineDoc(readFileSync(p, 'utf8'));

/** A minimal but realistic Agent Skill on disk. */
function makeSkill(dir, { name = 'test-skill', description = 'Use when testing.', body = '# Test\n\nUse `npx rwa doc` to read it.\n', refs = {}, scripts = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
  if (Object.keys(refs).length) {
    mkdirSync(join(dir, 'references'), { recursive: true });
    for (const [n, c] of Object.entries(refs)) writeFileSync(join(dir, 'references', n), c);
  }
  for (const [n, c] of Object.entries(scripts)) {
    mkdirSync(dirname(join(dir, n)), { recursive: true });
    writeFileSync(join(dir, n), c);
  }
  return dir;
}

// ─── The constraint that shaped the design ─────────────────────────────

test('#47 negative control: a real SKILL.md body CANNOT be a system_prompt', () => {
  // This is why the body rides as a reference. Measured against the actual file,
  // not asserted: markdown is full of backticks and the install gate rejects
  // them. If this starts passing, the spec MUST was relaxed and the mapping in
  // skill-import.mjs should be reconsidered — it would be cleaner as a prompt.
  const skillMd = readFileSync(join(REAL_SKILL, 'SKILL.md'), 'utf8');
  const agent = { author_pubkey: 'QUJD', description: 'd', role: 'r', system_prompt: skillMd, vault_namespace_set: [], version: 'rwa-agent/1' };
  const gate = validateAgentInstall({ agent }, { signed: true, verified: true });
  assert.equal(gate.ok, false, 'if this is now ok, revisit the body-as-reference mapping');
  assert.ok(gate.errors.includes('agent_prompt_injection_risk'));

  // And the synthesized prompt that replaces it must pass the same gate — a
  // prompt that trips it would make the whole carrier unusable, releasing
  // neither the prompt nor the references.
  const clean = { ...agent, system_prompt: synthesizePrompt({ role: 'r', dropped: ['bin/x.mjs'] }) };
  assert.equal(validateAgentInstall({ agent: clean }, { signed: true, verified: true }).ok, true);
});

// ─── The acceptance case, end to end ───────────────────────────────────

test('#47: the repo\'s own Agent Skill imports, verifies, and reports through rwa doc --json', () => {
  const t = tmp();
  try {
    const out = join(t.dir, 'c.html');
    const r = run(['skill', 'import', REAL_SKILL, '--out', out], t.dir);
    assert.equal(r.status, 0, r.stderr);

    const got = readOfferedRole(bodyOf(out));
    assert.equal(got.status, 'ok', 'the carrier verifies AND passes the install gate');
    assert.equal(got.role.verified, true);
    assert.equal(got.role.role, 'authoring-rewritables', 'frontmatter name became the role');
    assert.match(got.role.description, /^Use when asked to create, edit, or inspect/,
      'frontmatter description became the description — this is what tells an agent WHEN to use it');

    // The instructions must arrive intact. A body mangled to survive a screen
    // would be a skill that no longer says what its author wrote.
    const names = got.role.references.map(x => x.name);
    assert.deepEqual(names, ['SKILL.md', 'edit-contract.md'], 'body first, then references/');
    const carried = got.role.references.find(x => x.name === 'SKILL.md').content;
    const original = readFileSync(join(REAL_SKILL, 'SKILL.md'), 'utf8').split(/^---\r?\n[\s\S]*?^---\r?\n/m)[1];
    assert.equal(carried.trim(), original.trim(), 'the body is carried byte-for-byte');
    assert.ok(carried.includes('`'), 'including its backticks, which is the whole difficulty');
  } finally { t.cleanup(); }
});

// ─── Scripts: dropped, and said so ─────────────────────────────────────

test('#47: scripts are NOT carried, and the omission is stated in three places', () => {
  const t = tmp();
  try {
    const dir = makeSkill(join(t.dir, 'skill'), {
      scripts: { 'scripts/run.py': 'print("SECRET_PAYLOAD")\n', 'bin/tool.mjs': 'console.log(1)\n' },
    });
    const out = join(t.dir, 'c.html');
    const r = run(['skill', 'import', dir, '--out', out], t.dir);
    assert.equal(r.status, 0, r.stderr);

    // 1. on stderr, at import time
    assert.match(r.stderr, /NOT carried/);
    assert.match(r.stderr, /scripts\/run\.py/);
    assert.match(r.stderr, /bin\/tool\.mjs/);

    // 2. in the card, because the carrier is what travels — whoever opens it
    //    later never saw the import run
    const body = bodyOf(out);
    assert.match(body, /Not included/);
    assert.match(body, /scripts\/run\.py/);

    // 3. in the system_prompt, so the model is told too
    const got = readOfferedRole(body);
    assert.match(got.role.systemPrompt, /NOT included here/);

    // And the bytes genuinely did not come along.
    assert.ok(!body.includes('SECRET_PAYLOAD'), 'script CONTENT must not be in the carrier');
    assert.ok(!readFileSync(out, 'utf8').includes('SECRET_PAYLOAD'), 'nor anywhere else in the file');
  } finally { t.cleanup(); }
});

test('#47: a skill with no scripts says nothing about scripts', () => {
  // The complement: the warning must mean something when it appears.
  const t = tmp();
  try {
    const dir = makeSkill(join(t.dir, 'skill'), { refs: { 'a.md': '# A\n' } });
    const out = join(t.dir, 'c.html');
    const r = run(['skill', 'import', dir, '--out', out], t.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /NOT carried/);
    assert.doesNotMatch(bodyOf(out), /Not included/);
    assert.doesNotMatch(readOfferedRole(bodyOf(out)).role.systemPrompt, /NOT included/);
  } finally { t.cleanup(); }
});

// ─── Reading the skill ─────────────────────────────────────────────────

test('#47: frontmatter parsing — flat scalars in, everything else refused', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: b\n---\nbody\n').data, { name: 'a', description: 'b' });
  assert.equal(parseFrontmatter('---\nname: a\ndescription: b\n---\nbody\n').body, 'body\n');
  assert.equal(parseFrontmatter('no fences here').error, 'no_frontmatter');
  // Quotes are stripped; a colon inside the value survives (descriptions have them).
  assert.equal(parseFrontmatter('---\nname: "x"\ndescription: a: b\n---\n').data.description, 'a: b');
  // A block scalar is REFUSED rather than half-read: silently keeping the first
  // line would import a skill whose description is truncated, i.e. undiscoverable.
  assert.match(parseFrontmatter('---\ndescription: |\n  long\n---\n').error, /unsupported_frontmatter_value/);
  assert.match(parseFrontmatter('---\nnot a pair\n---\n').error, /unparsable_frontmatter_line/);
});

test('#47: role derivation reports rather than renames silently', async () => {
  assert.equal(roleFromName('authoring-rewritables'), 'authoring-rewritables');
  assert.equal(roleFromName('Code Review Helper'), 'code-review-helper');
  assert.equal(roleFromName('---'), null);
  assert.equal(roleFromName(''), null);

  const t = tmp();
  try {
    const dir = makeSkill(join(t.dir, 'skill'), { name: 'Code Review Helper' });
    const r = run(['skill', 'import', dir, '--out', join(t.dir, 'c.html')], t.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /imported as role "code-review-helper"/, 'the mapping is stated, not silent');
  } finally { t.cleanup(); }
});

test('#47: a folder without SKILL.md is refused, and the message says why', async () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, 'notaskill'), { recursive: true });
    const r = run(['skill', 'import', join(t.dir, 'notaskill')], t.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no SKILL\.md/);
  } finally { t.cleanup(); }
});

test('#47: a missing description is refused — a carrier without one is undiscoverable', async () => {
  const t = tmp();
  try {
    const dir = join(t.dir, 'skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\n\nbody\n');
    await assert.rejects(() => readSkillDir(dir), /no "description"/);
  } finally { t.cleanup(); }
});

test('#47: oversized references fail at IMPORT, naming the budget', async () => {
  // Not silently truncated. Dropping instruction bytes without saying so is the
  // exact failure #47 says must never happen.
  const t = tmp();
  try {
    const dir = makeSkill(join(t.dir, 'skill'), {
      refs: { 'big.md': 'x'.repeat(MAX_AGENT_REFERENCE_BYTES + 1) },
    });
    await assert.rejects(() => readSkillDir(dir), /over the .* KB limit/);
  } finally { t.cleanup(); }
});

test('#47: non-text files under references/ are dropped, not base64-smuggled', async () => {
  const t = tmp();
  try {
    const dir = makeSkill(join(t.dir, 'skill'), { refs: { 'ok.md': '# ok\n' } });
    writeFileSync(join(dir, 'references', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const parsed = await readSkillDir(dir);
    assert.deepEqual(parsed.references.map(r => r.name), ['SKILL.md', 'ok.md']);
    assert.ok(parsed.dropped.some(d => d.endsWith('logo.png')));
  } finally { t.cleanup(); }
});

test('#47: a symlink under references/ is listed but never followed', async () => {
  // A skill folder is someone else's data. Following a link inside it would let
  // it pull an arbitrary file off the importer's disk into a signed, shareable
  // carrier — so links are reported as not-carried rather than read.
  const t = tmp();
  try {
    const dir = makeSkill(join(t.dir, 'skill'), { refs: { 'real.md': '# real\n' } });
    const secret = join(t.dir, 'secret.md');
    writeFileSync(secret, 'PRIVATE_KEY_MATERIAL\n');
    symlinkSync(secret, join(dir, 'references', 'sneaky.md'));
    const parsed = await readSkillDir(dir);
    assert.deepEqual(parsed.references.map(r => r.name), ['SKILL.md', 'real.md']);
    assert.ok(parsed.dropped.some(d => d.endsWith('sneaky.md')), 'listed, so the omission is visible');
    assert.ok(!JSON.stringify(parsed.references).includes('PRIVATE_KEY_MATERIAL'));
  } finally { t.cleanup(); }
});

test('#47: a long dropped list is elided rather than dumped', () => {
  const many = Array.from({ length: 57 }, (_, i) => `scripts/f${i}.py`);
  const out = formatDropped(many);
  assert.equal(out.split('\n').length, 21, '20 shown plus the tally');
  assert.match(out, /… and 37 more/);
  assert.equal(formatDropped(['a.py']).split('\n').length, 1, 'and a short list is shown whole');
});
