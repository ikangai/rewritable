#!/usr/bin/env node
import { newCmd, importCmd, version, KNOWN_KINDS, openWithPrefill, SEED_CANDIDATES } from '../src/commands.mjs';
import { resolveApiKey, backendMaxTokens } from '../src/backend.mjs';
import { parseCreateArgs, createCmd } from '../src/create.mjs';
import { relative } from 'node:path';

const HELP = `rwa — single-file re-writeable documents

Usage:
  rwa new [path]              create a fresh rwa document
                              (default: ./rewritable.html, --kind=document)
  rwa new <name> [path]       a bare <name> resolves template-first: clone a cwd
                              file labeled data-rwa-template="<name>" (fresh UUID,
                              label stripped) if one exists; else, if <name> is a
                              known kind (document/workflow/presentation/workspace/skill-host), create
                              that built-in kind. So "rwa new presentation" makes a
                              deck, and your own labeled file overrides the builtin.
                              Default out: ./<name>-YYYY-MM-DD.html.
  rwa import <input> [path]   convert a md/html/txt file into an rwa document
                              (default: <input-basename>.html, in input's dir)
  rwa clone <url> [path]      clone a public webpage into a rewritable (fetches;
                              SSRF-guarded). Extracts the main article + title.
                              Unlike \`import\`, this REQUIRES the network.
                              (default: ./<url-slug>.html)
  rwa create <task...>        scaffold + agent-fill a new rewritable from a
  rwa draft  <task...>        natural-language task, baked into a self-contained
                              file. Leading word picks a frame (template/kind)
                              like 'rwa new'; the rest is the brief. Flags:
                              --kind/--from/--data (- = stdin)/--out plus the
                              --backend/--model/--base-url/--api-key backend flags.
                              Output is held to a strict no-external-dependency
                              bar (exit 4 on a CDN/remote ref). 'draft' = 'create'.
  rwa edit <path> [...]       apply a tool-envelope or instruction to a
                              rewritable in place. Plan path: pipe an
                              apply_edits / apply_dsl_plan / replace_document
                              envelope on stdin, or pass --plan <file>.
                              Instruction path: pass a plain-text instruction
                              as the second positional and the CLI runs the
                              agent loop (backend-configurable below).
  rwa upgrade <path>          re-bootstrap a rewritable onto the current
                              seed. Preserves DOC_UUID, the INLINE_DOC body
                              verbatim (frozen zones, signed records, and
                              all), PRODUCT_KIND, <title>, and RWA.FILE —
                              everything else in the bootstrap comes from
                              the current seed. Refuses to write unless the
                              rebuilt file round-trips DOC_UUID + INLINE_DOC
                              byte-for-byte. See --check / --dry-run below.
                              --json emits {path,uuid,kind,currentSeedId,
                              targetSeedId,needsUpgrade,mode,written}.
  rwa doc <path>              print the editable document body (the exact
                              LF-canonical text the edit contract operates on).
                              The read counterpart to \`rwa edit\`. With --json,
                              print the self-description/1 superset instead —
                              the edit contract plus "what is this, what can be
                              done with it": {rwa, kind, title, affordances,
                              baseline, frozenZones, baseHash, origin, role,
                              …, doc}. \`role\` is the specialist this container
                              asks an agent to BE — its signed rwa-agent/1
                              record — or null with \`roleStatus\` saying why
                              (none / unverified / multiple). An unverified role
                              definition is prompt injection promoted to
                              configuration, so its prompt is withheld, never
                              handed over with a warning.
                              baseHash is the staleness token: feed it back as
                              \`rwa edit --base-hash\` so a concurrent write is
                              refused instead of silently clobbered.
                              Exit 2 on a non-rewritable file — a clean
                              "is this a rewritable?" probe.
                              --outline lists the document's blocks instead of
                              its text — one row each: data-rwa-id, size, tag,
                              and a capped preview, indented by heading level.
                              --preview <n> budgets that preview (0 = a pure
                              id/tag/size skeleton). An outline costs O(block
                              count), not O(document size), so it pays most on
                              documents whose blocks are substantial.
                              --block <id> prints exactly one block's source.
                              Outline + one block + --base-hash closes a
                              read-modify-write cycle whose cost is proportional
                              to the EDIT rather than to the document.
                              --virtual emits embedded images as opaque
                              \`rwa-asset:<id>\` tokens instead of their bytes —
                              the form the in-page agent has always seen. A
                              one-image document drops from ~60 KB to ~140
                              bytes. PAIR it with \`rwa edit --virtual\`; a
                              token-form read with a raw-form write is refused
                              (\`virtual_form_mismatch\`), never mis-anchored.
  rwa doctor <path>           offline, read-only health check: frozen-zone
                              integrity, size headroom, orphaned rwa-asset
                              image tokens, <script>/<style> tag balance,
                              reserved-id/duplicate-block-id hygiene, and
                              seed freshness. Never writes. Exit 0 (clean),
                              5 (an error-severity finding exists), or the
                              usual 1/2 usage/file errors. --json emits
                              {ok, uuid, kind, findings:[{id, severity,
                              title, detail, …}]}.
  rwa ls [paths...]           list the rewritables in a folder (or file list;
                              default: ./), one line each: kind · title ·
                              affordances. The "what are all these?" counterpart
                              to \`rwa doc\`. Non-rewritables are counted, not
                              hidden. With --json, an array of self-description
                              rows. Lenient: a completed scan exits 0.
  rwa workspace create <dir>  create a folder-level rwa-index.html control
                              center. The index is a rewritable of kind
                              workspace, with a frozen manifest generated from
                              sibling rewritables in that directory.
  rwa workspace sync [dir]    refresh <dir>/rwa-index.html from the current
                              sibling rewritable inventory (default: ./).
  rwa publish <path>          publish a local rewritable to the share service
                              and print the hosted URL. POSTs your edited bytes;
                              the hosted snapshot is anonymous, 24h, with a fresh
                              DOC_UUID. Target: --url > \$RWA_PUBLISH_URL >
                              https://rewritable.ikangai.com. --json emits
                              {short,url,expiresAt}.
  rwa publish-site <path>     scp a rewritable to a static site (needs RWA_SITE_* env)
  rwa proxy [--port N]        run a local OpenRouter key broker on 127.0.0.1: the
                              key stays on this machine (env or ~/.rwa/openrouter-key)
                              and containers use the KEYLESS Ollama/LM Studio backend
                              with Base URL http://127.0.0.1:11435/v1 — no more
                              per-tab key pasting, and no key in any browser. Web
                              origins are refused unless --allow-origin is given
                              (file:// containers and local tools always pass).
  rwa proxy --agent           run the same loopback service backed by your LOCAL
                              agent instead of a key: it asks \`claude -p\` and
                              synthesizes real tool_calls, so the container gets a
                              MULTI-TURN tool-use backend and no API key exists in
                              any browser at all. This is what \`bridge\` /
                              \`bridge-session\` could not be: single-shot, so
                              skin --l1, prose extraction and the compose paths
                              refuse them and degrade. Over this proxy they work.
                              --model pins the agent model; --max-calls caps how
                              much one session may spend (default 200).
                              The answering agent runs with NO tools — document
                              content is untrusted, and it must be able to answer
                              without being able to act.
  rwa proxy set-key           prompt for the key (hidden input) and store it at
                              ~/.rwa/openrouter-key with mode 600.
  rwa host <path>             ingest a rewritable into a hosted runtime (POST /r)
                              and print {id, token, url}. The network-bearing
                              counterpart of \`publish\` for round-trip hosted
                              editing — the returned url carries the capability
                              token in its #k= fragment. Target: --url >
                              \$RWA_HOST_URL. --json emits {id,token,url}.
  rwa install <skill> <host>  install a signed .rwa-skill.json into a skill-host
                              container, offline. Verifies the signature + runs the
                              same trust gates as the in-app dialog, then splices the
                              skill into the frozen #rwa-skills zone. Requires --yes
                              (no dialog to consent in); gate failures are final.
                              --json emits {skillId,name,kind,verified,status}.
  rwa skill publish <file>    publish a SIGNED .rwa-skill.json to the marketplace
                              index (POST /skills/publish). The envelope is already
                              signed — no key needed. Online; --url overrides the
                              service, --json emits {skillId,registryUrl,verified}.
  rwa skin <path> <name>      apply a named style preset to a rewritable in
                              place (deterministic, offline, model-free). Names:
                              notion-clean, linear-dark, editorial-serif,
                              stripe-docs, terminal-mono.
                              \`rwa skin <path> reset\` removes the skin (and any
                              sk-* wrappers a prior --l1 restyle left). The
                              preset's <style data-rwa-skin> block rides inside
                              the document, so it ships in the exported file and
                              one undo (⌘Z in the app) reverts it. --json emits
                              {exitCode,mode,skin}.
                              --l1 opts into the agent-driven content-aware
                              restyle: the model adds sk-* class hooks/wrappers,
                              then theme + wrappers commit together (needs a
                              backend — see the --backend flags below; a missing
                              backend exits 4). Agent decline degrades to
                              theme-only; --json emits {exitCode,mode,skin,degraded}.

Flags:
  --kind <name>  (new only) starter kind: document (default), workflow,
                 presentation, workspace, or skill-host. 'document' is the canonical prose
                 container. 'workflow' scaffolds three stages (Inbox / In
                 progress / Done). 'presentation' scaffolds a prose deck that the
                 'Present' toggle displays as slides (split on h1/h2) without
                 changing the stored text. 'workspace' scaffolds a directory
                 control center; prefer \`rwa workspace create\` so the manifest
                 is filled from disk. 'skill-host' hosts permission-gated
                 skills installed from .rwa-skill.json files (v0.8 actions spec).
                 See docs/specs/rwa-product-types.md.
  --skin <name>  (new only) bake a style preset into the new container:
                 notion-clean, linear-dark, editorial-serif, stripe-docs,
                 terminal-mono. Orthogonal to
                 --kind (a skinned document or presentation). Deterministic and
                 offline; change or remove it later with
                 \`rwa skin <file> <name|reset>\`.
  --force, -f    overwrite the destination if it exists
  --open, -o     open the resulting file in the default app. First-paint
                 sessionStorage is pre-populated from env / ./.env:
                   OPENROUTER_API_KEY → ?key=…    (lifted into rwa_apikey)
                   RWA_BACKEND        → ?backend= (openrouter|ollama|lmstudio|atomic|bridge)
                   RWA_MODEL          → ?model=…  (model name string)
                 The bootstrap lifts each into sessionStorage and scrubs the
                 URL bar on first paint, so the values don't sit in history.
  --vision       (import only, .pdf only) send the PDF to OpenRouter and
                 ask the model to convert it to clean HTML. Bypasses the
                 local pdfjs heuristic entirely. Requires OPENROUTER_API_KEY.
                 Costs ~$0.001-$0.05 per page in API tokens depending on model.
  --claude       (import only, .pdf or .docx) spawn \`claude -p\` to convert
                 the file using the local pdf/docx skills (Anthropic
                 official). Best fidelity for documents that benefit from
                 skill-driven extraction (multi-column, tables, tracked
                 changes). Requires the \`claude\` CLI installed. The agent
                 reads the file's contents, so a malicious file could
                 hijack it: this refuses to run unless you also pass
                 --trust-input. (Default import, without --claude, parses
                 the file safely and never executes its contents.)
  --trust-input  (with --claude) consent to run the extraction agent with
                 --permission-mode bypassPermissions on this file. Only use
                 on files whose source you trust — prompt-injection text in
                 an untrusted file becomes code execution.
  --model <id>   (with --vision) override the OpenRouter model id.
                 Default: google/gemini-3.5-flash.
  --timeout <s>  (with --claude) wall-clock cap for the subprocess in
                 seconds. Default: 1200 (20 minutes). Long academic
                 papers may need more.
  --plan <file>  (edit only) read the tool-envelope from <file> instead of
                 stdin. Use \`--plan -\` to force stdin even when stdin is
                 not a pipe.
  --json         (edit) on SUCCESS, emit the result object on stdout:
                 \`{ok, tool, compiledTo?, applied, baseHash, newHash,
                 bytes}\` — one JSON object, so a caller can confirm what
                 was applied without re-reading the document. \`baseHash\`
                 and \`newHash\` are sha-256 over the LF-canonical editable
                 body before/after — the same value \`rwa doc --json\` and
                 the hosted \`/r/:id/doc\` report, so all three surfaces
                 agree on what a document is. Carry \`newHash\` into the
                 next edit's \`--base-hash\`.
                 On FAILURE, one JSON object per line on stderr — each a
                 \`{code, subcode, details}\` object.
  --virtual      (doc) emit rwa-asset tokens in place of embedded image
                 bytes. (edit) the envelope's anchors are in that token
                 form, because you read the document with \`doc --virtual\`.
                 The two are one contract — mixing them fails loud.
  --base-hash <h>
                 (edit) apply only if the document still hashes to <h> —
                 the 64-hex \`baseHash\` from \`rwa doc --json\` or the
                 \`newHash\` of your previous edit. If anyone wrote in
                 between, the edit is REFUSED (exit 3,
                 \`base_hash_mismatch\`) instead of overwriting their work;
                 re-read, recompose and retry. Without it, edits are
                 last-writer-wins.
                 (doc) emit the editing-contract object on stdout instead of
                 the raw body; on failure, the \`{code, subcode, details}\`
                 object goes to stderr.
                 (doctor) emit the {ok, uuid, kind, findings} object on
                 stdout instead of the plain-text report; failures use the
                 same \`{code, subcode, details}\` stderr shape.
  --backend <n>  (edit instruction path / skin --l1) backend name. One of:
                 openrouter (default), ollama, lmstudio, atomic. Falls back
                 to \$RWA_BACKEND if unset.
  --model <id>   (edit instruction path / skin --l1) model id passed to the
                 backend. Falls back to \$RWA_MODEL, then a
                 sensible default for the backend.
  --base-url <u> (edit instruction path / skin --l1) override the OpenAI-
                 compatible base URL. Defaults: openrouter →
                 https://openrouter.ai/api/v1, ollama →
                 http://localhost:11434/v1 (or \$RWA_OLLAMA_URL),
                 lmstudio → http://localhost:1234/v1 (or
                 \$RWA_LMSTUDIO_URL).
  --api-key <k>  (edit instruction path / skin --l1) API key for the backend.
                 Openrouter: required, falls back to \$RWA_OPENROUTER_KEY
                 then \$OPENROUTER_API_KEY. Other backends ignore this flag.
  --l1           (skin only) opt into the agent-driven content-aware restyle
                 (needs a backend; missing backend exits 4). Default skin is
                 deterministic theme-only.
  --theme-only   (skin only) apply just the preset's deterministic theme block
                 — the default behavior — and silence the "theme-only" note.
  --check        (upgrade only) report current vs. target seed id and
                 whether an upgrade is needed; never writes.
  --dry-run      (upgrade only) like --check, but also rebuilds in memory
                 and verifies the DOC_UUID/INLINE_DOC round-trip; never
                 writes.
  --version      print version and exit
  --help, -h     this help

Supported import formats: .md, .markdown, .html, .htm, .csv, .txt, .docx, .pdf
`;

const args = process.argv.slice(2);
const verb = args[0];


// Render an outline as an indented tree (#34). Indentation follows the HEADING
// hierarchy rather than DOM nesting, because that is the structure a reader
// actually navigates by: a heading sets the level, everything after it sits one
// level in. Ids are the column that matters — they are what `--block <id>` and
// an edit instruction refer to — so they lead each row.
function formatOutline(r) {
  if (!r.count) return '(no anchorable blocks)';
  const lines = [];
  let level = 0;
  for (const b of r.outline) {
    const h = /^h([1-6])$/.exec(b.tag);
    if (h) level = Number(h[1]) - 1;
    const indent = '  '.repeat(h ? level : level + 1);
    const id = b.id ? b.id : '········';
    const flag = b.frozen ? ' [frozen]' : '';
    const size = String(b.chars).padStart(6);
    lines.push(`${id}  ${size}  ${indent}${b.tag}${flag}${b.preview ? '  ' + b.preview : ''}`);
  }
  lines.push('');
  const unnamed = r.outline.filter(b => !b.id).length;
  lines.push(`${r.count} block${r.count === 1 ? '' : 's'}` +
    (unnamed ? ` (${unnamed} without an id — commit once to backfill)` : '') +
    `  ·  ${r.baseHash.slice(0, 12)}`);
  return lines.join('\n');
}

// `rwa edit` failure surface — one line per emit. Plain mode: short
// human-readable string. JSON mode: a single JSON object per line so
// callers (CI, agent loops) can parse without regex.
function emitEdit(payload, jsonMode) {
  if (jsonMode) {
    process.stderr.write(JSON.stringify(payload) + '\n');
  } else {
    const parts = [payload.code, payload.subcode].filter(Boolean);
    let line = 'rwa edit: ' + parts.join('/');
    if (payload.details && Object.keys(payload.details).length) {
      line += ' ' + JSON.stringify(payload.details);
    }
    process.stderr.write(line + '\n');
  }
}

// `rwa edit` SUCCESS surface (#30). The failure path above has always been
// well-formed; success was silent, which left a delegating agent with exit 0
// and nothing to audit — re-reading the whole document is exactly the cost
// delegation exists to avoid. Success goes to STDOUT (the repo convention every
// other verb follows: `upgrade`, `doc`, `doctor`, `ls`, `publish` all put the
// result on stdout and errors on stderr), so `rwa edit --json` is pipeable.
function emitEditResult(result, jsonMode) {
  if (jsonMode) {
    // Drop the legacy `exitCode` field from the wire shape — it is an internal
    // caller convention, not part of the reported result.
    const { exitCode: _exitCode, ...payload } = result;
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    const what = result.compiledTo ? `${result.tool}→${result.compiledTo}` : result.tool;
    process.stdout.write(
      `✓ ${what}: ${result.applied} edit${result.applied === 1 ? '' : 's'} applied · ` +
      `${result.bytes} bytes · ${result.newHash.slice(0, 12)}\n`,
    );
  }
}

// Drain stdin to a UTF-8 string. Used by `rwa edit` when stdin is piped
// without an explicit --plan file argument.
function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

// Map exit codes to category names for the --json payload's `code` field.
// Subcodes (specific failure reasons) come from edit.mjs / underlying modules.
// Throws on unknown codes — Rule 12 (fail loud): a synthetic fallback would
// mask future programmer bugs (e.g. someone adds `new CliError(5, ...)` and
// forgets to extend this switch).
function codeName(n) {
  switch (n) {
    case 1: return 'usage_error';
    case 2: return 'file_error';
    case 3: return 'envelope_error';
    case 4: return 'agent_error';
    case 5: return 'doctor_findings';
    default: throw new Error(`codeName: unexpected exit code ${n}`);
  }
}

// Generic single-value flag extractor. Returns `{present, value}` so callers
// can distinguish "flag absent" (use env / default) from "flag present with a
// bad value" (must surface usage_error). A bad value is either missing (flag
// is the last token) or another flag (starts with `-`). Silently falling back
// to env in the bad-value case lets typos like `--api-key --json` route
// `--json` into the Authorization header — fail loud instead (Rule 12).
function getFlag(name, rest) {
  const i = rest.indexOf(name);
  if (i < 0) return { present: false };
  const value = rest[i + 1];
  return { present: true, value };
}

// Validate a flag returned by getFlag. If present-with-bad-value, emit
// usage_error/missing_flag_value and signal the caller to bail. Returns the
// usable string when present-and-good, or undefined when absent (caller
// resolves via env / default chain).
function resolveFlag(flagResult, name, jsonMode) {
  if (!flagResult.present) return { ok: true, value: undefined };
  const v = flagResult.value;
  if (v === undefined || v.startsWith('-')) {
    emitEdit(
      { code: 'usage_error', subcode: 'missing_flag_value', details: { flag: name } },
      jsonMode,
    );
    return { ok: false };
  }
  return { ok: true, value: v };
}

// Default base URLs per backend — mirrors seeds/rewritable.html
// resolveBackendConfig (openrouter:2275, ollama:2243, lmstudio:2259).
// ollama and lmstudio honor RWA_*_URL overrides so the user can point at a
// remote host or non-standard port. openrouter is fixed (the URL has never
// drifted in the seed) so no override.
function envBaseUrl(name) {
  switch (name) {
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'ollama':     return process.env.RWA_OLLAMA_URL || 'http://localhost:11434/v1';
    case 'lmstudio':   return process.env.RWA_LMSTUDIO_URL || 'http://localhost:1234/v1';
    case 'atomic':     return process.env.RWA_ATOMIC_URL || 'http://127.0.0.1:1337/v1';
    default:           return undefined;
  }
}

// Extract `const PRODUCT_KIND = '...';` from the bootstrap. The seed bakes
// this at emit time (cli/src/seed.mjs applySeedSubs); reading it back lets
// us select the right SYSTEM_PROMPTS entry. Falls back to 'document' if the
// regex doesn't match — pre-PRODUCT_KIND containers all rendered as
// document-kind in the runtime, so defaulting matches that history.
function detectProductKind(fileText) {
  const m = fileText.match(/const PRODUCT_KIND = '([^']*)';/);
  return m ? m[1] : null;
}

(async () => {
  try {
    if (verb === '--version' || verb === '-V') {
      console.log(await version());
      return;
    }
    if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
      process.stdout.write(HELP);
      if (!verb) process.exitCode = 2;
      return;
    }
    const rest = args.slice(1);

    if (verb === 'edit') {
      // `--json` is opt-in and only applies to `edit` — other verbs ignore it.
      const jsonMode = rest.includes('--json');
      // `--plan <file>` or `--plan -` (force stdin). Default: stdin if piped.
      const planIdx = rest.indexOf('--plan');
      const planArg = planIdx >= 0 ? rest[planIdx + 1] : undefined;
      if (planIdx >= 0 && (planArg === undefined || (planArg.startsWith('-') && planArg !== '-'))) {
        emitEdit({ code: 'usage_error', subcode: 'missing_plan_value' }, jsonMode);
        process.exitCode = 1;
        return;
      }
      // `--base-hash <hex>` — optimistic concurrency (#31). The caller asserts
      // which version of the document it composed against; a mismatch means
      // somebody else wrote in between, so we refuse rather than clobber.
      // Absent = today's last-writer-wins behaviour, so nothing breaks.
      const baseHashIdx = rest.indexOf('--base-hash');
      const baseHashArg = baseHashIdx >= 0 ? rest[baseHashIdx + 1] : undefined;
      if (baseHashIdx >= 0 && (baseHashArg === undefined || baseHashArg.startsWith('-'))) {
        emitEdit({ code: 'usage_error', subcode: 'missing_base_hash_value' }, jsonMode);
        process.exitCode = 1;
        return;
      }
      if (baseHashArg !== undefined && !/^[0-9a-f]{64}$/.test(baseHashArg)) {
        // Fail loud on a malformed hash rather than treating it as a mismatch:
        // "you typed it wrong" and "someone else edited" need different fixes.
        emitEdit({ code: 'usage_error', subcode: 'malformed_base_hash', details: { got: baseHashArg } }, jsonMode);
        process.exitCode = 1;
        return;
      }
      // Backend flags carry a value — keep them out of `positionals` so
      // their argument doesn't get parsed as a stray instruction word.
      // #33 — the envelope speaks rwa-asset token form because the caller read
      // the document with `rwa doc --virtual`. The instruction path virtualizes
      // unconditionally (the model must never see pixels), so this only applies
      // to the plan path.
      const virtualPlan = rest.includes('--virtual');
      const FLAG_WITH_VALUE = new Set(['--plan', '--base-hash', '--backend', '--model', '--base-url', '--api-key']);
      const positionals = rest.filter((a, i) =>
        !a.startsWith('-') && !FLAG_WITH_VALUE.has(rest[i - 1])
      );
      const filePath = positionals[0];
      const instruction = positionals.slice(1).join(' ');
      if (!filePath) {
        emitEdit({ code: 'usage_error', subcode: 'missing_file_arg' }, jsonMode);
        process.exitCode = 1;
        return;
      }

      // Input-source detection. Three mutually exclusive ways to supply
      // the plan/instruction:
      //   1. positional instruction string
      //   2. piped stdin (without --plan, or with explicit `--plan -`)
      //   3. --plan <file>
      //
      // Stdin probing is content-based, not TTY-based. `process.stdin.isTTY`
      // is unreliable: child_process.spawn() (used by our tests + every CI
      // harness) always leaves stdin as a non-TTY pipe even when the parent
      // sends nothing. So we drain stdin eagerly and treat empty bytes as
      // "no stdin input". `--plan -` overrides this and forces stdin even
      // when empty (caller said so explicitly).
      const hasPositionalInstruction = instruction.length > 0;
      const hasPlanFile = typeof planArg === 'string' && planArg !== '-';
      const hasPlanDash = planArg === '-';

      // Read stdin only when there's no positional instruction AND no --plan <file>.
      // We accept that this means we cannot detect `pipe | rwa edit X "instruction"` as
      // `conflicting_input` — that combination is rare, and detecting it would require
      // either eagerly draining stdin (which hangs on slow upstreams) or a non-blocking
      // peek (platform-specific). Strict-and-loud beats hang-and-then-loud.
      //
      // Note: when --plan <file> is set, piped stdin is intentionally ignored. The design
      // treats explicit-file as the unambiguous source of intent; detecting "stdin happens
      // to have bytes too" would require eagerly draining (defeats the file-only fast path)
      // or a non-blocking peek. We accept the trade-off.
      let stdinBuf = '';
      let stdinHasContent = false;
      if (!hasPlanFile && !hasPositionalInstruction) {
        stdinBuf = await readStdin();
        stdinHasContent = stdinBuf.length > 0;
      }
      const planFromStdin = hasPlanDash || (stdinHasContent && !hasPlanFile);

      const sources =
        (hasPositionalInstruction ? 1 : 0) +
        (planFromStdin ? 1 : 0) +
        (hasPlanFile ? 1 : 0);
      if (sources === 0) {
        emitEdit({ code: 'usage_error', subcode: 'missing_input' }, jsonMode);
        process.exitCode = 1;
        return;
      }
      if (sources > 1) {
        emitEdit({ code: 'usage_error', subcode: 'conflicting_input' }, jsonMode);
        process.exitCode = 1;
        return;
      }

      // Instruction path: run the agent loop and apply the resulting envelope.
      if (hasPositionalInstruction) {
        // Resolve backend config: explicit flag wins, then env, then default.
        // The default model id matches the seed (seeds/rewritable.html
        // const RWA.MODEL) so first-paint behavior is consistent across CLI
        // and browser surfaces.
        //
        // Each flag is validated explicitly: present-with-bad-value (e.g.
        // `--api-key --json` or `--backend` with no following token) errors
        // with usage_error/missing_flag_value rather than silently falling
        // back to env (which would, e.g., route `--json` into the
        // Authorization header). Absent flags resolve via env / default.
        const backendFlag  = resolveFlag(getFlag('--backend',  rest), '--backend',  jsonMode);
        if (!backendFlag.ok)  { process.exitCode = 1; return; }
        const modelFlag    = resolveFlag(getFlag('--model',    rest), '--model',    jsonMode);
        if (!modelFlag.ok)    { process.exitCode = 1; return; }
        const baseUrlFlag  = resolveFlag(getFlag('--base-url', rest), '--base-url', jsonMode);
        if (!baseUrlFlag.ok)  { process.exitCode = 1; return; }
        const apiKeyFlag   = resolveFlag(getFlag('--api-key',  rest), '--api-key',  jsonMode);
        if (!apiKeyFlag.ok)   { process.exitCode = 1; return; }

        const backendName = backendFlag.value || process.env.RWA_BACKEND || 'openrouter';
        const modelId     = modelFlag.value   || process.env.RWA_MODEL   || 'google/gemini-3.5-flash';
        const baseUrl     = baseUrlFlag.value || envBaseUrl(backendName);
        const apiKey      = resolveApiKey(backendName, apiKeyFlag.value);

        // Reject unknown backends fast. `bridge` is browser-only by design
        // (single-shot via web_cli_bridge); the CLI has no equivalent.
        if (!['openrouter', 'ollama', 'lmstudio', 'atomic'].includes(backendName)) {
          emitEdit({ code: 'usage_error', subcode: 'unknown_backend', details: { backend: backendName } }, jsonMode);
          process.exitCode = 1;
          return;
        }
        if (backendName === 'openrouter' && !apiKey) {
          emitEdit({ code: 'agent_error', subcode: 'no_api_key', details: { backend: 'openrouter' } }, jsonMode);
          process.exitCode = 4;
          return;
        }

        // Read the target file. Same file_error shape as the plan path so
        // callers can dedupe `not_found` / `read_error` handling across
        // both code paths.
        const { readFile } = await import('node:fs/promises');
        let fileText;
        try {
          fileText = await readFile(filePath, 'utf8');
        } catch (e) {
          if (e && e.code === 'ENOENT') {
            emitEdit({ code: 'file_error', subcode: 'not_found', details: { path: filePath } }, jsonMode);
            process.exitCode = 2; return;
          }
          emitEdit({
            code: 'file_error', subcode: 'read_error',
            details: { path: filePath, errno: e && e.code, message: e && e.message },
          }, jsonMode);
          process.exitCode = 2; return;
        }

        const { extractInlineDoc } = await import('../src/seed.mjs');
        let currentDoc;
        try {
          currentDoc = extractInlineDoc(fileText);
        } catch (_e) {
          emitEdit({ code: 'file_error', subcode: 'not_a_rewritable', details: { path: filePath } }, jsonMode);
          process.exitCode = 2; return;
        }

        // Staleness check BEFORE the agent loop (#31). applyPlan re-checks at
        // commit time and is the actual guarantee; this early copy exists so a
        // stale document costs nothing. On the instruction path the model call
        // is the expensive step and it is the DELEGATING agent's tokens being
        // spent — burning them to produce an envelope we already know we will
        // refuse is exactly the waste the two-agent split is meant to avoid.
        if (baseHashArg !== undefined) {
          const { bodyHash } = await import('../src/edit.mjs');
          const actual = bodyHash(currentDoc);
          if (actual !== baseHashArg) {
            const { FAILURE_HINTS } = await import('../src/apply-edits.mjs');
            emitEdit({
              code: 'envelope_error', subcode: 'base_hash_mismatch',
              details: { expected: baseHashArg, actual, hint: FAILURE_HINTS.base_hash_mismatch },
            }, jsonMode);
            process.exitCode = 3; return;
          }
        }

        // Detect product kind from the bootstrap so we pick the right
        // SYSTEM_PROMPTS entry. Pre-PRODUCT_KIND containers and unknown
        // kinds both fall through to the 'document' entry below.
        const productKind = detectProductKind(fileText) || 'document';

        // Load the seed and extract SYSTEM_PROMPTS / TOOL_SCHEMAS — same
        // in-package-first lookup `rwa new` uses. Per-kind SYSTEM_PROMPTS
        // entries already interpolate ${SYSTEM_PROMPT_RULES} internally
        // (see seeds/rewritable.html lines 1369-1370 and 1481), so we use
        // the resolved string verbatim — concatenating SYSTEM_PROMPT_RULES
        // again would duplicate ~4.5KB on every request.
        const { loadSeed } = await import('../src/seed.mjs');
        const { SEED_CANDIDATES } = await import('../src/commands.mjs');
        const seedText = await loadSeed(SEED_CANDIDATES);
        const { extractFromSeed } = await import('../src/seed-extract.mjs');
        const { SYSTEM_PROMPTS, TOOL_SCHEMAS } = extractFromSeed(seedText);
        const systemPrompt = SYSTEM_PROMPTS[productKind] || SYSTEM_PROMPTS.document;

        // Compute marker-form frozen-zone names from the CURRENT doc so the
        // model sees the same list the apply-edits guard will enforce.
        const { findFrozenZones, virtualizeImages } = await import('../src/apply-edits.mjs');
        const frozenZoneNames = findFrozenZones(currentDoc).map(z => z.name);

        // images-v1 (rwa-edit-spec.md §19): the model never sees image bytes.
        // The prompt carries the VIRTUAL doc (data:image src → rwa-asset
        // tokens); applyPlan({virtualImages}) re-derives the same hash-keyed
        // map and expands the model's token-form envelope back to real bytes.
        const promptDoc = virtualizeImages(currentDoc).doc;

        // Run the agent loop. Retry telemetry goes to stderr (plain or
        // JSON depending on mode) so CI / wrapper scripts can observe
        // progress without parsing stdout.
        const { runAgentLoop } = await import('../src/agent-loop.mjs');
        let envelope;
        try {
          const result = await runAgentLoop({
            systemPrompt,
            toolSchemas: TOOL_SCHEMAS,
            currentDoc: promptDoc,
            instruction,
            frozenZoneNames,
            // #25 — read from the container's FROZEN head, never from the
            // document body: a marker inside INLINE_DOC is content, and content
            // is what an injected instruction can delete. Absent in every
            // container emitted before #25, and empty for anything the user
            // authored themselves.
            origin: (fileText.match(/<meta name="rwa-origin" content="([^"]*)">/) || [])[1] || null,
            backend: { baseUrl, model: modelId, apiKey, maxTokens: backendMaxTokens(backendName) },
            onRetry: r => {
              if (jsonMode) {
                process.stderr.write(JSON.stringify({ phase: 'retry', attempt: r.attempt, reason: r.reason }) + '\n');
              } else {
                process.stderr.write(`rwa edit: attempt ${r.attempt}/3 retrying — ${r.reason}\n`);
              }
            },
          });
          envelope = result.envelope;
        } catch (e) {
          if (e && (e.subcode === 'no_envelope_after_retries' || e.subcode === 'backend_error')) {
            emitEdit({ code: 'agent_error', subcode: e.subcode, details: e.details }, jsonMode);
            process.exitCode = 4; return;
          }
          throw e;
        }

        // Apply the envelope through the same applyPlan used by the plan
        // path — single splice/write code path, single error surface. The
        // model saw the virtual doc, so the envelope is token-form.
        const { applyPlan } = await import('../src/edit.mjs');
        try {
          emitEditResult(await applyPlan(filePath, envelope, { virtualImages: true, baseHash: baseHashArg }), jsonMode);
          return;
        } catch (e) {
          if (e && typeof e.exitCode === 'number') {
            emitEdit({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details }, jsonMode);
            process.exitCode = e.exitCode;
            return;
          }
          throw e;
        }
      }

      // Plan path: envelope comes from --plan file OR the stdin buffer we
      // already drained above.
      let envelopeJson;
      if (hasPlanFile) {
        const fs = await import('node:fs/promises');
        try {
          envelopeJson = await fs.readFile(planArg, 'utf8');
        } catch (e) {
          const subcode = e && e.code === 'ENOENT' ? 'plan_not_found' : 'plan_read_error';
          emitEdit({ code: 'file_error', subcode, details: { path: planArg, errno: e && e.code } }, jsonMode);
          process.exitCode = 2;
          return;
        }
      } else {
        envelopeJson = stdinBuf;
      }

      let envelope;
      try {
        envelope = JSON.parse(envelopeJson);
      } catch (e) {
        emitEdit({ code: 'envelope_error', subcode: 'malformed_json', details: { message: e.message } }, jsonMode);
        process.exitCode = 3;
        return;
      }

      const { applyPlan } = await import('../src/edit.mjs');
      try {
        emitEditResult(await applyPlan(filePath, envelope, { baseHash: baseHashArg, virtualImages: virtualPlan }), jsonMode);
        return;
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          emitEdit({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details }, jsonMode);
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
    }

    // `rwa doc <path> [--json]` — the READ counterpart to `rwa edit`. Prints
    // the LF-canonical editable body (plain mode) or the full editing contract
    // (--json). stdout is reserved for the document/contract so pipes stay
    // clean; errors go to stderr, mirroring `rwa edit`'s file_error surface.
    // `rwa upgrade <path> [--check|--dry-run] [--json]` — re-bootstrap an
    // existing container onto the current seed (#12), preserving DOC_UUID,
    // INLINE_DOC (verbatim), PRODUCT_KIND, <title>, and RWA.FILE. See
    // src/upgrade.mjs for the full contract, including the round-trip
    // sanity check that gates every write.
    if (verb === 'upgrade') {
      const jsonMode = rest.includes('--json');
      const check = rest.includes('--check');
      const dryRun = rest.includes('--dry-run');
      const filePath = rest.find(a => !a.startsWith('-'));
      const emitUpgrade = (payload) => {
        if (jsonMode) {
          process.stderr.write(JSON.stringify(payload) + '\n');
        } else {
          const parts = [payload.code, payload.subcode].filter(Boolean);
          let line = 'rwa upgrade: ' + parts.join('/');
          if (payload.details && Object.keys(payload.details).length) {
            line += ' ' + JSON.stringify(payload.details);
          }
          process.stderr.write(line + '\n');
        }
      };
      if (!filePath) {
        emitUpgrade({ code: 'usage_error', subcode: 'missing_file_arg' });
        process.exitCode = 1;
        return;
      }
      if (check && dryRun) {
        emitUpgrade({ code: 'usage_error', subcode: 'conflicting_flags', details: { flags: ['--check', '--dry-run'] } });
        process.exitCode = 1;
        return;
      }
      const mode = dryRun ? 'dry-run' : (check ? 'check' : 'write');
      const { upgradeCmd } = await import('../src/upgrade.mjs');
      let result;
      try {
        result = await upgradeCmd(filePath, { mode });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          emitUpgrade({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else if (result.mode === 'noop') {
        process.stdout.write(`${filePath}: already at the current seed (${result.targetSeedId}) — nothing to do\n`);
      } else if (result.mode === 'checked') {
        process.stdout.write(`${filePath}: upgrade available (${result.currentSeedId || 'unknown'} → ${result.targetSeedId}) — not written (--check)\n`);
      } else if (result.mode === 'dry-run') {
        process.stdout.write(`${filePath}: would upgrade (${result.currentSeedId || 'unknown'} → ${result.targetSeedId}) — verified, not written (--dry-run)\n`);
      } else {
        process.stdout.write(`✓ upgraded ${filePath} (${result.currentSeedId || 'unknown'} → ${result.targetSeedId})\n`);
      }
      return;
    }

    if (verb === 'doc') {
      const jsonMode = rest.includes('--json');
      // #33 — emit the rwa-asset token form instead of embedded image bytes.
      // Pair it with `rwa edit --virtual`; the two are one read/write contract.
      const virtual = rest.includes('--virtual');
      // #34 — the two cheap read modes. `--outline` lists the document's blocks
      // (id, tag, size, preview) instead of its text; `--block <id>` returns
      // exactly one block's source. Together with #31's baseHash they let a
      // caller close a read-modify-write cycle whose cost is proportional to the
      // EDIT rather than to the document.
      const outlineMode = rest.includes('--outline');
      // `--preview <n>` budgets the outline. An outline costs O(block count),
      // not O(document size), so on a document of many SHORT blocks it saves
      // little at the default; `--preview 0` drops to a pure skeleton (id, tag,
      // size) which is a small fraction of any document. Callers that know their
      // budget should set it rather than discover this.
      const previewIdx = rest.indexOf('--preview');
      const previewArg = previewIdx >= 0 ? rest[previewIdx + 1] : undefined;
      if (previewIdx >= 0 && !/^\d+$/.test(String(previewArg))) {
        emitDocUsage({ code: 'usage_error', subcode: 'malformed_preview', details: { got: previewArg } }, jsonMode);
        process.exitCode = 1;
        return;
      }
      const blockIdx = rest.indexOf('--block');
      const blockArg = blockIdx >= 0 ? rest[blockIdx + 1] : undefined;
      if (blockIdx >= 0 && (blockArg === undefined || blockArg.startsWith('-'))) {
        emitDocUsage({ code: 'usage_error', subcode: 'missing_block_value' }, jsonMode);
        process.exitCode = 1;
        return;
      }
      const DOC_FLAG_WITH_VALUE = new Set(['--block', '--preview']);
      const filePath = rest.find((a, i) => !a.startsWith('-') && !DOC_FLAG_WITH_VALUE.has(rest[i - 1]));
      const emitDocUsage = (payload) => {
        if (jsonMode) process.stderr.write(JSON.stringify(payload) + '\n');
        else process.stderr.write('rwa doc: ' + [payload.code, payload.subcode].filter(Boolean).join('/') + '\n');
      };
      const emitDoc = (payload) => {
        if (jsonMode) {
          process.stderr.write(JSON.stringify(payload) + '\n');
        } else {
          const parts = [payload.code, payload.subcode].filter(Boolean);
          let line = 'rwa doc: ' + parts.join('/');
          if (payload.details && Object.keys(payload.details).length) {
            line += ' ' + JSON.stringify(payload.details);
          }
          process.stderr.write(line + '\n');
        }
      };
      if (!filePath) {
        emitDoc({ code: 'usage_error', subcode: 'missing_file_arg' });
        process.exitCode = 1;
        return;
      }
      const { inspectDoc, outlineDoc, readBlock } = await import('../src/doc.mjs');

      if (outlineMode || blockArg !== undefined) {
        try {
          if (blockArg !== undefined) {
            const r = await readBlock(filePath, blockArg, { virtual });
            if (jsonMode) process.stdout.write(JSON.stringify(r) + '\n');
            else process.stdout.write(r.block.source.endsWith('\n') ? r.block.source : r.block.source + '\n');
          } else {
            const r = await outlineDoc(filePath, { virtual, ...(previewArg !== undefined ? { preview: Number(previewArg) } : {}) });
            if (jsonMode) process.stdout.write(JSON.stringify(r) + '\n');
            else process.stdout.write(formatOutline(r) + '\n');
          }
          return;
        } catch (e) {
          if (e && typeof e.exitCode === 'number') {
            emitDoc({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details });
            process.exitCode = e.exitCode;
            return;
          }
          throw e;
        }
      }

      let info;
      try {
        info = await inspectDoc(filePath, { virtual });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          emitDoc({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      if (jsonMode) {
        // One call gives an agent: the read (doc), the write-contract (kind,
        // frozen zones, uuid), AND the self-description ("what is this, what can
        // be done with it" — kind/affordances/title/blocks/baseline). The payload
        // is the minimal SUPERSET of the static self-description/1 object (spec
        // §3) plus the edit-contract extras, so it validates as self-description/1
        // (validateSelfDescription ignores the extras) while staying one call.
        // `rewritable:true` is an explicit parsed-field marker, not just an exit
        // code. Field-pinned to tools/self-description.mjs by doc.test.mjs.
        process.stdout.write(JSON.stringify({
          ...info.self,
          rewritable: true,
          baseHash: info.baseHash,
          // #35 — null unless this container came from somewhere else. An
          // external agent reading through this door composes its own prompt and
          // never sees the runtime's provenance line, so the marker has to
          // travel WITH the read or it does not reach the reader at all.
          origin: info.origin,
          // #37 — what agent this container wants you to BE. `role` is populated
          // only when exactly one installed record verifies AND passes the
          // install gates; otherwise it is null and `roleStatus` says why
          // ('none' | 'unverified' | 'multiple'). An unverified role definition
          // is prompt injection promoted to configuration, so its prompt is
          // withheld rather than offered with a warning.
          role: info.role,
          roleStatus: info.roleStatus,
          ...(info.rolesOffered.length ? { rolesOffered: info.rolesOffered } : {}),
          // `virtual`/`assets` describe the PROJECTION in `doc`; `baseHash` and
          // `blocks` describe the document itself. A consumer must not confuse
          // "what I was handed" with "what this file is".
          virtual: info.virtual,
          ...(info.virtual ? { assets: info.assets } : {}),
          length: info.doc.length,
          doc: info.doc,
        }) + '\n');
      } else {
        // Terminal/pipe friendly: the body with a single trailing newline.
        // The byte-exact path is --json's `doc` field.
        process.stdout.write(info.doc.endsWith('\n') ? info.doc : info.doc + '\n');
      }
      return;
    }

    // `rwa doctor <path>` — standalone, offline, READ-ONLY health check
    // (issue #23). Runs the same validation battery apply-edits.mjs enforces
    // as a side effect of `rwa edit`, without writing anything, so a
    // received/hand-edited/years-old file can be asked "is this valid?"
    // directly. Exit 0 (clean) / 5 doctor_findings (an error-severity finding
    // exists) / 2 file_error (mirrors `rwa doc`) / 1 usage_error.
    if (verb === 'doctor') {
      const jsonMode = rest.includes('--json');
      const filePath = rest.find(a => !a.startsWith('-'));
      const emitDoctor = (payload) => {
        if (jsonMode) {
          process.stderr.write(JSON.stringify(payload) + '\n');
        } else {
          const parts = [payload.code, payload.subcode].filter(Boolean);
          let line = 'rwa doctor: ' + parts.join('/');
          if (payload.details && Object.keys(payload.details).length) {
            line += ' ' + JSON.stringify(payload.details);
          }
          process.stderr.write(line + '\n');
        }
      };
      if (!filePath) {
        emitDoctor({ code: 'usage_error', subcode: 'missing_file_arg' });
        process.exitCode = 1;
        return;
      }
      const { diagnose, formatReport } = await import('../src/doctor.mjs');
      let result;
      try {
        result = await diagnose(filePath);
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          emitDoctor({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      // The report itself is not an error surface — it's the tool's normal
      // output, whether the container is clean or not. stdout stays reserved
      // for the report; errors above (usage/file) are the only stderr path.
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(formatReport(filePath, result) + '\n');
      }
      if (!result.ok) process.exitCode = 5;
      return;
    }

    // `rwa ls [paths...] [--json]` — collection-scale self-description: the
    // "what are all these?" counterpart to `rwa doc`'s "what is this?". Reports
    // each rewritable's identity (kind/title/affordances) across a folder or
    // file list, flagging non-rewritables and bad paths as rows. Lenient like
    // its namesake — a completed scan exits 0; per-file issues live in the rows.
    if (verb === 'ls') {
      const jsonMode = rest.includes('--json');
      const paths = rest.filter(a => !a.startsWith('-'));
      const { listRewritables, formatRows } = await import('../src/ls.mjs');
      const rows = await listRewritables(paths);
      process.stdout.write((jsonMode ? JSON.stringify(rows) : formatRows(rows)) + '\n');
      return;
    }

    // `rwa workspace create <dir>` / `rwa workspace sync [dir]` — a directory
    // control center. The generated rwa-index.html is itself a rewritable, but
    // its manifest is CLI-owned and refreshed from sibling rewritables.
    if (verb === 'workspace') {
      const sub = rest.find(a => !a.startsWith('-'));
      const force = rest.includes('--force') || rest.includes('-f');
      const open = rest.includes('--open') || rest.includes('-o');
      const positionals = rest.filter((a) => !a.startsWith('-'));
      const dirPath = positionals[1] || '.';
      const emitWorkspace = (msg) => { process.stderr.write('rwa workspace: ' + msg + '\n'); };

      if (!sub || !['create', 'sync'].includes(sub)) {
        emitWorkspace('usage: rwa workspace create <dir> [--force] [--open] | rwa workspace sync [dir] [--open]');
        process.exitCode = 1;
        return;
      }
      if (sub === 'create' && !positionals[1]) {
        emitWorkspace('missing <dir> argument');
        process.exitCode = 1;
        return;
      }

      const { workspaceCreateCmd, workspaceSyncCmd } = await import('../src/workspace.mjs');
      try {
        const result = sub === 'create'
          ? await workspaceCreateCmd({ dirPath, force, seedCandidates: SEED_CANDIDATES })
          : await workspaceSyncCmd({ dirPath, seedCandidates: SEED_CANDIDATES });
        console.log(`wrote ${relative(process.cwd(), result.indexPath) || result.indexPath} (${result.docs.length} document${result.docs.length === 1 ? '' : 's'})`);
        if (open) await openWithPrefill(result.indexPath);
      } catch (e) {
        emitWorkspace((e && e.message) || String(e));
        process.exitCode = (e && e.exitCode) || 1;
      }
      return;
    }

    // `rwa publish <file> [--url <base>] [--json]` — publish a local rewritable
    // to the service's snapshot endpoint and print the share URL. Thin client
    // for `POST /publish`; see src/publish.mjs. Intentionally online (the
    // offline-first invariant of new/import does not apply to a publish action).
    if (verb === 'publish') {
      const jsonMode = rest.includes('--json');
      // `--url` takes a value, so its value token must NOT be mistaken for the
      // positional file. Skip the index right after `--url` when finding it.
      const urlFlag = getFlag('--url', rest);
      const urlIdx = rest.indexOf('--url');
      const skip = urlIdx >= 0 ? urlIdx + 1 : -1;
      const filePath = rest.find((a, i) => !a.startsWith('-') && i !== skip);
      // Publish has its OWN exit-4 label: a network/remote failure is a
      // `publish_error`, not the shared codeName(4)='agent_error'. File (2) and
      // usage (1) errors reuse codeName — they mean the same across verbs.
      const emitPublish = (payload) => {
        if (jsonMode) {
          process.stderr.write(JSON.stringify(payload) + '\n');
        } else {
          const parts = [payload.code, payload.subcode].filter(Boolean);
          let line = 'rwa publish: ' + parts.join('/');
          if (payload.details && Object.keys(payload.details).length) {
            line += ' ' + JSON.stringify(payload.details);
          }
          process.stderr.write(line + '\n');
        }
      };
      if (!filePath) {
        emitPublish({ code: 'usage_error', subcode: 'missing_file_arg' });
        process.exitCode = 1;
        return;
      }
      if (urlFlag.present && (urlFlag.value === undefined || urlFlag.value.startsWith('-'))) {
        emitPublish({ code: 'usage_error', subcode: 'missing_flag_value', details: { flag: '--url' } });
        process.exitCode = 1;
        return;
      }
      // Resolution: --url > RWA_PUBLISH_URL > hardcoded default (in publish.mjs).
      const baseUrl = urlFlag.value || process.env.RWA_PUBLISH_URL || undefined;
      const { publishCmd } = await import('../src/publish.mjs');
      let result;
      try {
        result = await publishCmd(filePath, { baseUrl });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          const code = e.exitCode === 4 ? 'publish_error' : codeName(e.exitCode);
          emitPublish({ code, subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(
          '✓ Published!\n' +
          `  URL:     ${result.url}\n` +
          '  Expires: in 24 hours (anonymous share)\n' +
          '  Note:    the hosted copy gets a fresh DOC_UUID (distinct container)\n',
        );
      }
      return;
    }

    // `rwa skill publish <file.rwa-skill.json> [--url base] [--json]` — publish a SIGNED skill
    // envelope to the marketplace index (POST /skills/publish, I6 §11). The envelope is already
    // signed (no key needed). Online by design; exit 4 labeled `publish_error` (like `publish`).
    // `rwa intelligence new <role> --prompt "..." [--description ..] [--model id] [--backend name]
    //  [--affinity kind,kind] [--vault ns,ns] [--out file] [--force]` — I-C (intelligence/0.2 §6):
    // mint a signed rwa-agent/1 role and scaffold a carrier rewritable (private key → sibling file).
    if (verb === 'intelligence') {
      const sub = rest[0];
      if (sub !== 'new') {
        process.stderr.write("rwa intelligence: unknown subcommand '" + (sub || '') + "' (try: rwa intelligence new <role> --prompt \"...\")\n");
        process.exitCode = 1;
        return;
      }
      const subRest = rest.slice(1);
      const valFlags = ['--prompt', '--description', '--model', '--backend', '--affinity', '--vault', '--out'];
      const role = subRest.find((a, i) => !a.startsWith('-') && !valFlags.includes(subRest[i - 1]));
      const g = (n) => getFlag(n, subRest).value;
      const list = (n) => { const v = g(n); return v ? v.split(',').map(s => s.trim()).filter(Boolean) : []; };
      try {
        const { intelligenceNewCmd } = await import('../src/intelligence.mjs');
        await intelligenceNewCmd({
          role, prompt: g('--prompt'), description: g('--description'),
          model: g('--model'), backend: g('--backend'),
          affinity: list('--affinity'), vault: list('--vault'),
          outPath: g('--out'), force: subRest.includes('--force') || subRest.includes('-f'),
        });
      } catch (e) {
        process.stderr.write('rwa intelligence: ' + ((e && e.message) || e) + '\n');
        process.exitCode = (e && e.exitCode) || 1;
      }
      return;
    }

    if (verb === 'skill') {
      const sub = rest[0];
      const subRest = rest.slice(1);
      if (sub !== 'publish') {
        process.stderr.write("rwa skill: unknown subcommand '" + (sub || '') + "' (try: rwa skill publish <file>)\n");
        process.exitCode = 1;
        return;
      }
      const jsonMode = subRest.includes('--json');
      const urlFlag = getFlag('--url', subRest);
      const urlIdx = subRest.indexOf('--url');
      const skip = urlIdx >= 0 ? urlIdx + 1 : -1;
      const filePath = subRest.find((a, i) => !a.startsWith('-') && i !== skip);
      const emitSP = (payload) => {
        if (jsonMode) { process.stderr.write(JSON.stringify(payload) + '\n'); return; }
        const parts = [payload.code, payload.subcode].filter(Boolean);
        let line = 'rwa skill publish: ' + parts.join('/');
        if (payload.details && Object.keys(payload.details).length) line += ' ' + JSON.stringify(payload.details);
        process.stderr.write(line + '\n');
      };
      if (!filePath) { emitSP({ code: 'usage_error', subcode: 'missing_file_arg' }); process.exitCode = 1; return; }
      if (urlFlag.present && (urlFlag.value === undefined || urlFlag.value.startsWith('-'))) {
        emitSP({ code: 'usage_error', subcode: 'missing_flag_value', details: { flag: '--url' } }); process.exitCode = 1; return;
      }
      const baseUrl = urlFlag.value || process.env.RWA_PUBLISH_URL || undefined;
      const { skillPublishCmd } = await import('../src/skill-publish.mjs');
      let result;
      try {
        result = await skillPublishCmd(filePath, { baseUrl });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          const code = e.exitCode === 4 ? 'publish_error' : codeName(e.exitCode);
          emitSP({ code, subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(
          '✓ Published skill to the index!\n' +
          `  skillId:  ${result.skillId}\n` +
          `  URL:      ${result.registryUrl}\n` +
          `  verified: ${result.verified}\n`,
        );
      }
      return;
    }

    // `rwa proxy [--port N] [--allow-origin O]... [--upstream U]` + `rwa proxy set-key`
    // — local OpenRouter key broker; see src/proxy.mjs for the threat notes.
    // Network-bearing by design (offline-first excludes it, like clone/publish-site).
    if (verb === 'proxy') {
      const { startProxy, setKeyCmd, resolveProxyKey, DEFAULT_PORT } = await import('../src/proxy.mjs');
      if (rest[0] === 'set-key') {
        try {
          const r = await setKeyCmd({});
          process.stderr.write(`✓ key stored at ${r.keyFile} (mode 600)\n`);
        } catch (e) {
          process.stderr.write(`rwa proxy set-key: usage_error/${e.subcode || 'failed'}\n`);
          process.exitCode = e.exitCode || 1;
        }
        return;
      }
      const portFlag = getFlag('--port', rest);
      const upstreamFlag = getFlag('--upstream', rest);
      const allowOrigins = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--allow-origin' && rest[i + 1] && !rest[i + 1].startsWith('-')) allowOrigins.push(rest[i + 1]);
      }
      // #36 — `--agent` swaps the upstream: instead of brokering a KEY to a
      // remote API, the proxy answers locally by asking a capability-narrowed
      // `claude -p` and synthesizing tool_calls. No key is needed, and none ever
      // enters the browser. Everything else about the server is identical, which
      // is why the container needs no change to use it.
      if (rest.includes('--agent')) {
        const { createAgentUpstream, spawnClaudeRunner, DEFAULT_MAX_CALLS } = await import('../src/agent-upstream.mjs');
        const modelFlag = getFlag('--model', rest);
        const maxFlag = getFlag('--max-calls', rest);
        const maxCalls = maxFlag.value ? parseInt(maxFlag.value, 10) : DEFAULT_MAX_CALLS;
        if (!Number.isFinite(maxCalls) || maxCalls < 1) {
          process.stderr.write('rwa proxy: usage_error/bad_max_calls — --max-calls must be a positive integer\n');
          process.exitCode = 1;
          return;
        }
        const agent = createAgentUpstream({
          maxCalls,
          model: modelFlag.value || 'claude',
          runAgent: spawnClaudeRunner({ model: modelFlag.value || null }),
          // Every back-delegated call spends the HUMAN's tokens in their own
          // session, so the count is printed, not merely enforced.
          onCall: (e) => process.stderr.write(`[proxy] agent call ${e.call}/${e.maxCalls} → ${e.tool} (${e.ms}ms)\n`),
        });
        const { port: aport } = await startProxy({
          port: portFlag.value ? parseInt(portFlag.value, 10) : DEFAULT_PORT,
          agent,
          allowOrigins,
          allowNullOrigin: !rest.includes('--no-null-origin'),
          log: (line) => process.stderr.write(`[proxy] ${line}\n`),
        });
        process.stderr.write([
          `rwa proxy listening on http://127.0.0.1:${aport}/v1  (agent: local claude, NO api key)`,
          `  container setup (once per tab): ⚙ → Backend "Ollama (localhost)" → Base URL http://127.0.0.1:${aport}/v1 → pick a model (Test lists it)`,
          `  the container gets a multi-turn tool-use backend, so skin --l1 and the compose paths work — which single-shot bridge/bridge-session cannot do`,
          `  budget: ${maxCalls} agent calls for the life of this process (--max-calls)`,
          `  the answering agent runs with NO tools: document content is untrusted, and it must be able to answer without being able to act`,
          `  NOTE: while this runs, any local process or file:// page on this machine can spend your Claude quota through it. Ctrl-C stops it.`,
          '',
        ].join('\n'));
        return; // server keeps the process alive
      }

      const resolved = resolveProxyKey({});
      if (!resolved) {
        process.stderr.write('rwa proxy: usage_error/no_key — run `rwa proxy set-key` or set RWA_OPENROUTER_KEY\n');
        process.exitCode = 1;
        return;
      }
      if (resolved.conflict) {
        process.stderr.write('rwa proxy: WARNING — an environment key is shadowing a DIFFERENT stored key (set-key file). The environment wins; unset the env var if the stored key is the current one.\n');
      }
      // Validate before serving: /models is public, so a dead key looks alive
      // until the first paid call. Skipped only when --upstream points at a
      // custom (test) endpoint that may not implement /auth/key.
      if (!upstreamFlag.value) {
        const { validateKey } = await import('../src/proxy.mjs');
        const v = await validateKey({ key: resolved.key });
        if (!v.ok) {
          process.stderr.write(`rwa proxy: key_error/invalid_key — the ${resolved.source === 'env' ? 'environment' : 'stored'} key failed auth (${v.status}: ${v.message}). ` +
            (resolved.source === 'env' ? 'Your shell profile may carry a stale key — fix it there or unset it and use `rwa proxy set-key`.\n' : 'Re-run `rwa proxy set-key` with a current key.\n'));
          process.exitCode = 1;
          return;
        }
      }
      const { port } = await startProxy({
        port: portFlag.value ? parseInt(portFlag.value, 10) : DEFAULT_PORT,
        key: resolved.key,
        upstream: upstreamFlag.value,
        allowOrigins,
        allowNullOrigin: !rest.includes('--no-null-origin'),
        log: (line) => process.stderr.write(`[proxy] ${line}\n`),
      });
      process.stderr.write([
        `rwa proxy listening on http://127.0.0.1:${port}/v1  (key: ${resolved.source === 'env' ? 'environment' : resolved.source})`,
        `  container setup (once per tab): ⚙ → Backend "Ollama (localhost)" → Base URL http://127.0.0.1:${port}/v1 → pick a model (Test lists the catalog)`,
        `  origins: file:// containers + local tools${allowOrigins.length ? ' + ' + allowOrigins.join(', ') : ''}; other web origins are refused`,
        `  NOTE: while this runs, any local process or file:// page on this machine can spend through it. Ctrl-C stops it.`,
        '',
      ].join('\n'));
      return; // server keeps the process alive
    }

    // `rwa publish-site <file> [--host h] [--path p] [--url base] [--json]` —
    // copy a rewritable VERBATIM onto a static site over scp; print the live URL.
    // Durable counterpart to `rwa publish` (ephemeral share). Online by design.
    // Config: flags > RWA_SITE_HOST / RWA_SITE_PATH / RWA_SITE_URL. See
    // src/publish-site.mjs. Exit 4 is labeled `publish_error` (like `publish`).
    if (verb === 'publish-site') {
      const jsonMode = rest.includes('--json');
      const hostFlag = getFlag('--host', rest);
      const pathFlag = getFlag('--path', rest);
      const urlFlag = getFlag('--url', rest);
      // Flag VALUE tokens must not be mistaken for the positional file.
      const skip = new Set();
      for (const f of ['--host', '--path', '--url']) {
        const i = rest.indexOf(f); if (i >= 0) skip.add(i + 1);
      }
      const filePath = rest.find((a, i) => !a.startsWith('-') && !skip.has(i));
      const emitPS = (payload) => {
        if (jsonMode) { process.stderr.write(JSON.stringify(payload) + '\n'); return; }
        const parts = [payload.code, payload.subcode].filter(Boolean);
        let line = 'rwa publish-site: ' + parts.join('/');
        if (payload.details && Object.keys(payload.details).length) line += ' ' + JSON.stringify(payload.details);
        process.stderr.write(line + '\n');
      };
      if (!filePath) { emitPS({ code: 'usage_error', subcode: 'missing_file_arg' }); process.exitCode = 1; return; }
      for (const [name, flag] of [['--host', hostFlag], ['--path', pathFlag], ['--url', urlFlag]]) {
        if (flag.present && (flag.value === undefined || flag.value.startsWith('-'))) {
          emitPS({ code: 'usage_error', subcode: 'missing_flag_value', details: { flag: name } });
          process.exitCode = 1; return;
        }
      }
      const { publishSite } = await import('../src/publish-site.mjs');
      let result;
      try {
        result = await publishSite(filePath, { host: hostFlag.value, path: pathFlag.value, url: urlFlag.value });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          const code = e.exitCode === 4 ? 'publish_error' : codeName(e.exitCode);
          emitPS({ code, subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode; return;
        }
        throw e;
      }
      if (jsonMode) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(`✓ Published to ${result.url}\n`);
      return;
    }

    // `rwa host <file> [--url <base>] [--json]` — ingest a local rewritable into
    // a hosted runtime's `POST /r` and print the `{id, token, url}` it mints. The
    // network-bearing INGEST client (the round-trip-edit foundation), the way
    // `rwa publish` is the ephemeral-share client. Online by design (offline-first
    // excludes it, like clone/publish-site). Config: --url > $RWA_HOST_URL. See
    // src/host.mjs. Exit 4 is labeled `host_error` (like publish's `publish_error`).
    if (verb === 'host') {
      const jsonMode = rest.includes('--json');
      // `--url` takes a value, so its value token must NOT be mistaken for the
      // positional file. Skip the index right after `--url`.
      const urlFlag = getFlag('--url', rest);
      const urlIdx = rest.indexOf('--url');
      const skip = urlIdx >= 0 ? urlIdx + 1 : -1;
      const filePath = rest.find((a, i) => !a.startsWith('-') && i !== skip);
      // Host has its OWN exit-4 label: a transport/HTTP failure is a `host_error`,
      // not the shared codeName(4)='agent_error'. File (2) and usage (1) errors
      // reuse codeName — they mean the same across verbs.
      const emitHost = (payload) => {
        if (jsonMode) { process.stderr.write(JSON.stringify(payload) + '\n'); return; }
        const parts = [payload.code, payload.subcode].filter(Boolean);
        let line = 'rwa host: ' + parts.join('/');
        if (payload.details && Object.keys(payload.details).length) line += ' ' + JSON.stringify(payload.details);
        process.stderr.write(line + '\n');
      };
      if (!filePath) {
        emitHost({ code: 'usage_error', subcode: 'missing_file_arg' });
        process.exitCode = 1;
        return;
      }
      if (urlFlag.present && (urlFlag.value === undefined || urlFlag.value.startsWith('-'))) {
        emitHost({ code: 'usage_error', subcode: 'missing_flag_value', details: { flag: '--url' } });
        process.exitCode = 1;
        return;
      }
      const { hostFile } = await import('../src/host.mjs');
      let result;
      try {
        result = await hostFile(filePath, { url: urlFlag.value });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          // config_error is usage-class (exit 1) → render under usage_error, like
          // publish-site's config_error. Only the exit-4 transport class becomes
          // `host_error`.
          const code = e.exitCode === 4 ? 'host_error' : codeName(e.exitCode);
          emitHost({ code, subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(
          '✓ Hosted!\n' +
          `  id:    ${result.id}\n` +
          `  token: ${result.token}\n` +
          `  url:   ${result.url}\n` +
          '  Note:  the url carries your capability token in its #k= fragment — keep it to keep editing.\n',
        );
      }
      return;
    }

    // `rwa install <skill.rwa-skill.json> <skill-host.html> [--yes|--trust] [--json]` (v0.9 §3 / I11).
    // The offline, headless counterpart of the seed's install dialog: verify the Ed25519
    // signature, run the SAME gates (unsigned-capability / compute-with-perms / permission
    // grammar / dynamic-import reject), then splice the envelope into the frozen #rwa-skills
    // zone and write atomically. No dialog to consent in → an explicit --yes/--trust is
    // required, and gate failures (exit 3) are FINAL — --yes cannot override them. Exit codes:
    // 1 usage, 2 file, 3 envelope/gate (reuses codeName — no verb-specific exit-4 class). See
    // src/install.mjs. The CLI is the sole audited exception to runtime-sole-writer (Inv 39).
    if (verb === 'install') {
      const jsonMode = rest.includes('--json');
      const consent = rest.includes('--yes') || rest.includes('--trust');
      const [envPath, hostPath] = rest.filter((a) => !a.startsWith('-'));
      const emitInstall = (payload) => {
        if (jsonMode) { process.stderr.write(JSON.stringify(payload) + '\n'); return; }
        const parts = [payload.code, payload.subcode].filter(Boolean);
        let line = 'rwa install: ' + parts.join('/');
        if (payload.details && Object.keys(payload.details).length) line += ' ' + JSON.stringify(payload.details);
        process.stderr.write(line + '\n');
      };
      if (!envPath || !hostPath) {
        emitInstall({ code: 'usage_error', subcode: 'missing_file_args', details: { usage: 'rwa install <skill.rwa-skill.json> <skill-host.html> [--yes] [--json]' } });
        process.exitCode = 1;
        return;
      }
      const { installSkillFile } = await import('../src/install.mjs');
      let result;
      try {
        result = await installSkillFile(envPath, hostPath, { consent });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          emitInstall({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      // Non-blocking lookalike warning (spec §3 / Inv 23) → always to stderr; --json also
      // carries result.lookalike in the stdout object. The install already succeeded.
      if (result.lookalike) {
        process.stderr.write('⚠ rwa install: the name "' + result.name + '" closely matches "' + result.lookalike + '", installed from a DIFFERENT key. The author is identified by the key, not the name — review before trusting.\n');
      }
      // I5 — same-key rename heads-up (non-blocking, registry-derived). This author published other
      // names in this host; surfaced so a rename reads as continuity, not a new author.
      if (Array.isArray(result.priorNames) && result.priorNames.length) {
        process.stderr.write('note: rwa install: this author (same key) previously published: ' + result.priorNames.join(', ') + '. The current name is "' + result.name + '" — identity is the key, not the name.\n');
      }
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        const label = result.status === 'updated' ? 'Updated' : result.status === 'already_installed' ? 'Already installed' : 'Installed';
        process.stdout.write(
          '✓ ' + label + ' ' + result.name + ' (' + result.kind + ', ' + (result.verified ? 'verified' : 'UNVERIFIED') + ')\n' +
          '  skillId: ' + result.skillId + '\n' +
          (result.update && result.update.added.length ? '  + added: ' + result.update.added.join(', ') + '\n' : '') +
          (result.update && result.update.removed.length ? '  − removed: ' + result.update.removed.join(', ') + '\n' : ''),
        );
      }
      return;
    }

    // `rwa skin <file> <name|reset> [--l1] [--theme-only] [--json]`.
    //
    // DEFAULT (no --l1): deterministic, model-free theme swap. Applies a preset's
    // <style data-rwa-skin> block in place: first skin INSERTS via replace_document
    // (adding a <style> changes the structural shape), re-skin SWAPS via apply_edits,
    // reset removes it (deskinDoc — clears wrappers too) — all routed through the
    // same applyPlan write path as `rwa edit` for atomic write + frozen-zone safety
    // + the shared file_error surface. Offline, no key.
    //
    // --l1 (opt-in): the always-on content-aware restyle. De-skin the doc, drive
    // the agent over a multi-turn backend with the preset recipe to add additive
    // sk-* class hooks + wrappers (NO write yet), splice the theme block onto the
    // agent's output, then commit ONCE (theme + wrappers together). Agent
    // decline/invalid-edit degrades to a theme-only commit (the skin always
    // lands); a missing/unreachable backend fails LOUD (exit 4) like `rwa edit`.
    // Mirrors seeds/rewritable.html applySkinL1 (docs/plans/2026-06-03-skinning-design.md).
    if (verb === 'skin') {
      const jsonMode = rest.includes('--json');
      const themeOnly = rest.includes('--theme-only');
      const l1 = rest.includes('--l1');
      // Drop the flags that take a following value from the positional scan so a
      // `rwa skin doc.html notion-clean --l1 --model foo` doesn't read `foo` as
      // a positional. Mirrors the edit path's flag-aware positional handling.
      const SKIN_FLAG_WITH_VALUE = new Set(['--backend', '--model', '--base-url', '--api-key']);
      const positionals = rest.filter((a, i) => !a.startsWith('-') && !SKIN_FLAG_WITH_VALUE.has(rest[i - 1]));
      const filePath = positionals[0];
      const action = positionals[1];
      const emitSkin = (payload) => {
        if (jsonMode) {
          process.stderr.write(JSON.stringify(payload) + '\n');
        } else {
          const parts = [payload.code, payload.subcode].filter(Boolean);
          let line = 'rwa skin: ' + parts.join('/');
          if (payload.details && Object.keys(payload.details).length) {
            line += ' ' + JSON.stringify(payload.details);
          }
          process.stderr.write(line + '\n');
        }
      };
      if (!filePath || !action) {
        emitSkin({ code: 'usage_error', subcode: 'missing_args', details: { usage: 'rwa skin <file> <name|reset> [--l1] [--theme-only]' } });
        process.exitCode = 1;
        return;
      }

      // ── L1 path: agent-driven restyle. `reset` is deterministic — never L1. ──
      if (l1 && action !== 'reset') {
        // Resolve backend config exactly like `rwa edit`'s instruction path so
        // --l1 inherits the same flags / env / default chain and the same
        // missing-backend behavior (openrouter with no key → exit 4).
        const backendFlag  = resolveFlag(getFlag('--backend',  rest), '--backend',  jsonMode);
        if (!backendFlag.ok)  { process.exitCode = 1; return; }
        const modelFlag    = resolveFlag(getFlag('--model',    rest), '--model',    jsonMode);
        if (!modelFlag.ok)    { process.exitCode = 1; return; }
        const baseUrlFlag  = resolveFlag(getFlag('--base-url', rest), '--base-url', jsonMode);
        if (!baseUrlFlag.ok)  { process.exitCode = 1; return; }
        const apiKeyFlag   = resolveFlag(getFlag('--api-key',  rest), '--api-key',  jsonMode);
        if (!apiKeyFlag.ok)   { process.exitCode = 1; return; }

        const backendName = backendFlag.value || process.env.RWA_BACKEND || 'openrouter';
        const modelId     = modelFlag.value   || process.env.RWA_MODEL   || 'google/gemini-3.5-flash';
        const baseUrl     = baseUrlFlag.value || envBaseUrl(backendName);
        const apiKey      = resolveApiKey(backendName, apiKeyFlag.value);

        if (!['openrouter', 'ollama', 'lmstudio', 'atomic'].includes(backendName)) {
          emitSkin({ code: 'usage_error', subcode: 'unknown_backend', details: { backend: backendName } });
          process.exitCode = 1; return;
        }
        if (backendName === 'openrouter' && !apiKey) {
          emitSkin({ code: 'agent_error', subcode: 'no_api_key', details: { backend: 'openrouter' } });
          process.exitCode = 4; return;
        }

        // Read the target to pick the right SYSTEM_PROMPTS entry by product kind
        // (file errors surface as file_error/exit 2, same as skinCmd / edit).
        const { readFile } = await import('node:fs/promises');
        let fileText;
        try {
          fileText = await readFile(filePath, 'utf8');
        } catch (e) {
          if (e && e.code === 'ENOENT') { emitSkin({ code: 'file_error', subcode: 'not_found', details: { path: filePath } }); process.exitCode = 2; return; }
          emitSkin({ code: 'file_error', subcode: 'read_error', details: { path: filePath, errno: e && e.code, message: e && e.message } });
          process.exitCode = 2; return;
        }
        const productKind = detectProductKind(fileText) || 'document';

        // Load SYSTEM_PROMPTS / TOOL_SCHEMAS from the seed — same in-package-first
        // lookup `rwa edit` uses.
        const { loadSeed } = await import('../src/seed.mjs');
        const { SEED_CANDIDATES: SC } = await import('../src/commands.mjs');
        const seedText = await loadSeed(SC);
        const { extractFromSeed } = await import('../src/seed-extract.mjs');
        const { SYSTEM_PROMPTS, TOOL_SCHEMAS } = extractFromSeed(seedText);
        const systemPrompt = SYSTEM_PROMPTS[productKind] || SYSTEM_PROMPTS.document;

        const { skinCmdL1 } = await import('../src/skin.mjs');
        let result;
        try {
          result = await skinCmdL1(filePath, action, {
            systemPrompt,
            toolSchemas: TOOL_SCHEMAS,
            backend: { baseUrl, model: modelId, apiKey, maxTokens: backendMaxTokens(backendName) },
            onRetry: r => {
              if (jsonMode) process.stderr.write(JSON.stringify({ phase: 'retry', attempt: r.attempt, reason: r.reason }) + '\n');
              else process.stderr.write(`rwa skin: attempt ${r.attempt}/3 retrying — ${r.reason}\n`);
            },
          });
        } catch (e) {
          if (e && typeof e.exitCode === 'number') {
            if (!jsonMode && e.subcode === 'unknown_skin') process.stderr.write('rwa skin: ' + e.message + '\n');
            else emitSkin({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details });
            process.exitCode = e.exitCode;
            return;
          }
          throw e;
        }
        if (jsonMode) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else if (result.degraded) {
          process.stdout.write(`✓ skin "${result.skin}" applied (theme-only)\n`);
          process.stderr.write('note: the model did not contribute a usable restyle — applied the deterministic theme only.\n');
        } else {
          process.stdout.write(`✓ skin "${result.skin}" applied (theme + content-aware restyle)\n`);
        }
        return;
      }

      const { skinCmd } = await import('../src/skin.mjs');
      let result;
      try {
        result = await skinCmd(filePath, action);
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          // unknown_skin carries a known-list message; surface it verbatim in
          // plain mode so the user sees their options (mirrors unknown --kind).
          if (!jsonMode && e.subcode === 'unknown_skin') {
            process.stderr.write('rwa skin: ' + e.message + '\n');
          } else {
            emitSkin({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details });
          }
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else if (result.mode === 'noop') {
        process.stdout.write(`note: ${filePath} has no skin — nothing to reset\n`);
      } else if (result.mode === 'reset') {
        process.stdout.write(`✓ skin removed from ${filePath}\n`);
      } else {
        const word = result.mode === 'insert' ? 'applied' : 'changed to';
        process.stdout.write(`✓ skin ${word} "${result.skin}" (theme-only)\n`);
        // Not a silent downgrade (Rule 12): tell the user this is the
        // deterministic theme only. --theme-only signals "I know"; --l1 opts
        // into the content-aware restyle. Either silences the note.
        if (!themeOnly) {
          process.stderr.write('note: applied the deterministic theme only — pass --l1 for the content-aware restyle, or --theme-only to silence this note.\n');
        }
      }
      return;
    }

    // `rwa clone <url> [path] [--force]` — fetch a public webpage and write it
    // as a self-contained rewritable. Unlike every other verb this REQUIRES the
    // network (it fetches). The fetch layer is SSRF-guarded (src/fetch-page.mjs);
    // all of its failures plus the destination-exists check surface as a
    // CloneError carrying a numeric exitCode (2 = file/fetch class) + subcode.
    // We mirror `emitEdit`'s plain stderr format ("rwa clone: <codeName>/<subcode>
    // <details?>") so the failure surface is consistent with `rwa edit`.
    if (verb === 'clone') {
      const force = rest.includes('--force') || rest.includes('-f');
      const localizeImages = rest.includes('--localize-images');
      const positionals = rest.filter(a => !a.startsWith('-'));
      const url = positionals[0];
      const outPath = positionals[1];
      const emitClone = (payload) => {
        const parts = [payload.code, payload.subcode].filter(Boolean);
        let line = 'rwa clone: ' + parts.join('/');
        if (payload.details && Object.keys(payload.details).length) {
          line += ' ' + JSON.stringify(payload.details);
        }
        process.stderr.write(line + '\n');
      };
      if (!url) {
        emitClone({ code: 'usage_error', subcode: 'missing_url_arg' });
        process.exitCode = 1;
        return;
      }
      const { cloneCmd } = await import('../src/clone.mjs');
      try {
        await cloneCmd({ url, outPath, force, localizeImages });
      } catch (e) {
        if (e && typeof e.exitCode === 'number') {
          emitClone({ code: codeName(e.exitCode), subcode: e.subcode, details: e.details });
          process.exitCode = e.exitCode;
          return;
        }
        throw e;
      }
      return;
    }

    // `rwa create <task…>` / `rwa draft <task…>` (design 2026-05-31 §4): scaffold
    // + agent-fill a self-contained rewritable in one shot. Its own flag grammar
    // (parseCreateArgs), so it returns before the new/import positional handling.
    if (verb === 'create' || verb === 'draft') {
      const parsed = parseCreateArgs(rest);
      if (!parsed.words.length && !parsed.from && !parsed.kind) {
        console.error('rwa create: missing <task> (e.g. "rwa create a presentation about Q3")');
        process.exitCode = 2;
        return;
      }
      // --data - reads stdin (design §4.3); drain it here so createCmd stays IO-pure
      // about its data source.
      let stdinData;
      if (parsed.data === '-') stdinData = await readStdin();
      try {
        const { out, kind: rk, fromMsg } = await createCmd(parsed, { seedCandidates: SEED_CANDIDATES, cwd: process.cwd(), stdinData });
        const kindMsg = rk !== 'document' ? ` (kind: ${rk})` : '';
        console.log(`wrote ${relative(process.cwd(), out) || out}${fromMsg || kindMsg}`);
        if (parsed.open) await openWithPrefill(out);
      } catch (e) {
        const label = [e && e.subcode].filter(Boolean).join('/') || (e && e.message) || String(e);
        const details = e && e.details && Object.keys(e.details).length ? ' ' + JSON.stringify(e.details) : '';
        console.error('rwa create: ' + label + details);
        process.exitCode = (e && e.exitCode) || 1;
      }
      return;
    }

    const force = rest.includes('--force') || rest.includes('-f');
    const open = rest.includes('--open') || rest.includes('-o');
    const vision = rest.includes('--vision');
    const claude = rest.includes('--claude');
    const trustInput = rest.includes('--trust-input');
    // Import fidelity loop (PDF): measure the deterministic import + auto-escalate to --vision when
    // low AND a model is reachable. --no-escalate opts out; --target-fidelity <0..1> sets the bar.
    const escalate = !rest.includes('--no-escalate');
    const tfIdx = rest.indexOf('--target-fidelity');
    const targetFidelity = tfIdx >= 0 ? Number(rest[tfIdx + 1]) : undefined;
    if (tfIdx >= 0 && (!Number.isFinite(targetFidelity) || targetFidelity < 0 || targetFidelity > 1)) {
      console.error('rwa import: --target-fidelity must be a number between 0 and 1');
      process.exitCode = 2;
      return;
    }
    // --model and --timeout take a value: find the index, then take the next arg.
    const modelIdx = rest.indexOf('--model');
    const model = modelIdx >= 0 ? rest[modelIdx + 1] : undefined;
    const timeoutIdx = rest.indexOf('--timeout');
    const timeoutSec = timeoutIdx >= 0 ? Number(rest[timeoutIdx + 1]) : undefined;
    if (timeoutIdx >= 0 && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
      console.error(`rwa: --timeout requires a positive number of seconds (got "${rest[timeoutIdx + 1]}")`);
      process.exitCode = 2;
      return;
    }
    const kindIdx = rest.indexOf('--kind');
    const kind = kindIdx >= 0 ? rest[kindIdx + 1] : undefined;
    if (kindIdx >= 0 && (!kind || kind.startsWith('-'))) {
      console.error('rwa: --kind requires a name (e.g. --kind workflow)');
      process.exitCode = 2;
      return;
    }
    if (kind && !KNOWN_KINDS.includes(kind)) {
      console.error(`rwa: unknown --kind "${kind}". Known: ${KNOWN_KINDS.join(', ')}.`);
      process.exitCode = 2;
      return;
    }
    // `rwa new --skin <name>` bakes a preset's <style data-rwa-skin> block into
    // the emitted container (deterministic, offline). Orthogonal to --kind. An
    // unknown name is caught by newCmd (skinByName throws exit-2 with the list).
    const skinIdx = rest.indexOf('--skin');
    const skinName = skinIdx >= 0 ? rest[skinIdx + 1] : undefined;
    if (skinIdx >= 0 && (!skinName || skinName.startsWith('-'))) {
      console.error('rwa: --skin requires a name (e.g. --skin notion-clean)');
      process.exitCode = 2;
      return;
    }
    const positional = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '--model' && rest[i - 1] !== '--timeout' && rest[i - 1] !== '--kind' && rest[i - 1] !== '--skin' && rest[i - 1] !== '--target-fidelity');
    if (verb === 'new') {
      // `rwa new --kind <starter>` selects a built-in starter. Otherwise a bare-word
      // first positional is a TEMPLATE name (clone a data-rwa-template-labeled file
      // from cwd); a .html / path-bearing first positional is the output path.
      let templateName, outPath;
      if (!kind && positional[0] && !/\.html?$/i.test(positional[0]) && !/[\\/]/.test(positional[0])) {
        templateName = positional[0];
        outPath = positional[1];
      } else {
        outPath = positional[0];
      }
      await newCmd({ outPath, force, open, kind, templateName, skin: skinName });
    } else if (verb === 'import') {
      if (!positional[0]) {
        console.error('rwa import: missing <input> argument');
        process.exitCode = 2;
        return;
      }
      await importCmd({ inputPath: positional[0], outPath: positional[1], force, open, vision, claude, trustInput, model, timeoutSec, escalate, targetFidelity });
    } else {
      console.error(`rwa: unknown verb "${verb}". Try --help.`);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('rwa: ' + (e && e.message || e));
    process.exitCode = (e && e.exitCode) || 1;
  }
})();
