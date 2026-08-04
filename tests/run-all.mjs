// Runs every root test file and reports one summary.
//
// The root suite is 45 standalone files, each its own harness printing
// "N pass, M fail" and exiting non-zero on failure. Before this runner there was
// no single command that ran them all — `npm test` here ran only e2e.mjs, and the
// named scripts covered 12 of 45. CI needs one command with one exit code.
//
// A test that neither passes nor exits is a failure for automation, so this
// enforces a per-file timeout and reports TIMEOUT distinctly from FAIL.
//
// Run: node tests/run-all.mjs          (from the repo root or tests/)
//      TEST_TIMEOUT_MS=300000 node tests/run-all.mjs
//      node tests/run-all.mjs bridge inline-edit      (substring filters)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 180_000);

// Not tests. skill-exec-probe.mjs is a GENERATOR: it emits a browser artifact for
// the Worker/CSP steps jsdom cannot run, and has no pass/fail of its own.
const NOT_A_TEST = new Set(['run-all.mjs', 'skill-exec-probe.mjs']);

const filters = process.argv.slice(2);
const files = fs.readdirSync(HERE)
  .filter(f => f.endsWith('.mjs') && !NOT_A_TEST.has(f))
  .filter(f => !filters.length || filters.some(x => f.includes(x)))
  .sort();

const COUNT_RE = /(\d+)\s+pass(?:ed)?,\s*(\d+)\s+fail(?:ed)?/i;

function run(file) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      cwd: path.resolve(HERE, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });

    const timer = setTimeout(() => { child.kill('SIGKILL'); }, TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const m = out.match(COUNT_RE);
      const counts = m ? { pass: +m[1], fail: +m[2] } : null;
      // SIGKILL with all assertions green means the file finished its work but
      // never released the event loop — jsdom keeps it alive unless the file
      // calls process.exit explicitly. Broken for automation either way.
      const timedOut = signal === 'SIGKILL';
      const status = timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL';
      resolve({ file, status, code, ms, counts, out });
    });
  });
}

const results = [];
for (const f of files) {
  const r = await run(f);
  results.push(r);
  const c = r.counts ? `${r.counts.pass}/${r.counts.pass + r.counts.fail}` : '—';
  console.log(`${r.status.padEnd(7)} ${String(Math.round(r.ms / 1000) + 's').padStart(5)}  ${c.padStart(9)}  ${r.file}`);
}

const failed = results.filter(r => r.status === 'FAIL');
const timedOut = results.filter(r => r.status === 'TIMEOUT');

for (const r of [...failed, ...timedOut]) {
  console.log(`\n───── ${r.file} (${r.status}) ─────\n${r.out.trim().split('\n').slice(-25).join('\n')}`);
}

const totalAssertions = results.reduce((n, r) => n + (r.counts ? r.counts.pass : 0), 0);
console.log(`\n${results.length} files — ${results.length - failed.length - timedOut.length} pass, ${failed.length} fail, ${timedOut.length} timeout (${totalAssertions} assertions)`);
if (timedOut.length) {
  console.log(`TIMEOUT means the file never exited within ${TIMEOUT_MS}ms. If its assertions all passed,\nit is missing a terminating process.exit() — see the convention in tests/mode.mjs.`);
}
process.exit(failed.length + timedOut.length ? 1 : 0);
