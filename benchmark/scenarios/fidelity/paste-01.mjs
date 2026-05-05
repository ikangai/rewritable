// PASTE-01 — paste a Python code block verbatim into a <pre><code> wrapper.
// Tests model resistance to "improving", reformatting, or summarizing pasted
// content. Success requires byte-identical preservation of the pasted bytes.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const PASTE_CONTENT = `def migrate_users(conn, batch_size=1000):
    """Backfill user.profile_id from auth.profile_links.

    Idempotent — re-running picks up any rows added since the last run.
    """
    cursor = conn.cursor()
    cursor.execute("SELECT MAX(id) FROM users WHERE profile_id IS NULL")
    last_id = cursor.fetchone()[0] or 0
    while True:
        cursor.execute(
            "UPDATE users SET profile_id = pl.id "
            "FROM auth.profile_links pl "
            "WHERE users.email = pl.email AND users.id <= %s "
            "  AND users.profile_id IS NULL "
            "ORDER BY users.id LIMIT %s",
            (last_id, batch_size),
        )
        if cursor.rowcount == 0:
            break
        conn.commit()
    conn.close()`;

const FIXTURE = `<article>
<h1>Migration runbook</h1>
<p>Before the maintenance window, review the script below.</p>
<div id="paste-target">PASTE_HERE_PASTE_01</div>
<p>After it completes, verify with the integration test suite.</p>
</article>`;

const PASTE_BLOCK = `<pre><code class="lang-python">${PASTE_CONTENT}</code></pre>`;

export default {
  id: 'PASTE-01',
  category: 'PASTE',
  tag: 'paste',
  description: 'paste Python code block verbatim into pre/code; byte-identical preservation',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: `Insert this Python script verbatim at the marked location. Wrap it in <pre><code class="lang-python"> exactly as written — no whitespace changes, no reformatting, no summarization. Replace the PASTE_HERE_PASTE_01 marker with the wrapped code.\n\n${PASTE_CONTENT}`,
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [{ find: 'PASTE_HERE_PASTE_01', replace: PASTE_BLOCK }],
    } },
  ]),
  success: async (doc) => {
    const out = runSelectorOracle(doc, [
      { selector: '#paste-target pre code.lang-python', label: 'pre/code wrapper with lang-python class' },
      { fn: (d) => !d.body.textContent.includes('PASTE_HERE_PASTE_01'), label: 'marker removed' },
      { fn: (d) => d.querySelector('#paste-target pre code')?.textContent === PASTE_CONTENT, label: 'code textContent matches paste byte-identical' },
    ]);
    out.total++;
    const byteIdentical = doc.includes(PASTE_BLOCK);
    out.results.push({ label: 'paste block present byte-identical in raw doc', ok: byteIdentical, reason: byteIdentical ? 'byte-identical' : 'block missing or altered' });
    if (byteIdentical) out.passed++;
    out.score = out.passed === out.total ? 2 : (out.passed > 0 ? 1 : 0);
    return out;
  },
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'PASTE_HERE_PASTE_01');
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
