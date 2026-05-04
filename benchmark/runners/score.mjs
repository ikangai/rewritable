// benchmark/runners/score.mjs — TSV writer + summary formatter.
//
// Output goes to benchmark/results/conformance.tsv (one row per scenario per
// run) and benchmark/results/summary.md (markdown human report).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');

export function ensureResultsDir() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

export function writeTSV(scenarios, results) {
  ensureResultsDir();
  const tsv = path.join(RESULTS_DIR, 'conformance.tsv');
  const rows = [
    ['id', 'category', 'pass', 'reason', 'duration_ms'].join('\t'),
    ...scenarios.map((s, i) => {
      const r = results[i] || {};
      return [
        s.id,
        s.category || s.id.split('-')[0],
        r.pass ? '1' : '0',
        (r.reason || '').replaceAll('\t', ' ').replaceAll('\n', ' '),
        String(r.duration_ms || 0),
      ].join('\t');
    }),
  ];
  fs.writeFileSync(tsv, rows.join('\n') + '\n');
  return tsv;
}

export function writeSummary(scenarios, results) {
  ensureResultsDir();
  const md = path.join(RESULTS_DIR, 'summary.md');
  const total = scenarios.length;
  const passing = results.filter(r => r.pass).length;
  const byCat = new Map();
  scenarios.forEach((s, i) => {
    const cat = s.category || s.id.split('-')[0];
    if (!byCat.has(cat)) byCat.set(cat, { pass: 0, total: 0, fails: [] });
    const e = byCat.get(cat);
    e.total++;
    if (results[i]?.pass) e.pass++;
    else e.fails.push({ id: s.id, reason: results[i]?.reason || 'no result' });
  });

  const lines = [
    '# Conformance summary',
    '',
    `**${passing} / ${total} conformance scenarios passing** against \`seeds/rewritable.html\`.`,
    '',
    '## Per-category breakdown',
    '',
    '| Category | Passing | Total |',
    '|---|---|---|',
    ...[...byCat.entries()].map(([cat, e]) => `| ${cat} | ${e.pass} | ${e.total} |`),
    '',
  ];
  const fails = [...byCat.entries()]
    .flatMap(([cat, e]) => e.fails.map(f => ({ cat, ...f })));
  if (fails.length > 0) {
    lines.push('## Failures', '');
    lines.push('| ID | Reason |');
    lines.push('|---|---|');
    fails.forEach(f => {
      lines.push(`| ${f.id} | ${f.reason.replaceAll('|', '\\|')} |`);
    });
  }
  fs.writeFileSync(md, lines.join('\n') + '\n');
  return md;
}
