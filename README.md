# Gymkhana Timer

Motion-triggered PWA lap timer for motorcycle gymkhana practice. The phone sits on a tripod facing the start/finish line; the camera detects the bike crossing the line and times the run.

- Spec: [`TZ.md`](./TZ.md)
- Design system: [`DESIGN.md`](./DESIGN.md)
- Contributor / agent guide: [`AGENTS.md`](./AGENTS.md)

## Run locally

Requires [Bun](https://bun.sh) `>=1.1.0`. No install step — the app has zero runtime deps.

```bash
bun run start              # http://localhost:8080
PORT=3000 bun run start    # override port
```

The dev server is [`scripts/dev-server.ts`](./scripts/dev-server.ts) — a tiny zero-dep `Bun.serve` script.

## Testing on a phone

Camera and service worker require HTTPS off `localhost`. The dev server spawns a `cloudflared` quick tunnel and prints a QR automatically — scan it with your phone and you're testing over HTTPS in one step.

## CI / Production deploy

Every push and PR is verified by [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — `bun build` smoke-tests `app.js` and `sw.js` and every JSON file is validated. Pushes to `master` that pass verification are auto-deployed to GitHub Pages (`https://h0x91b.github.io/Gymkhana-Timer/`). Bump `CACHE_VERSION` in [`sw.js`](./sw.js) before each release — without it, installed PWAs keep serving the previous bundle from the service-worker cache.
