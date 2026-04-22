# 006 — Re-acquire Wake Lock on visibility change

## Context

`app.js:requestWakeLock()` asks for a screen Wake Lock when the user starts the camera so the phone doesn't sleep mid-run. The Screen Wake Lock spec requires the browser to **auto-release** the lock whenever the page stops being visible (tab switch, phone lock, app switcher, incoming call, battery-saver). Once released, there is no way to "resume" — the only remedy is to re-request.

Before this change, a single interruption (e.g., accepting a call between runs) left the phone on its default sleep timeout for the rest of the session.

## Decision

Add a `document.addEventListener('visibilitychange', ...)` listener in `app.js` that calls `requestWakeLock()` whenever `document.visibilityState === 'visible'`. Guard with a module-scope `wakeLockDesired` flag that is set by the first successful (or attempted) `requestWakeLock()` call, so we don't grab a lock on page load before the user has asked for the camera.

`requestWakeLock()` also attaches a `release` listener that clears the stored lock reference, so the next visibility-return path starts from a clean state.

## Risks

- **Silent retry failures.** If re-requesting fails (page still being torn down, permissions revoked), we only `console.warn`. Acceptable — the next `visibilitychange` will try again.
- **Extra lock requests.** If multiple `visibilitychange` events fire (some browsers fire on tab/window-level changes), `requestWakeLock()` short-circuits when `wakeLock && !wakeLock.released`, so no duplicate requests reach the API.
- **Battery.** Wake Lock only prevents screen sleep; it does not wake the CPU beyond normal. No additional battery cost vs. the existing behavior on first request.

## Alternatives considered

1. **Do nothing** — tell users "don't switch apps during a session." Rejected: the whole point of a Wake Lock is to survive real-world interruptions.
2. **`setInterval` to re-request every N seconds** — rejected: noisy, wastes CPU, and still races with visibility transitions.
3. **Hidden `<video>` autoplay / silent AudioContext** — keeps CPU alive but doesn't actually stop screen sleep on modern Android, and is the kind of hack the spec was written to replace.

Re-request on `visibilitychange` is the pattern explicitly recommended by MDN and the WICG spec examples.
