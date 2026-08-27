// The deploy gate must be able to FAIL on /health. (#48)
//
// `scripts/deploy.sh verify` fetched /health, printed it, and never tested it:
// the success condition read seed_code + the bootstrap marker + byte count only.
// So a deploy where Traefik still serves the static seed but the Node service is
// wedged printed `/health -> UNREACHABLE` on one line and `OK` on the next.
// Observed live on the 2026-08-27 prod deploy.
//
// This is the negative control for that gate, and it is the whole point of the
// change — per CLAUDE.md Rule 13, a check is not trusted until it has been
// watched failing on deliberately broken input. Adding `$health` to the
// predicate is three characters; proving the predicate can fail is the work.
//
// It drives the REAL script through its real entry point (`deploy.sh verify`)
// against a local server standing in for the site, rather than testing a copy of
// the logic. A reimplementation of the predicate would pass while the shipped
// script stayed broken — which is the exact failure mode being fixed here.
//
// The cases below are chosen so each can only be satisfied for the right reason:
// unreachable, 5xx and 200-with-a-different-body all have to fail, and they fail
// through different mechanisms (curl -f exit status for the first two, the body
// comparison for the third). The healthy case and the recovers-on-retry case
// guard the other direction — a gate that fails everything is not a gate.
//
// Run: node tests/deploy-verify.mjs

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// Overridable so the control can be re-observed FAILING against a pre-fix copy
// of the script — `git show <rev>:scripts/deploy.sh > /tmp/pre48.sh` — by someone
// who did not write it, without mutating a working tree several agents share.
// A negative control nobody but its author has ever seen go red is a weaker
// claim than one that can be reproduced on demand.
const DEPLOY_SH = process.env.DEPLOY_SH || path.join(ROOT, 'scripts', 'deploy.sh');
// The real seed: >100 KB and carrying id="rwa-bootstrap", which is what the
// seed half of the predicate actually looks for. Using the genuine artifact
// means the seed checks pass for the same reason they pass in production.
const SEED = readFileSync(path.join(ROOT, 'seeds', 'rewritable.html'));

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL', label, detail == null ? '' : '\n        ' + String(detail).replace(/\n/g, '\n        ')); }
};

/**
 * A stand-in for the deployed site.
 * `health` is a function of the attempt number, so a probe can be made to fail
 * once and then recover — the behaviour real deploys show while Traefik
 * re-registers, and the reason this gate has a retry budget at all.
 */
function startSite({ health, seed = SEED }) {
  let healthHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const r = health(++healthHits);
      if (r === null) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found\n'); }
      res.writeHead(r.status, { 'Content-Type': 'text/plain' });
      return res.end(r.body);
    }
    if (req.url === '/rewritable.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(seed);
    }
    res.writeHead(404).end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        healthHits: () => healthHits,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

/** Run the real script's real verify subcommand against `url`. */
function runVerify(url, env = {}) {
  return new Promise(resolve => {
    const child = spawn('bash', [DEPLOY_SH, 'verify'], {
      cwd: ROOT,
      env: {
        ...process.env,
        SITE_URL: url,
        // Small budget: these cases resolve immediately, and a 10 x 6s default
        // would make the suite take minutes to prove a sub-second property.
        VERIFY_ATTEMPTS: '2',
        VERIFY_DELAY: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}

const OK = () => ({ status: 200, body: 'ok\n' });

(async () => {
  console.log('deploy.sh verify — the /health probe must be able to fail (#48)\n');

  // Preconditions, stated loudly rather than skipped. A silent skip here would
  // report an untested gate as a passing suite, which is the shape of defect
  // this file exists to prevent.
  const probe = spawn('curl', ['--version'], { stdio: 'ignore' });
  const haveCurl = await new Promise(r => { probe.on('close', c => r(c === 0)); probe.on('error', () => r(false)); });
  check('preconditions: bash + curl available (the script needs both)', haveCurl,
    'curl is not runnable — this suite cannot verify the deploy gate on this machine');
  if (!haveCurl) { console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`); process.exit(1); }

  // ─── The control: broken /health must FAIL verification ────────────────
  //
  // Each of these serves a perfectly good seed. That is deliberate: the whole
  // defect is that a good seed was sufficient to declare the deploy OK.

  {
    const site = await startSite({ health: () => null });          // 404, no such route
    const r = await runVerify(site.url);
    await site.close();
    check('an unreachable /health FAILS verification, despite a good seed', r.code !== 0,
      `exit ${r.code}\n${r.out}`);
    check('…and the failure names the health value, not just "seed not served"',
      r.code !== 0 && /health/i.test(r.out) && /UNREACHABLE/.test(r.out), r.out);
    // What this suite pins is that the predicate CAN fail. Whether the default
    // 10 x 6s budget covers a real container recreate — where /health lags
    // Traefik re-registration — is pinned by nothing, and cannot be, from a stub
    // that recovers on command. So the failure has to carry that knowledge
    // itself: the person who hits a budget-red must be steered to raise the
    // budget, because the tempting alternative is deleting the health term and
    // restoring the exact defect this closed.
    //
    // Both halves, deliberately AND-ed: someone who keeps "raise
    // VERIFY_ATTEMPTS" while dropping the "do not drop the check" clause has
    // removed the half that carries the warning and kept the half that merely
    // looks helpful, and this must notice. Stated because an undocumented
    // intention is indistinguishable from an accident — a later reader
    // simplifying this to one term would be tidying, as far as they could tell.
    //
    // This assertion is also the most rot-prone kind in the file: it checks that
    // a string appears in output, so it keeps passing through any rewrite of the
    // message that preserves a token and loses the meaning. So it has been
    // verified by mutation, and must be again if either wording changes:
    //
    //   sed '/if \[\[ "$health" != "ok" \]\]/,/^  fi$/d' scripts/deploy.sh > /tmp/m.sh
    //   DEPLOY_SH=/tmp/m.sh node tests/deploy-verify.mjs
    //   → exactly 1 red, and it is this assertion. The gate assertions stay
    //     green, correctly: the gate still works with a worse message.
    //
    // Anchored to the block's TEXT, not to line numbers. A recipe that says
    // "delete lines 256-258" silently rots the next time anything above it
    // moves, and then points the reader at the wrong three lines — they delete
    // something else, see a red that is not this pin firing, and conclude the
    // pin still bites when it no longer does. (Raised by agent-192, 2026-08-27,
    // whose own recipe carried exactly that dependency.)
    //
    // One trap, hit while verifying this. Deleting only the four `warn` lines
    // and leaving the `if` leaves an EMPTY body — a bash syntax error. The
    // result is NOT an obviously broken run: it is 5 pass / 6 fail, and the
    // five survivors are every assertion that EXPECTS VERIFICATION TO FAIL
    // (unreachable, 5xx, wrong body, bad seed, and the precondition). A script
    // that dies of a syntax error exits non-zero, which satisfies all of them
    // vacuously, having evaluated nothing at all.
    //
    // So the mutant reads as a gate that rejects healthy sites and lag-then-
    // recover while still catching every wedged case — i.e. HYPERSENSITIVE. That
    // is a coherent diagnosis, and the action it invites is weakening the gate.
    // An all-red run would at least look like an environment problem. Remove the
    // whole `if … fi`, as the sed above does. (Measured by agent-192, 2026-08-27,
    // correcting an earlier version of this note that claimed "all red".)
    check('…and it steers the reader to raise the budget rather than drop the check',
      /VERIFY_ATTEMPTS/.test(r.out) && /do not drop the check/i.test(r.out), r.out);
  }

  {
    const site = await startSite({ health: () => ({ status: 503, body: 'down\n' }) });
    const r = await runVerify(site.url);
    await site.close();
    // curl -f turns 5xx into a non-zero exit, so this reaches the predicate as
    // UNREACHABLE — a different mechanism from the body check below.
    check('a 5xx /health FAILS verification', r.code !== 0, `exit ${r.code}\n${r.out}`);
  }

  {
    // The case the body comparison exists for: HTTP-fine, semantically wrong.
    // curl -f is happy here, so only comparing the payload catches it.
    const site = await startSite({ health: () => ({ status: 200, body: 'maintenance\n' }) });
    const r = await runVerify(site.url);
    await site.close();
    check('a 200 /health with the WRONG body FAILS verification', r.code !== 0,
      `exit ${r.code}\n${r.out}`);
  }

  // ─── The other direction: a gate that fails everything is not a gate ───

  {
    const site = await startSite({ health: OK });
    const r = await runVerify(site.url);
    await site.close();
    check('a healthy site PASSES', r.code === 0, `exit ${r.code}\n${r.out}`);
    check('…and still reports both probes', /\/health\s*->\s*ok/.test(r.out) && /rewritable\.html.*200/.test(r.out), r.out);
  }

  {
    // The retry-budget property, and the reason this is not a one-line change.
    // /health is structurally LATER than Traefik registration: on the 2026-08-27
    // deploy the seed served on attempt 5 while /health was still UNREACHABLE,
    // then answered 200 by hand seconds later. A gate that fails on the first
    // miss would red a deploy that was fine — and the first person to see that
    // would weaken the gate back out. It must consume the retry budget.
    const site = await startSite({ health: (n) => (n === 1 ? null : OK()) });
    const r = await runVerify(site.url, { VERIFY_ATTEMPTS: '3', VERIFY_DELAY: '1' });
    const hits = site.healthHits();
    await site.close();
    check('a /health that lags one attempt and then recovers PASSES', r.code === 0,
      `exit ${r.code}\n${r.out}`);
    check('…having actually retried (the gate uses the budget, it does not fail fast)',
      hits >= 2, `/health was polled ${hits}x`);
  }

  {
    // Guard the half that already worked, so the change cannot trade one probe
    // for the other.
    const site = await startSite({ health: OK, seed: Buffer.from('<html>too small, no marker</html>') });
    const r = await runVerify(site.url);
    await site.close();
    check('a healthy /health does NOT excuse a bad seed', r.code !== 0, `exit ${r.code}\n${r.out}`);
  }

  console.log(`\n== Summary ==\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
