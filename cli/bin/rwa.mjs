#!/usr/bin/env node
import { newCmd, importCmd, version, KNOWN_KINDS, openWithPrefill, SEED_CANDIDATES } from '../src/commands.mjs';
import { resolveApiKey } from '../src/backend.mjs';
import { parseCreateArgs, createCmd } from '../src/create.mjs';
import { relative } from 'node:path';

const HELP = `rwa — single-file re-writeable documents

Usage:
  rwa new [path]              create a fresh rwa document
                              (default: ./rewritable.html, --kind=document)
  rwa new <name> [path]       a bare <name> resolves template-first: clone a cwd
                              file labeled data-rwa-template="<name>" (fresh UUID,
                              label stripped) if one exists; else, if <name> is a
                              known kind (document/workflow/presentation/skill-host), create
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
  rwa doc <path>              print the editable document body (the exact
                              LF-canonical text the edit contract operates on).
                              The read counterpart to \`rwa edit\`. With --json,
                              print the self-description/1 superset instead —
                              the edit contract plus "what is this, what can be
                              done with it": {rwa, kind, title, affordances,
                              baseline, frozenZones, …, doc}.
                              Exit 2 on a non-rewritable file — a clean
                              "is this a rewritable?" probe.
  rwa ls [paths...]           list the rewritables in a folder (or file list;
                              default: ./), one line each: kind · title ·
                              affordances. The "what are all these?" counterpart
                              to \`rwa doc\`. Non-rewritables are counted, not
                              hidden. With --json, an array of self-description
                              rows. Lenient: a completed scan exits 0.
  rwa publish <path>          publish a local rewritable to the share service
                              and print the hosted URL. POSTs your edited bytes;
                              the hosted snapshot is anonymous, 24h, with a fresh
                              DOC_UUID. Target: --url > \$RWA_PUBLISH_URL >
                              https://rewritable.ikangai.com. --json emits
                              {short,url,expiresAt}.
  rwa publish-site <path>     scp a rewritable to a static site (needs RWA_SITE_* env)
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
                 presentation, or skill-host. 'document' is the canonical prose
                 container. 'workflow' scaffolds three stages (Inbox / In
                 progress / Done). 'presentation' scaffolds a prose deck that the
                 'Present' toggle displays as slides (split on h1/h2) without
                 changing the stored text. 'skill-host' hosts permission-gated
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
  --json         (edit) emit one JSON object per line on stderr for
                 structured failure reporting — each line a single
                 \`{code, subcode, details}\` object.
                 (doc) emit the editing-contract object on stdout instead of
                 the raw body; on failure, the \`{code, subcode, details}\`
                 object goes to stderr.
  --backend <n>  (edit instruction path / skin --l1) backend name. One of:
                 openrouter (default), ollama, lmstudio. Falls back to
                 \$RWA_BACKEND if unset.
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
        const apiKey      = resolveApiKey(backendName, apiKeyFlag.value);

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

    // `rwa doc <path> [--json]` — the READ counterpart to `rwa edit`. Prints
    // the LF-canonical editable body (plain mode) or the full editing contract
    // (--json). stdout is reserved for the document/contract so pipes stay
    // clean; errors go to stderr, mirroring `rwa edit`'s file_error surface.
    if (verb === 'doc') {
      const jsonMode = rest.includes('--json');
      const filePath = rest.find(a => !a.startsWith('-'));
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
      const { inspectDoc } = await import('../src/doc.mjs');
      let info;
      try {
        info = await inspectDoc(filePath);
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

        if (!['openrouter', 'ollama', 'lmstudio'].includes(backendName)) {
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
            backend: { baseUrl, model: modelId, apiKey },
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
        await cloneCmd({ url, outPath, force });
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
    const positional = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '--model' && rest[i - 1] !== '--timeout' && rest[i - 1] !== '--kind' && rest[i - 1] !== '--skin');
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
