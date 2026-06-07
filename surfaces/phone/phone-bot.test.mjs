// Tests for the phone voice-dispatch core (`handleTurn`). EVERYTHING is injected,
// so the whole suite is fully offline: the foundation, the agent, and the rwa-exec
// are scripted fakes; the ONLY real dependency is `twiml.mjs` — and that is on
// purpose. We use the REAL TwiML builders so the assertions check the actual XML a
// phone would receive (escaping included), not a stub.
//
// WHY each assertion matters (Rule 9 — tests encode intent, not just behavior):
//  - the call must NEVER end in silence or an unhandled throw. Every branch — and
//    the whole-body catch — must emit a <Response> that either re-gathers (the call
//    continues) or hangs up (a clean end). A test that only checked "no throw" would
//    pass on a silent empty response; we assert the actual TwiML shape.
//  - the EDIT path must post the EXACT modify payload. The envelope version, the new
//    body, the reason, the baseHash, and the actor are the contract with the
//    foundation; a refactor that drops or renames any of them must fail loudly.
//  - the capability token === write access to the bound doc. It must reach NEITHER
//    any spoken text NOR any log argument. We thread a sentinel token through every
//    path and scan all output + log args for it — the security property is pinned.
//  - 409 stale_base must retry the modify exactly ONCE with a FRESH baseHash, then
//    give up with a voice-shaped message. This is optimistic-concurrency correctness.
//  - the exported temp file must be cleaned on BOTH the success and the failure path
//    (the `finally`), or the host leaks files.

import assert from 'node:assert/strict';
import { handleTurn } from './phone-bot.mjs';
import * as twiml from './twiml.mjs';
import { FoundationError } from '../telegram/foundation-api.mjs';

let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`ok - ${name}`);
  });
}

const TOKEN = 'SENTINEL-TOKEN-do-not-leak-9f3a';
const DOC_ID = 'abc123';
const ENV = { PHONE_DOC_ID: DOC_ID, PHONE_DOC_TOKEN: TOKEN };

// Build a deps bundle. Each sub-fake records its calls; behavior is overridable
// per-test via the `over` overrides. `twiml` is the REAL module.
function makeDeps(over = {}) {
  const calls = {
    describe: [], readDoc: [], exportDoc: [], modify: [],
    classify: [], answer: [], rwaEdit: [], writeTemp: [], unlinkTemp: [], log: [],
  };
  const foundation = {
    describe: (...a) => { calls.describe.push(a); return (over.describe ?? (() => Promise.resolve({ title: 'Q3 Report' })))(...a); },
    readDoc: (...a) => { calls.readDoc.push(a); return (over.readDoc ?? (() => Promise.resolve({ doc: 'DOC BODY', baseHash: 'h0' })))(...a); },
    exportDoc: (...a) => { calls.exportDoc.push(a); return (over.exportDoc ?? (() => Promise.resolve('<html>bytes</html>')))(...a); },
    modify: (...a) => { calls.modify.push(a); return (over.modify ?? (() => Promise.resolve({ baseHash: 'h1' })))(...a); },
  };
  const agent = {
    classifyIntent: (...a) => { calls.classify.push(a); return (over.classifyIntent ?? (() => Promise.resolve('ask')))(...a); },
    answer: (...a) => { calls.answer.push(a); return (over.answer ?? (() => Promise.resolve('The revenue was 4.2 million.')))(...a); },
  };
  const exec = {
    rwaEdit: (...a) => { calls.rwaEdit.push(a); return (over.rwaEdit ?? (() => Promise.resolve({ ok: true, doc: 'NEW BODY' })))(...a); },
  };
  const writeTemp = (...a) => { calls.writeTemp.push(a); return (over.writeTemp ?? (() => '/tmp/phone-xyz.html'))(...a); };
  const unlinkTemp = (...a) => { calls.unlinkTemp.push(a); return (over.unlinkTemp ?? (() => Promise.resolve()))(...a); };
  const log = (...a) => { calls.log.push(a); };
  return { deps: { foundation, agent, exec, twiml, env: ENV, log, writeTemp, unlinkTemp }, calls };
}

// Scan a value (TwiML string OR a log-args array) for the sentinel token. Errors
// stringify their message + stack; we walk arbitrary args defensively.
function leaks(value) {
  const seen = JSON.stringify(value, (k, v) => (v instanceof Error ? `${v.message} ${v.stack}` : v));
  return seen.includes(TOKEN);
}
function assertNoTokenLeak(xml, calls) {
  assert.ok(!xml.includes(TOKEN), 'token must not appear in TwiML output');
  for (const args of calls.log) {
    assert.ok(!leaks(args), 'token must not appear in any log argument');
  }
}

// ── greeting / no-speech ─────────────────────────────────────────────────────

await test('empty SpeechResult → greeting + a <Gather> to /phone/turn (no throw)', async () => {
  const { deps, calls } = makeDeps();
  const xml = await handleTurn({}, deps);
  assert.ok(xml.startsWith('<?xml'), 'has the XML prolog');
  assert.ok(/<Say>[^<]*Q3 Report/.test(xml), 'greeting mentions the doc title from describe');
  assert.ok(xml.includes('<Gather input="speech" action="/phone/turn"'), 'gathers to /phone/turn');
  assert.equal(calls.classify.length, 0, 'no classification on call start');
  assert.equal(calls.modify.length, 0, 'no modify on call start');
  assertNoTokenLeak(xml, calls);
});

await test('greeting: describe failure still greets (generic) — never fails the call', async () => {
  const { deps, calls } = makeDeps({ describe: () => Promise.reject(new FoundationError('request_failed', { status: 0 })) });
  const xml = await handleTurn({ SpeechResult: '' }, deps);
  assert.ok(xml.includes('<Say>'), 'still says a greeting');
  assert.ok(xml.includes('<Gather input="speech" action="/phone/turn"'), 'still gathers');
  assert.ok(!xml.includes('<Hangup'), 'a describe failure must NOT end the call');
  assertNoTokenLeak(xml, calls);
});

// ── goodbye ──────────────────────────────────────────────────────────────────

await test('goodbye → <Say>Goodbye. + <Hangup/>, no classify / no foundation calls', async () => {
  const { deps, calls } = makeDeps();
  const xml = await handleTurn({ SpeechResult: "Okay that's all, goodbye" }, deps);
  assert.ok(xml.includes('<Say>Goodbye.</Say>'), 'says goodbye');
  assert.ok(xml.includes('<Hangup/>'), 'hangs up');
  assert.equal(calls.classify.length, 0, 'goodbye short-circuits before classify');
  assert.equal(calls.readDoc.length, 0, 'goodbye touches no foundation call');
  assertNoTokenLeak(xml, calls);
});

await test('goodbye: "stop" / "hang up" / "bye" variants all hang up', async () => {
  for (const phrase of ['stop', 'please hang up', 'bye now']) {
    const { deps } = makeDeps();
    const xml = await handleTurn({ SpeechResult: phrase }, deps);
    assert.ok(xml.includes('<Hangup/>'), `"${phrase}" should hang up`);
  }
});

// ── ask ──────────────────────────────────────────────────────────────────────

await test('ask → readDoc + agent.answer; <Say> carries the answer + a <Gather>', async () => {
  const { deps, calls } = makeDeps({ classifyIntent: () => Promise.resolve('ask') });
  const xml = await handleTurn({ SpeechResult: 'what was revenue?' }, deps);
  assert.equal(calls.readDoc.length, 1, 'reads the bound doc');
  assert.deepEqual(calls.readDoc[0], [DOC_ID, TOKEN], 'reads by bound id+token');
  assert.equal(calls.answer.length, 1, 'asks the agent to answer');
  assert.deepEqual(calls.answer[0], ['what was revenue?', 'DOC BODY'], 'answer gets the question + doc body');
  assert.ok(xml.includes('<Say>The revenue was 4.2 million.</Say>'), 'speaks the answer');
  assert.ok(xml.includes('<Gather input="speech" action="/phone/turn"'), 're-gathers for the next turn');
  assert.equal(calls.modify.length, 0, 'ask never mutates');
  assertNoTokenLeak(xml, calls);
});

await test('ask: a doc-derived answer with XML metachars is escaped in <Say>', async () => {
  // The answer is untrusted text flowing into <Say>; it MUST be escaped or it could
  // inject TwiML. We rely on twiml.say to escape — assert the raw < never survives.
  const { deps } = makeDeps({
    classifyIntent: () => Promise.resolve('ask'),
    answer: () => Promise.resolve('5 < 6 & "yes"'),
  });
  const xml = await handleTurn({ SpeechResult: 'compare' }, deps);
  assert.ok(xml.includes('5 &lt; 6 &amp; &quot;yes&quot;'), 'answer is XML-escaped');
  assert.ok(!/<Say>5 < 6/.test(xml), 'no unescaped < survives into <Say>');
});

// ── edit ─────────────────────────────────────────────────────────────────────

await test('edit → EXACT modify payload + confirmation <Say> + gather; unlinkTemp called', async () => {
  const { deps, calls } = makeDeps({ classifyIntent: () => Promise.resolve('edit') });
  const xml = await handleTurn({ SpeechResult: 'make the title bigger', From: '+15551234567' }, deps);

  // The contract: read for baseHash, export to temp, rwaEdit, modify.
  assert.equal(calls.readDoc.length, 1, 'reads for the baseHash');
  assert.equal(calls.exportDoc.length, 1, 'exports the container bytes');
  assert.deepEqual(calls.writeTemp[0], ['<html>bytes</html>', '.html'], 'writes exported bytes to a .html temp');
  assert.deepEqual(calls.rwaEdit[0], ['/tmp/phone-xyz.html', 'make the title bigger'], 'rwaEdit gets temp path + the spoken instruction');

  // THE load-bearing assertion: the exact modify payload.
  assert.equal(calls.modify.length, 1, 'modifies exactly once');
  const [mid, mtoken, payload] = calls.modify[0];
  assert.equal(mid, DOC_ID);
  assert.equal(mtoken, TOKEN);
  assert.deepEqual(payload, {
    envelope: { version: 'rwa-edit/1', doc: 'NEW BODY', reason: 'make the title bigger' },
    baseHash: 'h0',
    actor: 'phone:+15551234567',
  }, 'EXACT modify payload (envelope/baseHash/actor)');

  assert.ok(/<Say>[^<]*updated/i.test(xml), 'confirms the update');
  assert.ok(xml.includes('<Gather input="speech" action="/phone/turn"'), 're-gathers');
  assert.equal(calls.unlinkTemp.length, 1, 'cleans the temp file');
  assert.deepEqual(calls.unlinkTemp[0], ['/tmp/phone-xyz.html'], 'unlinks the exact temp it wrote');
  assertNoTokenLeak(xml, calls);
});

await test("edit: actor falls back to 'phone:caller' when From is absent", async () => {
  const { deps, calls } = makeDeps({ classifyIntent: () => Promise.resolve('edit') });
  await handleTurn({ SpeechResult: 'tweak it' }, deps);
  assert.equal(calls.modify[0][2].actor, 'phone:caller', 'no From → phone:caller');
});

await test('edit bad_instruction → "couldn\'t apply" + gather; modify NOT called; temp cleaned', async () => {
  const { deps, calls } = makeDeps({
    classifyIntent: () => Promise.resolve('edit'),
    rwaEdit: () => Promise.resolve({ ok: false, code: 'bad_instruction' }),
  });
  const xml = await handleTurn({ SpeechResult: 'change it', From: '+1' }, deps);
  // The apostrophe in "couldn't" is XML-escaped by say() to &#39;, so match around it.
  assert.ok(/couldn\S*t apply/i.test(xml), 'voice-shaped "couldn\'t apply"');
  assert.ok(xml.includes('<Gather'), 'still gathers — the call continues');
  assert.equal(calls.modify.length, 0, 'bad_instruction must NOT reach modify');
  assert.equal(calls.unlinkTemp.length, 1, 'temp still cleaned in finally');
});

await test('edit rwaEdit failure → apology + gather; raw failure LOGGED not spoken; temp cleaned', async () => {
  const failure = { ok: false, step: 'edit', code: 7, stderr: 'find_not_found: <secret-internal-detail>' };
  const { deps, calls } = makeDeps({
    classifyIntent: () => Promise.resolve('edit'),
    rwaEdit: () => Promise.resolve(failure),
  });
  const xml = await handleTurn({ SpeechResult: 'do the thing', From: '+1' }, deps);
  assert.ok(/sorry/i.test(xml), 'apologizes');
  assert.ok(xml.includes('<Gather'), 'gathers — call continues');
  assert.ok(!xml.includes('secret-internal-detail'), 'raw stderr is NOT spoken');
  assert.equal(calls.modify.length, 0, 'a failed edit never modifies');
  assert.ok(calls.log.length >= 1, 'the raw failure is logged host-side');
  assert.equal(calls.unlinkTemp.length, 1, 'temp cleaned in finally on failure too');
});

// ── 409 stale_base retry-once ────────────────────────────────────────────────

await test('409 stale_base → re-readDoc + ONE modify retry with the FRESH baseHash → success', async () => {
  let modifyCalls = 0;
  const { deps, calls } = makeDeps({
    classifyIntent: () => Promise.resolve('edit'),
    // First readDoc → h0; the retry's readDoc → h2 (fresh).
    readDoc: (() => { let n = 0; return () => Promise.resolve({ doc: 'D', baseHash: n++ === 0 ? 'h0' : 'h2' }); })(),
    modify: () => {
      modifyCalls++;
      if (modifyCalls === 1) return Promise.reject(new FoundationError('stale_base', { status: 409, currentHash: 'h2' }));
      return Promise.resolve({ baseHash: 'h3' });
    },
  });
  const xml = await handleTurn({ SpeechResult: 'edit it', From: '+1' }, deps);
  assert.equal(calls.modify.length, 2, 'modify tried twice (initial + one retry)');
  assert.equal(calls.modify[0][2].baseHash, 'h0', 'first attempt used the stale hash');
  assert.equal(calls.modify[1][2].baseHash, 'h2', 'retry used the FRESH re-read hash');
  assert.equal(calls.readDoc.length, 2, 're-read to get the fresh hash');
  assert.ok(/<Say>[^<]*updated/i.test(xml), 'retry succeeded → confirmation');
});

await test('409 stale_base TWICE → "document changed" + gather (gives up after one retry)', async () => {
  const { deps, calls } = makeDeps({
    classifyIntent: () => Promise.resolve('edit'),
    modify: () => Promise.reject(new FoundationError('stale_base', { status: 409, currentHash: 'hx' })),
  });
  const xml = await handleTurn({ SpeechResult: 'edit it', From: '+1' }, deps);
  assert.equal(calls.modify.length, 2, 'exactly two attempts — no infinite retry');
  assert.ok(/changed/i.test(xml), 'voice-shaped "the document changed"');
  assert.ok(xml.includes('<Gather'), 'gathers — call continues, not hangup');
});

// ── 404 / 401 on the bound doc → hangup ──────────────────────────────────────

await test('404 not_found on readDoc → "isn\'t available" + <Hangup/>', async () => {
  const { deps } = makeDeps({
    classifyIntent: () => Promise.resolve('ask'),
    readDoc: () => Promise.reject(new FoundationError('not_found', { status: 404 })),
  });
  const xml = await handleTurn({ SpeechResult: 'what is it?' }, deps);
  // apostrophe in "isn't" is XML-escaped (&#39;) by say().
  assert.ok(/isn\S*t available/i.test(xml), 'tells the caller the doc is unavailable');
  assert.ok(xml.includes('<Hangup/>'), 'a dead bound doc ends the call');
});

await test('401 unauthorized on readDoc → "isn\'t available" + <Hangup/>', async () => {
  const { deps, calls } = makeDeps({
    classifyIntent: () => Promise.resolve('ask'),
    readDoc: () => Promise.reject(new FoundationError('unauthorized', { status: 401 })),
  });
  const xml = await handleTurn({ SpeechResult: 'what is it?' }, deps);
  assert.ok(xml.includes('<Hangup/>'), 'a bad token ends the call');
  assertNoTokenLeak(xml, calls);
});

// ── generic failures never leave silence ─────────────────────────────────────

await test('generic foundation failure (request_failed) → apology + gather, NO throw', async () => {
  const { deps, calls } = makeDeps({
    classifyIntent: () => Promise.resolve('ask'),
    readDoc: () => Promise.reject(new FoundationError('request_failed', { status: 0 })),
  });
  const xml = await handleTurn({ SpeechResult: 'hi' }, deps);
  assert.ok(/sorry/i.test(xml), 'apologizes');
  assert.ok(xml.includes('<Gather'), 'call continues');
  assert.ok(calls.log.length >= 1, 'the raw error is logged');
});

await test('agent.classifyIntent throws → apology + gather (whole-body catch, no silence)', async () => {
  const { deps } = makeDeps({ classifyIntent: () => Promise.reject(new Error('model blew up')) });
  const xml = await handleTurn({ SpeechResult: 'hello' }, deps);
  assert.ok(xml.startsWith('<?xml'), 'a real <Response> is returned, not silence');
  assert.ok(/sorry/i.test(xml), 'apologizes');
  assert.ok(xml.includes('<Gather'), 'call continues');
});

await test('agent.answer throws → apology + gather (whole-body catch)', async () => {
  const { deps } = makeDeps({
    classifyIntent: () => Promise.resolve('ask'),
    answer: () => Promise.reject(new Error('boom')),
  });
  const xml = await handleTurn({ SpeechResult: 'q' }, deps);
  assert.ok(/sorry/i.test(xml));
  assert.ok(xml.includes('<Gather'));
});

// ── token-absence across EVERY path (the security property) ───────────────────

await test('token NEVER appears in TwiML or log across ask / edit / greeting / error', async () => {
  // ask
  {
    const { deps, calls } = makeDeps({ classifyIntent: () => Promise.resolve('ask') });
    const xml = await handleTurn({ SpeechResult: 'q' }, deps);
    assertNoTokenLeak(xml, calls);
  }
  // edit (success)
  {
    const { deps, calls } = makeDeps({ classifyIntent: () => Promise.resolve('edit') });
    const xml = await handleTurn({ SpeechResult: 'edit', From: '+1' }, deps);
    assertNoTokenLeak(xml, calls);
  }
  // greeting
  {
    const { deps, calls } = makeDeps();
    const xml = await handleTurn({}, deps);
    assertNoTokenLeak(xml, calls);
  }
  // error path that LOGS the raw error (most likely leak site)
  {
    const { deps, calls } = makeDeps({
      classifyIntent: () => Promise.resolve('edit'),
      // make the foundation reject with an error whose stack could carry the token
      // if anyone built it from the binding — assert it never does.
      modify: () => Promise.reject(new FoundationError('bad_request', { status: 400, detail: 'nope' })),
    });
    const xml = await handleTurn({ SpeechResult: 'edit', From: '+1' }, deps);
    assertNoTokenLeak(xml, calls);
  }
});

console.log(`\n${passed} passed`);
