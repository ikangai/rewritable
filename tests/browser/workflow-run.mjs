// `rwa run` — the invoke door (#38), against a real browser.
//
// The gap: a workflow rewritable could only be executed by a human opening it.
// The runner lives inside the seed and nowhere else, so `describe()` would report
// runnable steps and then offer no way to reach them.
//
// This belongs in the browser lane and nowhere else, by that lane's own rule —
// "if jsdom could assert it, it does not belong here". The whole claim under test
// is that the CLI drives the REAL runner in a REAL browser and gets what a person
// would get. A jsdom re-implementation of the runner would assert the opposite of
// what matters: that a copy agrees with itself.
//
// The design constraint is that `rwa run` clicks the same `.rwa-run` control a
// person clicks and reads the page's own `window.__rwaWorkflow` state, so the
// runner is never duplicated. These fixtures therefore carry the seed's own
// FROZEN runner block verbatim and only supply steps — if they carried a runner
// of their own, the test would prove nothing about the shipped one.
//
// A missing Chrome SKIPS loudly and exits 0, unless REQUIRE_BROWSER=1 (CI).

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { findChrome } from '../../cli/src/cdp.mjs';
import { runFile } from '../../cli/src/run.mjs';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../../cli/src/seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, '..', '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL', label, detail == null ? '' : '— ' + detail); }
};

if (!findChrome()) {
  const msg = 'no Chrome binary found (set CHROME_BIN to override)';
  if (process.env.REQUIRE_BROWSER === '1') {
    console.error(`\n✗ run lane REQUIRED but ${msg}`);
    process.exit(1);
  }
  console.log(`\n⚠ SKIPPED: rwa run lane — ${msg}.`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'rwa-run-'));

/** A workflow container carrying the SEED's runner and the given steps. */
function workflowFixture(name, steps) {
  const ov = kindOverrides('workflow');
  const html = applySeedSubs(readFileSync(SEED, 'utf8'), {
    uuid: randomUUID(), title: 'W', fileMeta: name, productKind: 'workflow',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  // Replace ONLY the <article> inside the SHIPPED workflow body. The frozen
  // wf-style and runner blocks around it are the ones `rwa new --kind workflow`
  // emits and must survive untouched — they are what is on trial.
  const scaffold = ov.body;
  const li = steps.map((s, i) =>
    `<li class="rwa-step" data-rwa-id="wfstep${i}a"><script type="text/rwa-step">${s}</` + `script></li>`).join('\n');
  const article =
    '<article class="rwa-workflow">\n<header><h1>Lane fixture</h1></header>\n'
    + '<ol class="rwa-flow">\n' + li + '\n</ol>\n'
    + '<footer class="rwa-workflow-footer"><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>\n'
    + '</article>';
  const body = scaffold.replace(/<article class="rwa-workflow">[\s\S]*?<\/article>/, article);
  if (body === scaffold) throw new Error('fixture: the scaffold article was not found — the workflow kind changed shape');
  const p = join(dir, name);
  writeFileSync(p, replaceInlineDoc(html, body), 'utf8');
  return p;
}

// A throw inside one block would otherwise abort the lane and hide every later
// check — which is how a single regression comes to look like a broken suite.
const guard = async (label, fn) => {
  try { await fn(); }
  catch (e) { fail++; console.log('  FAIL', label, '— threw ' + (e && (e.subcode || e.message))); }
};

console.log('rwa run — the invoke door, in a real browser (#38)\n');

try {
  // ─── The acceptance case ─────────────────────────────────────────────
  await guard('acceptance: one-step workflow', async () => {
    const f = workflowFixture('one.html', ['async function run(ctx, prev) { return { ok: true, doubled: 21 * 2 }; }']);
    const r = await runFile(f);
    check('a one-step workflow executes and returns its result',
      r.ran === true && r.result && r.result.ok === true && r.result.doubled === 42, JSON.stringify(r.result));
    check('…and reports the kind it ran', r.kind === 'workflow', r.kind);
    check('…with no page errors', r.consoleErrors.length === 0, JSON.stringify(r.consoleErrors));
  });

  // ─── Steps compose, which is the thing a runner is FOR ────────────────
  await guard('steps chain', async () => {
    const f = workflowFixture('chain.html', [
      'async function run(ctx, prev) { return 7; }',
      'async function run(ctx, prev) { return prev * 6; }',
    ]);
    const r = await runFile(f);
    // 42 can only appear if step 2 received step 1's output. A runner that ran
    // the steps independently, or ran only the last one, cannot produce it.
    check('steps chain — the second sees the first\'s output', r.result === 42, JSON.stringify(r.result));
  });

  // ─── Timing: the bug this nearly shipped with ─────────────────────────
  await guard('fast workflow is detected', async () => {
    // A trivial workflow finishes in tens of milliseconds. The first version of
    // runFile polled for `running === true` in a separate round-trip and so
    // never saw it, reporting "never started" and burning the full timeout on a
    // workflow that had already returned. Pinned so it cannot come back.
    const f = workflowFixture('fast.html', ['async function run(ctx, prev) { return "instant"; }']);
    const t0 = Date.now();
    const r = await runFile(f, { timeoutMs: 20000 });
    const elapsed = Date.now() - t0;
    check('a workflow that finishes faster than a poll interval is still detected',
      r.result === 'instant', JSON.stringify(r.result));
    check('…and returns promptly rather than waiting out the timeout',
      elapsed < 15000, elapsed + 'ms');
  });

  // ─── A step that throws must not read as success ──────────────────────
  await guard('throwing step', async () => {
    const f = workflowFixture('boom.html', ['async function run(ctx, prev) { throw new Error("step exploded"); }']);
    let threw = null, r = null;
    try { r = await runFile(f); } catch (e) { threw = e; }
    // Whichever way the runner surfaces it, the one unacceptable outcome is a
    // clean success with a result that looks fine.
    const looksClean = r && r.ran === true && r.consoleErrors.length === 0
      && r.result != null && !JSON.stringify(r.result).includes('exploded');
    check('a throwing step does not report a clean success',
      !looksClean, 'threw=' + !!threw + ' result=' + JSON.stringify(r && r.result) + ' console=' + JSON.stringify(r && r.consoleErrors));
  });

  // ─── Refusals are about the document, not the run ─────────────────────
  await guard('no-step workflow refuses', async () => {
    const f = workflowFixture('empty.html', []);
    let code = null, sub = null;
    try { await runFile(f); } catch (e) { code = e.exitCode; sub = e.subcode; }
    check('a workflow with no steps refuses, naming the reason', code === 6 && sub === 'run_failed', code + '/' + sub);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass + fail} checks — ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
