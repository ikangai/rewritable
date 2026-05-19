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
                              Instruction path (Tasks 6/7) is TODO.

Flags:
  --kind <name>  (new only) starter kind: document (default) or workflow.
                 'document' is the canonical prose container — substrate
                 layer. 'workflow' scaffolds three stages (Inbox / In
                 progress / Done) and swaps the lens placeholder for the
                 workflow framing. See docs/specs/rwa-product-types.md.
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
                 changes). Requires the \`claude\` CLI installed and runs
                 with --permission-mode bypassPermissions; only use on
                 files you trust.
  --model <id>   (with --vision) override the OpenRouter model id.
                 Default: google/gemini-3-flash-preview.
  --timeout <s>  (with --claude) wall-clock cap for the subprocess in
                 seconds. Default: 1200 (20 minutes). Long academic
                 papers may need more.
  --plan <file>  (edit only) read the tool-envelope from <file> instead of
                 stdin. Use \`--plan -\` to force stdin even when stdin is
                 not a pipe.
  --json         (edit only) emit one JSON object per line on stderr for
                 structured failure reporting. Each line is a single
                 \`{code, subcode, details}\` object.
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
function codeName(n) {
  if (n === 1) return 'usage_error';
  if (n === 2) return 'file_error';
  if (n === 3) return 'envelope_error';
  if (n === 4) return 'agent_error';
  return 'unknown_error';
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
      // Reserve Task 7's backend flags so their values don't leak into
      // `positionals` as bogus instructions. We don't act on them yet.
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

      let stdinBuf = '';
      let stdinHasContent = false;
      if (!hasPlanFile) {
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

      // Instruction path: deferred to Task 7 (agent loop + backends).
      if (hasPositionalInstruction) {
        emitEdit({ code: 'usage_error', subcode: 'not_yet_implemented', details: { mode: 'instruction' } }, jsonMode);
        process.exitCode = 1;
        return;
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
      await importCmd({ inputPath: positional[0], outPath: positional[1], force, open, vision, claude, model, timeoutSec });
    } else {
      console.error(`rwa: unknown verb "${verb}". Try --help.`);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('rwa: ' + (e && e.message || e));
    process.exitCode = (e && e.exitCode) || 1;
  }
})();
