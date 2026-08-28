// `rwa run <file>` (#38) — execute a workflow rewritable headlessly.
//
// The gap this closes: a workflow rwa could only be executed by a human opening
// it in a browser. The runner lives inside the seed and nowhere else, so
// `describe()` would happily report that a container has runnable steps and then
// offer no door to reach them — a negotiation surface advertising capabilities
// with no way to invoke them.
//
// IT DRIVES THE BUTTON, IT DOES NOT REIMPLEMENT THE RUNNER. That is the whole
// design constraint from #38, and it is not a nicety in this repo: a second
// runner outside the seed would be a fifth mirror to keep in step, and the one
// thing it could never guarantee is the acceptance criterion — "the same results
// as a browser run". So this boots the real container in real Chrome, clicks the
// same `.rwa-run` control a person clicks, and reads the same
// `window.__rwaWorkflow` state the page itself keeps. If the runner changes, this
// follows for free, because it is a user, not a copy.
//
// `window.__rwaWorkflow` is ordinary page state the workflow body maintains for
// its own UI — NOT one of the seed's jsdom-gated `window.__rwa*` test hooks,
// which are undefined in a real browser (see tests/browser/'s rule). Verified by
// reading the emitted body: NS is created unconditionally at module scope.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { launch, findChrome } from './cdp.mjs';
import { extractInlineDoc } from './seed.mjs';
import { CliError } from './edit.mjs';

const PRODUCT_KIND_RE = /const PRODUCT_KIND\s*=\s*'([a-z-]+)'/;
/** Boot budget — the same shape `rwa render` uses. */
const BOOT_MS = 8000;
/** Default ceiling for the run itself. Workflow steps can do real network work. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run a workflow rewritable and return its result.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=120000] — ceiling for the run, not the boot
 * @returns {Promise<{kind, ran, result, durationMs, consoleErrors: string[]}>}
 * @throws {CliError} 1 usage · 2 file errors · 6 `chrome_not_found` / `run_failed`
 */
export async function runFile(filePath, opts = {}) {
  // Validate before spending ~1s of Chrome startup, and report through the same
  // `file_error` surface every other verb uses.
  let fileText;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }
  try { extractInlineDoc(fileText); }
  catch { throw new CliError(2, 'not_a_rewritable', { path: filePath }); }

  const kind = (fileText.match(PRODUCT_KIND_RE) || [])[1] || 'document';
  if (kind !== 'workflow') {
    // Refuse with the reason, not a generic failure. `run` means "execute the
    // steps this container defines"; a document has none, and pretending
    // otherwise by clicking whatever happens to be present would be worse.
    throw new CliError(1, 'not_runnable', {
      path: filePath, kind,
      reason: 'rwa run executes a workflow container. This one is kind "' + kind + '", which defines no steps. '
        + 'Compute and edit-surface affordances reported by describe() are not yet invocable from the CLI — see #38.',
    });
  }

  if (!findChrome()) {
    throw new CliError(6, 'chrome_not_found', {
      hint: 'rwa run drives the real container in a real browser, so the run matches a browser run. '
        + 'Install Chrome/Chromium, or set CHROME_BIN to its path.',
    });
  }

  const abs = resolve(filePath);
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  let page;
  try {
    page = await launch({ url: pathToFileURL(abs).href });
  } catch (e) {
    throw new CliError(6, 'run_failed', { stage: 'launch', message: e && e.message });
  }

  const started = Date.now();
  try {
    // Wait for the RUNTIME, not merely for load: the document is hydrated from
    // IndexedDB after boot, so acting on load would drive the inline snapshot
    // rather than what a person would see and click.
    const ready = await page.eval(async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const mount = document.getElementById('rwa-doc-mount');
        if (window.runtime && mount && mount.innerHTML.trim().length > 0) return true;
        await new Promise(r => setTimeout(r, 50));
      }
      return false;
    }, BOOT_MS);
    if (!ready) throw new CliError(6, 'run_failed', { stage: 'boot', message: 'the container never finished booting' });

    // Find the control a person would click, and say so precisely if it is
    // missing — "no Run button" is an answer about the document, and quite
    // different from "the run failed".
    // Scoped to the document mount, NEVER document-wide. The runtime chrome has
    // a "Run" button of its own (the `/` prompt pal), and a document-wide
    // selector that drifted onto it would fire a model edit while reporting a
    // workflow run. The control we want is the one the workflow body renders.
    const found = await page.eval(() => {
      const btn = document.querySelector('#rwa-doc-mount .rwa-run');
      return { hasButton: !!btn, hasNs: !!window.__rwaWorkflow, steps: document.querySelectorAll('#rwa-doc-mount .rwa-step').length };
    });
    if (!found.hasButton) {
      throw new CliError(6, 'run_failed', {
        stage: 'discover',
        steps: found.steps,
        message: found.steps === 0
          ? 'this workflow container defines no steps, so it renders no Run control — there is nothing to run yet'
          : 'no .rwa-run control inside #rwa-doc-mount — nothing a person could click either',
      });
    }

    // Click it, exactly as a person does — and observe `running` in the SAME
    // evaluation, which is what makes the start detectable at all.
    //
    // runWorkflow() sets NS.running = true synchronously before its first await,
    // so immediately after .click() returns, a started run is already visible.
    // A separate polling round-trip CANNOT see that reliably: a trivial workflow
    // finishes in well under one poll interval, so "wait until you see it
    // running" reports never-started for exactly the workflows that work best.
    // Measured, not reasoned — the first version of this did precisely that and
    // burned the whole timeout on a workflow that had already returned 42.
    //
    // Guarded against the already-running case because clicking a running
    // workflow ABORTS it (the button is a Run/Cancel toggle), and starting a run
    // by cancelling one would be a spectacular way to report success.
    const start = await page.eval(() => {
      const ns = window.__rwaWorkflow;
      if (ns && ns.running) return { ok: false, why: 'already_running' };
      document.querySelector('#rwa-doc-mount .rwa-run').click();
      const after = window.__rwaWorkflow;
      return { ok: !!(after && after.running), why: 'clicked' };
    });
    if (!start.ok) {
      throw new CliError(6, 'run_failed', {
        stage: 'start',
        consoleErrors: page.consoleErrors.slice(0, 5),
        message: start.why === 'already_running'
          ? 'the workflow was already running on load'
          : 'the Run control was clicked but the workflow did not start — its handler may have thrown at boot',
      });
    }

    // Now it is genuinely running, so waiting for it to stop is unambiguous.
    const outcome = await page.eval(async (limit) => {
      const t0 = Date.now();
      while (Date.now() - t0 < limit) {
        const ns = window.__rwaWorkflow;
        if (!ns || !ns.running) return { done: true, result: ns ? ns.lastResult : null };
        await new Promise(r => setTimeout(r, 50));
      }
      return { done: false };
    }, timeoutMs);

    if (!outcome.done) {
      throw new CliError(6, 'run_timeout', {
        stage: 'execute',
        timeoutMs,
        consoleErrors: page.consoleErrors.slice(0, 5),
        message: 'the workflow was still running after ' + Math.round(timeoutMs / 1000) + 's (raise --timeout)',
      });
    }

    return {
      kind,
      ran: true,
      result: outcome.result ?? null,
      durationMs: Date.now() - started,
      // Surfaced, never swallowed: a workflow whose step threw can still finish
      // and hand back a result, and the console is where that shows.
      consoleErrors: page.consoleErrors.slice(),
    };
  } finally {
    try { await page.close(); } catch { /* already gone */ }
  }
}
