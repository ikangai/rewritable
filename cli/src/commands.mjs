import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { loadSeed, applySeedSubs, replaceInlineDoc, extractInlineDoc, kindOverrides, KNOWN_KINDS } from './seed.mjs';
import { skinByName } from './skins.mjs';
import { resolveBareWord } from './template.mjs';
import { convert } from './import.mjs';
import { convertPdfViaVision } from './import-vision.mjs';
import { convertViaClaudeCli } from './import-claude.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);

// Look in the in-package copy first (published case), fall back to the
// repo-canonical seed (dev case where cli/ sits next to seeds/). Exported so
// the `rwa edit` instruction path can extract SYSTEM_PROMPTS/TOOL_SCHEMAS
// from the same seed `rwa new`/`rwa import` use — single source of truth.
export const SEED_CANDIDATES = [
  path.join(packageRoot, 'seeds', 'rewritable.html'),
  path.join(packageRoot, '..', 'seeds', 'rewritable.html'),
];

async function readPkg() {
  return JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
}

export async function version() {
  const pkg = await readPkg();
  return `rwa ${pkg.version}`;
}

function titleFromBasename(basename) {
  return basename
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ') || 'Untitled';
}

async function ensureWritable(outPath, force) {
  try {
    await fs.stat(outPath);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (!force) {
    const e = new Error(`destination exists: ${outPath} (use --force to overwrite)`);
    e.exitCode = 2;
    throw e;
  }
}

function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r || p;
}

// Parse a single var out of a .env-style file. Minimal — handles KEY=value,
// surrounding whitespace, optional matched single/double quotes, leading `export`.
// Skips blank/comment lines. No interpolation, no multiline values.
async function readEnvKey(name) {
  if (process.env[name]) return process.env[name];
  let text;
  try {
    text = await fs.readFile(path.join(process.cwd(), '.env'), 'utf8');
  } catch (_) { return null; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== name) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v || null;
  }
  return null;
}

// Validate-and-return a backend name. Returns null for invalid input rather
// than throwing — pre-fill is best-effort; an unknown value just means the
// user sees the default backend (openrouter) on first paint.
function validBackend(v) {
  return ['openrouter', 'ollama', 'lmstudio', 'atomic', 'bridge'].includes(v) ? v : null;
}

// Collect URL-param pre-fills from env / ./.env. Returns an object whose keys
// match the URL params the bootstrap lifts (key, backend, model). Missing or
// invalid values are omitted; the bootstrap falls back to its defaults.
async function collectPrefill() {
  const out = {};
  const key     = await readEnvKey('OPENROUTER_API_KEY');
  const backend = validBackend(await readEnvKey('RWA_BACKEND'));
  const model   = await readEnvKey('RWA_MODEL');
  if (key)     out.key = key;
  if (backend) out.backend = backend;
  if (model)   out.model = model;
  return out;
}

function openFile(target, prefill) {
  // When any prefill is present we open via a file:// URL with the params so
  // the bootstrap can lift them into sessionStorage on first paint and scrub
  // the URL bar via history.replaceState. Without any prefill we use the bare
  // path so the open command is byte-identical to before.
  let arg;
  const params = prefill || {};
  const hasAny = params.key || params.backend || params.model;
  if (hasAny) {
    const u = pathToFileURL(target);
    if (params.key) u.searchParams.set('key', params.key);
    if (params.backend) u.searchParams.set('backend', params.backend);
    if (params.model) u.searchParams.set('model', params.model);
    arg = u.toString();
  } else {
    arg = target;
  }
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'open'; args = [arg];
  } else if (process.platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '""', arg];
  } else {
    cmd = 'xdg-open'; args = [arg];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', err => {
    console.error(`note: could not open file (${err.code || err.message})`);
  });
  child.unref();
}

// Open a freshly-written container, lifting env / .env prefills into the
// file:// URL (key/backend/model) exactly as the new/import open paths do.
// Exported so `rwa create` can honor --open without duplicating openFile +
// collectPrefill. (newCmd/importCmd keep their inline blocks unchanged.)
export async function openWithPrefill(out) {
  const prefill = await collectPrefill();
  if (prefill.key) console.error('note: passing OPENROUTER_API_KEY via ?key= URL parameter');
  if (prefill.backend) console.error(`note: passing RWA_BACKEND=${prefill.backend} via ?backend= URL parameter`);
  if (prefill.model) console.error(`note: passing RWA_MODEL=${prefill.model} via ?model= URL parameter`);
  openFile(out, prefill);
}

export async function newCmd({ outPath, force, open, kind, templateName, skin }) {
  // Two body sources funnel through one seed-subs path. Default: a built-in
  // starter (kindOverrides). `templateName` set: clone a data-rwa-template-labeled
  // file from cwd — pristine seed + the template's INLINE_DOC (label stripped),
  // fresh UUID. A cloned instance is a document with the template's body (the
  // template `kind` is a discovery label, not a PRODUCT_KIND).
  let out, bodyOverride, fromMsg = '';
  let resolvedKind = kind || 'document';
  if (templateName) {
    // Template-first, kind-fallback (design 2026-05-31 §3.2), via the ONE resolver
    // shared with `rwa create`: a bare word is first a cwd template label to clone;
    // on a miss, if it names a built-in kind, emit that kind; otherwise error naming
    // both misses. A user's labeled file thus overrides the built-in starter, and
    // `rwa new presentation` makes the deck.
    const frame = await resolveBareWord(templateName, process.cwd());
    const dated = `./${templateName}-${new Date().toISOString().slice(0, 10)}.html`;
    if (frame && frame.source === 'template') {
      if (frame.ambiguous) console.error(`note: multiple "${templateName}" templates in ./; using ${rel(frame.templatePath)} (most recent)`);
      out = path.resolve(outPath || dated);
      bodyOverride = frame.body;        // already label-stripped by the resolver
      resolvedKind = 'document';
      fromMsg = ` (from template ${rel(frame.templatePath)})`;
    } else if (frame && frame.source === 'kind') {
      resolvedKind = frame.kind;
      out = path.resolve(outPath || dated);
      // bodyOverride stays unset → kindOverrides(resolvedKind) supplies the body.
    } else {
      const e = new Error(`no rwa file in ./ is labeled "${templateName}", and "${templateName}" is not a known kind (${KNOWN_KINDS.join(', ')}). Add data-rwa-template="${templateName}" to a doc's root element to make it a template, or use a known kind.`);
      e.exitCode = 2;
      throw e;
    }
  } else {
    out = path.resolve(outPath || './rewritable.html');
  }
  await ensureWritable(out, force);
  const seed = await loadSeed(SEED_CANDIDATES);
  const fileMeta = path.basename(out);
  const title = titleFromBasename(path.basename(out, path.extname(out)));
  // R9-minimal: kind defaults to 'document' (current behavior — no overrides
  // applied, byte-identical to pre-flag emit). For other kinds, kindOverrides
  // supplies the INLINE_DOC body and lens placeholder; SYSTEM_PROMPT is
  // intentionally left alone (audit R1).
  const overrides = kindOverrides(resolvedKind);
  let result = applySeedSubs(seed, {
    uuid: crypto.randomUUID(),
    title,
    fileMeta,
    lensPlaceholder:    overrides.lensPlaceholder,
    palPlaceholder:     overrides.palPlaceholder,
    productHeader:      overrides.productHeader,
    productKind:        resolvedKind,                    // audit R1
    lensClickToAnchor:  overrides.lensClickToAnchor,     // audit R3 scoped
  });
  let body = bodyOverride != null ? bodyOverride : overrides.body;
  // --skin: prepend the preset's <style data-rwa-skin> block as the leading child
  // of INLINE_DOC. Skin is orthogonal to kind (a skinned document/presentation),
  // and the inject runs AFTER applySeedSubs (the `rwa import` ordering lesson) so
  // the skin CSS can't false-match a substitution regex. Deterministic, offline,
  // model-free — the L1 restyle is a later phase. skinByName throws exit-2 on an
  // unknown name (caught by the bin's outer handler).
  if (skin) {
    const { theme } = skinByName(skin);
    const base = body != null ? body : extractInlineDoc(result);
    body = theme + '\n' + base;
  }
  if (body != null) result = replaceInlineDoc(result, body);
  await fs.writeFile(out, result, 'utf8');
  // Annotate with the resolved kind (covers both `--kind presentation` and the
  // bare-word `rwa new presentation` fallback); a template clone reports its source.
  const kindMsg = resolvedKind !== 'document' ? ` (kind: ${resolvedKind})` : '';
  console.log(`wrote ${rel(out)}${fromMsg || kindMsg}`);
  if (open) {
    const prefill = await collectPrefill();
    if (prefill.key) console.error('note: passing OPENROUTER_API_KEY via ?key= URL parameter');
    if (prefill.backend) console.error(`note: passing RWA_BACKEND=${prefill.backend} via ?backend= URL parameter`);
    if (prefill.model) console.error(`note: passing RWA_MODEL=${prefill.model} via ?model= URL parameter`);
    openFile(out, prefill);
  }
}

export { KNOWN_KINDS };

export async function importCmd({ inputPath, outPath, force, open, vision, claude, trustInput, model, timeoutSec, escalate, targetFidelity }) {
  if (vision && claude) {
    const e = new Error('--vision and --claude are mutually exclusive');
    e.exitCode = 2;
    throw e;
  }
  const input = path.resolve(inputPath);
  const inputDir = path.dirname(input);
  const inputBasename = path.basename(input, path.extname(input));
  const out = path.resolve(outPath || path.join(inputDir, `${inputBasename}.html`));
  await ensureWritable(out, force);

  const ext = path.extname(input).toLowerCase().replace(/^\./, '');
  let html, warnings;
  if (vision) {
    if (ext !== 'pdf') {
      const e = new Error(`--vision is currently only supported for .pdf (got .${ext})`);
      e.exitCode = 2;
      throw e;
    }
    console.error('note: vision: posting to openrouter…');
    // Buffer for HTTP base64 encoding.
    const contents = await fs.readFile(input);
    ({ html, warnings } = await convertPdfViaVision(contents, { model }));
  } else if (claude) {
    if (trustInput) {
      console.error(`note: claude: --trust-input set — running the agent with bypassPermissions on ${path.basename(input)}. Only safe for files you trust.`);
    }
    // Pass the path; the skill reads the file itself via its own tools.
    // trustInput gates the bypassPermissions agent (see import-claude.mjs); the
    // consent gate there throws with exitCode 2 when it is absent.
    const claudeOpts = { trustInput, ...(timeoutSec ? { timeoutMs: timeoutSec * 1000 } : {}) };
    ({ html, warnings } = await convertViaClaudeCli(input, ext, claudeOpts));
  } else {
    // Buffer (not utf8 string) — docx and pdf are binary, and text formats
    // decode internally inside convert().
    const contents = await fs.readFile(input);
    const conv = await convert(ext, contents);
    ({ html, warnings } = conv);
    // Import fidelity loop (PDF) — measure the deterministic import; on a low structural score,
    // auto-escalate to --vision, but ONLY when a model is reachable (offline-first: a keyless
    // import stays offline and warns). `--no-escalate` opts out. Design: docs/plans/2026-06-30-…
    if (ext === 'pdf' && conv.fidelityInput && escalate !== false) {
      const { measureAndEscalate } = await import('./import-fidelity.mjs');
      const r = await measureAndEscalate(
        { structuralInput: conv.fidelityInput, importResult: conv },
        {
          threshold: targetFidelity,
          escalate: escalate !== false,
          modelReachable: () => !!(process.env.RWA_OPENROUTER_KEY || process.env.OPENROUTER_API_KEY),
          visionImport: async () => { console.error('note: import fidelity low — escalating to --vision (openrouter)…'); return convertPdfViaVision(contents, { model }); },
        },
      );
      if (r.note) console.error('note: ' + r.note);
      html = r.result.html;
      warnings = r.result.warnings || warnings;
    }
  }
  for (const w of warnings) console.error(`note: ${w}`);

  const seed = await loadSeed(SEED_CANDIDATES);
  const fileMeta = path.basename(out);
  const title = titleFromBasename(path.basename(out, path.extname(out)));

  // Order matters: apply seed-level substitutions (DOC_UUID, title, FILE)
  // FIRST against the pristine seed, then drop the imported content into
  // INLINE_DOC. Otherwise an imported file containing `const DOC_UUID = ...`
  // (e.g. another rwa file) would produce two regex matches and trip the
  // exactly-one check in applySeedSubs.
  const subbed = applySeedSubs(seed, {
    uuid: crypto.randomUUID(),
    title,
    fileMeta,
  });
  const result = replaceInlineDoc(subbed, html);
  await fs.writeFile(out, result, 'utf8');
  console.log(`wrote ${rel(out)}`);
  if (open) {
    const prefill = await collectPrefill();
    if (prefill.key) console.error('note: passing OPENROUTER_API_KEY via ?key= URL parameter');
    if (prefill.backend) console.error(`note: passing RWA_BACKEND=${prefill.backend} via ?backend= URL parameter`);
    if (prefill.model) console.error(`note: passing RWA_MODEL=${prefill.model} via ?model= URL parameter`);
    openFile(out, prefill);
  }
}
