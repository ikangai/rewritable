// Shared helper for SNAPSHOT-* scenarios.
// Walks the buildFile output the same way the runtime's buildFile() does:
// finds `const INLINE_DOC = \`` and matches the closing backtick honoring
// `\\` escapes. Returns { prefix, body, suffix } where prefix is everything
// up to and including the opening backtick, suffix is everything from the
// closing backtick onward, and body is the literal content between.

export function sliceInlineDoc(file) {
  const marker = 'const INLINE_DOC = `';
  const start = file.indexOf(marker);
  if (start < 0) return null;
  const cs = start + marker.length; // first byte of literal body
  let i = cs;
  while (i < file.length) {
    if (file[i] === '\\') { i += 2; continue; }
    if (file[i] === '`') break;
    i++;
  }
  if (i >= file.length) return null;
  return {
    prefix: file.slice(0, cs),
    body: file.slice(cs, i),
    suffix: file.slice(i),
  };
}
