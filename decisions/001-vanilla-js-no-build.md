# 001 — Vanilla JS, no bundler, no framework

## Context

TZ.md explicitly rules out frameworks and heavy libs (OpenCV.js, React/Vue, etc.) because the app is small, single-purpose, and must ship as a PWA without a build step getting in the way of iteration. The question was whether to still add a minimal bundler (Vite/esbuild) for ergonomics.

## Decision

Ship plain ES modules loaded directly by the browser. No bundler, no TypeScript, no npm runtime deps. `index.html` references `app.js` as `type="module"` and every import uses a `./` prefix with a `.js` extension. Service worker caches the raw source files as-is (see `sw.js` `ASSETS` list).

## Risks

- No tree-shaking or minification — fine for a ~10-file project, would hurt at 10× this size.
- No type system — relies on JSDoc and discipline. For this project the surface area is small enough that this is acceptable.
- Adding a bundler later is a one-day refactor; the decision is reversible.

## Alternatives considered

- **Vite**: excellent DX, but introduces a build step, a `dist/` directory, and a deploy pipeline that has to stay in sync with the service worker cache list. Overkill at this size.
- **esbuild + single-bundle output**: smaller than Vite but same core downside.
- **TypeScript via `tsc --watch`**: adds a compile step without giving us a framework or bundler. Not worth it for ~500 LOC total.
