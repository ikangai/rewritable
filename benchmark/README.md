# rwa-edit fidelity benchmark v1.3

Conformance + fidelity harness for `seeds/rewritable.html`.

The conformance layer is deterministic — no model in the loop. It loads the
seed in jsdom (mirroring `tests/e2e.mjs`) and invokes the runtime's
`applyEdits` / `replaceDocument` / `modify` APIs directly with hand-built
envelopes. Each conformance scenario is one of:

- **CONFORM-\*** — one per failure code in `rwa-edit-spec.md` §10
- **SHAPE / ATOM / SEQ / BOOTSTRAP** — hard-rule coverage (rules 9+10, 3, 6, 1)
- **AUDIT** — `rwa_hist` shape and ordering (§12)
- **MUTEX** — caller-held lock visibility (rule 8)
- **SNAPSHOT** — bootstrap byte-identity across edits (rwa container §11)
- **AUTHOR** — frozen-zone evolution via external editing (§7.2)
- **EDGE** — operationally-important edge cases the spec leaves implementation-defined

## Run

```sh
cd benchmark
npm install
npm run conformance
```

Final line of stdout is the metric: `<passing> / <total> conformance scenarios passing`.

## The graders have their own gates

Three lanes exist to keep the SCORERS honest, because a benchmark whose grader
quietly stops grading reports success indistinguishable from the real thing.
All three are model-free, offline, and run in CI:

```sh
npm run test:oracles      # 44 assertions on diff/selector/coherence/import-facts
npm run fidelity:control  # negative control: prove each drift detector fires
npm run cost:check        # ratchet suite prompt size (tokens_in, stub model)
```

`fidelity:control` is the one worth understanding. `fidelity:stub` asserts that
a perfect model scores perfectly — which a **dead** detector also satisfies, since
the correct drift under the stub is 0. The control asserts the other direction:
for each scenario it perturbs the input outside the declared edit region and
requires that scenario's own `stability()` oracle to notice. A scenario whose
oracle stays silent must say why:

| declaration | meaning |
|---|---|
| `driftProbe: 'envelope'` | stability reads the tool envelope, not the bytes |
| `driftProbe: 'none'` | no drift dimension (hardcoded score — runtime-behaviour or payload-shape test) |
| `driftProbe: 'custom'` | stability lives in `scoreAfterCustom` — routes to a third probe that runs the scenario for real and corrupts its result object |

No declaration is an exemption: `'custom'` ROUTES to a different probe rather than
skipping one. **Silence without a declaration is a build failure.** `'none'` scenarios are also
excluded from the `meanT` / drift aggregates — a hardcoded `score: 2` should not
vote on a dimension it never measures.

`npm run fidelity:baseline` is a narrower thing than its name suggests: it is a
*calibration* check that runs only scenarios carrying a `baselineDoc` (currently
one, FID-01) and prints how many it excluded. It is not a suite-wide control.

## Layout

```
benchmark/
├── package.json
├── runners/
│   ├── harness.mjs            # shared jsdom loader, runtime API exposure
│   ├── run-conformance.mjs    # discovers + runs scenarios/conformance/*.mjs
│   └── score.mjs              # TSV writer, summary formatter
├── scenarios/
│   └── conformance/
│       ├── conform-01.mjs     # one scenario per file, default-exporting { id, run }
│       └── ...
├── oracles/                   # diff/selector/runtime helpers (used by fidelity layer)
└── results/
    ├── conformance.tsv        # autoresearch loop log
    └── summary.md             # human-readable summary after a run
```

## Scenario module shape

```js
export default {
  id: 'CONFORM-01',
  description: 'apply_edits with version "rwa-edit/2" rejected as version_unsupported',
  category: 'CONFORM',
  weight: 1,
  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.applyEdits({ version: 'rwa-edit/2', edits: [{ find: 'x', replace: 'y' }] }, 'x');
      return { pass: false, reason: 'expected throw' };
    } catch (err) {
      return { pass: err?.code === 'version_unsupported', reason: `code=${err?.code}` };
    } finally {
      ctx.dispose();
    }
  },
};
```

`npm run trajectory` / `npm run trajectory:check` score document coherence (heading outline, class churn, dead CSS, id hygiene, markup-vs-text growth — `oracles/coherence.mjs`) across a scripted, model-free N-edit sequence per `scenarios/trajectory/*.mjs`, applied through the real commit path — see `runners/run-trajectory.mjs`'s header for exactly what the stub run does and doesn't measure.

## Print-fidelity scenarios

`scenarios/print/` is a separate test surface from conformance / fidelity:
self-contained HTML fixtures that exercise the runtime's `@media print`
stylesheet (page-break behavior, `@page` margins, runtime chrome hiding,
named pages, colour preservation). They can't run in jsdom — jsdom doesn't
paginate — so the runner is a thin headless-Chrome wrapper.

```sh
node benchmark/scenarios/print/generate.mjs   # regenerate the 23 .html fixtures
node benchmark/scenarios/print/validate.mjs   # print each → PDF → assert
```

Requires Chrome / Chromium on PATH or at the default macOS location, and
`pdfinfo` / `pdftotext` from `poppler` (`brew install poppler`).

PDFs land in `benchmark/results/print/<id>.pdf` — same basename as the
source fixture in `scenarios/print/<id>.html`, so you can open both
side-by-side or diff renders across runs. Both the validator output dir
and the generated PDFs are gitignored.

See `scenarios/print/MANIFEST.md` for the per-scenario catalog and
`scenarios/print/_runner-spec.md` for the design sketch of a larger
puppeteer-based runner (deferred — current text-only validator is
sufficient for the failure modes the print CSS protects against).
