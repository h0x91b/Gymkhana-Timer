/**
 * Static dev server for the Gymkhana Timer PWA.
 *
 * Usage:
 *   bun run start            # defaults: port 8080, binds to 0.0.0.0
 *   PORT=3000 bun run start  # override port
 *   HOST=127.0.0.1 bun run start
 *   TUNNEL=0 bun run start   # disable the cloudflared quick tunnel
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
 *
 * Dev dep:
 *   `qrcode-terminal` — draws an ANSI QR block in the terminal. Dev-only;
 *   the shipped PWA has zero runtime dependencies.
 */

import { stat, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { networkInterfaces } from "node:os";
// @ts-expect-error — no types ship with qrcode-terminal; tiny API, used via .generate
import qrcode from "qrcode-terminal";

const ROOT = resolve(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

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

const server = Bun.serve({
	port: PORT,
	hostname: HOST,
	fetch(req) {
		const url = new URL(req.url);
		const safe = resolveSafe(url.pathname);
		if (!safe) return new Response("Forbidden", { status: 403 });
		return serve(safe);
	},
});

console.log(`Gymkhana Timer dev server`);
console.log(`  Local:   http://localhost:${server.port}`);
for (const addr of lanAddresses()) {
	console.log(`  LAN:     http://${addr}:${server.port}  (camera needs HTTPS off localhost)`);
}
console.log(`  Root:    ${ROOT}`);
console.log(`  Stop:    Ctrl-C`);

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
