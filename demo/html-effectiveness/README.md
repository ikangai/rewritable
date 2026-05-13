# html-effectiveness — original vs. rewritable

Side-by-side comparison: twenty single-file HTML examples from [thariqs.github.io/html-effectiveness](https://thariqs.github.io/html-effectiveness/), each also imported into a re-writeable container via `rwa import`.

## Layout

- `original/01.html` … `20.html` — pinned copies of the source pages, downloaded `2026-05-13`. Source repository: <https://github.com/thariqs/html-effectiveness>.
- `rewritable/01.html` … `20.html` — the same content imported into a re-writeable container. Bootstrap is byte-identical across all twenty (modulo `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` body).
- `index.html` — a static index page with tab navigation and side-by-side iframes (`#01`–`#20` hash routes).

## How the rewritable side was generated

```sh
for n in 01 02 03 … 20; do
  rwa import "original/${n}.html" "rewritable/${n}.html"
done
```

`rwa import` extracts `<style>` blocks from `<head>`, takes `<body>` content (or the whole document if no `<body>` tag), preserves `<script>` tags with a stderr warning, and drops the result into the seed's `INLINE_DOC` template literal.

## Notes

- Interactivity is preserved across all twenty — the light/dark toggle (02), slide-deck arrow-key nav (09), tabbed code panes (14), kanban drag-reorder (18), and so on all behave the same on the rewritable side.
- The lens chrome floats at `bottom:24px` over the document. Content pinned at the bottom of the viewport in the original may be partially occluded in the rewritable version.
- The originals are third-party content. The author retains copyright; this folder snapshots them for offline comparison.
