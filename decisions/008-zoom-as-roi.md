# 008 — Zoom-as-ROI replaces the two-tap corner picker

## Context

The original ROI setup was a two-tap picker: the rider tapped two opposite
corners of the start/finish line on the camera feed, and the resulting
axis-aligned rectangle was stored as the ROI. The same viewport also
supported pinch-zoom + two-finger pan (decision 005).

Those two input systems interacted badly: a pinch gesture starts with a
single `pointerdown`, `pointers.size` is `1` for the first finger's entire
event, and `body.dataset.gesturing` only flips to `true` once the second
finger lands. The RoiPicker's `pointerdown` listener on `#overlay` therefore
always registered the first finger as a corner tap *before* the gesture
system could claim the event. Symptom in the field: "pinch zoom drops a
stray ROI point, second Set ROI is impossible". Reported on 2026-04-22.

## Investigation

Three ways out were considered:

1. **Keep the tap picker, add a debounce** — delay corner-tap registration
   by ~100 ms so a following second finger can disqualify it. Adds state,
   still fights the pinch on fast gestures, still forces 2 extra taps for
   setup.
2. **Zoom-as-ROI** — drop the picker entirely. The viewport transform
   (`translate(tx, ty) scale(z)`) *already* defines a visible sub-rectangle
   of the video; treat that as the ROI on Set ROI press.
3. **Hybrid** — single-tap = corner, pinch = zoom. Still suffers from
   the same race, and the rider now has to reason about two input modes.

The viewport transform is trivially invertible:

```
cssRoi = { x: -tx/z, y: -ty/z, w: W/z, h: H/z }
```

`Viewport._clamp()` already guarantees the transform leaves no gaps inside
the viewport, so the rectangle is always within `[0..W] × [0..H]` — no
extra clamping needed. `mapCssRoiToVideoRoi()` handles the `object-fit:
cover` conversion exactly as before.

## Decision

Option 2. `RoiPicker` is dropped from the live code path; the `Set ROI`
button synchronously reads the current viewport transform, converts it to
a video-pixel rectangle, and hands it to the detector. `roi.js` stays in
the repo (tiny file, useful historical reference) but is no longer
imported by `app.js`.

Net effect:

- One-press setup: Start camera → pinch to frame → Set ROI. No corner taps.
- Pinch/pan gestures work without competing with any other listener.
- ROI is visually unambiguous: "what you see is what gets timed".

## Risks

- Rider who doesn't pinch at all ends up with ROI = full video. Slower
  detection and more false triggers, but correctness unaffected. They can
  re-pick by tapping the thumbnail.
- ROI is always phone-viewport-shaped (portrait or landscape). Polygon
  masks remain a future option if that becomes a limit.

## Alternatives considered

See Investigation: debounced tap picker (1) and hybrid tap+pinch (3).
Both retain the race condition; debouncing merely reduces the window.
