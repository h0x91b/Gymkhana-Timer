# 012 — CI-generated build info for the UI stamp

## Context

The app is a static no-build PWA, but the UI needs to show which version is running and when that deployed build was made. `CACHE_VERSION` already identifies the installable bundle, while browser `Last-Modified` headers are host-dependent and unreliable once the service worker serves cached responses.

## Investigation

The simplest client-only option was to fetch `sw.js`, parse `CACHE_VERSION`, and display the response timestamp. That worked only when the network/header path was honest; offline PWA launches and cache-first responses could make the timestamp ambiguous or missing.

## Decision

Add a tiny `build-info.js` module with the same static module shape in source and production. Source renders as a local dev build; the GitHub Pages deploy job overwrites the module just before uploading the Pages artifact, copying `CACHE_VERSION` from `sw.js` and stamping `builtAt` plus `GITHUB_SHA`.

## Risks

Authors still have to bump `CACHE_VERSION` for releases, because that remains the PWA cache invalidation key. If another host deploys the repo without running the GitHub Actions step, the UI will correctly show `dev` rather than a fabricated build time.

## Alternatives considered

- Parse `sw.js` at runtime and use the HTTP `Last-Modified` header: fewer files, but unreliable under service-worker cache-first behavior.
- Add a full build pipeline that injects constants: accurate, but contradicts the project's no-build architecture.
- Use `package.json` version only: stable, but it says nothing about the deployed artifact or publish time.
