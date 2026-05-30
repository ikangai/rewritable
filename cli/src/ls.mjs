// `rwa ls` — collection-scale self-description. Where inspectDoc answers "what is
// THIS file?", listRewritables answers "what are all these?": it resolves a set
// of paths (files, directories, or — by default — the current directory) to
// candidate .html files and reports each one's self-description/1 projection,
// flagging non-rewritables. The scan is lenient: a missing path or a
// non-rewritable is a row in the result, never a thrown error — so one bad entry
// can't abort the inventory of a whole folder.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectDoc } from './doc.mjs';

const HTML_RE = /\.html?$/i;

/**
 * Expand input paths to a flat, ordered list of candidate files. A directory
 * contributes its (non-recursive) .html children; a file contributes itself; a
 * path that cannot be stat'd is kept as a `missing` candidate so the caller can
 * report it rather than silently drop it. No inputs ⇒ scan the current directory.
 *
 * @param {string[]} paths
 * @returns {Promise<Array<{file:string, missing?:boolean}>>}
 */
export async function resolveTargets(paths) {
  const inputs = (paths && paths.length) ? paths : ['.'];
  const targets = [];
  for (const p of inputs) {
    let st;
    try { st = await stat(p); } catch { targets.push({ file: p, missing: true }); continue; }
    if (st.isDirectory()) {
      let names;
      try { names = await readdir(p); } catch { targets.push({ file: p, missing: true }); continue; }
      for (const name of names.filter(n => HTML_RE.test(n)).sort()) {
        targets.push({ file: join(p, name) });
      }
    } else {
      targets.push({ file: p });
    }
  }
  return targets;
}

/**
 * Inspect each candidate and classify it. Each row is one of:
 *   { file, status:'rewritable', self }            — self-description/1 object
 *   { file, status:'not_a_rewritable' }            — a plain .html / other file
 *   { file, status:'error', reason }               — not_found / read_error
 *
 * @param {string[]} paths
 * @returns {Promise<Array<object>>}
 */
export async function listRewritables(paths) {
  const targets = await resolveTargets(paths);
  const rows = [];
  for (const t of targets) {
    if (t.missing) { rows.push({ file: t.file, status: 'error', reason: 'not_found' }); continue; }
    try {
      const info = await inspectDoc(t.file);
      rows.push({ file: t.file, status: 'rewritable', self: info.self });
    } catch (e) {
      if (e && e.subcode === 'not_a_rewritable') {
        rows.push({ file: t.file, status: 'not_a_rewritable' });
      } else {
        rows.push({ file: t.file, status: 'error', reason: (e && e.subcode) || 'read_error' });
      }
    }
  }
  return rows;
}

/**
 * Render the rows as a human-readable, aligned inventory. Rewritables become a
 * KIND/TITLE/AFFORDANCES/FILE table; a footer counts rewritables vs. other files
 * and names any errors — nothing is silently dropped (Rule 12).
 *
 * @param {Array<object>} rows
 * @returns {string}
 */
export function formatRows(rows) {
  const rwa = rows.filter(r => r.status === 'rewritable');
  const other = rows.filter(r => r.status === 'not_a_rewritable');
  const errors = rows.filter(r => r.status === 'error');

  const lines = [];
  if (rwa.length) {
    const cells = rwa.map(r => ({
      kind: r.self.kind || '',
      title: r.self.title || '—',
      affordances: r.self.affordances.length ? r.self.affordances.map(a => a.kind).join(',') : '—',
      file: r.file,
    }));
    const head = { kind: 'KIND', title: 'TITLE', affordances: 'AFFORDANCES', file: 'FILE' };
    const w = (k) => Math.max(head[k].length, ...cells.map(c => c[k].length));
    const wk = w('kind'), wt = w('title'), wa = w('affordances');
    const row = (c) => `${c.kind.padEnd(wk)}  ${c.title.padEnd(wt)}  ${c.affordances.padEnd(wa)}  ${c.file}`;
    lines.push(row(head));
    for (const c of cells) lines.push(row(c));
    lines.push('');
  }
  const parts = [`${rwa.length} rewritable${rwa.length === 1 ? '' : 's'}`];
  if (other.length) parts.push(`${other.length} other (${other.map(r => r.file).join(', ')})`);
  if (errors.length) parts.push(`${errors.length} error (${errors.map(r => `${r.file}: ${r.reason}`).join(', ')})`);
  lines.push(parts.join(', '));
  return lines.join('\n');
}
