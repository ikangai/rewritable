#!/usr/bin/env node
import { newCmd, importCmd, version } from '../src/commands.mjs';

const HELP = `rwa — single-file re-writeable documents

Usage:
  rwa new [path]              create a fresh rwa document
                              (default: ./rewritable.html)
  rwa import <input> [path]   convert a md/html/txt file into an rwa document
                              (default: <input-basename>.html, in input's dir)

Flags:
  --force, -f    overwrite the destination if it exists
  --open, -o     open the resulting file in the default app
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
  --version      print version and exit
  --help, -h     this help

Supported import formats: .md, .markdown, .html, .htm, .csv, .txt, .docx, .pdf
`;

const args = process.argv.slice(2);
const verb = args[0];

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
    const force = rest.includes('--force') || rest.includes('-f');
    const open = rest.includes('--open') || rest.includes('-o');
    const vision = rest.includes('--vision');
    const claude = rest.includes('--claude');
    // --model takes a value: find the index, then take the next arg.
    const modelIdx = rest.indexOf('--model');
    const model = modelIdx >= 0 ? rest[modelIdx + 1] : undefined;
    const positional = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '--model');
    if (verb === 'new') {
      await newCmd({ outPath: positional[0], force, open });
    } else if (verb === 'import') {
      if (!positional[0]) {
        console.error('rwa import: missing <input> argument');
        process.exitCode = 2;
        return;
      }
      await importCmd({ inputPath: positional[0], outPath: positional[1], force, open, vision, claude, model });
    } else {
      console.error(`rwa: unknown verb "${verb}". Try --help.`);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('rwa: ' + (e && e.message || e));
    process.exitCode = (e && e.exitCode) || 1;
  }
})();
