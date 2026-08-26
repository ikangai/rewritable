import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { cloneFromHtml } from '../src/clone.mjs';
import { inspectDoc } from '../src/doc.mjs';

const fixture = readFileSync(new URL('./fixtures/ikangai-post.html', import.meta.url), 'utf8');

test('cloneFromHtml produces a valid rewritable with the post title + content', async () => {
  const out = '/tmp/clone-test-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'https://www.ikangai.com/post/');
  const info = await inspectDoc(out);
  assert.equal(info.self.kind, 'document');
  assert.match(info.self.title, /No Orchestration Required/);
  assert.ok(info.doc.includes('<article'), 'wraps content in an article');
  assert.ok(info.doc.includes('<h1'), 'has a title heading');
  assert.ok(!/<script[\s>]/i.test(info.doc), 'no scripts survive into the body');
  assert.ok(info.doc.includes('ikangai.com/post'), 'records provenance link');
  rmSync(out, { force: true });
});

test('cloneFromHtml is a valid rewritable per the edit contract (uuid present)', async () => {
  const out = '/tmp/clone-test2-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'https://www.ikangai.com/post/');
  const info = await inspectDoc(out);
  assert.equal(info.rewritable ?? true, true);
  assert.ok(info.uuid && /[0-9a-f-]{36}/.test(info.uuid), 'has a DOC_UUID');
  rmSync(out, { force: true });
});

// Rule 9: these encode WHY escapeHtml is load-bearing — the cloned title and
// the provenance URL are attacker-controlled (they come off a fetched page /
// a user-supplied URL). Without escaping, a `<script>` in the title would
// survive into the body, or a `"` in the URL would break out of the href
// attribute. Each assertion fails if the corresponding escapeHtml() is removed.

test('cloneFromHtml escapes HTML metacharacters in the page title', async () => {
  // A page whose <title>/og:title carries markup + an ampersand. extractArticle
  // reads the title; cloneFromHtml prepends it as an <h1>. If the title were
  // not escaped, the raw <script> would land in the document body.
  const evil = `<!doctype html><html><head>`
    + `<meta property="og:title" content="Pwned <script>x</script> &amp; co">`
    + `<title>Pwned <script>x</script> &amp; co</title></head>`
    + `<body><article><p>Some real body text to extract.</p></article></body></html>`;
  const out = '/tmp/clone-test3-' + process.pid + '.html';
  await cloneFromHtml(evil, out, 'https://x.example/post/');
  const info = await inspectDoc(out);
  // The title-derived <h1> must NOT contain a raw executable <script> tag.
  assert.ok(!/<script[\s>]/i.test(info.doc), 'no raw <script> from the title survives');
  assert.ok(info.doc.includes('&lt;script&gt;'), 'the title <script> is HTML-escaped');
  assert.ok(info.doc.includes('&amp;'), 'the title ampersand is HTML-escaped');
  rmSync(out, { force: true });
});

test('cloneFromHtml escapes a double-quote in the sourceUrl (no attribute breakout)', async () => {
  const out = '/tmp/clone-test4-' + process.pid + '.html';
  // A URL containing a raw " — if interpolated unescaped into href="…" it would
  // close the attribute and let trailing bytes become new attributes/markup.
  await cloneFromHtml(fixture, out, 'https://x.example/a"b');
  const info = await inspectDoc(out);
  assert.ok(info.doc.includes('href="https://x.example/a&quot;b"'),
    'the " in the URL is escaped to &quot; inside a single href attribute');
  assert.ok(!info.doc.includes('href="https://x.example/a"b"'),
    'the raw " does not appear unescaped inside the href value');
  rmSync(out, { force: true });
});

test('cloneFromHtml records provenance inside an href attribute', async () => {
  const out = '/tmp/clone-test5-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'https://www.ikangai.com/post/');
  const info = await inspectDoc(out);
  // Tighter than "appears anywhere": the provenance URL must be the value of an
  // href attribute (a real clickable link), not just stray text.
  assert.ok(info.doc.includes('href="https://www.ikangai.com/post/"'),
    'provenance URL is an href attribute value');
  rmSync(out, { force: true });
});

// C1/H1 (final-review): the EXTRACTED ARTICLE BODY is attacker-controlled web
// HTML, not marked's well-formed double-quoted output. The shared sanitizer
// must neutralise active URL schemes in EVERY attribute form — single-quoted,
// unquoted, and non-href URL attributes — or a clickable `javascript:` link
// survives into the file://-origin container (where it has IDB/OPFS access).
// Each assertion fails if the step-3 generalisation in sanitizeImportedHtml is
// reverted to the double-quoted-href/src-only form.
test('cloneFromHtml neutralises hostile URL attributes inside the article body (C1)', async () => {
  const evil = `<!doctype html><html><head><title>Real Post</title></head><body>`
    + `<article>`
    + `<p>Intro paragraph long enough to be picked by the density fallback so the`
    + ` whole article block is selected for extraction by the cloner here.</p>`
    + `<p><a href='javascript:alert(1)'>single-quoted js link</a></p>`
    + `<p><a href=javascript:alert(2)>unquoted js link</a></p>`
    + `<p><a href="javascript:alert(3)">double-quoted js link</a></p>`
    + `<form action='javascript:alert(4)'><button formaction="javascript:alert(5)">go</button></form>`
    + `<img src='javascript:alert(6)'>`
    + `<p>More body text to keep the extractor confident this is the article.</p>`
    + `</article></body></html>`;
  const out = '/tmp/clone-test7-' + process.pid + '.html';
  await cloneFromHtml(evil, out, 'https://x.example/post/');
  const info = await inspectDoc(out);
  // No javascript: scheme survives in ANY attribute form (single/unquoted/double).
  assert.ok(!/javascript:/i.test(info.doc),
    'no javascript: URL survives in any attribute form (single-quoted, unquoted, action/formaction)');
  rmSync(out, { force: true });
});

test('cloneFromHtml drops the provenance link for a non-http(s) sourceUrl (B1)', async () => {
  const out = '/tmp/clone-test6-' + process.pid + '.html';
  // Defence-in-depth: the wired path is SSRF-guarded, but the exported fn must
  // be safe-by-default — a javascript: URL must never become a live href.
  await cloneFromHtml(fixture, out, 'javascript:alert(1)');
  const info = await inspectDoc(out);
  assert.ok(!info.doc.includes('href="javascript:'),
    'a javascript: sourceUrl never becomes a live href');
  rmSync(out, { force: true });
});

// #25 — provenance in the FROZEN head, not just the visible footer.
//
// The footer lives inside INLINE_DOC, which makes it content: an edit can remove
// it, and it reaches the model inside the fenced DATA region where it carries no
// authority. The runtime reads this meta instead and tells the model, on every
// later edit, that the text it is holding came from somewhere else. A marker the
// document can edit is a marker injected text can delete.
test('cloneFromHtml stamps the source URL into the edit-unreachable head (#25)', async () => {
  const out = '/tmp/clone-origin-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'https://www.ikangai.com/post/');
  const text = readFileSync(out, 'utf8');
  assert.match(text, /<meta name="rwa-origin" content="https:\/\/www\.ikangai\.com\/post\/">/);
  const { extractInlineDoc } = await import('../src/seed.mjs');
  assert.ok(!extractInlineDoc(text).includes('rwa-origin'),
    'the marker must be outside INLINE_DOC — inside, an edit could delete it');
  rmSync(out, { force: true });
});

test('a non-http scheme is never recorded as provenance (#25)', async () => {
  // Mirrors the gate on the visible provenance link: only http/https becomes a
  // live reference. A hostile scheme must not ride into the model's prompt.
  const out = '/tmp/clone-origin-bad-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'javascript:alert(1)');
  const text = readFileSync(out, 'utf8');
  assert.match(text, /<meta name="rwa-origin" content="">/);
  assert.ok(!text.includes('content="javascript:'), 'no javascript: scheme in the head');
  rmSync(out, { force: true });
});

test('rwa upgrade preserves provenance — an upgrade gains fixes, never loses facts (#25)', async () => {
  const out = '/tmp/clone-origin-upg-' + process.pid + '.html';
  await cloneFromHtml(fixture, out, 'https://www.ikangai.com/post/');
  const { upgradeCmd } = await import('../src/upgrade.mjs');
  await upgradeCmd(out, { mode: 'write' });
  const text = readFileSync(out, 'utf8');
  assert.match(text, /<meta name="rwa-origin" content="https:\/\/www\.ikangai\.com\/post\/">/,
    'dropping this would silently un-mark a cloned container as foreign');
  rmSync(out, { force: true });
});
