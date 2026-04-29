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
  --version      print version and exit
  --help, -h     this help

Supported import formats: .md, .markdown, .html, .htm, .txt
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
    const positional = rest.filter(a => !a.startsWith('-'));
    if (verb === 'new') {
      await newCmd({ outPath: positional[0], force });
    } else if (verb === 'import') {
      if (!positional[0]) {
        console.error('rwa import: missing <input> argument');
        process.exitCode = 2;
        return;
      }
      await importCmd({ inputPath: positional[0], outPath: positional[1], force });
    } else {
      console.error(`rwa: unknown verb "${verb}". Try --help.`);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('rwa: ' + (e && e.message || e));
    process.exitCode = (e && e.exitCode) || 1;
  }
})();
