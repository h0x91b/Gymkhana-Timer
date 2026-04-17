# 002 — Dev server launches a cloudflared quick tunnel with an in-terminal QR code

## Context

The dev server serves the PWA over plain HTTP. That is fine for browsing the
UI on a laptop, but the whole point of this project is phone-side camera
detection, and `getUserMedia` + service workers refuse to run on plain HTTP
off-`localhost`. Testing on a real phone over LAN was therefore useless
without an external tunnel (cloudflared / ngrok / localtunnel), and the
developer had to juggle a second terminal + paste or hand-type the HTTPS URL
on the phone every time.

## Investigation

Checked three tunnel options:

- **cloudflared quick tunnel** (`cloudflared tunnel --url http://localhost:PORT`) — anonymous, no account, no config files, stable `trycloudflare.com` subdomain per invocation, HTTPS by default. Prints the assigned URL to stderr once ready.
- **ngrok** — requires an auth token, rate-limited on the free plan, extra signup.
- **localtunnel** — free, but flaky and has unreliable CORS behavior.

Checked two terminal-QR approaches:

- `qrcode-terminal` npm package — ~6 KB, zero transitive deps, Node-compatible, renders UTF-8 half-blocks that scan reliably from most phone cameras.
- System `qrencode` CLI — requires `brew install qrencode` on every dev box; shell-out gets messy.

## Decision

- Spawn `cloudflared tunnel --url http://localhost:${PORT} --no-autoupdate` from `scripts/dev-server.ts` on every `bun run dev`.
- Watch the child's stdout + stderr for the first `https://*.trycloudflare.com` URL, then print it plus a QR code via `qrcode-terminal`.
- Opt-out via `TUNNEL=0 bun run dev` for environments without internet or when only local UI work is needed.
- Graceful skip (log + continue) if `cloudflared` is not installed.
- Kill the child on SIGINT/SIGTERM/exit so tunnels don't leak between sessions.
- Add `qrcode-terminal` as a **devDependency** only. The shipped PWA stays zero-dep (see `decisions/001-vanilla-js-no-build.md`).

## Risks

- **Each run burns a fresh `trycloudflare.com` subdomain.** The URL changes every restart, so any phone-side bookmarks go stale. Acceptable because we scan the QR each time anyway.
- **Anonymous quick tunnels are throttled.** Cloudflare reserves the right to rate-limit or drop them. Fine for manual testing, not for anything resembling production.
- **Tunnel exposes the dev server to the public internet.** Anyone with the URL can hit the static files until the tunnel is torn down. Since the repo is open source and the server only serves static files from the project root, the blast radius is low — but never run the dev server in a directory containing secrets.
- **Child process cleanup on abrupt kills.** If Bun is SIGKILL'd the `exit` handler won't fire and `cloudflared` can orphan. Rare on dev boxes; manual `pkill cloudflared` is the fallback.

## Alternatives considered

- **Hard-required cloudflared (fail fast if missing)** — rejected; people doing pure-UI work on the plane shouldn't hit an error.
- **Integrate ngrok** — rejected; auth token overhead for no clear benefit over cloudflared.
- **Ship a pure-JS QR encoder inline** — rejected; ~500 lines for a dev-only feature is not worth avoiding a single devDependency.
- **Named Cloudflare tunnel with a stable hostname** — would give a persistent URL, but requires Cloudflare account, `cert.pem`, DNS config. Over-engineered for personal phone-testing.
