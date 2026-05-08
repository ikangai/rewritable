import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { loadSeed, applySeedSubs, replaceInlineDoc } from './seed.mjs';
import { convert } from './import.mjs';
import { convertPdfViaVision } from './import-vision.mjs';

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

function openFile(target) {
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'open'; args = [target];
  } else if (process.platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '""', target];
  } else {
    cmd = 'xdg-open'; args = [target];
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
  if (open) openFile(out);
}

export async function importCmd({ inputPath, outPath, force, open, vision, model }) {
  const input = path.resolve(inputPath);
  const inputDir = path.dirname(input);
  const inputBasename = path.basename(input, path.extname(input));
  const out = path.resolve(outPath || path.join(inputDir, `${inputBasename}.html`));
  await ensureWritable(out, force);

  const ext = path.extname(input).toLowerCase().replace(/^\./, '');
  // Buffer (not utf8 string) — docx and pdf are binary, and text formats
  // decode internally inside convert().
  const contents = await fs.readFile(input);
  let html, warnings;
  if (vision) {
    if (ext !== 'pdf') {
      const e = new Error(`--vision is currently only supported for .pdf (got .${ext})`);
      e.exitCode = 2;
      throw e;
    }
    console.error('note: vision: posting to openrouter…');
    ({ html, warnings } = await convertPdfViaVision(contents, { model }));
  } else {
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
  if (open) openFile(out);
}
