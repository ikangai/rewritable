// Zero-dep TwiML (Twilio's XML) string builders. Mirrors the small zero-dep
// module style of `surfaces/telegram/telegram-api.mjs` — pure functions, only
// node-free string work, no imports.
//
// SECURITY — XML-escaping is the load-bearing safety here. Every piece of text
// that reaches a <Say> body or an XML attribute is UNTRUSTED: it is either the
// caller's transcribed speech (echoed back) or a doc-derived answer. Unescaped,
// such text could inject TwiML elements/attributes (e.g. an extra <Hangup/>, or
// breaking out of action="…"). So all text goes through `escapeXml` before it is
// interpolated. This module never assumes its input is pre-escaped.

// Escape the five XML metacharacters. ORDER MATTERS: `&` MUST be escaped first,
// otherwise the `&` in the entities we produce (e.g. `&lt;`) would itself get
// re-escaped to `&amp;lt;`. Non-string input is coerced — callers pass through
// arbitrary values (transcripts, answers) and a missing/numeric field must not
// throw or leak `[object Object]`-style surprises into the XML.
export function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// A <Say> element — Twilio speaks the (escaped) text to the caller.
export function say(text) {
  return `<Say>${escapeXml(text)}</Say>`;
}

// A speech <Gather>: Twilio listens for the caller's speech and POSTs the
// transcript to `action`. An optional nested `prompt` is spoken WHILE listening
// (barge-in friendly). `hints` is an optional comma-list biasing the recognizer.
// Both attributes are escaped — an action/hints carrying `&` or `"` must not
// break out of its attribute.
export function gather({ action, prompt, hints }) {
  return (
    `<Gather input="speech" action="${escapeXml(action)}"` +
    (hints ? ` hints="${escapeXml(hints)}"` : '') +
    '>' +
    (prompt ? say(prompt) : '') +
    '</Gather>'
  );
}

// A <Hangup/> — ends the call.
export function hangup() {
  return '<Hangup/>';
}

// Wrap parts in a single <Response> with the XML prolog Twilio requires.
export function respond(...parts) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join('')}</Response>`;
}
