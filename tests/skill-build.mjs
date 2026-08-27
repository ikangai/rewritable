// The skill builder (#42) — the gate that makes hand-drift impossible.
//
// `authoring-rewritables` is the door most agents come through, and its "hard
// rules" section is the only place several load-bearing facts are written down
// for an agent. It also carried verbatim copies of nine `cli/src` modules and
// the seed, re-vendored BY HAND, outside the repo, with no gate. Measured three
// weeks after the last careful re-vendor: six of nine modules and the seed had
// drifted. #18 closed exactly this for the three IN-REPO seed copies; this was
// the fourth copy, and the one that teaches agents the rules.
//
// An installed skill lives outside the repo, so CI can never assert on it. What
// CI CAN assert — and what makes `--install` trustworthy — is that a fresh build
// is correct, self-consistent, and actually works. That is this file.
//
// The last two checks matter most and are the easiest to leave out:
//
//   • the built skill is EXERCISED, not just compared. A file-by-file diff
//     proves the copies match; it does not prove the vendored subset is
//     sufficient to run. Only running `new` → `doc` → `edit` does.
//   • the CHECKER is given something broken and must notice. A drift detector
//     that always says "current" is worse than none, because it converts an
//     unexamined risk into a false assurance.
//
// Run:  (cd tests && node skill-build.mjs)

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, check, manifest, vendoredModules, REPO, SKILL_SRC } from '../tools/build-skill.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const t = (label, cond, detail) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL', label, detail == null ? '' : '— ' + detail); }
};

const dir = mkdtempSync(join(tmpdir(), 'rwa-skillbuild-'));
const target = join(dir, 'skill');

console.log('skill builder — generated, not hand-copied\n');

try {
  // ── A. The manifest is DERIVED, not hand-listed ──────────────────────
  {
    const mods = vendoredModules();
    t('A1 the vendored set is non-empty', mods.length > 0);
    // The derivation walks rwa-lite's imports and their transitive closure, so a
    // module added to cli/src that the glue reaches must appear without anyone
    // remembering to add it. Assert the closure really closed: every relative
    // import inside a vendored module resolves to another vendored module.
    let unresolved = [];
    for (const m of mods) {
      const src = readFileSync(join(REPO, 'cli', 'src', m), 'utf8');
      for (const hit of src.matchAll(/from\s+'\.\/([\w-]+\.mjs)'/g)) {
        if (!mods.includes(hit[1])) unresolved.push(`${m} → ${hit[1]}`);
      }
    }
    t('A2 the dependency closure is complete', unresolved.length === 0, unresolved.join(', '));
  }

  // ── B. A fresh build is byte-identical to the repo ───────────────────
  {
    const r = build(target);
    t('B1 the build wrote files', r.files > 5, `${r.files} files`);

    let bad = [];
    for (const [rel, src] of manifest()) {
      const built = join(target, rel);
      if (!existsSync(built)) { bad.push(rel + ' (missing)'); continue; }
      if (readFileSync(built).compare(readFileSync(src)) !== 0) bad.push(rel + ' (differs)');
    }
    t('B2 every built file matches its repo source byte-for-byte', bad.length === 0, bad.join(', '));

    // The provenance note is regenerated, so it can never describe a stale build.
    const vend = readFileSync(join(target, 'references', 'VENDORED.md'), 'utf8');
    t('B3 VENDORED.md is generated and says so', /GENERATED, do not hand-edit/.test(vend));
    t('B4 and names the modules this build actually vendored',
      vendoredModules().every(m => vend.includes(m)));
  }

  // ── C. The checker agrees with the builder — and NOTICES damage ──────
  {
    const fresh = check(target);
    t('C1 a fresh build checks clean', fresh.ok && fresh.extra.length === 0,
      JSON.stringify({ missing: fresh.missing, drifted: fresh.drifted, extra: fresh.extra }));

    // NEGATIVE CONTROL. A drift detector that cannot fail is worse than none: it
    // converts an unexamined risk into a false assurance. Damage one vendored
    // file and one skill-local file, and require both to be named.
    const victim = join(target, 'src', 'edit.mjs');
    writeFileSync(victim, readFileSync(victim, 'utf8') + '\n// drift\n');
    writeFileSync(join(target, 'SKILL.md'), '# tampered\n');
    const damaged = check(target);
    t('C2 the checker fails on a drifted vendored module', !damaged.ok && damaged.drifted.includes(join('src', 'edit.mjs')));
    t('C3 and on a drifted skill-local file', damaged.drifted.includes('SKILL.md'));

    // And a rebuild repairs it — the build is a clean replace, not a merge, so a
    // module dropped from the manifest cannot linger and be imported by older glue.
    writeFileSync(join(target, 'stale-module.mjs'), 'export const gone = 1;\n');
    build(target);
    const repaired = check(target);
    t('C4 a rebuild repairs drift', repaired.ok);
    t('C5 and removes files a build would not produce', !existsSync(join(target, 'stale-module.mjs')));
  }

  // ── D. The built skill actually RUNS ─────────────────────────────────
  {
    // The check a file diff cannot make: is the vendored subset SUFFICIENT?
    // Every module could match the repo perfectly and the skill still be unable
    // to boot, because a needed one was never in the manifest.
    const lite = join(target, 'bin', 'rwa-lite.mjs');
    const work = join(dir, 'work');
    const file = join(work, 'x.html');
    execFileSync('node', ['-e', `require('node:fs').mkdirSync(${JSON.stringify(work)},{recursive:true})`]);

    execFileSync('node', [lite, 'new', file], { stdio: 'pipe' });
    t('D1 rwa-lite new emits a container', existsSync(file));

    const body = execFileSync('node', [lite, 'doc', file], { encoding: 'utf8' });
    t('D2 rwa-lite doc reads it back', body.includes('<article'));

    const planPath = join(work, 'p.json');
    writeFileSync(planPath, JSON.stringify({
      version: 'rwa-edit/1', edits: [{ find: 'Untitled', replace: 'Built by the skill' }],
    }));
    execFileSync('node', [lite, 'edit', file, '--plan', planPath], { stdio: 'pipe' });
    const after = execFileSync('node', [lite, 'doc', file], { encoding: 'utf8' });
    t('D3 rwa-lite edit applies an envelope', after.includes('Built by the skill'));

    // And the skill inherits the epic's work rather than lagging it — the
    // clearest single proof that a rebuild really does carry the repo forward.
    t('D4 the built skill carries the block-id backfill (#32)', /data-rwa-id="[a-z2-7]{8}"/.test(after));
    const json = JSON.parse(execFileSync('node', [lite, 'doc', file, '--json'], { encoding: 'utf8' }));
    t('D5 and the read door reports the staleness token (#31)', /^[0-9a-f]{64}$/.test(json.baseHash || ''));
  }

  // ── E. The repo owns only what it should ─────────────────────────────
  {
    // src/ and seeds/ must NOT be committed under skills/: a second copy in the
    // repo would be the same drift risk wearing a different hat.
    t('E1 the repo carries no vendored src/ under skills/', !existsSync(join(SKILL_SRC, 'src')));
    t('E2 and no vendored seed', !existsSync(join(SKILL_SRC, 'seeds')));
    t('E3 but does carry the skill\'s own glue', existsSync(join(SKILL_SRC, 'bin', 'rwa-lite.mjs')));
    t('E4 and its instructions', existsSync(join(SKILL_SRC, 'SKILL.md')));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass + fail} checks — ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
