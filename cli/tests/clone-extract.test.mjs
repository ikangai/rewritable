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
