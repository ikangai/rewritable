#!/usr/bin/env node
// rwa-lite — the dep-free subset of the `rwa` CLI, vendored into the
// authoring-rewritables skill. Wires `new` / `edit` / `doc` / `ls` over the
// verbatim cli/src modules in ../src. NO npm dependencies, so it runs from a
// bare `node` anywhere (the full CLI's `import`/`create`/`publish` paths pull
// in marked/papaparse/mammoth/pdfjs and a live backend, and are deliberately
// out of scope here — see SKILL.md). The seed is bundled at ../seeds.
//
// This file mirrors bin/rwa.mjs's dispatch for these four verbs; the actual
// logic lives in the vendored modules. See references/VENDORED.md for the
// source version and how to re-vendor.
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename, extname } from 'node:path';
import fs from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, '..', 'seeds', 'rewritable.html');

import { loadSeed, applySeedSubs, replaceInlineDoc, kindOverrides, KNOWN_KINDS, extractInlineDoc } from '../src/seed.mjs';
import { applyPlan } from '../src/edit.mjs';
import { inspectDoc, outlineDoc, readBlock } from '../src/doc.mjs';
import { listRewritables, formatRows } from '../src/ls.mjs';

const HELP = `rwa-lite — author & edit single-file re-writeable documents (dep-free subset)

  rwa-lite new [--kind <k>] [out.html]   create a fresh rewritable
                                         kinds: ${KNOWN_KINDS.join(', ')} (default: document)
  rwa-lite edit <file> --plan <p.json>   apply an edit envelope from a file
  rwa-lite edit <file> < envelope.json   apply an edit envelope from stdin
  rwa-lite doc <file> [--json]           print the editable body, or the
                                         self-description/1 contract (--json)
  rwa-lite ls [paths...] [--json]        list rewritables (kind · title · affordances)

Edit envelopes are apply_edits / apply_dsl_plan / replace_document objects
(references/edit-contract.md). Exit codes: 0 ok · 1 usage · 2 file · 3 envelope.`;

function codeName(n) {
  return { 1: 'usage_error', 2: 'file_error', 3: 'envelope_error', 4: 'agent_error' }[n] || 'error';
}
function emit(prefix, payload) {
  const parts = [payload.code, payload.subcode].filter(Boolean);
  let line = `${prefix}: ${parts.join('/')}`;
  if (payload.details && Object.keys(payload.details).length) line += ' ' + JSON.stringify(payload.details);
  process.stderr.write(line + '\n');
}
function titleFromBasename(b) {
  const t = b.replace(/[-_]+/g, ' ').trim();
  return t ? t.replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
}
function getFlagValue(name, rest) {
  const i = rest.indexOf(name);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
}
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
const [verb, ...rest] = process.argv.slice(2);

try {
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(HELP);
    if (!verb) process.exitCode = 1;
    return;
  }

  // ---- new ----------------------------------------------------------------
  // Mirrors commands.mjs newCmd's core: loadSeed → kindOverrides → applySeedSubs
  // → replaceInlineDoc. Omits templates / --skin / --open (full CLI features).
  if (verb === 'new') {
    const kind = getFlagValue('--kind', rest) || 'document';
    if (!KNOWN_KINDS.includes(kind)) {
      emit('rwa-lite new', { code: 'usage_error', subcode: 'unknown_kind', details: { kind, known: KNOWN_KINDS } });
      process.exitCode = 1; return;
    }
    // --kind takes a value; skip that index so the path isn't mistaken for it.
    const kindIdx = rest.indexOf('--kind');
    const kindValIdx = kindIdx >= 0 ? kindIdx + 1 : -1;
    const positional = rest.find((a, i) => !a.startsWith('-') && i !== kindValIdx);
    const out = resolve(positional || './rewritable.html');
    const seed = await loadSeed([SEED_PATH]);
    const fileMeta = basename(out);
    const title = titleFromBasename(basename(out, extname(out)));
    const ov = kindOverrides(kind);
    let result = applySeedSubs(seed, {
      uuid: crypto.randomUUID(), title, fileMeta,
      lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
      productHeader: ov.productHeader, productKind: kind, lensClickToAnchor: ov.lensClickToAnchor,
    });
    if (ov.body != null) result = replaceInlineDoc(result, ov.body);
    await fs.writeFile(out, result, 'utf8');
    console.log(`wrote ${out}${kind !== 'document' ? ` (kind: ${kind})` : ''}`);
    return;
  }

  // ---- edit (plan / stdin envelope path only) -----------------------------
  // Claude composes the envelope; this is the deterministic applier. The full
  // CLI's instruction path (its own agent loop + backend) is out of scope.
  if (verb === 'edit') {
    // Skip any flag VALUE, not just --plan's: a bare --base-hash argument would
    // otherwise be mistaken for the file path.
    const EDIT_FLAG_WITH_VALUE = new Set(['--plan', '--base-hash']);
    const filePath = rest.find((a, i) => !a.startsWith('-') && !EDIT_FLAG_WITH_VALUE.has(rest[i - 1]));
    if (!filePath) { emit('rwa-lite edit', { code: 'usage_error', subcode: 'missing_file_arg' }); process.exitCode = 1; return; }
    const planArg = getFlagValue('--plan', rest);
    // #31 — optimistic concurrency. Without it a skill-driven write silently
    // overwrites anyone who committed in between; the CLI door has refused that
    // since the two-agent epic, and this door should not be the soft one.
    const baseHashArg = getFlagValue('--base-hash', rest);
    let envelopeJson;
    if (planArg) {
      try { envelopeJson = await fs.readFile(planArg, 'utf8'); }
      catch (e) {
        emit('rwa-lite edit', { code: 'file_error', subcode: e.code === 'ENOENT' ? 'plan_not_found' : 'plan_read_error', details: { path: planArg } });
        process.exitCode = 2; return;
      }
    } else {
      envelopeJson = await readStdin();
      if (!envelopeJson.trim()) {
        emit('rwa-lite edit', { code: 'usage_error', subcode: 'no_envelope', details: { hint: 'pass --plan <file> or pipe an envelope on stdin' } });
        process.exitCode = 1; return;
      }
    }
    let envelope;
    try { envelope = JSON.parse(envelopeJson); }
    catch (e) { emit('rwa-lite edit', { code: 'envelope_error', subcode: 'malformed_json', details: { message: e.message } }); process.exitCode = 3; return; }
    try { await applyPlan(filePath, envelope); return; }
    catch (e) {
      if (e && typeof e.exitCode === 'number') { emit('rwa-lite edit', { code: codeName(e.exitCode), subcode: e.subcode, details: e.details }); process.exitCode = e.exitCode; return; }
      throw e;
    }
  }

  // ---- doc ----------------------------------------------------------------
  if (verb === 'doc') {
    const jsonMode = rest.includes('--json');
    // The cheap read modes, mirroring the full CLI: --virtual swaps embedded
    // image bytes for rwa-asset tokens, --outline lists blocks instead of text,
    // --block <id> returns one block. An agent driving this skill should not be
    // stuck paying for the whole document on every turn.
    const virtual = rest.includes('--virtual');
    const outlineMode = rest.includes('--outline');
    const blockIdx = rest.indexOf('--block');
    const blockArg = blockIdx >= 0 ? rest[blockIdx + 1] : undefined;
    const filePath = rest.find((a, i) => !a.startsWith('-') && rest[i - 1] !== '--block');
    if (!filePath) { emit('rwa-lite doc', { code: 'usage_error', subcode: 'missing_file_arg' }); process.exitCode = 1; return; }
    try {
      if (outlineMode || blockArg !== undefined) {
        const r = blockArg !== undefined
          ? await readBlock(filePath, blockArg, { virtual })
          : await outlineDoc(filePath, { virtual });
        if (jsonMode) process.stdout.write(JSON.stringify(r) + '\n');
        else if (blockArg !== undefined) process.stdout.write(r.block.source.replace(/\n?$/, '\n'));
        else process.stdout.write(r.outline.map(b => `${b.id || '········'}  ${String(b.chars).padStart(6)}  ${b.tag}${b.frozen ? ' [frozen]' : ''}  ${b.preview}`).join('\n') + '\n');
        return;
      }
      const info = await inspectDoc(filePath, { virtual });
      if (jsonMode) {
        // The FULL read contract, not a subset: baseHash is the staleness token
        // an agent feeds back to make its write safe, and origin says whether the
        // text it is holding came from somewhere else.
        process.stdout.write(JSON.stringify({
          ...info.self, rewritable: true,
          baseHash: info.baseHash, origin: info.origin,
          role: info.role, roleStatus: info.roleStatus,
          virtual: info.virtual,
          length: info.doc.length, doc: info.doc,
        }) + '\n');
      } else {
        process.stdout.write(info.doc.endsWith('\n') ? info.doc : info.doc + '\n');
      }
    } catch (e) {
      if (e && typeof e.exitCode === 'number') { emit('rwa-lite doc', { code: codeName(e.exitCode), subcode: e.subcode, details: e.details }); process.exitCode = e.exitCode; return; }
      throw e;
    }
    return;
  }

  // ---- ls -----------------------------------------------------------------
  if (verb === 'ls') {
    const jsonMode = rest.includes('--json');
    const paths = rest.filter(a => !a.startsWith('-'));
    const rows = await listRewritables(paths);
    process.stdout.write((jsonMode ? JSON.stringify(rows) : formatRows(rows)) + '\n');
    return;
  }

  emit('rwa-lite', { code: 'usage_error', subcode: 'unknown_command', details: { verb } });
  process.exitCode = 1;
} catch (e) {
  process.stderr.write(`rwa-lite: internal_error ${e && e.message}\n`);
  process.exitCode = 1;
}
}

main();
