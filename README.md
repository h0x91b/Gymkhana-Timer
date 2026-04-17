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

Camera and service worker require HTTPS off `localhost`. For phone testing over LAN, tunnel the local port through `cloudflared` or `ngrok`, or deploy the repo root to any static host (GitHub Pages, Cloudflare Pages, Netlify).
