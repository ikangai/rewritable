import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { loadSeed, applySeedSubs, replaceInlineDoc, extractInlineDoc, kindOverrides } from './seed.mjs';
import { inspectDoc } from './doc.mjs';

export const WORKSPACE_INDEX = 'rwa-index.html';
const UUID_RE = /const DOC_UUID = '([0-9a-f-]{36})';/;

function titleFromDir(dir) {
  const base = path.basename(path.resolve(dir)) || 'Workspace';
  return base
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ') || 'Workspace';
}

function titleFromFile(file) {
  return path.basename(file, path.extname(file))
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ') || file;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function safeScriptJson(obj) {
  return JSON.stringify(obj, null, 2).replace(/<\/script/gi, '<\\/script');
}

function defaultWorkspaceContext(name) {
  return `<section class="rwa-ws-context" data-rwa-workspace-context>
<h2>Workspace memory</h2>
<p>Use this space for durable notes that every document in this workspace should be able to rely on.</p>

<h2>Guidelines</h2>
<ul>
  <li>Describe the shared tone, standards, constraints, and recurring decisions for this workspace.</li>
  <li>For a writing workspace, add voice, structure, audience, and publishing rules here.</li>
</ul>

<h2>Examples</h2>
<p>Add canonical examples that new documents can imitate, such as a representative blog post, proposal, report, or brief.</p>

<h2>Open questions</h2>
<ul>
  <li>Track unresolved decisions that should shape future documents.</li>
</ul>
</section>`;
}

function extractWorkspaceContext(doc, name) {
  const m = String(doc || '').match(/<section\b[^>]*\bdata-rwa-workspace-context\b[^>]*>[\s\S]*?<\/section>/i);
  return m ? m[0] : defaultWorkspaceContext(name);
}

async function indexUuid(indexPath) {
  try {
    const text = await fs.readFile(indexPath, 'utf8');
    return (text.match(UUID_RE) || [])[1] || crypto.randomUUID();
  } catch (e) {
    if (e && e.code === 'ENOENT') return crypto.randomUUID();
    throw e;
  }
}

async function ensureCreateTarget(dir, indexPath, force) {
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) {
      const e = new Error(`workspace target is not a directory: ${dir}`);
      e.exitCode = 2;
      throw e;
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      await fs.mkdir(dir, { recursive: true });
    } else {
      throw e;
    }
  }

  try {
    await fs.stat(indexPath);
    if (!force) {
      const e = new Error(`workspace index exists: ${indexPath} (use --force to overwrite)`);
      e.exitCode = 2;
      throw e;
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
}

async function ensureSyncTarget(dir) {
  const st = await fs.stat(dir).catch(e => {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`workspace directory not found: ${dir}`);
      err.exitCode = 2;
      throw err;
    }
    throw e;
  });
  if (!st.isDirectory()) {
    const e = new Error(`workspace target is not a directory: ${dir}`);
    e.exitCode = 2;
    throw e;
  }
}

export async function scanWorkspace(dir) {
  const names = (await fs.readdir(dir))
    .filter(n => /\.html?$/i.test(n))
    .filter(n => n !== WORKSPACE_INDEX)
    .sort((a, b) => a.localeCompare(b));
  const docs = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const info = await inspectDoc(filePath);
      docs.push({
        file: name,
        title: info.self.title || titleFromFile(name),
        kind: info.self.kind || info.kind || 'document',
        uuid: info.uuid,
        blocks: info.self.blocks || 0,
        affordances: Array.isArray(info.self.affordances)
          ? info.self.affordances.map(a => ({ kind: a.kind, name: a.name, label: a.label, provenance: a.provenance }))
          : [],
      });
    } catch (e) {
      if (e && e.subcode === 'not_a_rewritable') continue;
      throw e;
    }
  }
  return docs;
}

export function buildWorkspaceBody({ name, docs, generatedAt = new Date().toISOString(), contextHtml }) {
  const manifest = {
    version: 'rwa-workspace/1',
    name,
    generatedAt,
    index: WORKSPACE_INDEX,
    documents: docs,
  };
  const cards = docs.length
    ? docs.map(doc => {
        const kinds = doc.affordances && doc.affordances.length
          ? doc.affordances.map(a => a.kind).join(', ')
          : 'baseline';
        const href = './' + encodeURI(doc.file).replace(/"/g, '%22');
        return `<a class="rwa-ws-card" href="${escapeAttr(href)}">
  <span class="rwa-ws-kind">${escapeHtml(doc.kind)}</span>
  <strong>${escapeHtml(doc.title)}</strong>
  <span>${escapeHtml(doc.file)}</span>
  <small>${escapeHtml(String(doc.blocks))} blocks · ${escapeHtml(kinds)}</small>
</a>`;
      }).join('\n')
    : '<p class="rwa-ws-empty">No sibling rewritables yet. Add documents to this folder, then run <code>rwa workspace sync</code>.</p>';

  return `<!-- rwa:frozen:begin workspace-style -->
<style>
.rwa-workspace{max-width:1040px;margin:0 auto;padding:32px 24px 72px;}
.rwa-workspace header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:24px;border-bottom:1px solid var(--gray-200,#e5e7eb);padding-bottom:18px;}
.rwa-workspace h1{margin:0;font-size:2rem;line-height:1.1;}
.rwa-workspace .rwa-ws-meta{margin:0;color:var(--gray-500,#6b7280);font-size:13px;}
.rwa-ws-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;}
.rwa-ws-card{display:flex;flex-direction:column;gap:7px;padding:14px 16px;border:1px solid var(--gray-200,#e5e7eb);border-radius:8px;text-decoration:none;color:inherit;background:var(--gray-50,#f9fafb);}
.rwa-ws-card:hover{border-color:var(--gray-400,#9ca3af);background:#fff;}
.rwa-ws-card strong{font-size:16px;line-height:1.25;}
.rwa-ws-card span{font-size:13px;color:var(--gray-600,#4b5563);overflow-wrap:anywhere;}
.rwa-ws-card small{font-size:12px;color:var(--gray-500,#6b7280);}
.rwa-ws-kind{align-self:flex-start;text-transform:uppercase;letter-spacing:.04em;font-size:10px!important;color:#fff!important;background:var(--gray-800,#1f2937);border-radius:4px;padding:2px 6px;}
.rwa-ws-empty{color:var(--gray-500,#6b7280);line-height:1.5;}
.rwa-ws-context{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin:20px 0 28px;}
.rwa-ws-context h2{margin:18px 0 0;font-size:1.1rem;}
.rwa-ws-context h2:first-child{margin-top:0;}
.rwa-ws-context p,.rwa-ws-context ul,.rwa-ws-context ol{margin:0;line-height:1.55;}
.rwa-ws-live{margin-top:28px;padding-top:18px;border-top:1px solid var(--gray-200,#e5e7eb);}
.rwa-ws-live h2{margin:0 0 12px;font-size:1rem;}
.rwa-ws-live-card{background:#fff;border-color:var(--blue,#2563eb);}
</style>
<!-- rwa:frozen:end workspace-style -->
<article class="rwa-workspace">
<header>
  <div>
    <h1>${escapeHtml(name)}</h1>
    <p class="rwa-ws-meta">${docs.length} document${docs.length === 1 ? '' : 's'} · synced ${escapeHtml(generatedAt)}</p>
  </div>
</header>
${contextHtml || defaultWorkspaceContext(name)}
<h2>Workspace documents</h2>
<section class="rwa-ws-grid" aria-label="Workspace documents">
${cards}
</section>
<section class="rwa-ws-live" data-rwa-workspace-live hidden>
<h2>Open now</h2>
<div class="rwa-ws-grid" data-rwa-workspace-live-grid></div>
</section>
</article>
<!-- rwa:frozen:begin workspace-manifest -->
<script type="application/rwa-workspace+json" id="rwa-workspace" data-rwa-frozen>${safeScriptJson(manifest)}</script>
<!-- rwa:frozen:end workspace-manifest -->`;
}

async function writeWorkspaceIndex(dir, { seedCandidates, uuid }) {
  const indexPath = path.join(dir, WORKSPACE_INDEX);
  const docs = await scanWorkspace(dir);
  const name = titleFromDir(dir);
  let contextHtml = defaultWorkspaceContext(name);
  try {
    const existing = await fs.readFile(indexPath, 'utf8');
    contextHtml = extractWorkspaceContext(extractInlineDoc(existing), name);
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) contextHtml = defaultWorkspaceContext(name);
  }
  const overrides = kindOverrides('workspace');
  let html = applySeedSubs(await loadSeed(seedCandidates), {
    uuid,
    title: name,
    fileMeta: WORKSPACE_INDEX,
    lensPlaceholder: overrides.lensPlaceholder,
    palPlaceholder: overrides.palPlaceholder,
    productHeader: overrides.productHeader,
    productKind: 'workspace',
    lensClickToAnchor: overrides.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, buildWorkspaceBody({ name, docs, contextHtml }));
  await fs.writeFile(indexPath, html, 'utf8');
  return { indexPath, docs };
}

export async function workspaceCreateCmd({ dirPath = '.', force = false, seedCandidates }) {
  const dir = path.resolve(dirPath);
  const indexPath = path.join(dir, WORKSPACE_INDEX);
  await ensureCreateTarget(dir, indexPath, force);
  return writeWorkspaceIndex(dir, { seedCandidates, uuid: await indexUuid(indexPath) });
}

export async function workspaceSyncCmd({ dirPath = '.', seedCandidates }) {
  const dir = path.resolve(dirPath);
  await ensureSyncTarget(dir);
  const indexPath = path.join(dir, WORKSPACE_INDEX);
  return writeWorkspaceIndex(dir, { seedCandidates, uuid: await indexUuid(indexPath) });
}
