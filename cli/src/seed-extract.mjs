const EXTRACT_BEGIN = (name) => `// rwa:extract:begin ${name}`;
const EXTRACT_END = (name) => `// rwa:extract:end ${name}`;

function extractBlock(seedText, name) {
  const begin = EXTRACT_BEGIN(name);
  const end = EXTRACT_END(name);
  const startIdx = seedText.indexOf(begin);
  if (startIdx === -1) throw new Error(`seed-extract: missing begin marker for ${name}`);
  const endIdx = seedText.indexOf(end, startIdx);
  if (endIdx === -1) throw new Error(`seed-extract: missing end marker for ${name}`);
  return seedText.slice(startIdx + begin.length, endIdx);
}

function evalConstBlock(block, name, deps = {}) {
  // Block contains: `\nconst NAME = { ... };\n`
  // Evaluate in an isolated function scope. `deps` lets us inject upstream
  // consts (e.g. SYSTEM_PROMPTS references SYSTEM_PROMPT_RULES via template
  // interpolation). Block must otherwise reference only built-ins.
  const depNames = Object.keys(deps);
  const depValues = depNames.map(k => deps[k]);
  const fn = new Function(...depNames, `${block}\nreturn ${name};`);
  return fn(...depValues);
}

export function extractFromSeed(seedText) {
  const SYSTEM_PROMPT_RULES = evalConstBlock(
    extractBlock(seedText, 'SYSTEM_PROMPT_RULES'),
    'SYSTEM_PROMPT_RULES'
  );
  const SYSTEM_PROMPTS = evalConstBlock(
    extractBlock(seedText, 'SYSTEM_PROMPTS'),
    'SYSTEM_PROMPTS',
    { SYSTEM_PROMPT_RULES }
  );
  const TOOL_SCHEMAS = evalConstBlock(
    extractBlock(seedText, 'TOOL_SCHEMAS'),
    'TOOL_SCHEMAS'
  );
  return { SYSTEM_PROMPTS, SYSTEM_PROMPT_RULES, TOOL_SCHEMAS };
}
