/**
 * Zero-dependency static dev server for the Gymkhana Timer PWA.
 *
 * Usage:
 *   bun run start            # defaults: port 8080, binds to 0.0.0.0
 *   PORT=3000 bun run start  # override port
 *   HOST=127.0.0.1 bun run start
 *
 * Notes:
 *   - Serves files from the project root.
 *   - Disables caching (dev) so the service worker and source files always
 *     refresh — production caching is handled by sw.js.
 *   - Camera + service worker require HTTPS off localhost. For phone testing
 *     over LAN, tunnel via cloudflared or ngrok; this script is plain HTTP.
 */

import { stat, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { networkInterfaces } from "node:os";

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
