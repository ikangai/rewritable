#!/usr/bin/env node
// benchmark/runners/run-control.mjs — the NEGATIVE CONTROL for the fidelity
// lane's drift oracle.
//
// WHY THIS EXISTS
//
// `npm run fidelity:stub` replays each scenario's reference tool trace — the
// edits a flawless model would emit — and asserts everything scores perfectly:
// S=2, T=2, drift_ratio=0. That is a real assertion, but it is a ONE-SIDED
// one, and a dead detector satisfies it just as well as a live one. A
// computeDrift() that unconditionally returned { drift_ratio: 0, score: 2 }
// would pass the entire 108-scenario stub run completely green.
//
// `fidelity:baseline` was supposed to be the other side of that. It wasn't:
// only ONE scenario in 108 (fid-01) ever defined a `baselineDoc`, and
// selectModel() silently fell back to the *stub* trace for the other 107. So
// the "bad model" run replayed the good model 107 times and reported
// meanS=2.00 meanT=1.98 drift=0.0000 — near-indistinguishable from perfect,
// which read as "models are fine" rather than "this lane measures nothing".
//
// This runner is the fix, and it takes the cheap route on purpose. Rather than
// hand-authoring 107 plausible wholesale-rewrite documents — which would be
// slow, and would put the same hand behind both the assertion and the thing
// asserted — it perturbs each scenario's own input with a stray byte placed
// OUTSIDE the declared edit region and requires that scenario's OWN stability
// oracle to notice. That is precisely the question a dead detector fails.
//
// THREE ORACLE FAMILIES, THREE PROBES
//
// Stability oracles here come in three shapes, and a probe that only reaches one
// of them reports the others as dead:
//
//   doc-based       computeDrift(fixture, doc, regions) — reads the resulting
//                   BYTES. Probe: splice a stray comment into the doc.
//   envelope-based  computeDriftFromEdits(fixture, envelope.edits, regions) —
//                   reads the EDIT SPANS and ignores the doc argument almost
//                   entirely. Probe: add an extra edit touching text outside
//                   the expected region.
//   customRun       scoreAfterCustom(out) — scored off the object customRun
//                   RETURNED, not the doc at all. Probe: run the scenario for
//                   real, then corrupt a string field of its result.
//
// PER SCENARIO
//
//   1. Establish a clean baseline — the reading the oracle gives when nothing
//      untoward happened. Tried with an empty-edit envelope first, then with
//      no envelope, because scenarios disagree about which of those means
//      "the model behaved".
//   2. Fire every applicable probe, several sites each.
//   3. The detector is ALIVE if any probe reads WORSE than the clean baseline
//      (lower score or higher drift_ratio). It is DEAD if every probe still
//      reports the same clean bill.
//
// Multiple sites are used per probe because a scenario whose expected-edit
// region happens to cover one end of the document would absorb a probe there
// and report no drift for an honest reason. Doc probes are HTML comments, so
// they are safe to splice at any inter-tag boundary.
//
// DECLARING A DOC-INSENSITIVE ORACLE
//
// Some scenarios score stability from the tool ENVELOPE rather than the
// resulting bytes — ROB-08 scores 2 only when the model made no tool call at
// all, and reads the doc not at all. Those oracles cannot fire on a doc probe,
// and that is correct behaviour, not a dead detector. They must say so:
//
//   driftProbe: 'envelope'   — stability is envelope-driven by design
//   driftProbe: 'none'       — the scenario has no drift dimension
//   driftProbe: 'custom'     — stability lives inside scoreAfterCustom, on the
//                              customRun path, where this static probe cannot
//                              reach it
//
// A 'custom' scenario is NOT exempt — the declaration routes it to a third probe
// that boots the real runtime, runs the scenario, and perturbs the result object
// it returned. If that probe cannot move the score, the scenario is reported DEAD
// like any other. Nothing here is excused from proving itself.
//
// SILENCE IS FAILURE. An oracle that does not fire and does not declare why is
// reported as DEAD and exits non-zero. That is the whole point: the failure
// mode this guards against is a detector that quietly stops detecting, and a
// guard that skips what it can't classify would reproduce it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as harness from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, '..', 'scenarios', 'fidelity');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

const PROBE = '<!--rwa-drift-probe-->';
// Deliberately shares no leading byte with markup or prose, so the diff core
// stays wide — see the edit-probe construction below.
const EDIT_PROBE = 'rwa-drift-probe';

async function discoverScenarios() {
  const files = fs.readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  const scenarios = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(SCENARIOS_DIR, f)).href);
    if (mod.default) scenarios.push({ ...mod.default, _file: f });
  }
  return scenarios;
}

function loadFixture(name) {
  const p = path.join(FIXTURES_DIR, 'templates', name + '.html');
  return fs.readFileSync(p, 'utf8');
}

function resolveFixture(scenario) {
  if (typeof scenario.fixtureContent === 'string') return scenario.fixtureContent;
  if (typeof scenario.fixture === 'string') return loadFixture(scenario.fixture);
  throw new Error(`scenario ${scenario.id}: must declare fixture or fixtureContent`);
}

const readOf = (res) => ({
  score: typeof res?.score === 'number' ? res.score : 2,
  drift: typeof res?.drift_ratio === 'number' ? res.drift_ratio : 0,
});

// A probe fired if the oracle read WORSE than its own clean baseline. Compared
// against the baseline rather than against a hardcoded 2/0 because scenarios
// disagree about what a clean reading looks like.
function worseThan(probe, clean) {
  const p = readOf(probe), c = readOf(clean);
  return p.score < c.score || p.drift > c.drift;
}

const NOOP_ENVELOPE = { version: 'rwa-edit/1', edits: [] };

// Three literal slices of the fixture to hang a spurious out-of-region edit
// off. Several are tried because any single one might legitimately fall inside
// the scenario's expected edit region, where an oracle is right to ignore it.
function editProbeSites(fixture) {
  const n = fixture.length;
  const w = Math.min(40, Math.max(8, Math.floor(n / 8)));
  const mid = Math.max(0, Math.floor(n / 2) - Math.floor(w / 2));
  return [
    ['head', fixture.slice(0, w)],
    ['middle', fixture.slice(mid, mid + w)],
    ['tail', fixture.slice(Math.max(0, n - w))],
  ].filter(([, lit]) => lit.length > 0);
}

// Family 3 — customRun scenarios, whose stability lives in scoreAfterCustom and
// is scored off the RESULT OBJECT that customRun returns, not off the doc. The
// only way to probe those is to actually run the scenario and then perturb what
// it produced. DEG-02 is the live case: it returns { endpoint1, endpoint2 } and
// scores 2 only when the two are byte-identical, so corrupting either one must
// drop the score. This is the family that would otherwise stay UNPROBED.
//
// This is the one probe that boots the real runtime (jsdom, via the shared
// harness), so it is applied ONLY to scenarios that declare driftProbe:'custom'
// — the ones where it is the difference between a proven detector and a
// declared gap. Scenarios declaring 'none' return a hardcoded score by
// construction; running them would confirm what their source already states.
async function probeCustomRun(s) {
  const fixture = resolveFixture(s);
  const ctx = await harness.fresh();
  let out;
  try {
    await ctx.setDoc(fixture);
    out = await s.customRun({ ctx, fixture });
  } catch (err) {
    return { verdict: 'threw', detail: `customRun threw: ${err.message}` };
  } finally {
    ctx.dispose();
  }
  if (!out || typeof out !== 'object') {
    return { verdict: 'silent', detail: 'customRun returned no result object to perturb' };
  }
  const strings = Object.entries(out).filter(([, v]) => typeof v === 'string' && v.length > 0);
  if (strings.length === 0) {
    return { verdict: 'silent', detail: 'customRun result carries no string field to perturb' };
  }

  const clean = readOf(s.scoreAfterCustom(out, fixture, out.endpoint1 ?? fixture).stabilityResult);
  if (clean.score < 2 || clean.drift > 0) {
    return { verdict: 'noisy', detail: `scoreAfterCustom reads unclean on its own untouched output (score=${clean.score}, drift=${clean.drift})` };
  }

  for (const [key] of strings) {
    const perturbed = { ...out, [key]: out[key] + PROBE };
    let res;
    try {
      res = s.scoreAfterCustom(perturbed, fixture, perturbed.endpoint1 ?? fixture).stabilityResult;
    } catch (err) {
      return { verdict: 'alive', detail: `fired at out.${key} (threw: ${err.message})` };
    }
    const r = readOf(res);
    if (r.score < clean.score || r.drift > clean.drift) {
      return {
        verdict: 'alive',
        detail: `fired at out.${key} (score ${clean.score}→${r.score}, drift ${clean.drift.toFixed(4)}→${r.drift.toFixed(4)})`,
      };
    }
  }
  return {
    verdict: 'silent',
    detail: `perturbing every string field of customRun's result (${strings.map(([k]) => k).join(', ')}) left the score at ${clean.score}`,
  };
}

// Cross-check for a driftProbe:'none' declaration.
//
// A 'none' that does not fire looks, from outside, exactly like a detector that
// has died — both are silence. The declaration says "this oracle is a constant,
// it has no drift dimension", so verify THAT property rather than taking the
// word for it: hit the oracle with structurally wild inputs and require the
// reading never to move. A genuine constant is invariant under all of them. An
// oracle that moves for some input it was not probed with is not a constant,
// and its 'none' is false.
//
// (Raised by agent-191, 2026-08-27: the exemption should be cross-checked
// against the property that justifies it, not accepted on its own say-so.)
async function verifyNoneIsConstant(s, fixture, clean) {
  const wild = [
    ['empty doc', '', NOOP_ENVELOPE],
    ['unrelated doc', '<article><p>nothing to do with the fixture</p></article>', NOOP_ENVELOPE],
    ['truncated doc', fixture.slice(0, Math.floor(fixture.length / 3)), NOOP_ENVELOPE],
    ['doubled doc', fixture + fixture, NOOP_ENVELOPE],
    ['no envelope', fixture, null],
    ['many edits', fixture, {
      version: 'rwa-edit/1',
      edits: editProbeSites(fixture).map(([, lit]) => ({ find: lit, replace: EDIT_PROBE })),
    }],
  ];
  for (const [label, doc, env] of wild) {
    let res;
    try {
      res = await s.stability(fixture, doc, env);
    } catch {
      // Throwing is a reading that moved — it is not a constant.
      return { constant: false, at: `${label} (threw)` };
    }
    if (worseThan(res, clean) || readOf(res).score > readOf(clean).score) {
      return { constant: false, at: label };
    }
  }
  return { constant: true };
}

async function probeScenario(s) {
  if (s.driftProbe === 'custom' && typeof s.customRun === 'function' && typeof s.scoreAfterCustom === 'function') {
    return probeCustomRun(s);
  }
  if (typeof s.stability !== 'function') {
    return { verdict: 'no-stability', detail: 'scenario declares no stability() oracle' };
  }
  const fixture = resolveFixture(s);

  // Establish the clean baseline. Scenarios disagree about which envelope
  // means "nothing untoward happened" — most read envelope.edits and treat a
  // missing envelope as total drift; ROB-08 inverts and treats ANY envelope as
  // the failure. Try both and take whichever the oracle calls clean.
  let clean = null, cleanEnvelope;
  for (const env of [NOOP_ENVELOPE, null]) {
    try {
      const res = await s.stability(fixture, fixture, env);
      const r = readOf(res);
      if (r.score >= 2 && r.drift === 0) { clean = res; cleanEnvelope = env; break; }
      if (clean === null) { clean = res; cleanEnvelope = env; }
    } catch (err) {
      return { verdict: 'threw', detail: `stability() threw on the untouched fixture: ${err.message}` };
    }
  }
  const c = readOf(clean);
  if (c.score < 2 || c.drift > 0) {
    return {
      verdict: 'noisy',
      detail: `no envelope makes stability() read clean against its OWN untouched fixture ` +
              `(best: score=${c.score}, drift_ratio=${c.drift}) — a probe cannot be distinguished from this`,
    };
  }

  const probes = [];
  // Family 1 — doc-based oracles: stray bytes spliced into the result.
  for (const [site, doc] of [['doc:prepend', PROBE + fixture], ['doc:append', fixture + PROBE]]) {
    probes.push([site, doc, cleanEnvelope]);
  }
  // Family 2 — envelope-based oracles: a spurious edit outside the region.
  for (const [site, literal] of editProbeSites(fixture)) {
    // The replacement must REPLACE bytes, not extend them. computeDriftFromEdits
    // strips the common prefix/suffix between find and replace to measure only
    // the changed core (so a model padding an anchor for uniqueness isn't scored
    // as drift) — which means `replace: find + something` has a zero-width core
    // and registers as no drift at all. EDIT_PROBE shares no leading byte with
    // markup, so the whole find span reads as changed.
    probes.push([
      `edit:${site}`,
      fixture,
      { version: 'rwa-edit/1', edits: [{ find: literal, replace: EDIT_PROBE }] },
    ]);
  }

  const results = [];
  for (const [site, doc, env] of probes) {
    try {
      const res = await s.stability(fixture, doc, env);
      const r = readOf(res);
      results.push({ site, fired: worseThan(res, clean), score: r.score, drift: r.drift });
    } catch (err) {
      // An oracle that throws on unexpected input is still detecting it —
      // loudly. Count it as alive, but say so.
      results.push({ site, fired: true, threw: err.message });
    }
  }

  const hit = results.find(r => r.fired);
  if (hit) {
    return {
      verdict: 'alive',
      detail: `fired at ${hit.site}` +
        (hit.threw ? ` (threw: ${hit.threw})` : ` (score ${c.score}→${hit.score}, drift ${c.drift.toFixed(4)}→${Number(hit.drift).toFixed(4)})`),
    };
  }
  // Silence. If the scenario claims driftProbe:'none', that claim is a testable
  // property — verify it instead of accepting it.
  if (s.driftProbe === 'none') {
    const v = await verifyNoneIsConstant(s, fixture, clean);
    if (!v.constant) {
      return {
        verdict: 'false-none',
        detail: `declares driftProbe:'none' but its reading MOVES on "${v.at}" — ` +
                `it is not a constant, so the exemption is false and its silence under the standard probes is unexplained`,
      };
    }
    return { verdict: 'silent-constant', detail: `constant under ${6} structurally wild inputs — 'none' verified` };
  }
  return {
    verdict: 'silent',
    detail: `none of ${results.length} probe sites moved the needle ` +
            `(score stayed ${c.score}, drift_ratio stayed ${c.drift.toFixed(4)})`,
  };
}

async function main() {
  const scenarios = await discoverScenarios();
  const VALID_DECL = ['envelope', 'none', 'custom'];
  const alive = [], declared = [], unprobed = [], dead = [];

  for (const s of scenarios) {
    const decl = s.driftProbe;
    if (decl !== undefined && !VALID_DECL.includes(decl)) {
      console.log(`  ${s.id.padEnd(12)} DEAD     bad declaration: driftProbe:'${decl}' is not one of ${VALID_DECL.join(' | ')}`);
      dead.push({ id: s.id, verdict: 'bad-declaration', detail: `driftProbe:'${decl}' is not a recognized value` });
      continue;
    }

    const { verdict, detail } = await probeScenario(s);

    if (verdict === 'alive') {
      console.log(`  ${s.id.padEnd(12)} ALIVE    ${detail}`);
      // A scenario that declares itself unprobeable but then fires is a stale
      // declaration — harmless to the gate, but it hides a real signal behind
      // an exemption, so name it. 'custom' is excluded: there the declaration
      // is what ROUTES the scenario to the customRun probe, so firing is the
      // success case and the declaration must stay.
      if (decl === 'envelope' || decl === 'none') {
        console.log(`  ${''.padEnd(12)}          note: declares driftProbe:'${decl}' but the probe DID fire — drop the declaration`);
      }
      alive.push(s.id);
      continue;
    }

    if (decl === 'custom') {
      console.log(`  ${s.id.padEnd(12)} UNPROBED customRun path — stability lives in scoreAfterCustom`);
      unprobed.push({ id: s.id });
      continue;
    }

    // A 'none' whose exemption failed its own cross-check is a DEAD detector
    // wearing a declaration, which is the exact thing this lane exists to catch.
    if (verdict === 'false-none') {
      console.log(`  ${s.id.padEnd(12)} DEAD     ${detail}`);
      dead.push({ id: s.id, verdict, detail });
      continue;
    }
    if (decl === 'envelope' || decl === 'none') {
      const suffix = verdict === 'silent-constant' ? ' — constant verified' : '';
      console.log(`  ${s.id.padEnd(12)} declared driftProbe:'${decl}'${suffix}`);
      declared.push({ id: s.id, decl });
      continue;
    }

    console.log(`  ${s.id.padEnd(12)} DEAD     ${verdict}: ${detail}`);
    dead.push({ id: s.id, verdict, detail });
  }

  const total = scenarios.length;
  console.log(`\n${alive.length} / ${total} drift detectors proven alive` +
              ` · ${declared.length} declared no-drift-dimension` +
              ` · ${unprobed.length} UNPROBED (customRun) · ${dead.length} DEAD`);
  if (unprobed.length) {
    // Named, every run. A gap this lane cannot close should not be able to
    // quietly become invisible just because the exit code is 0.
    console.log(`\n${unprobed.length} scenario(s) remain UNPROBED — their stability is scored inside`);
    console.log(`scoreAfterCustom on the customRun path, which this static probe cannot reach:`);
    console.log('  ' + unprobed.map(u => u.id).join(', '));
    console.log(`Closing that needs the probe to drive the real runtime. Not done.`);
  }

  if (dead.length) {
    console.error(`\nFAIL — ${dead.length} scenario stability oracle(s) did not notice a stray byte`);
    console.error(`placed outside the declared edit region, and did not declare why:\n`);
    for (const d of dead) console.error(`  ${d.id}  (${d.verdict}) — ${d.detail}`);
    console.error(`\nEither the oracle is broken, or the scenario is genuinely doc-insensitive`);
    console.error(`and must say so: add driftProbe: 'envelope' (stability reads the tool`);
    console.error(`envelope, not the bytes) or driftProbe: 'none' (no drift dimension),`);
    console.error(`with a comment saying which and why.`);
    process.exit(1);
  }

  console.log('\nPASS — every fidelity scenario either proves its drift detector fires, or declares why it cannot.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
