// `rwa skill import <dir>` (#47) — turn an Agent Skill on disk into a signed
// rewritable carrier.
//
// An Agent Skill is a folder: SKILL.md (YAML frontmatter + a markdown body),
// usually references/, sometimes scripts. A carrier is a signed `rwa-agent/1|2`
// record inside a rewritable. Three of the four parts map straight across; the
// fourth is deliberately left behind.
//
//   frontmatter name        → agent.role
//   frontmatter description → agent.description   (WHEN to use this skill)
//   SKILL.md body           → a carried REFERENCE named SKILL.md   ← see below
//   references/*            → carried references
//   scripts / executables   → DROPPED, and named
//
// WHY THE BODY IS A REFERENCE AND NOT `system_prompt`
//
// The obvious mapping — body → system_prompt — cannot be installed. The install
// gate (`validateAgentInstall` → `agent_prompt_injection_risk`) rejects any
// system_prompt containing a backtick, `${`, or a literal <DOC> tag, and that is
// a normative MUST in re-write-able-actions-spec-v0.9 §13, enforced identically
// in three mirrored sites (cli, service/lib, and the seed). Real skill bodies are
// markdown: the one in this repo has 49 backticks. Measured, not assumed — that
// exact file returns `agent_prompt_injection_risk` today.
//
// A rejected record is not merely unsigned-looking: `readOfferedRole` releases
// `systemPrompt` AND `references` only when `usable` (verified AND gate-clean),
// so the body-as-prompt mapping would deliver NOTHING to a reading agent.
//
// Carried references are exempt from that screen ON PURPOSE (#45: "real
// references are full of backticks and ${}, and screening them would reject
// essentially every genuine one"). So the body rides as a reference, the
// system_prompt is a short synthesized line that points at it, and a reading
// agent gets both through one `rwa doc --json`. That also happens to mirror how
// Agent Skills really work: the description is always loaded, the body on demand.
//
// The alternative — relaxing the screen — is a change to a shipped spec MUST
// across three mirrored implementations, and is not made here.

import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_AGENT_REFERENCES, MAX_AGENT_REFERENCE_BYTES } from './skill-manifest.mjs';

const ROLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const fail = (msg, code = 2) => { const e = new Error(msg); e.exitCode = code; throw e; };
const rel = (p) => path.relative(process.cwd(), p) || p;

// Text that can honestly ride as a reference. Anything else is reported as
// dropped rather than base64'd into a markdown slot where it would be unreadable.
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml', '.csv']);

/**
 * Minimal YAML frontmatter reader — `key: value` pairs between --- fences.
 *
 * Deliberately not a YAML parser (this package is zero-dependency) and
 * deliberately not tolerant: it understands flat scalars, and anything else
 * FAILS rather than being silently half-read. A skill whose description is
 * quietly truncated to its first line imports as a skill nobody can find, which
 * is worse than a refusal that says what it could not read.
 */
export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: null, body: text, error: 'no_frontmatter' };
  const data = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) return { data: null, body: text.slice(m[0].length), error: 'unparsable_frontmatter_line: ' + line.trim().slice(0, 60) };
    let v = kv[2].trim();
    // Block scalars (| and >) and nested maps would need a real parser. Say so.
    if (v === '|' || v === '>' || v === '') return { data: null, body: text.slice(m[0].length), error: 'unsupported_frontmatter_value: ' + kv[1] };
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length), error: null };
}

/** name → a legal agent role. Reports the mapping rather than renaming silently. */
export function roleFromName(name) {
  const slug = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 64);
  return ROLE_RE.test(slug) ? slug : null;
}

async function walk(dir, base = dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, base, out);
    else if (e.isFile()) out.push({ abs, rel: path.relative(base, abs), readable: true });
    // Symlinks (and sockets, fifos) are recorded as present but NEVER read: a
    // link inside the folder can point anywhere, and following one would let a
    // skill pull an arbitrary file off the importer's disk into a signed,
    // shareable carrier. Listed rather than skipped, so the omission is visible.
    else out.push({ abs, rel: path.relative(base, abs), readable: false });
  }
  return out;
}

// A skill folder can carry a lot of non-instruction material. Print enough to be
// actionable and then say how much was elided — a 4000-line stderr dump is not a
// more honest report, it is an unread one.
const DROPPED_SHOWN = 20;
export function formatDropped(dropped, indent = '        ') {
  const shown = dropped.slice(0, DROPPED_SHOWN).map(d => indent + d);
  if (dropped.length > DROPPED_SHOWN) shown.push(indent + '… and ' + (dropped.length - DROPPED_SHOWN) + ' more');
  return shown.join('\n');
}

/**
 * Read an Agent Skill directory into the parts a carrier needs.
 * @returns {{role, name, description, body, references: {name,content}[], dropped: string[]}}
 */
export async function readSkillDir(dir) {
  const root = path.resolve(dir);
  let st;
  try { st = await fs.stat(root); } catch { fail('skill import: ' + rel(root) + ' not found'); }
  if (!st.isDirectory()) fail('skill import: ' + rel(root) + ' is not a directory (expected a folder containing SKILL.md)');

  const skillMd = path.join(root, 'SKILL.md');
  let text;
  try { text = await fs.readFile(skillMd, 'utf8'); }
  catch { fail('skill import: no SKILL.md in ' + rel(root) + ' — that file is what makes a folder an Agent Skill'); }

  const { data, body, error } = parseFrontmatter(text);
  if (error) fail('skill import: SKILL.md frontmatter (' + error + '). Expected --- fences with flat "key: value" lines including name and description.');
  if (!data.name) fail('skill import: SKILL.md frontmatter has no "name"');
  if (!data.description) fail('skill import: SKILL.md frontmatter has no "description" — it is what tells an agent WHEN to use the skill, so a carrier without one is undiscoverable');
  const role = roleFromName(data.name);
  if (!role) fail('skill import: cannot derive a role from name "' + data.name + '" (needs at least one a-z0-9 character)');
  if (!body.trim()) fail('skill import: SKILL.md has frontmatter but no body — there are no instructions to carry');

  // The body first, so it reads first, then references/ in stable order.
  const references = [{ name: 'SKILL.md', content: body.replace(/^\s*\n/, '') }];
  const dropped = [];
  const files = (await walk(root)).sort((a, b) => a.rel.localeCompare(b.rel));
  for (const f of files) {
    if (f.rel === 'SKILL.md') continue;
    const inReferences = f.rel.startsWith('references' + path.sep);
    const ext = path.extname(f.rel).toLowerCase();
    if (f.readable && inReferences && TEXT_EXT.has(ext)) {
      references.push({ name: path.basename(f.rel), content: await fs.readFile(f.abs, 'utf8') });
    } else {
      dropped.push(f.rel);
    }
  }

  // Cap check here, where the message can name the files, rather than as a
  // downstream `references_too_large` with nothing pointing back at the skill.
  const bytes = references.reduce((n, r) => n + Buffer.byteLength(r.content, 'utf8'), 0);
  if (references.length > MAX_AGENT_REFERENCES) {
    fail('skill import: ' + references.length + ' references exceeds the limit of ' + MAX_AGENT_REFERENCES
      + '. They ride inside the container and count against its document budget. Trim references/ and re-run.');
  }
  if (bytes > MAX_AGENT_REFERENCE_BYTES) {
    fail('skill import: references total ' + Math.round(bytes / 1024) + ' KB, over the '
      + Math.round(MAX_AGENT_REFERENCE_BYTES / 1024) + ' KB limit. They ride inside the container and count '
      + 'against its document budget. Trim references/ and re-run — importing a truncated skill silently '
      + 'would be worse.');
  }
  return { role, name: data.name, description: data.description, body, references, dropped };
}

/**
 * The synthesized system_prompt.
 *
 * Must survive the install gate, so: no backtick, no ${, no <DOC>. Kept short on
 * purpose — the instructions are the carried SKILL.md, and duplicating them here
 * would create two copies that can disagree.
 *
 * The last sentence is required by #47: a carrier must never imply the scripts
 * came along. It says so to the model as well as to the human reading the card.
 */
export function synthesizePrompt({ role, dropped }) {
  const lines = [
    'You are the ' + role + ' skill, imported from an Agent Skill.',
    'Your full instructions are carried with this container as the reference named SKILL.md. Read it and follow it exactly; the other carried references are its supporting material.',
  ];
  if (dropped.length) {
    lines.push('This carrier holds instructions only. The original skill also shipped ' + dropped.length
      + ' non-instruction file(s) (such as scripts or binaries) which are NOT included here. Do not assume they exist, and do not attempt to run them.');
  }
  return lines.join(' ');
}

export async function skillImportCmd(opts = {}) {
  const parsed = await readSkillDir(opts.dir);
  const { intelligenceNewCmd } = await import('./intelligence.mjs');
  const out = opts.outPath || ('./' + parsed.role + '.skill.html');

  const result = await intelligenceNewCmd({
    role: parsed.role,
    description: parsed.description,
    prompt: synthesizePrompt(parsed),
    inlineReferences: parsed.references,
    outPath: out,
    force: opts.force,
    model: opts.model, backend: opts.backend,
    imported: { source: rel(path.resolve(opts.dir)), name: parsed.name, dropped: parsed.dropped },
  });

  // Report on stderr, so stdout stays free and so the omission is visible even
  // when the command is being read by a script that only checks the exit code.
  if (parsed.name !== parsed.role) {
    process.stderr.write('note: skill name "' + parsed.name + '" imported as role "' + parsed.role + '"\n');
  }
  if (parsed.dropped.length) {
    process.stderr.write('note: ' + parsed.dropped.length + ' file(s) NOT carried — a carrier holds instructions, not executables:\n');
    process.stderr.write(formatDropped(parsed.dropped) + '\n');
    process.stderr.write('      The imported skill is the instruction half only. See issue #46 for why running carried scripts needs a consent story that does not exist yet.\n');
  }
  return { ...result, ...parsed };
}
