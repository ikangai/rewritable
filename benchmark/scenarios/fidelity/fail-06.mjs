// FAIL-06 — structural_shape_changed tool_result payload contains
// shape_before and shape_after triples; model retries with replace_document.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';

const FIXTURE = `<style>:root { --x: 1; }</style>\n<div>BODY</div>`;
let captured = null;

export default {
  id: 'FAIL-06',
  category: 'FAIL',
  tag: 'failure_mode',
  description: 'structural_shape_changed payload contains shape_before/after; model retries with replace_document',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Add a <script> via apply_edits (will be rejected); retry with replace_document.',
  stub: () => {
    captured = null;
    return stubModel([
      // Turn 1: add a top-level <script> via apply_edits — rejected
      { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: '<div>BODY</div>', replace: '<div>BODY</div>\n<script>x=1;</script>' }] } },
      // Turn 2: capture payload, retry with replace_document
      (messages) => {
        const tr = [...messages].reverse().find(m => m.role === 'tool');
        if (tr) { try { captured = JSON.parse(tr.content); } catch { captured = { _raw: tr.content }; } }
        return { name: 'replace_document', envelope: { version: 'rwa-edit/1', doc: '<style>:root { --x: 1; }</style>\n<div>BODY</div>\n<script>x=1;</script>', reason: 'shape change required for new <script>' } };
      },
    ]);
  },
  success: () => runSelectorOracle('<div></div>', [
    { fn: () => captured?.code === 'structural_shape_changed', label: 'tool_result code' },
    { fn: () => captured?.shape_before && captured?.shape_after, label: 'shape_before/after triples present' },
  ]),
  stability: () => ({ drift_bytes: 0, drift_ratio: 0, score: 2 }),
};
