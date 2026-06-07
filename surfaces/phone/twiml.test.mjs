// Tests for the TwiML builders. The load-bearing property under test is the
// XML-escaping: ALL text reaching a <Say> body (caller speech echoes,
// doc-derived answers) is untrusted and MUST be escaped so it cannot inject
// TwiML elements/attributes. Each assertion below encodes WHY (Rule 9): the
// security invariant is "no unescaped XML metacharacter from the INPUT survives
// into the output", not merely "the output looks right".

import assert from 'node:assert/strict';
import { escapeXml, say, gather, hangup, respond } from './twiml.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test('escapeXml escapes all five XML metacharacters', () => {
  assert.equal(escapeXml('&'), '&amp;');
  assert.equal(escapeXml('<'), '&lt;');
  assert.equal(escapeXml('>'), '&gt;');
  assert.equal(escapeXml('"'), '&quot;');
  assert.equal(escapeXml("'"), '&#39;');
});

test('escapeXml escapes & FIRST — no double-escaping of produced entities', () => {
  // If `<` were escaped before `&`, the `&` in the produced `&lt;` would get
  // re-escaped to `&amp;lt;`. `&`-first is the whole correctness reason for the
  // ordering, so pin it directly.
  assert.equal(escapeXml('&<'), '&amp;&lt;');
  // A string that already contains an entity-looking sequence must be treated as
  // literal text: its `&` is escaped, proving we never assume pre-escaped input.
  assert.equal(escapeXml('&amp;'), '&amp;amp;');
});

test('escapeXml coerces non-string input to string', () => {
  assert.equal(escapeXml(5), '5');
  assert.equal(escapeXml(null), 'null');
  assert.equal(escapeXml(undefined), 'undefined');
  assert.equal(escapeXml(true), 'true');
});

test('say escapes the body — no raw metachar from input survives (SECURITY)', () => {
  const out = say('<b>5 & 6 "x" \'y\'');
  // The escaped entities must all be present...
  assert.ok(out.includes('&lt;b&gt;'), 'angle brackets escaped');
  assert.ok(out.includes('5 &amp; 6'), 'ampersand escaped');
  assert.ok(out.includes('&quot;x&quot;'), 'double quote escaped');
  assert.ok(out.includes('&#39;y&#39;'), 'single quote escaped');
  // ...and the body (everything between the Say tags) must contain NO raw
  // metacharacter from the input. This is the injection-resistance property:
  // caller speech / doc answers cannot break out of <Say>. We strip the entities
  // WE produced, then assert no raw metacharacter remains.
  const body = out.slice('<Say>'.length, -'</Say>'.length);
  const stripped = body
    .replaceAll('&amp;', '')
    .replaceAll('&lt;', '')
    .replaceAll('&gt;', '')
    .replaceAll('&quot;', '')
    .replaceAll('&#39;', '');
  for (const ch of ['<', '>', '&', '"', "'"]) {
    assert.ok(!stripped.includes(ch), `no raw ${ch} survives in <Say> body`);
  }
});

test('say wraps escaped text in <Say>…</Say>', () => {
  assert.equal(say('hi'), '<Say>hi</Say>');
});

test('gather is a speech gather with escaped action and nested prompt', () => {
  const out = gather({ action: '/phone/turn', prompt: 'Ask or tell me a change' });
  assert.ok(out.includes('input="speech"'), 'declares speech input');
  assert.ok(out.includes('action="/phone/turn"'), 'carries the action');
  assert.ok(
    out.includes('<Say>Ask or tell me a change</Say>'),
    'nests the prompt as a <Say> the caller hears while we listen',
  );
  assert.ok(out.startsWith('<Gather'), 'is a Gather element');
  assert.ok(out.endsWith('</Gather>'), 'is closed');
});

test('gather escapes the action attribute (SECURITY — attr injection)', () => {
  // An action carrying `&`/`"` could break out of the attribute. It must be
  // escaped just like body text.
  const out = gather({ action: '/turn?a=1&b="2"' });
  assert.ok(out.includes('action="/turn?a=1&amp;b=&quot;2&quot;"'), 'action escaped');
  assert.ok(!out.includes('a=1&b='), 'no raw & in attribute');
});

test('gather escapes the optional hints attribute and omits it when absent', () => {
  const withHints = gather({ action: '/x', hints: 'yes & no' });
  assert.ok(withHints.includes('hints="yes &amp; no"'), 'hints escaped when present');
  const without = gather({ action: '/x' });
  assert.ok(!without.includes('hints='), 'no hints attribute when not given');
});

test('gather omits the nested prompt when none is given', () => {
  const out = gather({ action: '/x' });
  assert.ok(!out.includes('<Say>'), 'no empty <Say> when prompt absent');
});

test('hangup is the exact self-closing element', () => {
  assert.equal(hangup(), '<Hangup/>');
});

test('respond emits one Response with the XML prolog wrapping parts in order', () => {
  const out = respond(say('hi'), gather({ action: '/x' }));
  assert.ok(
    out.startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
    'starts with the XML prolog (Twilio requires it)',
  );
  // Exactly one Response wrapper.
  assert.equal(out.match(/<Response>/g).length, 1, 'one opening Response');
  assert.equal(out.match(/<\/Response>/g).length, 1, 'one closing Response');
  // Parts appear inside, in the order passed.
  const sayIdx = out.indexOf('<Say>hi</Say>');
  const gatherIdx = out.indexOf('<Gather');
  assert.ok(sayIdx > -1 && gatherIdx > -1, 'both parts present');
  assert.ok(sayIdx < gatherIdx, 'parts preserve call order');
  assert.ok(out.endsWith('</Response>'), 'ends with the Response close');
});

console.log(`\n${passed} passed`);
