# 004 — Pinch-zoom via CSS transform, not MediaStreamTrack hardware zoom

## Context

The rider needs to zoom in on the start/finish line to pick a tight ROI.
A first attempt used `MediaStreamTrack.applyConstraints({ advanced: [{ zoom }] })`
— the native camera zoom exposed by Chrome on Android. In practice it felt
clunky: discrete steps on some devices, no continuous response during the
gesture, zero support on desktop browsers, and no built-in pan.

## Investigation

Three ways to do pinch-zoom in a web app:

1. **Hardware zoom via `applyConstraints`** — simple API, transparent to
   detection (detector receives pre-zoomed frames), but UX is bad and
   coverage is limited to Android Chrome.
2. **CSS `transform: scale()` + translate** — wraps the video in a
   transformable element, hardware-accelerated, smooth 60 FPS, works on
   every browser. Detector still reads `video.videoWidth/Height` for
   intrinsic frames, so detection is unaffected.
3. **GestureEvent (`gesturestart/change/end`)** — Safari/WebKit only, not
   standard. Would force a split implementation.

For the pan-along-with-zoom requirement, only option 2 is free to implement
(options 1 and 3 need an extra pan layer anyway).

Desktop parity matters because the user tests on a MacBook trackpad.
Browsers emulate trackpad pinch as `wheel` events with `ctrlKey=true`
(historical convention; Chrome, Safari, Firefox all honor it). Two-finger
scroll arrives as plain `wheel` events. So a single `wheel` handler covers
the desktop path.

## Decision

Use approach **2**: a dedicated `viewport.js` module applies a CSS
`translate(tx, ty) scale(z)` to a `#viewport` wrapper around `<video>` and
the ROI overlay.

Two input paths feed the same transform:

- Pointer Events (mobile): two active `pointerId`s drive pinch distance
  (→ zoom) and midpoint drift (→ pan) with a single formula.
- Wheel events (desktop, incl. macOS trackpad): `ctrlKey` → exponential
  zoom around the cursor; plain wheel → pan by deltaX/deltaY.

`transform-origin: 0 0` keeps the math simple: a tap at client point
(clientX, clientY) in the viewport's intrinsic (pre-transform) space is
`((clientX − parentRect.left − tx) / z, (clientY − parentRect.top − ty) / z)`.

The ROI picker consumes `viewport.cssToIntrinsic()` so stored ROIs are
pinch-invariant — zooming after a pick never moves the ROI in video
coordinates.

## Risks

- Wheel-with-ctrlKey is a browser convention, not a standard. If a
  browser ever drops the emulation, macOS trackpad pinch would stop
  working. Safari on iOS could also introduce a conflict if it ever
  shipped desktop-style wheel emulation.
- `offsetParent` can be `null` for detached or `display: none` elements;
  viewport.js falls back to `parentElement` to handle that.
- Pinch gestures + single-finger taps share the overlay while the ROI
  picker is active. We disambiguate with `ev.isPrimary` (secondary
  touches don't add ROI points) and `body[data-gesturing="true"]`
  (taps during an active pinch are suppressed).
- On a small phone with a pinched-in zoom, two-finger pan can bring the
  edge of the viewport inside the visible stage. `_clamp()` forces the
  translate to keep the transformed viewport covering its parent.

## Alternatives considered

- **Hardware zoom (`applyConstraints`)** — clunky UX, no desktop support,
  no pan. Tried first, rejected after hands-on feedback.
- **Hybrid** (hardware zoom on Android, CSS elsewhere) — two code paths
  for the same feature; cognitive overhead not worth the saved battery.
- **GestureEvent-based implementation** — only covers Safari/macOS,
  requires a Pointer Events fallback anyway. Net complexity increase.

See `viewport.js`, `roi.js::pick(viewport)`,
`app.js::mapCssRoiToVideoRoi(cssRoi, video, W, H)`.
