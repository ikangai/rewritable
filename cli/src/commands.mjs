import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { loadSeed, applySeedSubs, replaceInlineDoc } from './seed.mjs';
import { convert } from './import.mjs';
import { convertPdfViaVision } from './import-vision.mjs';
import { convertViaClaudeCli } from './import-claude.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);

// Look in the in-package copy first (published case), fall back to the
// repo-canonical seed (dev case where cli/ sits next to seeds/).
const SEED_CANDIDATES = [
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

function openFile(target, key) {
  // When a key is present we open via a file:// URL with `?key=…` so the
  // bootstrap can lift it into sessionStorage on first paint and scrub the
  // bar via history.replaceState. Without a key we use the bare path so
  // the open command is byte-identical to before.
  let arg;
  if (key) {
    const u = pathToFileURL(target);
    u.searchParams.set('key', key);
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

export async function newCmd({ outPath, force, open }) {
  const out = path.resolve(outPath || './rewritable.html');
  await ensureWritable(out, force);
  const seed = await loadSeed(SEED_CANDIDATES);
  const fileMeta = path.basename(out);
  const title = titleFromBasename(path.basename(out, path.extname(out)));
  const result = applySeedSubs(seed, {
    uuid: crypto.randomUUID(),
    title,
    fileMeta,
  });
  await fs.writeFile(out, result, 'utf8');
  console.log(`wrote ${rel(out)}`);
  if (open) {
    const key = await readEnvKey('OPENROUTER_API_KEY');
    if (key) console.error('note: passing OPENROUTER_API_KEY via ?key= URL parameter');
    openFile(out, key);
  }
}

export async function importCmd({ inputPath, outPath, force, open, vision, claude, model, timeoutSec }) {
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
    console.error(`note: claude: spawning \`claude -p\`…`);
    // Pass the path; the skill reads the file itself via its own tools.
    const claudeOpts = timeoutSec ? { timeoutMs: timeoutSec * 1000 } : {};
    ({ html, warnings } = await convertViaClaudeCli(input, ext, claudeOpts));
  } else {
    // Buffer (not utf8 string) — docx and pdf are binary, and text formats
    // decode internally inside convert().
    const contents = await fs.readFile(input);
    ({ html, warnings } = await convert(ext, contents));
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
    const key = await readEnvKey('OPENROUTER_API_KEY');
    if (key) console.error('note: passing OPENROUTER_API_KEY via ?key= URL parameter');
    openFile(out, key);
  }
}
