# 003 — Client-driven service worker activation

## Context

The PWA needs an in-app update flow so a rider who has installed the app on
their phone can pick up new code without uninstalling / reinstalling or
manually clearing site data. The previous `sw.js` called `self.skipWaiting()`
inside the `install` handler, which activates every new version immediately
but leaves the live page running the old JS until the next navigation. In
practice that produced "half-updated" sessions — new cache, old code — until
the user closed and reopened the app.

## Investigation

The textbook PWA update primitives are:

- `registration.update()` — forces a re-check of `./sw.js`.
- `registration.waiting` — the installed-but-not-active SW, if any.
- `ServiceWorkerRegistration.addEventListener('updatefound', …)` — fires when
  a new version starts installing.
- `self.skipWaiting()` — transitions the waiting SW to activating.
- `clients.claim()` — makes the newly activated SW take control of existing
  clients, which fires `controllerchange` in page code.

Call-site matters. Calling `skipWaiting()` in `install` gives zero client
control. Calling it in response to a `message` event gives the page UI a
chance to decide _when_. For gymkhana the timing matters: a silent reload
during `RUNNING` would kill the run; during `IDLE` / `FINISHED` it's free.

## Decision

- `sw.js` installs + caches but does **not** call `skipWaiting()`.
- `sw.js` listens for `{ type: 'SKIP_WAITING' }` messages and only then
  promotes the waiting SW.
- `app.js` polls `registration.update()` every 60 s and on `visibilitychange`
  (tab refocus) to find new versions promptly.
- On `updatefound → installed` (with an existing controller), `app.js`
  branches on `state`:
  - `IDLE` / `FINISHED` → post `SKIP_WAITING` immediately (silent reload).
  - `WAITING_START` / `RUNNING` → surface a `#btn-update` in the controls
    row; the rider clicks it when they're between runs.
- A single `controllerchange` listener guarded by `hadController` performs
  the one-shot `location.reload()` once the new SW takes over, and skips
  the first-install case where `clients.claim()` would otherwise trigger a
  spurious reload.

## Risks

- If the browser decides not to run the page's JS for a while (phone
  locked, tab backgrounded aggressively by battery saver), periodic
  `registration.update()` won't fire. On re-focus the `visibilitychange`
  handler catches up, so the worst case is "update picked up on next
  foreground," which matches user expectations anyway.
- `cache.addAll(ASSETS)` is still atomic — any missing asset path in
  `ASSETS` fails the whole install and the old SW stays in control.
  That's the correct fail-safe, but contributors bumping `ASSETS` need
  to keep it honest.
- The `controllerchange` reload path assumes the page can tolerate a
  reload; for gymkhana's short, bounded runs this is fine. A long-lived
  form-entry app would need a dirty-state check.

## Alternatives considered

1. **Keep `skipWaiting()` in `install`, reload on `controllerchange`.**
   Simple, but gives zero way to defer the update during a live run —
   the reload lands wherever `clients.claim()` fires.
2. **Never `skipWaiting`; wait for all tabs to close.** The default SW
   lifecycle. Safe, but on a phone the PWA is always the only open tab,
   so updates effectively require the user to kill the app manually.
   Unacceptable UX for this project.
3. **Full "reload to update" banner across the screen.** More visible,
   but noisy. A single small button in the controls row matches the
   app's minimal HUD aesthetic and follows DESIGN.md (terracotta for
   the one high-signal action).
