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
