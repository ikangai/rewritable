# Workflow product type — UX design

Date: 2026-05-18
Status: design validated, ready to implement

## Problem

The product-type taxonomy at `docs/specs/rwa-product-types.md` names *workflow* as one of four product types and places it at the graph layer (deferred `rwa-graph/1` spec). The CLI already accepts `rwa new --kind workflow` per the kind-machinery work, but the seed body for that kind is empty and there is no defined UX for authoring or running a workflow.

The dominant pattern in workflow tooling — n8n, Make, Zapier — is a 2D canvas of draggable nodes with property panels. Newer entries add text-to-workflow as a *generation shortcut* (Zapier Copilot, n8n's AI generator): you describe what you want, the canvas fills with nodes, then you edit the canvas. The canvas remains the canonical edit surface.

re-writeable already has the substrate primitives (`<script>` re-execution on render, inline JS, `window.modify()`, the lens, the audit log, frozen zones) to do something different. This document specifies that something.

## Core thesis

**The HTML document is the workflow.** Not "a workflow definition rendered in HTML." Not "an HTML wrapper around a workflow runtime." The `INLINE_DOC` literally contains the visible step structure *and* the executable code for each step. The agent generates both. The lens edits both. The runner is ~30 lines at the bottom of the doc that walks the steps on Run.

| | Source of truth | Edit surface | Where it runs |
|---|---|---|---|
| n8n / Make | JSON graph | 2D canvas | their cloud |
| Zapier (+ Copilot) | JSON graph | stack / Copilot generates | their cloud |
| LangGraph / Inngest | code | text editor | your server |
| **re-writeable workflow** | **structured HTML in `INLINE_DOC`** | **the lens (substantive); visual gestures (rearrange)** | **the browser** |

The unique slot is prose-source-of-truth, single-file, browser-local, lens-edited, agent-authored-code-per-step. No skill layer in v0.1. No registry, no installer, no shared catalog. Reuse comes later; for v0.1, every workflow is self-contained.

## The model

A workflow file is a single `.html` whose `INLINE_DOC` is:

1. A `<article class="rwa-workflow">` wrapper.
2. An `<ol class="rwa-flow">` of step cards.
3. Each `<li class="rwa-step">` contains:
   - A `<header>` with `<h3>` title and `<p>` description (visible).
   - A collapsed `<details>` containing the `<script type="text/rwa-step">` block.
   - An `<output class="rwa-step-output">` slot for last-run results.
4. A `<footer>` with one `<button class="rwa-run">Run</button>` plus a status region.
5. One runner `<script>` at the bottom of the doc.

The runner walks `document.querySelectorAll('li.rwa-step script[type="text/rwa-step"]')` in document order, compiles each into an async function, and chains them on Run click. Each step's compiled function is `async run(ctx, prev) → output`. The next step receives the previous step's return value as `prev`. A shared `ctx` object holds cross-step state. Outputs render into the step's `<output>` slot; errors stop the chain and highlight the failing step.

`type="text/rwa-step"` is the key trick: the browser ignores unknown script types, so the agent's generated code is *inert* in the DOM until the runner explicitly evaluates it. No accidental execution on render.

## Source format

Example shape — what the agent emits for the prompt *"Each morning, fetch my unread Gmail messages tagged Invoices, extract the PDFs, parse them, and append to a CSV file on disk."*

```html
<article class="rwa-workflow">
  <header>
    <h1>Morning Invoice Processor</h1>
    <p>Fetches new invoice emails, parses attached PDFs, appends to invoices.csv.</p>
  </header>

  <ol class="rwa-flow">
    <li class="rwa-step" data-rwa-id="...">
      <header>
        <h3>Fetch unread invoice emails</h3>
        <p>Calls Gmail API for unread messages with label "Invoices".</p>
      </header>
      <details>
        <summary>Code</summary>
        <script type="text/rwa-step">
          async function run(ctx, prev) {
            const token = await ctx.credentials.get('gmail');
            const r = await fetch(
              'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=label:Invoices is:unread',
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!r.ok) throw new Error(`Gmail: ${r.status}`);
            const { messages = [] } = await r.json();
            return { messageIds: messages.map(m => m.id) };
          }
        </script>
      </details>
      <output class="rwa-step-output"></output>
    </li>

    <li class="rwa-step" data-rwa-id="...">
      <header>
        <h3>Download PDF attachments</h3>
        <p>For each message, fetches PDF attachments as blobs.</p>
      </header>
      <details>
        <summary>Code</summary>
        <script type="text/rwa-step">
          async function run(ctx, prev) { /* ... */ }
        </script>
      </details>
      <output class="rwa-step-output"></output>
    </li>

    <!-- additional steps -->
  </ol>

  <footer class="rwa-workflow-footer">
    <button class="rwa-run">Run workflow</button>
    <span class="rwa-run-status" aria-live="polite"></span>
  </footer>
</article>

<script>
/* runner — same in every workflow file, ~30 LOC */
(function(){
  const steps = [...document.querySelectorAll('li.rwa-step')];
  const compile = (el) => {
    const src = el.querySelector('script[type="text/rwa-step"]').textContent;
    return new Function('ctx', 'prev',
      `return (async () => { ${src}; return run(ctx, prev); })()`);
  };
  const ctx = {
    credentials: {
      async get(key) {
        const v = sessionStorage.getItem('rwa_cred_' + key);
        if (v) return v;
        const entered = prompt(`Credential for ${key}:`);
        if (entered) sessionStorage.setItem('rwa_cred_' + key, entered);
        return entered;
      }
    }
  };
  document.querySelector('.rwa-run').addEventListener('click', async () => {
    let prev;
    for (const step of steps) {
      step.classList.add('running');
      try {
        prev = await compile(step)(ctx, prev);
        step.querySelector('.rwa-step-output').textContent =
          JSON.stringify(prev, null, 2);
        step.classList.remove('running');
        step.classList.add('done');
      } catch (e) {
        step.classList.remove('running');
        step.classList.add('failed');
        step.querySelector('.rwa-step-output').textContent =
          'Error: ' + e.message;
        break;
      }
    }
  });
})();
</script>
```

This is plain semantic HTML inside `INLINE_DOC`. The substrate's existing rendering, `data-rwa-id` backfill, frozen zones, lens anchoring, history, and undo all work unchanged. The runner uses the same inline-`<script>` re-execution path apps already rely on.

## Generation — text-to-workflow

The empty-state UX is the substrate's existing lens behavior with a workflow-flavored placeholder.

A fresh workflow file (created via `rwa new --kind workflow`) opens with:

- `INLINE_DOC` containing a near-empty skeleton: `<article class="rwa-workflow"><p class="placeholder">Describe what you want this workflow to do…</p></article>`. The lens default-state placeholder matches.
- The lens docked at the bottom in default state.
- `LENS_CLICK_TO_ANCHOR = false` for this kind (every block is implicitly anchorable; click-to-anchor isn't useful before there are steps).
- The `SYSTEM_PROMPTS.workflow` entry tells the agent that this is a workflow product type — `INLINE_DOC` is a list of executable steps; each step needs `<header>`, `<details>` with `<script type="text/rwa-step">`, and `<output>`; the runner script must be preserved.

The first user prompt (e.g. *"watch my inbox for invoice emails…"*) lands as `replace_document` per `rwa-lens-spec.md` §4.1 (first append into genuinely-empty doc). The agent generates the complete structure — title, steps, code, runner script. The lens drops to default state, ready for refinement.

Subsequent edits use the normal `apply_edits` / `apply_dsl_plan` path. The agent is good at this: workflow edits are overwhelmingly *structural* (insert step, rewrite a step's code, wrap two steps in a branch), which is exactly what `apply_dsl_plan` was designed for per `rwa-edit-dsl-spec.md` §12.

## Visual manipulation — the small fixed set

The lens is the primary editor for anything substantive. Visual gestures cover only direct manipulations where typing would be silly:

| Gesture | Where | Mechanism |
|---|---|---|
| Drag-to-reorder steps | visual | Synthetic `apply_edits` envelope swapping the two `<li>` source ranges |
| Delete step (⋮ menu → Delete) | visual | Synthetic `apply_edits` with `find = step source, replace = ""` |
| Insert step (`+` between cards) | visual → lens | `+` button opens the lens anchored to that gap; user types what to insert |
| Show / hide step code | visual | Native `<details>` toggle; no commit |
| Run | visual | The Run button; no edit |
| Edit step description | lens (anchored on step) | `/edit` slash command in anchored state |
| Edit step code | lens (anchored on step) | `/this step should also handle XML` |
| Add branch / parallel | lens (default) | Agent restructures `<ol>` |
| Whole-workflow restructure | lens (default) | `/run these in parallel`, etc. |

No property panel per step. No 2D canvas. No node-config UI. The visual is a stack of cards with five affordances (drag handle, delete, insert-between, show-code, run). Everything else is the lens.

Drag-to-reorder is the only gesture that needs new substrate code; the rest are HTML / lens behaviors that already exist. Reorder commits through the same modify/commit/audit machinery as everything else — it's just a structurally trivial `apply_edits` synthesized by the UI.

## Execution

The runner script is one of two things in the workflow file the agent must preserve: the `<article class="rwa-workflow">` structure and the trailing runner `<script>`. Both should be wrapped in frozen zones to prevent accidental damage from lens edits.

**Frozen zones for the workflow scaffold:**

```html
<!-- rwa:frozen:begin runner -->
<script>
(function(){ /* runner code */ })();
</script>
<!-- rwa:frozen:end runner -->
```

The agent can edit step bodies (description, code, output slot) freely, but the runner is locked. If a workflow needs runner changes (e.g. a parallel-execution variant), the user edits the file directly outside the lens — same escape hatch as for any frozen zone.

**Step execution model:**

- Each step's compiled function is `async run(ctx, prev) → output`.
- `prev` is the previous step's return value. The first step's `prev` is `undefined`.
- `ctx` is a shared object the runner constructs. It carries `ctx.credentials.get(name)` for the credential prompt; `ctx.signal` for cancellation (post-v0.1); future runner versions may add `ctx.log`, `ctx.shared`, etc.
- Steps return JSON-serializable values when possible (they render into `<output>` via `JSON.stringify`). Non-serializable values render as `[object Object]` and are passed through `prev` regardless.

**Error handling.** Throws stop the chain; the failing step is marked `.failed`; the error message renders into its `<output>`. No retry, no fallback. The user re-runs after editing (lens prompt: *"step 2 errored with X, fix it"*).

**Branches (post-v0.1 source shape).** A branch is a nested `<ol>` with a discriminator on its parent `<li>`:

```html
<li class="rwa-branch" data-rwa-id="...">
  <header><h3>If invoice total &gt; $1000</h3></header>
  <script type="text/rwa-step">
    async function run(ctx, prev) { return prev.total > 1000; }
  </script>
  <ol class="rwa-branch-true"> <!-- nested steps when true --> </ol>
  <ol class="rwa-branch-false"> <!-- nested steps when false --> </ol>
</li>
```

Branches and parallel groups can land in the runner incrementally — the source format already accommodates them via nesting. v0.1 ships with linear chain only; the runner gains branch handling when the first branched workflow demands it.

## Credentials

The same pattern the substrate already uses for the OpenRouter API key:

- `sessionStorage` per-key, prefixed `rwa_cred_<name>`.
- Prompted on first use via `ctx.credentials.get(name)`.
- Never persisted in `INLINE_DOC` (so sharing a `.html` doesn't leak keys).
- Cleared on tab close (sessionStorage semantics).

The agent's generated code uses `ctx.credentials.get('gmail')` etc. — readable names that match the prompt label. A workflow's preamble (the `<p>` under the title) should mention what credentials it needs so the user knows before pressing Run.

**Out of scope for v0.1:** OAuth flows, refresh-token plumbing, multi-account credentials. Workflows that need full OAuth either route through a backend the user already has, or wait for the skill layer to provide a proper credentials surface.

**CORS reality.** Browser fetch is CORS-bound. Services with CORS support (Stripe, OpenAI, Slack, GitHub, Linear) work out of the box. Services without CORS (Gmail without OAuth proxy, raw IMAP, most internal APIs) don't. This is a known v0.1 limitation. The lens should refuse to generate steps that obviously can't work in-browser; a follow-up tightening can validate generated `fetch` URLs against a CORS allowlist before commit.

## What `rwa new --kind workflow` produces

Six substitution regions in the seed at emit time, per `cli/src/seed.mjs` `kindOverrides`:

1. **`INLINE_DOC` body** — the empty-workflow skeleton:
   ```html
   <article class="rwa-workflow">
     <header><h1>Untitled workflow</h1></header>
     <p class="placeholder">Describe what you want this workflow to do…</p>
   </article>
   <!-- rwa:frozen:begin runner -->
   <script>/* runner — see design doc */</script>
   <!-- rwa:frozen:end runner -->
   ```
2. **`LENS_PLACEHOLDER`** — `"describe what you want this workflow to do"`
3. **`LEGACY_PAL_PLACEHOLDER`** — same as `LENS_PLACEHOLDER` (legacy ⌘K prompt fallback)
4. **`PRODUCT HEADER`** — `"<!-- product: workflow -->\n<!-- runs a sequence of agent-authored steps -->"`
5. **`PRODUCT_KIND`** — `"workflow"`
6. **`LENS_CLICK_TO_ANCHOR`** — `false`

Plus one new entry in `SYSTEM_PROMPTS.workflow` (per audit R1 — registry keyed by `PRODUCT_KIND`). The workflow framing must tell the agent:

- `INLINE_DOC` represents a workflow; each step is an `<li class="rwa-step">` with `<header>` (title + description), `<details>` containing `<script type="text/rwa-step">`, and `<output>`.
- Generated step code is an `async run(ctx, prev)` function returning JSON-serializable output.
- `ctx.credentials.get(name)` is the only way to read credentials.
- The frozen runner `<script>` must never be modified.
- Browsers run this code; only CORS-supporting APIs work.
- Each step's `data-rwa-id` is preserved across edits per existing protocol.

The shared `SYSTEM_PROMPT_RULES` (tool rules, DSL syntax, frozen-zone rules, `data-rwa-id` guidance) is appended unchanged.

## What is explicitly NOT in v0.1

- **No skill layer.** Each step's code is inline JavaScript. No skill installer, no permission grammar, no vault, no Worker isolation. This is acknowledged in the layer-cake doc as deferred and will land when concrete workflow pressure shapes the design.
- **No reuse.** Two workflows that fetch from the same API contain two copies of the fetch code. The agent regenerates from the prompt each time. Reuse is a v0.2+ concern, gated on the skill layer.
- **No catalog / registry / discovery.** Workflows are shared as `.html` files — copy, fork, edit. The existing `/publish` flow works unchanged.
- **No 2D canvas.** No drag-to-connect, no free node layout. Steps are a vertical stack.
- **No property panel per node.** The lens is the property panel for everything.
- **No DAG / branches / parallel execution.** Source format accommodates them via nested `<ol>`, but the runner ships linear-only. Branches land when the first branched workflow demands them.
- **No scheduling.** "Each morning" in a prompt becomes a description, not a cron trigger. The user clicks Run. Scheduling needs the skill layer or a long-lived runtime; both are out.
- **No retry / resume.** Failed runs stop. Re-run starts from the top. Resume-from-failure can land later via per-step output checkpointing in `runtime.shared.*`.
- **No OAuth.** sessionStorage-prompted strings only.

## Why this slot is uniquely re-writeable's

1. **Single file.** Publish via `/publish`; fork via save-as; version via Git. No accounts, no infra.
2. **Inspectable to the bone.** Every line of code that will execute is right there. Audit = expand `<details>`. No black-box connectors.
3. **The agent author IS the runtime author.** Same model writes the code and (on failure) rewrites it. No platform between user and code.
4. **LLM-native medium.** Inline JavaScript + semantic HTML is what modern LLMs produce most reliably. JSON node graphs are what they fail at most.
5. **Lens inheritance.** Click-to-anchor, slash commands, scoped edits, locked regions, undo, audit log — every workflow gets all of these free.
6. **Render-from-source honesty.** The visual is a CSS rendering of the same DOM the runner executes against. The view can never disagree with the runtime — there's no separate "view source" mode that secretly differs.
7. **Forward-compatible with the skill layer.** When the skill layer lands, a step's inline `<script>` can be swapped for a skill invocation with the same `<li class="rwa-step">` wrapper. Files written against v0.1 migrate trivially.

## Open choices to validate during implementation

- **Default view of code: shown or hidden?** I've specified `<details>` collapsed by default. Workflow authors may prefer visible code so the file is self-documenting at a glance. Trial both.
- **Where last-run output persists.** Inside `<output>` in `INLINE_DOC` (gets committed, visible after reload) vs. in a separate IDB store (clean separation between definition and runs). I'd default to the first for v0.1 — simplicity wins — but it means the file size grows with each run. Add a "clear outputs" affordance.
- **What `data-verb` is for.** I previously proposed `data-verb="fetch"` etc. for icon-styling per step. v0.1 can skip it — the `<h3>` title is enough to identify the step visually. Add `data-verb` only if the CSS-only diagram view needs it.

## Implementation order

A rough sequencing for the implementing agent (not a hard plan; the order is what matches the substrate's existing seams):

1. Add the workflow body / placeholder / prompt entries to `cli/src/seed.mjs` `KIND_TABLE` and `seeds/rewritable.html` `SYSTEM_PROMPTS.workflow`. Regenerate references.
2. Decide where the runner script lives. Two options: (a) inline in the workflow seed body (per-file, frozen), (b) part of the substrate runtime, behind a feature check on `<article class="rwa-workflow">`. (a) is more self-contained; (b) keeps step files smaller. I'd start with (a) — the runner is small and the "the file is the workflow" pitch is stronger.
3. Style the workflow product type: card layout for steps, vertical flow connectors, run button, output slots, running/done/failed states. Pure CSS; no JS framework.
4. Wire up the five visual gestures (drag-reorder, delete, insert-between, show-code, run). Reorder and delete commit via synthetic `apply_edits` envelopes through the existing modify pathway.
5. Smoke-test text-to-workflow end-to-end with a real model. The "morning invoice processor" prompt above is a reasonable benchmark.
6. Add a workflow scenario or two to `benchmark/` once the prompt is stable, mirroring the existing conformance / fidelity harness.

The substrate work is small: a CSS block, a runner script (~30 LOC), four event handlers for the visual gestures, one new entry in `SYSTEM_PROMPTS`, one new `KIND_TABLE` row. Almost everything else is "the lens already does this."

---

*Validated 2026-05-18 in conversation. The HTML document is the workflow. Each step is an `<li>` containing a `<header>`, an inert `<script type="text/rwa-step">`, and an `<output>`. The agent generates everything; the lens edits everything; a frozen runner script walks the steps on Run. No skill layer, no canvas, no reuse — defer all three until concrete pressure justifies them.*
