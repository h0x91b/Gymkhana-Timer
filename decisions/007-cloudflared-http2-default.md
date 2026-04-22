# 007 — Default the cloudflared quick tunnel to HTTP/2

## Context

`scripts/dev-server.ts` spawns `cloudflared tunnel --url http://localhost:$PORT`
to get an HTTPS URL for phone-side testing (`getUserMedia` + service workers
require HTTPS off-localhost). On the network we routinely dev on, the tunnel
printed its `https://*.trycloudflare.com` URL but the page never resolved:
the browser spun indefinitely.

## Investigation

Running `cloudflared tunnel --url http://localhost:8080 --no-autoupdate` by
hand reproduced the issue. Log pattern, repeated with exponential backoff:

```
INF Tunnel connection curve preferences: [X25519MLKEM768 CurveP256] … ip=198.41.192.57
ERR Failed to dial a quic connection error="failed to dial to edge with quic:
    timeout: no recent network activity" connIndex=0 …
INF Retrying connection in up to 2s …
```

QUIC is UDP/7844; the current network (residential ISP + VPN combo) drops or
heavily rate-limits it. Re-running with `--protocol http2` (TCP/7844)
registered a tunnel connection on the first attempt (`Registered tunnel
connection … protocol=http2 location=cdg15`) and the URL resolved.

## Decision

Pass `--protocol http2` by default when spawning cloudflared. Expose an env
escape hatch: `CF_PROTOCOL=quic bun run start` restores the original
behavior for networks where UDP works (QUIC is marginally faster on the
first handshake when it does connect).

## Risks

- HTTP/2 path multiplexing still works for SSE + dev-reload; tested live.
- Losing QUIC means slightly slower cold-start handshake — negligible for
  dev-loop latency (tunnel opens once per session).
- Cloudflare could deprecate the HTTP/2 fallback; the env override at least
  makes this a one-liner to revisit instead of editing the script.

## Alternatives considered

- **Auto-fallback on QUIC timeout.** Detect the dial-failure log line and
  respawn with `--protocol http2`. Rejected: adds ~15 s to every start on
  affected networks, plus stderr-parsing is brittle across cloudflared
  versions. The cost of just defaulting to HTTP/2 is effectively zero.
- **Leave QUIC as the default + document the workaround.** Rejected: the
  silent-hang failure mode is the worst possible UX — nothing logs the
  problem prominently, the URL looks alive, and new contributors lose
  time reproducing it.
- **Drop cloudflared, use ngrok / localtunnel.** Out of scope for this
  change; see decision 002 for why cloudflared was picked in the first
  place.
