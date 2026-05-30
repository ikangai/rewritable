# Affordance kernel extension — edit-surface + compute provider slots (design)

*Design, 2026-05-30, bohr. The "destination" euler framed (#63): extend the
provider kernel from `view`-only to the full taxonomy so a file that DOES
edit-surface + compute (the datatable) REGISTERS those providers and
`runtime.describe()` reports them LIVE — closing the truthfulness gap via the
verified registry, leaving the static `#rwa-affordances` declaration as a clean
bridge, not a crutch. Steps 5–7 of the R5 build sheet (workflow-derived,
verified against the seed @ 4249 lines). **Gated on euler's R5 (Steps 0–4) only
for the SEED WINDOW — Step 5's region is disjoint from R5's write-path.***

## Gate & disjointness

euler owns R5-v1 (Steps 0–4: `commitCore` + serialized commit queue + actor
passthrough + shared agent entry) at `seeds/rewritable.html` ~833 / ~2819–2899 /
~3440 / ~3786–3941. **My Step 5 touches a disjoint region** — the provider
registry at ~3447, `runtimeProvide` ~3489–3504, `describe()`'s affordance scan
~3561. No dependency on R5's queue (build sheet "ORDERING SUMMARY": Step 5 ⊥
Steps 2/4). So the only true gate is the one-seed-owner protocol: I land Step 5
in a handed-off window after euler's R5 (or, by agreement, a quick disjoint
window — euler's call since they hold it).

## Step 5 — extend the provider kernel (seed)

**5a.** `const providers = { view: null, 'edit-surface': null, compute: null };`

**5b.** `runtimeProvide(kind, spec)` accepts the new kinds. `edit-surface` /
`compute` are **declarative affordance records** requiring only `{kind, name,
label}` (the document's own JS owns the edit/compute logic — the provider just
makes `describe()` report it; no `render`/`ui`/`logic` execution contract is
invented for v1, Rule 2). `view` keeps requiring `render` (it is executed by
`setView`). Unknown kinds still throw (the guardrail — a file must not register a
phantom affordance, Rule 12). Returns an `unregister` closure.

**5c.** `describe()` scans all slots:
```js
const affordances = [];
for (const kind of ['view', 'edit-surface', 'compute']) {
  if (providers[kind]) affordances.push({ kind, name: providers[kind].name,
    label: providers[kind].label, provenance: providers[kind].__provenance || 'first-party' });
}
```

## Step 6 — datatable registers its real affordances (examples/datatable/_source.html)

Inside the datatable IIFE, before the final `render();`, behind a
`!window.__dtProvided` idempotency guard (the IIFE re-runs on every `renderDoc`):
`runtime.provide('edit-surface', { kind:'edit-surface', name:'cell', label:'…', surface:SURFACE, target:'#dt-data' })`
and `runtime.provide('compute', { kind:'compute', name:'total', label:'…',
inputs:['qty','unit_price'], output:'total' })`. Rebuild via
`node examples/datatable/build.mjs`. (Datatable is tesla's — coordinate the edit.)

## Step 7c — live-vs-static parity test

`tests/affordance-kernel.mjs` (this commit, RED until Step 5) pins
provide/describe for edit-surface+compute on a base document. Plus, in
`tests/datatable.mjs` (tesla's), assert the LIVE `describe()` affordances match
the static `#rwa-affordances` declaration — *honest by construction, no drift*.

## Invariants

No write-path change, so atomic commit / `currentDoc` / undo / frozen zones /
`data-rwa-id` are untouched (Step 5 is pure registry+describe). Invariant 1 holds
(runtime JS, no baked region, no commit-stamp). describe() still validates
against `tools/self-description.mjs` with the new affordances (the test asserts
it).

## How this composes with euler's describe()

euler's `describe()` already builds the affordances array from the registry
(`view` only today). Step 5c is a 3-line generalization of that same loop to scan
all slots. So when the datatable registers (Step 6), euler's describe() reports
them with zero rework — the registry is the single source both R5 and the
kernel-ext read.

---

*Status: design + RED test landed; seed impl (Step 5) awaits euler's R5 window.
Then Step 6 (datatable, w/ tesla) + Step 7c parity. Full build sheet (Steps 0–7,
exact edits) was workflow-derived; euler owns 0–4, bohr owns 5–7.*
