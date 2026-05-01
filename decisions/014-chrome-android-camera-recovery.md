# 014 — Camera recovery on Chrome for Android requires full app restart

## Context

Reported on Samsung Internet **and** Xiaomi MIUI: opening the WebGL bench page (`webgl-bench.html`) works on first load and reaches a stable 60 FPS, but after the user backgrounds the tab via Alt-Tab, the lock screen, or app-switch, the camera never comes back when the tab returns. Closing and reopening the tab is **not** enough — only a full Chrome process restart (close-and-reopen the browser app) recovers the camera.

## Investigation

We added defensive recovery logic that handles all three plausible root causes through a single `recover()` routine triggered by `track.onended`, `visibilitychange='visible'`, and `webglcontextlost`/`restored`:

1. **MediaStreamTrack auto-ends.** `recover()` calls `getUserMedia(CAMERA_CONSTRAINTS)` again, swaps `srcObject`, and calls `play()`.
2. **WebGL context lost.** `webglcontextlost` listener does `preventDefault` and reloads after 2 s if the context is not restored; `webglcontextrestored` reloads to reuse the simple init path.
3. **`video.paused` becomes `true` and rVFC stops firing.** `recover()` calls `play()` and re-arms `requestVideoFrameCallback`.

None of the three branches helped. The user reports the only thing that works is closing **the Chrome process itself** and reopening it. New tabs in the same Chrome session (even after a hard-refresh button that clears every SW cache, unregisters every SW, and reloads with a cache-busting query) do not bring the camera back.

This is not specific to our page. It points at Chromium's per-process camera-track lifecycle on Android: once the renderer's tracks have been killed in some particular way during backgrounding, the per-process state appears to refuse subsequent `getUserMedia` calls until the Chrome process is restarted.

## Decision

Stop trying to "recover" inside a single Chrome process. Keep the existing defensive `recover()` paths since they cover the cheap wins (track-ended on a healthy process, plain `paused`-after-hide, in-renderer context loss), but accept that for the underlying Chromium bug there is **no in-app workaround**.

## Risks

- The behaviour can persist after future Chromium updates and silently degrade UX. Mitigation: the page log panel records `track ended`, `recover.getUserMedia` failures, and `webglcontextlost` events — a screenshot tells us whether any of our defensive branches fired before the user gave up.
- Users on Samsung Internet may hit the same path. Same workaround (close and reopen the browser).

## Alternatives considered

- **Programmatic full reload via `location.reload()` on visibility return.** Discarded: testing showed the same dead camera state after a fresh document load in the same Chrome process. Reload alone does not break out of the stuck per-process state.
- **Force `MediaStreamTrack.stop()` on every track on `visibilitychange='hidden'`.** Discarded: stopping ourselves on hide doesn't help — the failing path is the kernel-level / renderer-level kill that already happens. Pre-emptive stop adds nothing.
- **Switch to `MediaStreamTrackProcessor` + `VideoFrame.copyTo` to bypass the `<video>` element.** Promising in theory but does not solve the root issue (the underlying camera-device lease is what's stuck, not the video element). Also far less portable across Android versions.
