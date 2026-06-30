// Regression guard for service/public/import.html — the whole browser importer was silently dead
// (regression 18521c7) because a comment contained a literal `</script`, which the HTML parser
// treats as the script element's end tag, cutting the inline script before convertPdf / the import
// pipeline ever ran. Nothing else browser-loads import.html, so no test caught it.
//
// Rule: every `</script` in the source must be EITHER escaped as `<\/script` (so it sits safely
// inside JS strings/comments) OR a genuine end tag — i.e. preceded by `>` (the `…></script>` form)
// or standing alone as `</script>` on its own line. Anything else (a `</script` mid-line in a
// comment or string) closes the script early. Pass an alternate path as argv[2] to check a revision.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = process.argv[2] || path.join(__dirname, '..', 'service', 'public', 'import.html');
const html = fs.readFileSync(HTML, 'utf8');
const lines = html.split('\n');

// offset → line number, for readable diagnostics
const lineAt = (idx) => html.slice(0, idx).split('\n').length;

const suspects = [];
for (const m of html.matchAll(/<\/script/gi)) {        // matches `</script` but NOT escaped `<\/script`
  const i = m.index;
  const precededByGt = html[i - 1] === '>';            // `…></script>` (end of a <script src> tag)
  const ln = lines[lineAt(i) - 1];
  const standalone = ln.trim() === '</script>';        // a closing tag on its own line
  if (!precededByGt && !standalone) suspects.push({ line: lineAt(i), text: ln.trim().slice(0, 80) });
}

console.log('== import.html </script>-cut guard (' + path.basename(HTML) + ') ==');
if (suspects.length === 0) {
  console.log('  OK  every </script is escaped or a genuine closing tag — no early script cut');
  console.log('\n== 1 pass, 0 fail ==');
  process.exit(0);
}
for (const s of suspects) console.log('  ✗   line ' + s.line + ' has an unescaped </script that cuts the script: ' + s.text);
console.log('\n== 0 pass, ' + suspects.length + ' fail ==');
process.exit(1);
