// Build the `authoring-rewritables` skill from this repo (#42).
//
// ## Why this exists
//
// The skill is the door most agents actually come through, and its "hard rules"
// section is the only place several load-bearing facts are written down for an
// agent. It also carried verbatim copies of nine `cli/src` modules and the seed,
// re-vendored BY HAND, outside the repo, with no gate. Measured on 2026-08-27,
// three weeks after the last careful re-vendor: six of the nine modules and the
// seed had already drifted.
//
// The answer is not a better copy discipline — #18 already tried that for the
// in-repo seed copies, and this is the fourth copy it did not reach. The answer
// is to stop hand-copying. The repo owns the skill's OWN files (SKILL.md, the
// rwa-lite glue, the references); everything vendored is GENERATED here. Drift
// becomes impossible by construction, because nobody copies anything: they
// rebuild.
//
//   node tools/build-skill.mjs --check     report staleness, write nothing
//   node tools/build-skill.mjs --install   (re)build into ~/.claude/skills
//   node tools/build-skill.mjs --out DIR   build somewhere else (CI, tests)
//
// The builder itself is gated by tests/skill-build.mjs, which is the part CI can
// see: an installed skill lives outside the repo, so CI can never assert on it —
// but it CAN assert that a fresh build is correct and self-consistent, which is
// what makes `--install` trustworthy.

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..');
export const SKILL_SRC = join(REPO, 'skills', 'authoring-rewritables');
export const DEFAULT_TARGET = join(homedir(), '.claude', 'skills', 'authoring-rewritables');

/**
 * The `cli/src` modules the skill vendors.
 *
 * Derived, not hand-listed, from what `bin/rwa-lite.mjs` imports plus the
 * transitive closure of those modules' own relative imports — so a new
 * dependency inside `cli/src` cannot be forgotten here. A hand-maintained list
 * is exactly the failure mode this file exists to remove.
 */
export function vendoredModules() {
  const glue = readFileSync(join(SKILL_SRC, 'bin', 'rwa-lite.mjs'), 'utf8');
  const seen = new Set();
  const queue = [...glue.matchAll(/from\s+'\.\.\/src\/([\w-]+\.mjs)'/g)].map(m => m[1]);
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    const p = join(REPO, 'cli', 'src', f);
    if (!existsSync(p)) throw new Error(`rwa-lite imports ../src/${f}, which does not exist in cli/src`);
    seen.add(f);
    for (const m of readFileSync(p, 'utf8').matchAll(/from\s+'\.\/([\w-]+\.mjs)'/g)) queue.push(m[1]);
  }
  return [...seen].sort();
}

/** Everything the built skill should contain, as `relative path → absolute source`. */
export function manifest() {
  const files = new Map();
  // The skill's OWN files — authored here, the only hand-maintained part.
  for (const rel of walk(SKILL_SRC)) files.set(rel, join(SKILL_SRC, rel));
  // The vendored runtime — generated, never hand-copied.
  for (const m of vendoredModules()) files.set(join('src', m), join(REPO, 'cli', 'src', m));
  files.set(join('seeds', 'rewritable.html'), join(REPO, 'seeds', 'rewritable.html'));
  return files;
}

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, join(base, name)));
    else out.push(join(base, name));
  }
  return out;
}

/** The provenance note, regenerated so it can never describe a stale build. */
function provenance() {
  const pkg = JSON.parse(readFileSync(join(REPO, 'cli', 'package.json'), 'utf8'));
  return `# Vendored from the rwa CLI — GENERATED, do not hand-edit

Everything in \`src/\` and \`seeds/rewritable.html\` is produced by
\`tools/build-skill.mjs\` in the re-write-able repo. Do not copy files here by
hand and do not edit them in place: the next build overwrites them, and a local
fix would be silently lost.

To refresh this skill after a repo change:

    node tools/build-skill.mjs --install

To check whether an installed skill is stale without writing anything:

    node tools/build-skill.mjs --check

## Why it is generated

This skill previously carried hand-vendored copies with a written re-vendoring
procedure. Three weeks after the last careful re-vendor, six of the nine modules
and the seed had drifted. The procedure was not the problem; hand-copying was.
The repo now owns only the skill's own files (\`SKILL.md\`, \`bin/rwa-lite.mjs\`,
\`references/*.md\`) and generates the rest.

## This build

- CLI package version: **${pkg.version}**
- Vendored modules: ${vendoredModules().join(', ')}
`;
}

/**
 * Compare a target directory against what a fresh build would produce.
 * @returns {{ok: boolean, missing: string[], drifted: string[], extra: string[], target: string}}
 */
export function check(target = DEFAULT_TARGET) {
  const want = manifest();
  const missing = [], drifted = [];
  if (!existsSync(target)) {
    return { ok: false, missing: [...want.keys()], drifted: [], extra: [], target, absent: true };
  }
  for (const [rel, src] of want) {
    const dst = join(target, rel);
    if (!existsSync(dst)) { missing.push(rel); continue; }
    if (readFileSync(dst).compare(readFileSync(src)) !== 0) drifted.push(rel);
  }
  // Files present in the target that a build would not produce. Reported rather
  // than deleted on --check: a stray file is information, not necessarily rubbish.
  const have = new Set(walk(target));
  const extra = [...have].filter(f => !want.has(f) && f !== join('references', 'VENDORED.md'));
  return { ok: missing.length === 0 && drifted.length === 0, missing, drifted, extra, target };
}

/** Build into `target`, replacing whatever is there. */
export function build(target = DEFAULT_TARGET) {
  const want = manifest();
  // A clean rebuild, so a module dropped from the manifest cannot linger and be
  // silently imported by an older glue file.
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  for (const [rel, src] of want) {
    const dst = join(target, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  writeFileSync(join(target, 'references', 'VENDORED.md'), provenance());
  return { target, files: want.size + 1 };
}

// ─── CLI ───────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const target = outIdx >= 0 ? resolve(args[outIdx + 1]) : DEFAULT_TARGET;

  if (args.includes('--check')) {
    const r = check(target);
    if (r.absent) {
      console.log(`skill not installed at ${r.target}`);
      process.exit(1);
    }
    if (r.ok && !r.extra.length) {
      console.log(`skill at ${r.target} is current (${manifest().size} files)`);
      process.exit(0);
    }
    // Fail LOUD and name every file — a stale skill teaches agents rules that no
    // longer hold, which is worse than no skill at all.
    console.error(`skill at ${r.target} is STALE`);
    for (const f of r.drifted) console.error(`  drifted  ${f}`);
    for (const f of r.missing) console.error(`  missing  ${f}`);
    for (const f of r.extra) console.error(`  extra    ${f}`);
    console.error('\nfix: node tools/build-skill.mjs --install');
    process.exit(1);
  }

  if (args.includes('--install') || outIdx >= 0) {
    const r = build(target);
    console.log(`built ${r.files} files into ${r.target}`);
    process.exit(0);
  }

  console.log('usage: node tools/build-skill.mjs [--check | --install | --out DIR]');
  process.exit(2);
}
