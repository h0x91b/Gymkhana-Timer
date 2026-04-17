# AGENTS.md — Gymkhana Timer

This file is the canonical agent/contributor guide for this repo.

> `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`, never the symlink. The symlink exists so every agent (Claude Code, Cursor, Codex, Aider, etc.) reads the same instructions regardless of which filename convention it follows. If both files show up in a diff, that's expected.

## What this project is

A PWA that times motorcycle gymkhana runs by watching the start/finish line through the phone's camera. The phone sits on a tripod and **does not move** during a run — that invariant is what makes detection simple.

Full spec: [`TZ.md`](./TZ.md). Read it before making non-trivial changes.

## UI design — DESIGN.md is MANDATORY

**Every UI change — new component, restyle, layout tweak, new screen — MUST follow [`DESIGN.md`](./DESIGN.md).** Read it before touching any visual code. It is the single source of truth for colors, typography, spacing, radii, shadows, and component styling.

Summary of what that means in practice:

- **Warm palette only.** Every neutral has a yellow-brown undertone. No cool blue-grays. Backgrounds are Parchment (`#f5f4ed`) or Ivory (`#faf9f5`) on light, Near Black (`#141413`) on dark — never pure white, never pure black.
- **Typography split.** Anthropic Serif (fallback Georgia) for headlines and the timer display — single weight 500 only, no bold. Anthropic Sans (fallback system-ui) for all UI text. Anthropic Mono (fallback ui-monospace) for code and debug output.
- **Terracotta (`#c96442`) is the only chromatic accent.** Reserve it for the primary CTA and the single highest-signal brand moment on any screen.
- **Ring shadows, not drop shadows.** Depth comes from `0px 0px 0px 1px` rings in warm grays (`--ring-warm`, `--ring-deep`). Drop shadows, when used at all, are whisper-soft (`rgba(0,0,0,0.05) 0px 4px 24px`).
- **Generous radii.** 8px for standard buttons/cards, 12px for primary buttons and inputs, 16–32px for featured containers and media.
- **Relaxed body line-height.** 1.60 for body text, 1.10–1.30 for headings.

All tokens (colors, radii, shadows, font stacks) are declared as CSS custom properties in [`style.css`](./style.css). **Never inline hex values in components** — use `var(--token)`. If a needed token is missing, add it to `style.css` (in both themes if applicable) and document it there.

When in doubt, open `DESIGN.md`'s "Agent Prompt Guide" section — it has copy-paste-ready descriptions for common components.

## Response style — Decision-First

When replying to the user, optimize for fast scanning and minimum necessary text.

- Aim for something the user can read in 10–15 seconds on normal task updates.
- Prefer short sentences, concrete nouns, direct verbs.
- No background unless it changes the decision. No restating the request. No summary of what was just done — the diff is the summary.
- When a choice has multiple viable options, use this structure:

  ```
  ============= [CANDIDATES] =============
  ============== [DECISION] ==============
  ================ [WHY] =================
  ================ [NEXT] =================
  ```

  Show 2–5 options in `CANDIDATES`, mark the chosen one with `(chosen)`, keep each option to ≤5 short lines. `DECISION` is where the pick gets explained.

- For any code change, end the reply with the [`## Test instructions`](#test-instructions) block.

## Language policy

**All code-facing text MUST be in English.** No exceptions.

Applies to:
- Commit messages
- Changelog files (`change-logs/`)
- Decision records (`decisions/`)
- Code comments and identifiers
- PR titles and descriptions
- Any text written into source files

The user communicates in Russian; agents reply in Russian. But anything persisted into the codebase or git history is English only.

## Tech constraints (non-negotiable)

- **Vanilla JS, no frameworks.** No React/Vue/Svelte/etc. Native ES modules, loaded directly — no bundler required.
- **No backend.** Fully client-side. No accounts, no telemetry, no analytics.
- **No OpenCV.js.** Diff is hand-rolled over `getImageData` on a downscaled ROI.
- **No npm runtime deps.** Dev tooling (a static server, a linter) is fine; the shipped app stays dependency-free.

## Architecture

```
index.html        UI shell: <video>, <canvas> overlay, controls
app.js            entry + state machine (IDLE → WAITING_START → RUNNING → FINISHED)
camera.js         getUserMedia + requestVideoFrameCallback wrapper
detector.js       background subtraction on a downscaled ROI
roi.js            tap-to-pick ROI on the overlay
timer.js          timer display + speechSynthesis feedback
storage.js        run history in localStorage
style.css         fullscreen HUD styling
manifest.json     PWA manifest (fullscreen, landscape)
sw.js             service worker (cache-first offline)
icons/            PWA icons (192, 512) — see icons/README.md
change-logs/      one entry per session (see below)
decisions/        architectural decision records (see below)
```

State machine lives in `app.js`. The detector is stateless w.r.t. the run — it only reports "motion crossed threshold" with a cooldown; `app.js` interprets the first trigger as start, the second as finish.

## Timing — read this before touching timer code

- **Authoritative timestamp is `metadata.mediaTime`** from `requestVideoFrameCallback`. It is the frame's own clock, in seconds, sub-millisecond precision.
- Do **not** use `performance.now()` / `Date.now()` for the elapsed value that goes into the result. They drift relative to frame capture because of processing jitter.
- `performance.now()` is acceptable only for the cosmetic smooth tick while running. The final displayed result must come from `t1.mediaTime - t0.mediaTime`.
- Web frame-rate ceiling is typically 30 FPS (33 ms quantization). Fine for gymkhana. Ask for 60 via constraints but don't rely on it.

## Detection — subtleties that bite

- `getImageData` on a full frame is slow. Always read only the ROI, downscaled to ≤ ~240 px on the long side before diffing.
- False triggers: shadows at low sun angle, other riders/people/birds in frame, cloud shadows shifting ambient light. Mitigations in `detector.js`: narrow ROI, tunable `threshold`, 1–2 s cooldown after each trigger.
- Cooldown is critical — without it the bike's own motion between the two finish-line cones fires start and finish on the same pass.
- Reference frame is averaged over the first N frames after arming to smooth sensor noise. If ambient light drifts over a long session, re-arm between runs.

## PWA

- Service worker caches all shipped assets. **Bump `CACHE_VERSION` in `sw.js` on every deploy** or users keep stale code forever.
- Wake Lock is requested on camera start so the screen doesn't sleep mid-run.
- Icons must be real PNGs before installs work on strict Android builds; placeholders are acceptable during development.
- Must be served over HTTPS (or `localhost`) for `getUserMedia` and service worker to function.

## Local development

Runtime for tooling is **Bun** (`>=1.1.0`). The shipped app has zero runtime deps. `qrcode-terminal` is a **dev-only** dependency used by the dev server to draw a QR code in the terminal; it never reaches the shipped bundle.

```bash
bun install                # first-time only — installs the dev deps
bun run start              # static server + cloudflared tunnel + QR + live reload
PORT=3000 bun run start    # override port
TUNNEL=0 bun run start     # skip the cloudflared tunnel (local-only)
DEV_RELOAD=0 bun run start # skip the live-reload shim (e.g. when testing the SW itself)
```

`bun run dev` is an alias for `bun run start`. The server script is [`scripts/dev-server.ts`](./scripts/dev-server.ts) — a `Bun.serve`-based static server. It serves files from the repo root, disables caching (so the service worker and source files always refresh), rejects path-traversal attempts, and prints LAN addresses on startup.

### Live reload

The server injects a tiny `<script>` shim before `</body>` in every served HTML response. The shim opens an SSE connection to `/_dev/reload`. A `fs.watch(ROOT, { recursive: true })` watcher on the server — filtered to ignore `.git/`, `node_modules/`, `change-logs/`, `decisions/`, `.dev3/`, `.claude/`, and dotfile / swap-file noise — broadcasts a `reload` event on any real change. The browser then unregisters the service worker, `caches.delete()`s every cache bucket, and calls `location.reload()`, so the next request actually hits the network instead of the stale SW cache. Disable with `DEV_RELOAD=0 bun run start` when you're testing the SW itself.

### Camera on a phone

`getUserMedia` and service workers require **HTTPS off `localhost`**. The dev server solves this automatically: on every start, it spawns a [`cloudflared`](https://github.com/cloudflare/cloudflared) quick tunnel (`cloudflared tunnel --url http://localhost:$PORT`) and prints the resulting `https://*.trycloudflare.com` URL **plus a QR code** in the terminal. Scan with a phone camera and you're testing over HTTPS in one step — camera + service worker both work.

- Install: `brew install cloudflared` (macOS) / see upstream docs for other platforms.
- Disable for offline / local-only work: `TUNNEL=0 bun run dev`.
- If `cloudflared` is missing, the tunnel is silently skipped and the local server keeps working.
- Each run gets a fresh subdomain — don't bookmark it, just scan the new QR each time.

Rationale and alternatives considered: [`decisions/002-dev-server-cloudflared-tunnel.md`](./decisions/002-dev-server-cloudflared-tunnel.md).

## Git

### Worktree

Agents typically run inside a **git worktree**, not the main working tree. Find the main project path with `git worktree list` (the first entry is the main working tree). When referencing the original project (reading a secret, copying a config, inspecting main branch state), use that path. Never write to the main working tree from a worktree — only read.

### Committing

- **ALWAYS commit immediately after any change — this is mandatory, not a suggestion.** Every edit, however small (a typo fix, a one-line tweak, a comment), gets committed the moment the change is on disk and makes sense as a self-contained unit. Do not batch up unrelated changes. Do not wait for the user to ask. Do not leave the working tree dirty across messages. If you finish editing and realize you haven't committed, commit before writing anything else to the user.
- **Commits in English only** (per [Language policy](#language-policy)). Use a HEREDOC for multi-line messages so formatting survives the shell.
- **Do NOT `git push` automatically.** Let the user decide when to push. If the user doesn't ask, mention briefly at the end (`(git push не делал)`) so they know.
- **Always include `.claude/` changes.** The `.claude/` directory (e.g., `settings.local.json`) gets modified automatically during agent sessions via UI — those changes are part of the session, include them.
- **Never let git open an editor.** Always pass messages inline (`git commit -m "..."`, `git tag -m "..."`). For continue-style operations, force non-interactive mode (`GIT_EDITOR=true git rebase --continue`, `git merge --continue --no-edit`, `git cherry-pick --continue --no-edit`).
- **Remember: changelog entry + decision record (if applicable) go in the SAME commit as the code change.** Never commit code without its changelog line.

### GitHub CLI (`gh`)

The repo lives under `~/Desktop/src-shared/`, so use the **`h0x91b`** account. Before running `gh` commands:

```bash
gh auth switch --user h0x91b 2>/dev/null || true
```

No-op for collaborators without that account configured.

## Changelog policy

**For every code change, create a changelog entry file.** This avoids merge conflicts when multiple agents work in parallel on different tasks.

- **Path:** `change-logs/YYYY/MM/DD/<type>-<short-slug>.md`
- **Type prefixes:** `feature-`, `fix-`, `refactor-`, `docs-`, `chore-`
- **Content:** plain text, 1–3 sentences, one paragraph max. No frontmatter, no headers.
- **One worktree = one changelog file.** A single task (worktree) produces exactly one changelog entry for the whole session — not one per commit, not one per subtask. If the task evolves, append to or update the existing entry.
- **Include the changelog file in the same commit as the code change.**
- The slug must be descriptive enough to avoid collisions with other agents working in parallel.

See [`change-logs/README.md`](./change-logs/README.md).

## Decision records

Document non-obvious architectural decisions, hacks, and workarounds in `decisions/`. This explains **why** to future agents and humans — not just what.

**Create a decision record when:**
- You relied on undocumented browser behavior or reverse-engineered internals
- You picked a non-obvious approach over a simpler one for a specific reason
- You implemented a workaround for a browser / API limitation
- The decision involves trade-offs or known risks worth documenting

- **Path:** `decisions/NNN-short-slug.md` (sequential numbering; check existing files for the next number)
- **Required sections:** `Context`, `Investigation` (if applicable), `Decision`, `Risks`, `Alternatives considered`
- **Keep it short.** Each section 2–4 sentences. Fits on one screen. Link to relevant file + function names.
- Include the decision file in the same commit as the code change.

See [`decisions/README.md`](./decisions/README.md).

## Bug fixing — reproduce first

When fixing a bug, start by reproducing it precisely before touching the fix.

1. Write down exact repro steps (what to click, what to expect, what actually happens) in the changelog entry or decision record.
2. If the bug is testable in code (pure logic in `detector.js`, `storage.js`), write a minimal HTML test harness or `<script type="module">` snippet that triggers the bug before fixing it.
3. Fix the code, verify the repro is gone, commit both together.

Exception: bugs that depend on camera hardware, specific lighting, or device-specific timing — skip the reproduction harness, but document the repro steps in the changelog regardless.

## Parallelism — TeamCreate over Agent (when available)

If the `TeamCreate` tool is available and you're about to spawn one or more agents for research or parallel work — **use `TeamCreate`** instead of the `Agent` tool. Team members run as independent peers and are the correct delegation mechanism.

Valid reasons to use `Agent` directly:
- A team member itself needs a sub-agent for an internal sub-task.
- The task is trivially small (single file read, single grep) where `Read`/`Grep`/`Glob` is more appropriate than any delegation.

If `TeamCreate` isn't available in this environment, use `Agent` normally.

## Test instructions

**Every task that changes code ends with a `## Test instructions` section** in the final reply to the user. This is the TL;DR — the user should be able to verify the work without reading the conversation.

Format:

```
## Test instructions

1. Go to [place in the app]
2. Click [element] / Do [action]
3. Expected: [what should happen]
```

Rules:
- **Cover the entire task, not just the last change.** If the session added feature A, then fixed B, then tweaked C — all three must be verifiable. Mark the latest item with `(new)` so the user can spot what changed in the most recent iteration.
- **Be specific.** Exact labels, menu paths, expected console output, which phone orientation. "Open the app" is not enough.
- **Include negative cases when relevant.** E.g., "Arm without setting ROI — should stay disabled, not crash."
- **Replace, don't duplicate.** If you posted test instructions earlier in the conversation, the new version replaces them entirely. Always provide the full set.

For this project, test instructions are manual (run the static server, open in a browser / phone) — there is no automated test runner.

## Styling & design tokens

All colors, radii, fonts, and shadows are declared as CSS custom properties in [`style.css`](./style.css) and follow [`DESIGN.md`](./DESIGN.md). **Never hardcode hex/rgb values in rules** — always reference a `var(--token)`.

Key token groups (see `style.css` `:root` for the full list):

| Group | Tokens | Purpose |
|---|---|---|
| Surfaces | `--parchment`, `--ivory`, `--warm-sand`, `--dark-surface`, `--deep-dark` | Page/card/elevated/dark backgrounds |
| Text | `--fg`, `--fg-strong`, `--fg-button`, `--fg-2`, `--fg-3`, `--fg-on-dark` | Warm-toned text hierarchy |
| Borders | `--border-cream`, `--border-warm`, `--border-dark` | Containment |
| Rings | `--ring-warm`, `--ring-deep` | Signature `0 0 0 1px` depth halos |
| Brand | `--terracotta`, `--terracotta-hover`, `--coral` | The only chromatic accents |
| Semantic | `--focus` (blue, focus ring only), `--error` | Accessibility / errors |
| Radii | `--radius-sm` (8px) → `--radius-xl` (32px) | Per DESIGN.md scale |
| Fonts | `--font-serif`, `--font-sans`, `--font-mono` | Anthropic Serif/Sans/Mono with fallbacks |
| Shadows | `--shadow-whisper`, `--shadow-hud` | Depth |
| Status | `--status-idle`, `--status-waiting`, `--status-running`, `--status-finished` | Semantic state colors used inline |

**If you need a color or token that doesn't exist, add it to `style.css` in both the `:root` (light) and `[data-theme="dark"]` blocks. Don't inline arbitrary values.** Any new token must honor the warm-palette rule — no cool blue-grays.

Theme is toggled via `data-theme="dark"` on `<html>`. Default is light (Parchment).

## Internationalization (i18n)

All user-facing strings MUST be localized. The i18n system lives in [`i18n/`](./i18n/) and supports three locales: **English** (default / source of truth), **Russian**, and **Spanish**.

**Strict rule: never hardcode user-facing strings in HTML or JS.** Always go through the `t()` function or a `data-i18n-key` attribute.

### Public API

```js
import { t, tPlural, getLocale, setLocale, onLocaleChange, statusKey } from './i18n/index.js';

t('ui.arm');                                  // → "Arm" / "Готов" / "Armar"
t('voice.finish', { seconds: '42.3' });       // → "Finish. 42.3 seconds"
tPlural('history.runCount', 3);               // picks _one/_few/_many/_other automatically
setLocale('ru');                              // persists to localStorage("gymkhana-locale")
onLocaleChange(() => rerender());             // subscribe to changes
```

### HTML — declarative translation via attribute

Any element with `data-i18n-key="..."` has its `textContent` replaced on boot and on every locale change:

```html
<button id="btn-arm" data-i18n-key="ui.arm">Arm</button>
```

The English text in the HTML serves as a visible fallback if the i18n module fails to load.

### Layout

```
i18n/
├── index.js            — t, tPlural, getLocale, setLocale, onLocaleChange, statusKey
├── interpolate.js      — {var} substitution + Intl.PluralRules plural-form picker
└── translations/
    ├── en.js           — source of truth; every key must exist here
    ├── ru.js
    └── es.js
```

### Adding a new string

1. Add the key to `i18n/translations/en.js`.
2. Add the translation to `ru.js` and `es.js` using the same key.
3. Use `t("your.key")` in JS, or `data-i18n-key="your.key"` in HTML.
4. Keys are flat namespaced strings: `ui.startCamera`, `voice.finish`, `status.running`, `history.runCount_one`, etc.

### Pluralization

Use suffix convention `_one`, `_few`, `_many`, `_other`. The `tPlural(baseKey, count)` call appends the right suffix automatically based on the locale's plural rules (via `Intl.PluralRules`).

```js
// en.js — English only needs _one and _other
'history.runCount_one': '{count} run',
'history.runCount_other': '{count} runs',

// ru.js — Russian needs _one, _few, _many, _other
'history.runCount_one': '{count} заезд',
'history.runCount_few': '{count} заезда',
'history.runCount_many': '{count} заездов',
'history.runCount_other': '{count} заезда',
```

Call as `tPlural('history.runCount', count)`.

### Adding a new locale

1. Create `i18n/translations/<locale>.js` with the same keys as `en.js`.
2. Register it in `i18n/index.js` (`ALL_LOCALES`, `LOCALE_LABELS`, `TRANSLATIONS`).
3. Plural rules are handled by `Intl.PluralRules` — no manual code needed for any locale browsers already support.

### What NOT to translate

- Voice synthesis for the `voice.*` keys is locale-aware because they come from `t()`, but the `speechSynthesis` engine picks a voice based on `document.documentElement.lang` (kept in sync in `app.js`).
- Technical terms that are the same in every language (`ROI`, `FPS`, `PWA`) stay as-is.

## Deploy

Any static host. Known-good: GitHub Pages, Cloudflare Pages, Netlify. No build step — push the repo root. Remember to bump `CACHE_VERSION` in `sw.js`.

## Conventions

- ES modules, no build step. Relative imports with `./` prefix and `.js` extension.
- One responsibility per module. Export one class or a small set of related functions.
- No silent `catch { /* empty */ }`. At minimum `console.warn` the reason.
- Don't reintroduce frameworks, bundlers, or CSS preprocessors without an explicit ask.

## Out of scope (per TZ)

- OpenCV.js / heavy CV libs
- Any JS framework
- Backend, accounts, telemetry
- TensorFlow.js / ML detection (deferred to a potential v4; only if false-trigger rate becomes a real problem)
