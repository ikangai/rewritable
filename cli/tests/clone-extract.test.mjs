import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractArticle } from '../src/clone-extract.mjs';

const fixture = readFileSync(new URL('./fixtures/ikangai-post.html', import.meta.url), 'utf8');

test('pulls og:title as the title', () => {
  const { title } = extractArticle(fixture);
  assert.match(title, /No Orchestration Required/);
});

test('extracts the entry-content body, not nav/footer', () => {
  const { html } = extractArticle(fixture);
  assert.ok(html.includes('<h2'), 'keeps article headings');
  assert.ok(/<p[\s>]/.test(html), 'keeps paragraphs');
  assert.ok(!/site-header|site-footer|<nav[\s>]/i.test(html), 'drops chrome');
});

test('balanced extraction keeps nested divs intact', () => {
  const { html } = extractArticle(fixture);
  const opens = (html.match(/<div[\s>]/gi) || []).length;
  const closes = (html.match(/<\/div>/gi) || []).length;
  assert.equal(opens, closes, 'nested divs are balanced (no truncation)');
});

test('generic fallback when no known profile matches', () => {
  const html = '<html><body><nav>menu</nav><div class="x"><h1>Hi</h1><p>'
    + 'a'.repeat(400) + '</p></div><footer>f</footer></body></html>';
  const { html: out } = extractArticle(html);
  assert.ok(out.includes('Hi') && out.includes('aaaa'), 'finds the dense block');
  assert.ok(!/menu|footer/.test(out), 'drops thin chrome');
});

// --- I1: '>' inside the container's OWN opening tag must not corrupt output.
// A quoted attribute value can legally contain '>'. A naive indexOf('>') ends
// the opening tag mid-attribute, splicing attribute bytes into the body.
test('I1: > inside the container opening tag attribute does not corrupt body', () => {
  const { html } = extractArticle(
    '<div class="entry-content" title="a>b"><p>real</p></div>',
  );
  assert.equal(html, '<p>real</p>');
});

// --- I2: raw-text elements (<script>/<style>) whose text contains </div> or
// <div must not truncate or miscount the depth scan. Their content is never
// markup, so the scan must fast-forward past the matching close tag.
test('I2: script text containing </div> does not truncate the scan', () => {
  const { html } = extractArticle(
    '<div class="entry-content"><script>var x="</div>";</script><p>body</p></div>',
  );
  assert.ok(html.includes('<p>body</p>'), 'keeps the trailing paragraph');
  assert.ok(html.includes('var x="</div>";'), 'keeps the full script body');
});

// --- M1: \b${cls}\b false-matches hyphenated classes. entry-content-wrapper
// is a DIFFERENT class and must not be selected as the entry-content profile.
test('M1: entry-content-wrapper does not match the entry-content profile', () => {
  // The hyphen-suffixed wrapper is THIN; a separate dense <article> holds the
  // real body. If entry-content-wrapper wrongly matched the entry-content
  // profile (Profile 1), we'd get its thin inner ('<p>w</p>'). With the fix it
  // doesn't match, so Profile 2 (<article>) wins and we get the dense body.
  const html = '<html><body>'
    + '<div class="entry-content-wrapper"><p>w</p></div>'
    + '<article><p>' + 'real '.repeat(50) + '</p></article>'
    + '</body></html>';
  const { html: out } = extractArticle(html);
  assert.ok(out.includes('real real'), 'the <article> body is selected');
  assert.ok(!out.includes('<p>w</p>'), 'the hyphen-suffixed wrapper is NOT picked');
});

// --- M4: numeric + smart-punctuation entity decoding in titles.
test('M4: decodes numeric and smart-punctuation entities in the title', () => {
  const { title } = extractArticle(
    '<meta property="og:title" content="Don&#8217;t &amp; &#8220;Go&#8221;">',
  );
  assert.equal(title, 'Don’t & “Go”');
});

// --- Rule 9: og:title must win over a DIFFERENT <title> and <h1>.
test('og:title wins over distinct <title> and <h1>', () => {
  const html = '<html><head>'
    + '<meta property="og:title" content="OG Wins">'
    + '<title>Title Loses | Site</title></head>'
    + '<body><h1>H1 Loses</h1></body></html>';
  const { title } = extractArticle(html);
  assert.equal(title, 'OG Wins');
});

// --- Rule 9: <title> site-suffix strip, when there is no og:title.
test('<title> drops a " | Site" suffix when og:title is absent', () => {
  const html = '<html><head><title>Real Headline | Acme Blog</title></head>'
    + '<body><h1>H1 Different</h1></body></html>';
  const { title } = extractArticle(html);
  assert.equal(title, 'Real Headline');
});

// --- Rule 9: og:title with content BEFORE property (attribute order).
test('og:title matches when content precedes property', () => {
  const html = '<meta content="Order Reversed" property="og:title">';
  const { title } = extractArticle(html);
  assert.equal(title, 'Order Reversed');
});
