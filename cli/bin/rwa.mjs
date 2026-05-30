#!/usr/bin/env node
import { newCmd, importCmd, version, KNOWN_KINDS } from '../src/commands.mjs';

const HELP = `rwa — single-file re-writeable documents

Usage:
  rwa new [path]              create a fresh rwa document
                              (default: ./rewritable.html, --kind=document)
  rwa import <input> [path]   convert a md/html/txt file into an rwa document
                              (default: <input-basename>.html, in input's dir)
  rwa edit <path> [...]       apply a tool-envelope or instruction to a
                              rewritable in place. Plan path: pipe an
                              apply_edits / apply_dsl_plan / replace_document
                              envelope on stdin, or pass --plan <file>.
                              Instruction path: pass a plain-text instruction
                              as the second positional and the CLI runs the
                              agent loop (backend-configurable below).

Flags:
  --kind <name>  (new only) starter kind: document (default), workflow, or
                 presentation. 'document' is the canonical prose container.
                 'workflow' scaffolds three stages (Inbox / In progress /
                 Done). 'presentation' scaffolds a prose deck that the
                 'Present' toggle displays as slides (split on h1/h2) without
                 changing the stored text. See docs/specs/rwa-product-types.md.
  --force, -f    overwrite the destination if it exists
  --open, -o     open the resulting file in the default app. First-paint
                 sessionStorage is pre-populated from env / ./.env:
                   OPENROUTER_API_KEY → ?key=…    (lifted into rwa_apikey)
                   RWA_BACKEND        → ?backend= (openrouter|ollama|lmstudio|bridge)
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
  --json         (edit only) emit one JSON object per line on stderr for
                 structured failure reporting. Each line is a single
                 \`{code, subcode, details}\` object.
  --backend <n>  (edit only, instruction path) backend name. One of:
                 openrouter (default), ollama, lmstudio. Falls back to
                 \$RWA_BACKEND if unset.
  --model <id>   (edit only, instruction path) model id passed to the
                 backend. Falls back to \$RWA_MODEL, then a
                 sensible default for the backend.
  --base-url <u> (edit only, instruction path) override the OpenAI-
                 compatible base URL. Defaults: openrouter →
                 https://openrouter.ai/api/v1, ollama →
                 http://localhost:11434/v1 (or \$RWA_OLLAMA_URL),
                 lmstudio → http://localhost:1234/v1 (or
                 \$RWA_LMSTUDIO_URL).
  --api-key <k>  (edit only, instruction path) API key for the backend.
                 Openrouter: required, falls back to
                 \$RWA_OPENROUTER_KEY. Other backends ignore this flag.
  --version      print version and exit
  --help, -h     this help

Supported import formats: .md, .markdown, .html, .htm, .csv, .txt, .docx, .pdf
`;

const args = process.argv.slice(2);
const verb = args[0];

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
    default:           return undefined;
  }
}

// Only openrouter requires a key — ollama and lmstudio run locally without
// auth. Pull from RWA_OPENROUTER_KEY (env conventions match the docker-
// compose deploy in service/).
function envApiKey(name) {
  switch (name) {
    case 'openrouter': return process.env.RWA_OPENROUTER_KEY;
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
      // Backend flags carry a value — keep them out of `positionals` so
      // their argument doesn't get parsed as a stray instruction word.
      const FLAG_WITH_VALUE = new Set(['--plan', '--backend', '--model', '--base-url', '--api-key']);
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
        const apiKey      = apiKeyFlag.value  || envApiKey(backendName);

        // Reject unknown backends fast. `bridge` is browser-only by design
        // (single-shot via web_cli_bridge); the CLI has no equivalent.
        if (!['openrouter', 'ollama', 'lmstudio'].includes(backendName)) {
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
        const { findFrozenZones } = await import('../src/apply-edits.mjs');
        const frozenZoneNames = findFrozenZones(currentDoc).map(z => z.name);

        // Run the agent loop. Retry telemetry goes to stderr (plain or
        // JSON depending on mode) so CI / wrapper scripts can observe
        // progress without parsing stdout.
        const { runAgentLoop } = await import('../src/agent-loop.mjs');
        let envelope;
        try {
          const result = await runAgentLoop({
            systemPrompt,
            toolSchemas: TOOL_SCHEMAS,
            currentDoc,
            instruction,
            frozenZoneNames,
            backend: { baseUrl, model: modelId, apiKey },
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
        // path — single splice/write code path, single error surface.
        const { applyPlan } = await import('../src/edit.mjs');
        try {
          await applyPlan(filePath, envelope);
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
        await applyPlan(filePath, envelope);
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

    const force = rest.includes('--force') || rest.includes('-f');
    const open = rest.includes('--open') || rest.includes('-o');
    const vision = rest.includes('--vision');
    const claude = rest.includes('--claude');
    const trustInput = rest.includes('--trust-input');
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
    const positional = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '--model' && rest[i - 1] !== '--timeout' && rest[i - 1] !== '--kind');
    if (verb === 'new') {
      await newCmd({ outPath: positional[0], force, open, kind });
    } else if (verb === 'import') {
      if (!positional[0]) {
        console.error('rwa import: missing <input> argument');
        process.exitCode = 2;
        return;
      }
      await importCmd({ inputPath: positional[0], outPath: positional[1], force, open, vision, claude, trustInput, model, timeoutSec });
    } else {
      console.error(`rwa: unknown verb "${verb}". Try --help.`);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('rwa: ' + (e && e.message || e));
    process.exitCode = (e && e.exitCode) || 1;
  }
})();
