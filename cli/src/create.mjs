// `rwa create <task…>` (and the `draft` alias) — scaffold + agent-fill into a
// SELF-CONTAINED rewritable in one shot (design 2026-05-31 §4). The task is a CLI
// INPUT, never a file capability: the CLI bakes the generated content (and any
// --data) into the INLINE_DOC snapshot, and the emitted file is thereafter an
// ordinary, dependency-free rewritable. Recurrence = re-run the CLI.
//
// Pipeline (§4.6): scaffold in memory → runAgentLoop (authoring) → apply the
// envelope to a temp file → assertSelfContained → write ONCE atomically. Nothing
// is written to the destination unless the whole pipeline succeeds, so a failed
// run never leaves a half-baked file on disk.

import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadSeed, applySeedSubs, replaceInlineDoc, extractInlineDoc, kindOverrides, KNOWN_KINDS } from './seed.mjs';
import { resolveBareWord } from './template.mjs';
import { extractFromSeed } from './seed-extract.mjs';
import { runAgentLoop } from './agent-loop.mjs';
import { applyPlan, CliError } from './edit.mjs';
import { assertSelfContained } from './self-contained.mjs';
import { findFrozenZones } from './apply-edits.mjs';
import { resolveApiKey, envBaseUrl, backendMaxTokens } from './backend.mjs';
import { atomicWrite } from './atomic-write.mjs';

// Hard cap on --data baked into the snapshot. The dataset lands inside INLINE_DOC
// of a single self-contained file the user will ship; an unbounded paste would
// bloat the artifact and the model context. Over the cap → fail loud (§4.3).
const DATA_CAP = 200_000;

const VALUE_FLAGS = new Set([
  '--kind', '--from', '--data', '--out',
  '--backend', '--model', '--base-url', '--api-key',
]);

/**
 * Parse `rwa create` argv into flags + the positional task words. Pure: no IO,
 * no kind resolution (that is resolveBareWord's job, §4.2 Stage 1). A value
 * flag's argument is never collected as a task word.
 *
 * @param {string[]} argv — args after the `create`/`draft` verb
 * @returns {{kind:string|null, from:string|null, data:string|null, out:string|null,
 *            force:boolean, open:boolean,
 *            backend:{name:string|null, model:string|null, baseUrl:string|null, apiKey:string|null},
 *            words:string[]}}
 */
export function parseCreateArgs(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const words = argv.filter((a, i) => {
    if (a.startsWith('-')) return false;            // a flag itself
    if (VALUE_FLAGS.has(argv[i - 1])) return false; // a value-flag's argument
    return true;
  });
  return {
    kind: get('--kind'),
    from: get('--from'),
    data: get('--data'),
    out:  get('--out'),
    force: argv.includes('--force') || argv.includes('-f'),
    open:  argv.includes('--open')  || argv.includes('-o'),
    backend: {
      name:    get('--backend'),
      model:   get('--model'),
      baseUrl: get('--base-url'),
      apiKey:  get('--api-key'),
    },
    words,
  };
}

// The create-only generation contract (design §4.5): output must run with ZERO
// external runtime dependencies. Appended to whichever per-kind system prompt the
// resolved frame selects — this is CLI-exclusive framing, never shipped in the
// seed bytes. assertSelfContained (below) is the code-level tripwire behind it.
const SELF_CONTAINMENT_DIRECTIVE = `

CRITICAL — the document you produce MUST be fully self-contained and run with NO external runtime dependencies:
- Do NOT reference any external URL: no <script src=...> to a CDN, no <link href=...> stylesheet, no remote <img>, no @import or url() pointing off-document. Everything is inlined.
- For any chart/graph/visualization, hand-roll it with inline <svg> or <canvas> + plain JavaScript. Do NOT use D3, Chart.js, or any library.
- Embed every piece of data directly in the document (e.g. a <script type="application/json"> island or a JS const). Never fetch data at runtime.
- Produce the COMPLETE document for the request — this is authoring from a starter, so a wholesale replace_document is appropriate.`;

// Mirror of commands.mjs titleFromBasename (kept local — create.mjs is a peer of
// commands.mjs, not a dependent). Filename → Title Case, with a safe fallback.
function titleFromBasename(basename) {
  return basename
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ') || 'Untitled';
}

function rel(p, cwd) {
  const r = path.relative(cwd, p);
  return r || p;
}

// Resolve the creation FRAME — kind + scaffold body + the brief words — from the
// parsed args (design §4.2). --kind wins and disables leading-word detection; an
// explicit kind keeps the full word list as the brief. Otherwise the leading word
// is matched template-first via resolveBareWord (the SAME resolver `rwa new` uses,
// so the two surfaces never diverge), and that word is consumed from the brief.
// A silent frame (no kind, no template match) defaults to document with the whole
// word list as the brief — Stage 2 model inference is deferred to v2 (§9.2).
async function resolveFrame(parsed, cwd) {
  if (parsed.kind) {
    if (!KNOWN_KINDS.includes(parsed.kind)) {
      throw new CliError(1, 'unknown_kind', { kind: parsed.kind, known: KNOWN_KINDS });
    }
    return { kind: parsed.kind, scaffoldBody: kindOverrides(parsed.kind).body, briefWords: parsed.words, fromMsg: '' };
  }
  const lead = parsed.words[0];
  const frame = lead ? await resolveBareWord(lead, cwd) : null;
  if (frame && frame.source === 'template') {
    return {
      kind: 'document',                 // a cloned instance is a document
      scaffoldBody: frame.body,         // already label-stripped by resolveBareWord
      briefWords: parsed.words.slice(1),
      fromMsg: ` (from template ${rel(frame.templatePath, cwd)})`,
    };
  }
  if (frame && frame.source === 'kind') {
    return { kind: frame.kind, scaffoldBody: kindOverrides(frame.kind).body, briefWords: parsed.words.slice(1), fromMsg: '' };
  }
  return { kind: 'document', scaffoldBody: null, briefWords: parsed.words, fromMsg: '' };
}

/**
 * `rwa create` / `rwa draft`: scaffold a fresh container, drive the agent loop to
 * author it, validate self-containment, and write ONCE — atomically. The emitted
 * file is an ordinary self-contained rewritable; the task left no capability in it.
 *
 * @param {object} parsed — parseCreateArgs output
 * @param {object} opts
 * @param {string[]} opts.seedCandidates — seed search paths (loadSeed order)
 * @param {string}   [opts.cwd] — base dir for relative paths + template scan
 * @param {string}   [opts.stdinData] — content for `--data -` (caller drains stdin)
 * @returns {Promise<{out:string, kind:string, fromMsg:string}>}
 * @throws {CliError} exit 1 usage / 2 file / 3 envelope / 4 agent
 */
export async function createCmd(parsed, { seedCandidates, cwd = process.cwd(), stdinData } = {}) {
  let { kind, scaffoldBody, briefWords, fromMsg } = await resolveFrame(parsed, cwd);

  // --from: base the artifact on an existing rewritable's editable body. Reuses
  // the same exit-2 surface (not_found / not_a_rewritable) as the rest of the CLI.
  if (parsed.from) {
    const fromPath = path.resolve(cwd, parsed.from);
    let fromText;
    try {
      fromText = await readFile(fromPath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: fromPath });
      throw new CliError(2, 'read_error', { path: fromPath, errno: e && e.code, message: e && e.message });
    }
    try {
      scaffoldBody = extractInlineDoc(fromText);
    } catch {
      throw new CliError(2, 'not_a_rewritable', { path: fromPath });
    }
    fromMsg = ` (from ${rel(fromPath, cwd)})`;
  }

  // --data: read the dataset to bake into the brief. `-` reads stdin (drained by
  // the caller). Never fetched at runtime; embedded inline by the agent (§4.3).
  let dataContent = null;
  if (parsed.data === '-') {
    dataContent = stdinData == null ? '' : stdinData;
  } else if (parsed.data) {
    const dataPath = path.resolve(cwd, parsed.data);
    try {
      dataContent = await readFile(dataPath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: dataPath });
      throw new CliError(2, 'read_error', { path: dataPath, errno: e && e.code, message: e && e.message });
    }
  }
  if (dataContent != null && dataContent.length > DATA_CAP) {
    throw new CliError(1, 'data_too_large', { bytes: dataContent.length, cap: DATA_CAP });
  }

  // Output path + clobber guard (matches new/import's --force semantics).
  const dated = `./${kind}-${new Date().toISOString().slice(0, 10)}.html`;
  const out = path.resolve(cwd, parsed.out || dated);
  try {
    await stat(out);
    if (!parsed.force) throw new CliError(2, 'dest_exists', { path: out });
  } catch (e) {
    if (e instanceof CliError) throw e;
    // ENOENT is the happy path (file doesn't exist yet); anything else is a real
    // stat error worth surfacing.
    if (!(e && e.code === 'ENOENT')) throw new CliError(2, 'read_error', { path: out, errno: e && e.code });
  }

  // Build the scaffold in memory — identical subs flow to newCmd.
  const seed = await loadSeed(seedCandidates);
  const overrides = kindOverrides(kind);
  let scaffold = applySeedSubs(seed, {
    uuid: crypto.randomUUID(),
    title: titleFromBasename(path.basename(out, path.extname(out))),
    fileMeta: path.basename(out),
    lensPlaceholder:   overrides.lensPlaceholder,
    palPlaceholder:    overrides.palPlaceholder,
    productHeader:     overrides.productHeader,
    productKind:       kind,
    lensClickToAnchor: overrides.lensClickToAnchor,
  });
  const body = scaffoldBody != null ? scaffoldBody : overrides.body;
  if (body != null) scaffold = replaceInlineDoc(scaffold, body);
  const scaffoldDoc = extractInlineDoc(scaffold);

  // Backend: flag → env → default. The key is used ONLY for the model call here;
  // it is never written into the artifact (the file carries content, not creds).
  const backendName = parsed.backend.name || process.env.RWA_BACKEND || 'openrouter';
  const backend = {
    baseUrl: parsed.backend.baseUrl || envBaseUrl(backendName),
    model:   parsed.backend.model   || process.env.RWA_MODEL || 'google/gemini-3.5-flash',
    apiKey:  resolveApiKey(backendName, parsed.backend.apiKey),
    maxTokens: backendMaxTokens(backendName),
  };

  // Per-kind system prompt + the create-only self-containment directive; the brief
  // carries any --data inline so the agent embeds it (never fetches).
  const { SYSTEM_PROMPTS, TOOL_SCHEMAS } = extractFromSeed(seed);
  const systemPrompt = (SYSTEM_PROMPTS[kind] || SYSTEM_PROMPTS.document) + SELF_CONTAINMENT_DIRECTIVE;
  const frozenZoneNames = findFrozenZones(scaffoldDoc).map(z => z.name);
  let instruction = briefWords.join(' ').trim() || `Author a complete ${kind} for this document.`;
  if (dataContent != null) {
    instruction += `\n\nUse this data — embed it inline in the document, do NOT fetch it at runtime:\n${dataContent}`;
  }

  let result;
  try {
    result = await runAgentLoop({ systemPrompt, toolSchemas: TOOL_SCHEMAS, currentDoc: scaffoldDoc, instruction, frozenZoneNames, backend });
  } catch (e) {
    throw new CliError(4, e.subcode || 'agent_error', e.details || { message: e && e.message });
  }

  // Atomicity (§4.6): apply + validate against a TEMP file, never the destination.
  // The destination is written exactly once, only after self-containment passes —
  // so any failure (envelope, frozen-zone, external-ref) leaves --out untouched.
  const tmp = path.join(tmpdir(), `rwa-create-${crypto.randomUUID()}.html`);
  try {
    await atomicWrite(tmp, scaffold);
    await applyPlan(tmp, result.envelope);                 // throws CliError on envelope/frozen issues
    const filled = await readFile(tmp, 'utf8');
    assertSelfContained(extractInlineDoc(filled));         // throws CliError(4) → out untouched
    await atomicWrite(out, filled);
  } finally {
    await rm(tmp, { force: true });
  }

  return { out, kind, fromMsg };
}
