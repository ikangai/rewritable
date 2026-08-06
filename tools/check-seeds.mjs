#!/usr/bin/env node
// Seed-copy freshness check (#18). `node tools/check-seeds.mjs`
//
// WHY: `seeds/rewritable.html` is the canonical bootstrap, and several copies of it live elsewhere.
// The 2026-08-05/06 audit produced a clean natural experiment: the ONE copy with an automated gate
// (the references, via the `refs-fresh` CI job) stayed correct, and both ungated copies rotted —
// `cli/seeds/` three times in a single day, the external authoring skill by two months.
//
// This is the detect half of that issue, deliberately not the fix half: it never writes, moves or
// deletes anything. Two of the copies it checks are outside the repository, where CI cannot reach
// and where silently rewriting a user's files would be worse than the staleness.
//
// Exit 1 if any reachable copy differs, so it can gate a release even though it cannot gate a push.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedIdentity } from '../cli/src/seed.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = path.join(REPO, 'seeds', 'rewritable.html');
const canonical = fs.readFileSync(canonicalPath, 'utf8');
const canonicalId = seedIdentity(canonical);

// Each copy says how it is kept in step, because the right response differs: a build artifact gets
// refreshed, a vendored copy gets re-vendored with its provenance updated, and a gated copy should
// never be stale in the first place.
const copies = [
  {
    path: path.join(REPO, 'cli', 'seeds', 'rewritable.html'),
    label: 'in-package seed (gitignored build artifact)',
    optional: true,
    fix: `cp seeds/rewritable.html cli/seeds/rewritable.html   # or delete it`,
    note: 'WINS the CLI seed-load order, so a stale copy silently emits an old runtime',
  },
  {
    path: path.join(os.homedir(), '.claude', 'skills', 'authoring-rewritables', 'seeds', 'rewritable.html'),
    label: 'authoring-rewritables skill (vendored, outside the repo)',
    optional: true,
    fix: 'cp seeds/rewritable.html ~/.claude/skills/authoring-rewritables/seeds/rewritable.html\n'
       + '       then re-vendor the changed cli/src files and update references/VENDORED.md',
    note: 'also vendors cli/src/*.mjs — a NEW seed.mjs against an OLD seed fails loudly (rwa-seed meta)',
  },
];

console.log(`canonical: ${path.relative(REPO, canonicalPath)} (${canonicalId})\n`);

let stale = 0, missing = 0, ok = 0;
for (const c of copies) {
  let text = null;
  try { text = fs.readFileSync(c.path, 'utf8'); } catch { /* absent */ }
  const shown = c.path.replace(os.homedir(), '~');
  if (text == null) {
    if (c.optional) { missing++; console.log(`  –  absent   ${c.label}\n     ${shown}`); }
    else { stale++; console.log(`  ✗  MISSING  ${c.label}\n     ${shown}`); }
    continue;
  }
  const id = seedIdentity(text);
  if (id === canonicalId) { ok++; console.log(`  ok  in sync  ${c.label}`); }
  else {
    stale++;
    console.log(`  ✗  STALE    ${c.label}`);
    console.log(`     ${shown}`);
    console.log(`     has ${id}, canonical is ${canonicalId}`);
    console.log(`     ${c.note}`);
    console.log(`     fix: ${c.fix}`);
  }
}

// The references are the copy that already has a gate; name it so this script's output is a complete
// picture rather than a partial one that implies the others are all there is.
console.log(`\n  ok  gated     references (hello.html, re-write-able-spec.html, carriers)`);
console.log(`               enforced by the refs-fresh CI job — node tools/regenerate-refs.mjs`);

console.log(`\n${ok} in sync, ${stale} stale, ${missing} absent (absent is fine — the copy is optional).`);
if (stale) {
  console.log('\nStale copies do not fail CI: two of them live outside the repo, and the in-package');
  console.log('one is gitignored so it does not exist on a fresh checkout. That is exactly why this');
  console.log('script exists — run it after any seed change, and before publishing.');
}
process.exit(stale ? 1 : 0);
