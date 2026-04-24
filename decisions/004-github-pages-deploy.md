# 004 — Deploy to GitHub Pages

## Context

The app is a PWA with a service worker that caches every shipped asset, so
once installed on a phone it can run fully offline. But "installed" is tied
to an **origin**: if a user installs the PWA from `http://localhost:3000` or
from a `https://*.trycloudflare.com` quick-tunnel URL, the installed app
points back at that origin — and both are ephemeral. Kill the dev server or
restart the tunnel and the installed PWA has nowhere to fetch updates from.

We need a stable, public HTTPS origin so the PWA survives dev-server
restarts and phone reboots.

## Investigation

Alternatives considered (see below). For a zero-dependency, zero-build
static app hosted by a single developer, **GitHub Pages** is the minimum-
friction option:

- The repo already lives on GitHub.
- Pages gives a stable HTTPS URL (`https://<owner>.github.io/<repo>/`) and
  unlimited free bandwidth for public repos.
- No build step, no Node toolchain at deploy time — GitHub's first-party
  `actions/upload-pages-artifact` + `actions/deploy-pages` workflow uploads
  the repo root verbatim.
- All asset references in `index.html`, `manifest.json`, and `sw.js` are
  already relative (`./foo`, not `/foo`), so the site works unchanged at
  any sub-path.

## Decision

Add `.github/workflows/pages.yml`: on push to `master` (and manual
`workflow_dispatch`), upload the whole repo as a Pages artifact and deploy.

- Workflow uses official first-party actions only
  (`checkout@v4`, `configure-pages@v5`, `upload-pages-artifact@v3`,
  `deploy-pages@v4`).
- `concurrency: pages` + `cancel-in-progress: false` serializes deploys so
  a rapid second push cannot race an in-flight one.
- The local `bun run start` dev server is untouched — it remains the
  fastest inner loop and the only path that provides live reload + a LAN
  QR code. Pages is production; dev-server is iteration.

## Risks

- **Stale service worker cache.** Users won't see a deployed update unless
  `CACHE_VERSION` in the published `sw.js` changes. The deploy job now
  rewrites it from GitHub Actions metadata before upload, so the
  client-driven update flow (see decision 003) gets a fresh version on
  every production deploy without relying on a manual source bump.
- **The repo is now publicly browsable.** Pages requires `public` repo
  visibility on the free plan. Everything already committed (including
  `AGENTS.md`, `decisions/`, `change-logs/`) becomes world-readable. No
  secrets are in the tree, but this is the moment to confirm that.
- **Custom domain / HTTPS.** The default `*.github.io` domain is HTTPS out
  of the box, which is required for `getUserMedia` and service workers.
  If we ever move to a custom domain, the `Enforce HTTPS` toggle in
  Settings → Pages must stay on.

## Alternatives considered

- **Cloudflare Pages / Netlify.** Same capability, extra provider account
  and build-config per site. No upside when the repo already lives on
  GitHub.
- **Named Cloudflare Tunnel.** Gives a stable subdomain without GitHub,
  but requires the developer's machine to be online for end users to
  reach the app — that defeats the "works offline forever after install"
  goal.
- **Android TWA (Bubblewrap) / Capacitor.** Wrap the PWA as a native APK.
  Real app icon, truly standalone, but requires Android SDK, signing, and
  a tool-chain that contradicts the project's "no build step, no deps"
  constraint. Parked as a possible v4 if the PWA story proves insufficient.
- **`file://` open.** Cannot be used — service workers refuse `file://`
  origins and `getUserMedia` is blocked in many browsers for local files.
