// Runtime version badge.
//
// Reads the currently-running `./sw.js` file and extracts CACHE_VERSION plus
// the response's Last-Modified header. This gives the user a visible
// "which build am I on?" signal in the HUD, which is invaluable when
// testing the in-app update flow — you can see at a glance whether the
// new SW has taken over after a reload.
//
// Why read it at runtime instead of baking it in at build time?
//
//   1. There is no build step. The app ships as plain ES modules; any
//      build-time constant would need an extra tool just to substitute.
//   2. Fetching `./sw.js` goes through the service worker's own cache, so
//      the version string we display is *actually* the version the SW
//      is using — it cannot drift from reality.
//   3. Last-Modified on the response mirrors the file's mtime on the
//      server (dev server or GitHub Pages / Cloudflare / Netlify all
//      emit it), which is effectively the deploy time.

const SW_URL = './sw.js';
const CACHE_VERSION_RE = /CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/;

/**
 * Populate the given element with a compact build-identity string, e.g.
 *   "v6 · 04-17 19:32"
 * On any failure (offline first-load, unexpected sw.js contents, etc.) the
 * element falls back to a dash so the HUD stays clean rather than showing
 * an error.
 */
export async function renderVersionBadge(el) {
  try {
    // cache: 'no-store' bypasses HTTP cache but NOT the service worker's
    // cache — the SW's fetch handler still sees the request and returns
    // the cached copy. That's exactly what we want: the version as the
    // running SW sees it, not whatever might be freshly on the network.
    const res = await fetch(SW_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`sw.js fetch returned ${res.status}`);

    const text = await res.text();
    const match = text.match(CACHE_VERSION_RE);
    if (!match) throw new Error('CACHE_VERSION not found in sw.js');

    // CACHE_VERSION is like "gymkhana-v6" — strip the namespace prefix for
    // display. Keep the full string as a tooltip for disambiguation.
    const full = match[1];
    const short = full.replace(/^gymkhana-/, '');

    const lastMod = res.headers.get('last-modified');
    const stamp = lastMod ? formatTimestamp(new Date(lastMod)) : null;

    el.textContent = stamp ? `${short} · ${stamp}` : short;
    el.title = lastMod ? `${full} · ${lastMod}` : full;
  } catch (err) {
    console.warn('Version badge failed:', err);
    el.textContent = '—';
  }
}

function formatTimestamp(d) {
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}
