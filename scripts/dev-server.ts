/**
 * Static dev server for the Gymkhana Timer PWA.
 *
 * Usage:
 *   bun run start              # defaults: port 8080, binds to 0.0.0.0
 *   PORT=3000 bun run start    # override port
 *   HOST=127.0.0.1 bun run start
 *   TUNNEL=0 bun run start     # disable the cloudflared quick tunnel
 *   DEV_RELOAD=0 bun run start # disable live-reload injection
 *
 * Notes:
 *   - Serves files from the project root.
 *   - Disables caching (dev) so the service worker and source files always
 *     refresh — production caching is handled by sw.js.
 *   - Camera + service worker require HTTPS off localhost. On start, this
 *     script spawns a `cloudflared` quick tunnel and prints the HTTPS URL as
 *     a QR code so you can open it on a phone in one scan. Requires
 *     `cloudflared` to be on $PATH (`brew install cloudflared`). If it's not
 *     installed or fails, the tunnel is silently skipped and the local
 *     server keeps working.
 *   - Live reload: every served HTML response gets a tiny <script> shim
 *     injected just before </body>. The shim opens an SSE connection to
 *     /_dev/reload and, when any watched file changes, unregisters the
 *     service worker, clears all caches, and calls location.reload() so
 *     the next request genuinely hits the network. Ignores noisy dirs
 *     (.git, node_modules, change-logs, decisions, .dev3, .claude).
 *
 * Dev dep:
 *   `qrcode-terminal` — draws an ANSI QR block in the terminal. Dev-only;
 *   the shipped PWA has zero runtime dependencies.
 */

import { stat, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { networkInterfaces } from "node:os";
// @ts-expect-error — no types ship with qrcode-terminal; tiny API, used via .generate
import qrcode from "qrcode-terminal";

const ROOT = resolve(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const DEV_RELOAD = process.env.DEV_RELOAD !== "0";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".ts": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

// =====================================================================
// Live-reload: SSE broadcaster + fs watcher + HTML shim injection.
// Everything in this block is dev-only. Production must not see any of it.
// =====================================================================

/** Connected browser tabs waiting for reload events. */
const reloadListeners = new Set<(event: string) => void>();

/**
 * Monotonic counter bumped on every watched file change. The shim polls
 * /_dev/version and triggers a reload whenever this number increases —
 * a dumb belt-and-braces fallback for environments where SSE is blocked
 * or buffered (some mobile carriers, overly aggressive proxies).
 */
let fileGeneration = Date.now();

function bumpGeneration(): void {
	fileGeneration = Date.now();
}

function subscribeReload(send: (event: string) => void): () => void {
	reloadListeners.add(send);
	return () => reloadListeners.delete(send);
}

function broadcastReload(reason: string): void {
	for (const send of reloadListeners) {
		try {
			send(reason);
		} catch {
			// Dead client — will be cleaned up by its own abort handler.
		}
	}
}

/**
 * Files / directories whose changes should NOT trigger a reload. Keeps the
 * watcher quiet during git operations, agent scratch writes, or log churn.
 */
const IGNORED_TOP_DIRS = new Set([
	".git",
	"node_modules",
	".dev3",
	".claude",
	"change-logs",
	"decisions",
]);

function shouldIgnoreChange(filename: string): boolean {
	if (!filename) return true;
	const parts = filename.split(/[\\/]/);
	if (IGNORED_TOP_DIRS.has(parts[0])) return true;
	// Editor swap / lock / dotfile churn.
	const base = parts[parts.length - 1];
	if (base.startsWith(".") || base.endsWith("~") || base.endsWith(".swp")) return true;
	return false;
}

/**
 * Client shim injected before </body> on every served HTML response.
 * Keeps the page state (camera permission, ROI, timer) only until the next
 * reload — the point of live-reload is exactly to get fresh code, so full
 * reload is fine here.
 *
 * Two jobs:
 *   1. Eagerly unregister any service worker + clear caches on every page
 *      load, so a stale SW from a prior session can't keep serving cached
 *      HTML without this shim. (Dev-only; production registers its own SW.)
 *   2. Subscribe to /_dev/reload SSE. On each "reload" event, tear down
 *      SW/caches again (in case a new one appeared) and call reload().
 */
const RELOAD_SHIM = `
<script>
(() => {
	const POLL_INTERVAL_MS = 5000;
	const tearDown = async () => {
		try {
			if ('serviceWorker' in navigator) {
				const regs = await navigator.serviceWorker.getRegistrations();
				await Promise.all(regs.map((r) => r.unregister()));
			}
			if ('caches' in window) {
				const keys = await caches.keys();
				await Promise.all(keys.map((k) => caches.delete(k)));
			}
		} catch (err) {
			console.warn('[dev-reload] cache teardown failed', err);
		}
	};
	// Fire-and-forget on every page load so a stale SW can't persist.
	tearDown();

	let reloading = false;
	const doReload = async (reason) => {
		if (reloading) return;
		reloading = true;
		console.log('[dev-reload] reloading — reason:', reason);
		await tearDown();
		location.reload();
	};

	// --- Fast path: SSE push (usually sub-second latency). -----------------
	if ('EventSource' in window) {
		console.log('[dev-reload] opening SSE /_dev/reload');
		const es = new EventSource('/_dev/reload');
		es.addEventListener('open', () => console.log('[dev-reload] SSE open'));
		es.addEventListener('reload', (e) => doReload('sse:' + e.data));
		es.addEventListener('error', (e) => {
			console.warn('[dev-reload] SSE error (auto-reconnects)', e);
		});
	} else {
		console.warn('[dev-reload] no EventSource — polling only');
	}

	// --- Slow-path fallback: 5 s polling. ----------------------------------
	// Runs in parallel with SSE. On networks / proxies where SSE is blocked
	// or aggressively buffered (some mobile carriers, Cloudflare edge under
	// certain configs), this is what actually triggers the reload. Worst-
	// case latency ≈ POLL_INTERVAL_MS.
	let lastGeneration = null;
	const poll = async () => {
		if (reloading) return;
		try {
			const res = await fetch('/_dev/version', { cache: 'no-store' });
			if (!res.ok) return;
			const { generation } = await res.json();
			if (lastGeneration === null) {
				lastGeneration = generation;
				console.log('[dev-reload] polling baseline gen=' + generation);
				return;
			}
			if (generation !== lastGeneration) {
				doReload('poll:gen=' + generation);
			}
		} catch (err) {
			// Server probably down or restarting — try again next tick.
		}
	};
	poll();
	setInterval(poll, POLL_INTERVAL_MS);
})();
</script>`;

/**
 * Dev-only replacement for sw.js. Whatever SW the app ships, under DEV_RELOAD
 * we override it with this stub. On install/activate it wipes every cache
 * bucket, unregisters itself, then navigates all controlled clients so they
 * reload free of SW interception. Result: a single refresh on a phone that
 * has a stale SW is enough to get into a clean, shim-enabled state.
 */
const DEV_SW_STUB = `
// Dev-only service worker stub — self-destructs and refuses to cache anything.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		try {
			const keys = await caches.keys();
			await Promise.all(keys.map((k) => caches.delete(k)));
		} catch {}
		try {
			await self.registration.unregister();
		} catch {}
		try {
			const clients = await self.clients.matchAll({ includeUncontrolled: true });
			for (const client of clients) {
				try { client.navigate(client.url); } catch {}
			}
		} catch {}
	})());
});
// Never serve from cache; just pass through.
self.addEventListener('fetch', (event) => {
	event.respondWith(fetch(event.request));
});
`;

function injectReloadShim(html: string): string {
	// Inject right before </body>; fall back to appending if the tag is absent.
	if (html.includes("</body>")) {
		return html.replace("</body>", `${RELOAD_SHIM}\n</body>`);
	}
	return html + RELOAD_SHIM;
}

function startWatcher(): void {
	if (!DEV_RELOAD) return;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingReason = "";
	try {
		watch(ROOT, { recursive: true }, (_event, rawFilename) => {
			const filename = typeof rawFilename === "string" ? rawFilename : rawFilename?.toString() ?? "";
			if (shouldIgnoreChange(filename)) return;
			pendingReason = filename;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				bumpGeneration();
				console.log(`  Reload:  ${pendingReason} → broadcasting (${reloadListeners.size} tab${reloadListeners.size === 1 ? "" : "s"}), gen=${fileGeneration}`);
				broadcastReload(pendingReason);
			}, 120);
		});
	} catch (err) {
		console.log(`  Reload:  fs.watch unavailable — live reload disabled (${err})`);
	}
}

// Padding comment to defeat intermediary proxy buffering (nginx, Cloudflare,
// some mobile carriers). A handful of proxies won't flush a response until
// a few KB of body have accumulated, which would delay or drop the first
// reload event. Preloading 2 KB of comment bytes flushes the buffer now.
// SSE comments start with ":" and are ignored by clients.
const SSE_PADDING = `:${" ".repeat(2048)}\n\n`;

function makeSseResponse(req: Request): Response {
	const encoder = new TextEncoder();
	let keepAlive: ReturnType<typeof setInterval> | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const enqueue = (text: string) => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// Controller already closed — nothing to do.
				}
			};
			const send = (event: string) => {
				enqueue(`event: reload\ndata: ${event.replace(/\n/g, " ")}\n\n`);
				// Extra padding right after a reload event to force any
				// proxy buffer to flush the event through immediately.
				enqueue(`: flush\n\n`);
			};
			// Initial padding + handshake comment so the browser considers
			// the connection established AND the proxy stops buffering.
			enqueue(SSE_PADDING);
			enqueue(`: dev-reload connected\n\n`);
			// Aggressive keepalive — 1 s. If a proxy is buffering, more
			// frequent writes give the client something to flush on.
			keepAlive = setInterval(() => enqueue(`: ping\n\n`), 1_000);
			const off = subscribeReload(send);
			const abort = () => {
				off();
				if (keepAlive) clearInterval(keepAlive);
				console.log(`  [dev]    SSE disconnect     (${reloadListeners.size} tab${reloadListeners.size === 1 ? "" : "s"} left)`);
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			};
			req.signal.addEventListener("abort", abort, { once: true });
		},
		cancel() {
			if (keepAlive) clearInterval(keepAlive);
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store, no-transform",
			connection: "keep-alive",
			// Tell nginx-family proxies (and any nginx-emulating edge) not
			// to buffer. Cloudflare quick tunnels in particular respect
			// this; without it the SSE stream can be held at the edge.
			"x-accel-buffering": "no",
		},
	});
}

function resolveSafe(urlPath: string): string | null {
	// Prevent path traversal — resolve and confirm it stays inside ROOT.
	const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
	const rel = normalize(decoded === "/" ? "/index.html" : decoded).replace(/^\/+/, "");
	const full = resolve(join(ROOT, rel));
	return full.startsWith(ROOT) ? full : null;
}

async function serve(path: string): Promise<Response> {
	let target = path;
	try {
		const info = await stat(target);
		if (info.isDirectory()) target = join(target, "index.html");
	} catch {
		return new Response("Not found", { status: 404 });
	}

	try {
		const body = await readFile(target);
		const mime = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";

		// Inject the live-reload shim into any served HTML. Never runs in
		// production — this server script is dev-only.
		if (DEV_RELOAD && mime.startsWith("text/html")) {
			const html = injectReloadShim(body.toString("utf8"));
			return new Response(html, {
				headers: {
					"content-type": mime,
					"cache-control": "no-store, must-revalidate",
				},
			});
		}

		return new Response(body, {
			headers: {
				"content-type": mime,
				// No dev-time caching — production caching is sw.js's job.
				"cache-control": "no-store, must-revalidate",
			},
		});
	} catch {
		return new Response("Not found", { status: 404 });
	}
}

function lanAddresses(): string[] {
	const out: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const iface of list ?? []) {
			if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
		}
	}
	return out;
}

/**
 * Short label for a request's origin — lets the trace log quickly tell
 * apart hits from your phone (ios/android), your laptop, and curl.
 */
function clientTag(req: Request): string {
	const ua = (req.headers.get("user-agent") ?? "").slice(0, 40);
	if (/iPhone|iPad/i.test(ua)) return "ios";
	if (/Android/i.test(ua)) return "android";
	if (/curl/i.test(ua)) return "curl";
	if (/Macintosh|Mac OS/i.test(ua)) return "mac";
	return "other";
}

const server = Bun.serve({
	port: PORT,
	hostname: HOST,
	fetch(req) {
		const url = new URL(req.url);
		const who = clientTag(req);

		// Dev-only SSE channel — sends a "reload" event whenever a watched
		// file changes. Never wired up in production builds.
		if (DEV_RELOAD && url.pathname === "/_dev/reload") {
			console.log(`  [dev]    SSE connect        from=${who}  (was ${reloadListeners.size} tab${reloadListeners.size === 1 ? "" : "s"})`);
			return makeSseResponse(req);
		}
		// Quick self-check: how many clients currently have SSE open, and
		// broadcast a synthetic reload so you can test end-to-end with curl.
		//   GET  /_dev/status         -> { "connected": N, "generation": N }
		//   GET  /_dev/trigger        -> fires a reload to all connected tabs
		if (DEV_RELOAD && url.pathname === "/_dev/status") {
			return Response.json({ connected: reloadListeners.size, generation: fileGeneration });
		}
		if (DEV_RELOAD && url.pathname === "/_dev/trigger") {
			bumpGeneration();
			broadcastReload("manual-trigger");
			console.log(`  [dev]    MANUAL trigger     gen=${fileGeneration}  (${reloadListeners.size} sse-tab${reloadListeners.size === 1 ? "" : "s"})`);
			return new Response(`triggered; ${reloadListeners.size} tab(s), gen=${fileGeneration}\n`);
		}
		// Polling fallback — client fetches this every N seconds and
		// compares against its last-seen generation. Cheap, ~30 bytes.
		// Works even when SSE is blocked/buffered by a proxy or carrier.
		// Intentionally NOT logged — it would spam the log every 5 s per tab.
		if (DEV_RELOAD && url.pathname === "/_dev/version") {
			return Response.json(
				{ generation: fileGeneration },
				{
					headers: {
						"cache-control": "no-store, must-revalidate",
						// Defeat any intermediate cache that ignores
						// cache-control (some mobile carriers, old proxies).
						"pragma": "no-cache",
						"expires": "0",
					},
				},
			);
		}
		// Dev-only: override sw.js with a self-destructing stub so a stale
		// SW from a prior session can't keep serving cached HTML without
		// the live-reload shim. Production users always get the real sw.js.
		if (DEV_RELOAD && (url.pathname === "/sw.js" || url.pathname.endsWith("/sw.js"))) {
			console.log(`  [dev]    sw.js STUB         from=${who}`);
			return new Response(DEV_SW_STUB, {
				headers: {
					"content-type": "text/javascript; charset=utf-8",
					"cache-control": "no-store, must-revalidate",
				},
			});
		}
		const safe = resolveSafe(url.pathname);
		if (!safe) return new Response("Forbidden", { status: 403 });
		// Log HTML navigations so you can see (a) whether a reload actually
		// re-fetches the page and (b) whether the shim is being delivered.
		if (url.pathname === "/" || url.pathname.endsWith(".html")) {
			console.log(`  [dev]    HTML ${url.pathname.padEnd(14)} from=${who}`);
		}
		return serve(safe);
	},
});

console.log(`Gymkhana Timer dev server`);
console.log(`  Local:   http://localhost:${server.port}`);
for (const addr of lanAddresses()) {
	console.log(`  LAN:     http://${addr}:${server.port}  (camera needs HTTPS off localhost)`);
}
console.log(`  Root:    ${ROOT}`);
console.log(`  Reload:  ${DEV_RELOAD ? "live (SSE + fs.watch)" : "disabled via DEV_RELOAD=0"}`);
console.log(`  Stop:    Ctrl-C`);

startWatcher();

/**
 * Spawn a cloudflared quick tunnel (`trycloudflare.com`), watch its log for
 * the assigned HTTPS URL, then print + QR-render it. Getting a real HTTPS
 * endpoint is the whole reason this exists — `getUserMedia` and service
 * workers refuse to run on plain HTTP off-localhost, so phone testing over
 * LAN is useless without a tunnel.
 *
 * The child process is killed on SIGINT/SIGTERM / parent exit.
 */
function startTunnel(port: number): void {
	if (process.env.TUNNEL === "0") {
		console.log(`  Tunnel:  disabled via TUNNEL=0`);
		return;
	}

	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(
			[
				"cloudflared",
				"tunnel",
				"--url",
				`http://localhost:${port}`,
				"--no-autoupdate",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
	} catch (err) {
		console.log(`  Tunnel:  cloudflared not found — skipping QR tunnel.`);
		console.log(`           Install it with: brew install cloudflared`);
		return;
	}

	let announced = false;
	const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

	const watch = async (stream: ReadableStream<Uint8Array> | null) => {
		if (!stream) return;
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			if (announced) continue;
			const text = decoder.decode(chunk);
			const match = text.match(urlRegex);
			if (!match) continue;
			announced = true;
			const url = match[0];
			console.log("");
			console.log(`  Tunnel:  ${url}`);
			console.log("");
			qrcode.generate(url, { small: true }, (qr: string) => {
				// qrcode-terminal prints with leading/trailing newlines already.
				process.stdout.write(qr);
				console.log(`  ^ scan on phone — HTTPS, camera works`);
			});
		}
	};

	watch(child.stdout as ReadableStream<Uint8Array>).catch(() => {});
	watch(child.stderr as ReadableStream<Uint8Array>).catch(() => {});

	const cleanup = () => {
		try {
			child.kill("SIGTERM");
		} catch {
			// Already dead — nothing to do.
		}
	};
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});
	process.on("exit", cleanup);

	child.exited.then((code) => {
		if (!announced) {
			console.log(`  Tunnel:  cloudflared exited with code ${code} before a URL was assigned.`);
		}
	});
}

startTunnel(server.port);
