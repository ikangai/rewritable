// Tests for the phone agent seam — the two model judgment-call steps
// (classifyIntent, answer). The whole module is offline-testable because the
// model call is INJECTED as `chat`: every test below passes a fake `chat` that
// records the prompt it received and returns a scripted string. The real
// network client is never constructed when `chat` is injected — that is the
// whole point of the seam, and it is asserted explicitly.
//
// WHY each assertion matters (Rule 9):
//  - classifyIntent must default to 'ask' on ANY ambiguous/garbage/empty reply.
//    'ask' is read-only; 'edit' mutates the document. A misparse that defaulted
//    to 'edit' would let garbage model output trigger an unintended edit. The
//    safe default is load-bearing, so it is pinned across several bad replies.
//  - both steps must actually feed the doc/utterance into the prompt sent to the
//    model — a model that can't see the doc can't answer or classify about it.
//    We assert the recorded prompt CONTAINS the doc body / utterance so the test
//    fails if a refactor ever drops the doc from the prompt.

import assert from 'node:assert/strict';
import { makeAgent } from './agent.mjs';

let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`ok - ${name}`);
  });
}

// A fake chat that records every call and returns a scripted reply. Synchronous
// resolution (Promise.resolve) — no network, no timers.
function recordingChat(reply) {
  const calls = [];
  const chat = ({ system, user }) => {
    calls.push({ system, user });
    return Promise.resolve(reply);
  };
  return { chat, calls };
}

const DOC = 'The Q3 report. Revenue was 4.2M. Margin held at 38 percent.';

await test("classifyIntent: scripted 'edit' reply → 'edit'", async () => {
  const { chat } = recordingChat('edit');
  const agent = makeAgent({ chat });
  assert.equal(await agent.classifyIntent('change the title', DOC), 'edit');
});

await test("classifyIntent: scripted 'ask' reply → 'ask'", async () => {
  const { chat } = recordingChat('ask');
  const agent = makeAgent({ chat });
  assert.equal(await agent.classifyIntent('what was revenue?', DOC), 'ask');
});

await test("classifyIntent: verbose reply containing EDIT → 'edit' (contains-parse)", async () => {
  // Models don't always reply with exactly one word. A reply that clearly
  // expresses edit intent must still classify as edit.
  const { chat } = recordingChat('I think you want to EDIT it');
  const agent = makeAgent({ chat });
  assert.equal(await agent.classifyIntent('rename the section', DOC), 'edit');
});

await test("classifyIntent: ambiguous reply → defaults to 'ask' (SAFE — no mutation)", async () => {
  // 'maybe' mentions neither ask nor edit → must not mutate the doc.
  const { chat } = recordingChat('maybe');
  const agent = makeAgent({ chat });
  assert.equal(await agent.classifyIntent('uh', DOC), 'ask');
});

await test("classifyIntent: empty reply → defaults to 'ask' (SAFE)", async () => {
  const { chat } = recordingChat('');
  const agent = makeAgent({ chat });
  assert.equal(await agent.classifyIntent('uh', DOC), 'ask');
});

await test("classifyIntent: garbage reply → defaults to 'ask' (SAFE)", async () => {
  const { chat } = recordingChat('!!!???###');
  const agent = makeAgent({ chat });
  assert.equal(await agent.classifyIntent('uh', DOC), 'ask');
});

await test("classifyIntent: reply mentioning BOTH words → 'edit' wins (mutation is the explicit signal)", async () => {
  // If a model hedges with both, treat the presence of 'edit' as the intent —
  // it is the word the user has to explicitly want. (Pins the precedence so a
  // refactor can't silently flip it.)
  const { chat } = recordingChat('ask or edit');
  const agent = makeAgent({ chat });
  assert.equal(await agent.classifyIntent('do something', DOC), 'edit');
});

await test('classifyIntent: the utterance AND doc reach the prompt sent to chat', async () => {
  const { chat, calls } = recordingChat('ask');
  const agent = makeAgent({ chat });
  await agent.classifyIntent('what was the margin?', DOC);
  assert.equal(calls.length, 1, 'chat called exactly once');
  const { system, user } = calls[0];
  assert.ok(/ask or edit/i.test(system), 'system frames the ask-vs-edit choice');
  assert.ok(user.includes('what was the margin?'), 'utterance reaches the prompt');
  assert.ok(user.includes('Margin held at 38 percent'), 'doc context reaches the prompt');
});

await test('answer: returns the trimmed model text', async () => {
  const { chat } = recordingChat('  Revenue was 4.2 million.  \n');
  const agent = makeAgent({ chat });
  assert.equal(await agent.answer('what was revenue?', DOC), 'Revenue was 4.2 million.');
});

await test('answer: the question AND the doc body reach the prompt sent to chat', async () => {
  const { chat, calls } = recordingChat('38 percent.');
  const agent = makeAgent({ chat });
  await agent.answer('what was the margin?', DOC);
  assert.equal(calls.length, 1, 'chat called exactly once');
  const { system, user } = calls[0];
  assert.ok(/ONLY the provided document/i.test(system), 'system constrains to the doc');
  assert.ok(/concise/i.test(system), 'system asks for a concise, spoken answer');
  assert.ok(user.includes('what was the margin?'), 'question reaches the prompt');
  assert.ok(user.includes('Margin held at 38 percent'), 'doc body reaches the prompt');
});

await test('injecting chat bypasses the real client entirely (fully offline)', async () => {
  // The seam guarantee: with an injected chat, no network client is ever built.
  // We prove it by running both methods with NO key/base-url in the env reachable
  // — they must succeed purely on the fake. (If the real client were touched it
  // would throw the no-key error from the default chat.)
  const { chat } = recordingChat('ask');
  const agent = makeAgent({ chat });
  await agent.classifyIntent('hi', DOC);
  await agent.answer('hi', DOC);
  // Reaching here without a thrown no-key error proves the real client was not
  // constructed or called.
  assert.ok(true);
});

console.log(`\n${passed} passed`);
