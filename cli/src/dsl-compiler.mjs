// rwa-edit-dsl/1 compiler — turns a DSL plan into an apply_edits or
// replace_document envelope. Read alongside rwa-edit-dsl-spec.md.
//
// Compile-down semantics:
//   - replace_document plan → { tool: 'replace_document', envelope }
//   - any other plan → { tool: 'apply_edits', envelope: { version, edits } }
//
// Multi-op plans apply sequentially against an evolving "shadow" doc — each
// op's anchor is resolved against the doc as it would look after preceding
// ops landed. The shadow is internal to compilation; the emitted edits are
// applied sequentially by the runtime in the same order, so every emitted
// `find` matches in turn.

const SUPPORTED_VERSION = 'rwa-edit-dsl/1';

class DslCompileError extends Error {
  constructor(code, message, op) {
    super(message);
    this.code = code;
    this.op = op;
  }
}

function makeError(code, message, op) {
  return new DslCompileError(code, message, op);
}

/**
 * Compile a DSL plan against a doc. Returns:
 *   { tool: 'apply_edits' | 'replace_document', envelope: <rwa-edit/1 envelope> }
 *
 * Throws DslCompileError on any spec violation.
 */
export function compileDslPlan(plan, doc) {
  if (!plan || typeof plan !== 'object') {
    throw makeError('op_malformed', 'plan must be an object');
  }
  if (plan.version !== SUPPORTED_VERSION) {
    throw makeError('version_unsupported', `expected ${SUPPORTED_VERSION}, got ${plan.version}`);
  }
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) {
    throw makeError('op_malformed', 'plan.ops must be a non-empty array');
  }

  // replace_document is a sole-op escape hatch.
  const hasReplaceDoc = plan.ops.some(op => op?.op === 'replace_document');
  if (hasReplaceDoc) {
    if (plan.ops.length !== 1) {
      throw makeError('op_malformed', 'replace_document must be the sole op in a plan');
    }
    const op = plan.ops[0];
    if (typeof op.doc !== 'string' || typeof op.reason !== 'string') {
      throw makeError('op_malformed', 'replace_document requires doc and reason fields');
    }
    return {
      tool: 'replace_document',
      envelope: { version: 'rwa-edit/1', doc: op.doc, reason: op.reason },
    };
  }

  // Otherwise: compile each op against an evolving shadow.
  let shadow = doc;
  const edits = [];
  for (const op of plan.ops) {
    const newEdits = compileOp(op, shadow);
    for (const e of newEdits) {
      validateEditApplies(shadow, e, op);
      edits.push(e);
      shadow = applyEditToShadow(shadow, e);
    }
  }
  return {
    tool: 'apply_edits',
    envelope: { version: 'rwa-edit/1', edits },
  };
}

function compileOp(op, doc) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
    throw makeError('op_malformed', 'each op must be an object with a string `op` field');
  }
  switch (op.op) {
    case 'replace': return compileReplace(op, doc);
    case 'insert': return compileInsert(op, doc);
    case 'delete': return compileDelete(op, doc);
    case 'set_attr': return compileSetAttr(op, doc);
    default: throw makeError('op_unknown', `unknown op: ${op.op}`, op);
  }
}

// ---------- replace ----------

function compileReplace(op, doc) {
  const { find, replace, region, all } = op;
  if (typeof find !== 'string' || typeof replace !== 'string') {
    throw makeError('op_malformed', 'replace requires `find` and `replace` strings', op);
  }

  let windowStart = 0;
  let windowEnd = doc.length;
  if (typeof region === 'string') {
    const matches = allOccurrences(doc, region);
    if (matches.length === 0) throw makeError('region_not_found', `region not found: ${preview(region)}`, op);
    if (matches.length > 1) throw makeError('region_not_unique', `region matches ${matches.length} times`, op);
    windowStart = matches[0];
    windowEnd = matches[0] + region.length;
  }

  const window = doc.slice(windowStart, windowEnd);
  const localOccs = allOccurrences(window, find);
  if (localOccs.length === 0) {
    throw makeError(all ? 'all_with_zero_matches' : 'op_malformed', `find has zero matches in search window: ${preview(find)}`, op);
  }
  if (!all && localOccs.length > 1) {
    throw makeError('op_malformed', `find has ${localOccs.length} matches in search window but all=false: ${preview(find)}`, op);
  }

  // For all=false, single match in window. If find is also globally unique, emit raw.
  // Otherwise contextualize using surrounding doc bytes.
  if (!all) {
    const globalOccs = allOccurrences(doc, find);
    if (globalOccs.length === 1) {
      return [{ find, replace }];
    }
    // Disambiguate with surrounding context drawn from the window.
    const absoluteStart = windowStart + localOccs[0];
    return [contextualizeEdit(doc, absoluteStart, find, replace)];
  }

  // all=true: emit one edit per local occurrence, contextualized.
  return localOccs.map(localStart => {
    const absoluteStart = windowStart + localStart;
    return contextualizeEdit(doc, absoluteStart, find, replace);
  });
}

// Extend find/replace bytes outward until find is uniquely locatable in doc.
// We extend backward by 1 char at a time then forward, alternating, until
// the candidate find appears exactly once in doc.
function contextualizeEdit(doc, absoluteStart, find, replace) {
  const findEnd = absoluteStart + find.length;
  let preLen = 0, postLen = 0;
  // Bound: at most extend 200 chars in each direction. Most disambiguations
  // need <20; 200 is a sanity cap.
  const MAX = 200;
  while (true) {
    const ctxFind = doc.slice(absoluteStart - preLen, findEnd + postLen);
    const ctxReplace = doc.slice(absoluteStart - preLen, absoluteStart) + replace + doc.slice(findEnd, findEnd + postLen);
    const occs = allOccurrences(doc, ctxFind);
    if (occs.length === 1) {
      return { find: ctxFind, replace: ctxReplace };
    }
    if (preLen >= MAX && postLen >= MAX) {
      throw makeError('op_malformed', `unable to disambiguate find within ${MAX} chars: ${preview(find)}`);
    }
    if (postLen <= preLen && findEnd + postLen < doc.length) postLen++;
    else if (absoluteStart - preLen > 0) preLen++;
    else postLen++;
  }
}

// ---------- insert ----------

function compileInsert(op, doc) {
  const { content, after, before } = op;
  if (typeof content !== 'string') {
    throw makeError('op_malformed', 'insert requires `content` string', op);
  }
  const positionalCount = (typeof after === 'string' ? 1 : 0) + (typeof before === 'string' ? 1 : 0);
  if (positionalCount !== 1) {
    throw makeError('op_malformed', 'insert requires exactly one of `after` or `before`', op);
  }
  const anchor = typeof after === 'string' ? after : before;
  const occs = allOccurrences(doc, anchor);
  if (occs.length === 0) throw makeError('op_malformed', `insert anchor not found: ${preview(anchor)}`, op);
  if (occs.length > 1) throw makeError('op_malformed', `insert anchor not unique: ${preview(anchor)} (${occs.length} matches)`, op);
  if (typeof after === 'string') {
    return [{ find: anchor, replace: anchor + content }];
  }
  return [{ find: anchor, replace: content + anchor }];
}

// ---------- delete ----------

function compileDelete(op, doc) {
  const { target } = op;
  if (typeof target !== 'string') {
    throw makeError('op_malformed', 'delete requires `target` string', op);
  }
  const occs = allOccurrences(doc, target);
  if (occs.length === 0) throw makeError('op_malformed', `delete target not found: ${preview(target)}`, op);
  if (occs.length > 1) throw makeError('op_malformed', `delete target not unique: ${preview(target)} (${occs.length} matches)`, op);
  return [{ find: target, replace: '' }];
}

// ---------- set_attr ----------

function compileSetAttr(op, doc) {
  const { anchor, attr, value } = op;
  if (typeof anchor !== 'string' || typeof attr !== 'string' || typeof value !== 'string') {
    throw makeError('op_malformed', 'set_attr requires anchor, attr, value strings', op);
  }
  if (!anchor.startsWith('<')) {
    throw makeError('anchor_unparseable', 'set_attr.anchor must start with `<`', op);
  }
  if (anchor.endsWith('>')) {
    throw makeError('anchor_unparseable', 'set_attr.anchor must end before `>`', op);
  }
  const occs = allOccurrences(doc, anchor);
  if (occs.length === 0) throw makeError('op_malformed', `set_attr anchor not found: ${preview(anchor)}`, op);
  if (occs.length > 1) throw makeError('op_malformed', `set_attr anchor not unique: ${preview(anchor)} (${occs.length} matches)`, op);
  const start = occs[0];
  const closeIdx = doc.indexOf('>', start + anchor.length);
  if (closeIdx < 0) throw makeError('anchor_unparseable', 'no `>` found after set_attr anchor', op);
  const fullTag = doc.slice(start, closeIdx + 1);

  // Reject attribute values containing chars that can't survive serialization.
  if (/[ --]/.test(value)) {
    throw makeError('attr_value_unrepresentable', 'value contains control characters', op);
  }
  const escapedValue = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  // Detect whether attr already appears in fullTag. We respect quote state to
  // avoid matching attribute substrings inside another attribute's value.
  const existingMatch = findAttrInTag(fullTag, attr);
  let newTag;
  if (existingMatch) {
    const [attrStart, attrEnd] = existingMatch;
    newTag = fullTag.slice(0, attrStart) + `${attr}="${escapedValue}"` + fullTag.slice(attrEnd);
  } else {
    newTag = fullTag.slice(0, -1) + ` ${attr}="${escapedValue}">`;
  }
  return [{ find: fullTag, replace: newTag }];
}

// Locate `attr` inside a parsed opening tag, returning [start, end) byte
// offsets within the tag of the attr's full `name="value"` substring (or
// `name='value'`, or `name=value`, or boolean `name`). Returns null if absent.
// Respects quote state to avoid false matches inside other attributes.
function findAttrInTag(tag, attrName) {
  // Walk attribute by attribute. The tag starts with <tagname or </tagname.
  // Skip past tagname.
  const nameMatch = tag.match(/^<\/?([a-zA-Z][a-zA-Z0-9_-]*)/);
  if (!nameMatch) return null;
  let i = nameMatch[0].length;
  while (i < tag.length - 1) {
    // Skip whitespace
    while (i < tag.length && /\s/.test(tag[i])) i++;
    if (i >= tag.length || tag[i] === '>' || tag[i] === '/') break;
    const attrStart = i;
    // Read attribute name
    let nameEnd = i;
    while (nameEnd < tag.length && !/[\s=>/]/.test(tag[nameEnd])) nameEnd++;
    const name = tag.slice(attrStart, nameEnd);
    i = nameEnd;
    // Optional = followed by value
    let attrEnd = nameEnd;
    if (tag[i] === '=') {
      i++;
      if (tag[i] === '"') {
        const close = tag.indexOf('"', i + 1);
        if (close < 0) return null;
        attrEnd = close + 1;
        i = attrEnd;
      } else if (tag[i] === "'") {
        const close = tag.indexOf("'", i + 1);
        if (close < 0) return null;
        attrEnd = close + 1;
        i = attrEnd;
      } else {
        // Unquoted value
        while (i < tag.length && !/[\s>]/.test(tag[i])) i++;
        attrEnd = i;
      }
    } else {
      attrEnd = nameEnd;
    }
    if (name === attrName) return [attrStart, attrEnd];
  }
  return null;
}

// ---------- shared helpers ----------

function allOccurrences(haystack, needle) {
  const out = [];
  if (needle.length === 0) return out;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + 1; // overlapping matches allowed
  }
  return out;
}

function applyEditToShadow(doc, edit) {
  const idx = doc.indexOf(edit.find);
  if (idx < 0) {
    throw makeError('op_malformed', `compiler shadow drift: emitted edit no longer matches: ${preview(edit.find)}`);
  }
  const next = doc.indexOf(edit.find, idx + 1);
  if (next >= 0) {
    throw makeError('op_malformed', `compiler shadow drift: emitted edit ambiguous (${allOccurrences(doc, edit.find).length} matches): ${preview(edit.find)}`);
  }
  return doc.slice(0, idx) + edit.replace + doc.slice(idx + edit.find.length);
}

function validateEditApplies(doc, edit, op) {
  if (typeof edit.find !== 'string' || typeof edit.replace !== 'string') {
    throw makeError('op_malformed', 'compiler bug: emitted non-string find/replace', op);
  }
  if (edit.find.length === 0) {
    throw makeError('op_malformed', 'compiler bug: emitted empty find', op);
  }
}

function preview(s) {
  const trimmed = s.length > 60 ? s.slice(0, 57) + '...' : s;
  return JSON.stringify(trimmed);
}

/**
 * Apply an envelope (the compileDslPlan output, OR a model's apply_edits/replace_document)
 * to a doc. Used by the fidelity-dsl runner's comparator to check round-trip
 * equivalence between the DSL-compiled envelope and the scenario stub envelope.
 *
 * Mirrors the runtime's apply path: each find must match exactly once in turn.
 *
 * @param {string} doc — the input doc (LF-canonical)
 * @param {{ tool: string, envelope: object }} env — { tool, envelope } pair
 * @returns {string} the post-apply doc
 */
export function applyEnvelopeToDoc(doc, env) {
  if (env.tool === 'replace_document') {
    return env.envelope.doc;
  }
  if (env.tool !== 'apply_edits') {
    throw new Error(`applyEnvelopeToDoc: unknown tool "${env.tool}"`);
  }
  let result = doc;
  for (const e of env.envelope.edits) {
    const idx = result.indexOf(e.find);
    if (idx < 0) {
      throw new Error(`apply: find not found: ${preview(e.find)}`);
    }
    const next = result.indexOf(e.find, idx + 1);
    if (next >= 0) {
      throw new Error(`apply: find not unique: ${preview(e.find)}`);
    }
    result = result.slice(0, idx) + e.replace + result.slice(idx + e.find.length);
  }
  return result;
}

export { DslCompileError };
