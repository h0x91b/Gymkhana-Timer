# 010 — Aim mode with fixed-square reticle replaces zoom-as-ROI

## Context

Decision 008 replaced the two-tap corner picker with zoom-as-ROI — the
visible viewport after pinch/pan was stored as the ROI. That fixed the
pinch-tap race but introduced two UX problems:

1. The ROI was always viewport-shaped (portrait-tall on a phone). Riders
   routinely set ROIs much larger than the actual gate because they
   didn't zoom aggressively, and a large ROI held the subject past the
   3-second cooldown (root cause of the false-3.000 finish — mitigated
   by decision 009's rising-edge gate but not eliminated).
2. There was no visual of "what will be timed". The rider had to
   imagine the whole screen was the ROI, which conflicts with the
   tradition of a small rectangular gate window.

The rider also wanted more zoom (6× was not enough from across the lot)
and fewer distractions while aiming (timer + history + debug chrome
competed for attention while framing the gate).

## Decision

Three interlocking changes:

1. **Aim mode.** A `body[data-aiming="true"]` state is entered right
   after the camera starts and re-entered whenever the rider taps the
   ROI thumbnail to re-frame. CSS keys off the flag to hide the entire
   HUD (timer, sub-line, cooldown pill, run history, debug row) and
   every control except the Confirm ROI button. One visible action,
   no competing chrome.
2. **Reticle.** A fixed centered `min(70vw, 70vh)` green square is
   rendered as a sibling of `#viewport`. It is pinned in screen space
   — the rider moves the video UNDER it via pinch/pan. `pointer-events:
   none` so it does not fight the gesture. Confirm ROI reads the
   reticle's screen rect, inverts the viewport's CSS transform, and
   maps the resulting intrinsic CSS rect into video-pixel coordinates
   via the existing `mapCssRoiToVideoRoi`. The ROI is therefore always
   square and is exactly what the rider saw inside the reticle.
3. **maxZ 6 → 12.** Riders set the phone 5–10 m from the gate; 6× was
   not enough to isolate a narrow gate line from across the lot. 12×
   still leaves usable pixel density (original 1280×720 → a 107×107
   video-pixel sub-region at full 12× zoom if reticle is ~15% of the
   viewport's intrinsic frame; plenty for background subtraction).

## Alternatives considered

- **Draggable reticle.** Users could drag/resize the square with single
  touches. Adds the same gesture-conflict class the original picker
  had. Discarded.
- **Dynamic reticle (largest inscribed square).** Auto-reshape under
  orientation change. Creates layout jitter and surprises the rider.
  Discarded.
- **Keep zoom-as-ROI, raise cooldown to 8 s.** Papers over the
  too-large-ROI problem, breaks short routes, still no WYSIWYG.
  Discarded.

## Risks

- A rider who never zooms ends up with a small ROI in the center of an
  unzoomed frame — likely smaller than intended. Teaching cue: the
  `ui.gestureHint` pill explicitly says "pinch to place the gate
  inside the square".
- Aim mode hides the Debug and Threshold controls. Riders who need to
  tweak those mid-practice have to commit a ROI first, then reveal
  the panel via tap. Acceptable — these are advanced knobs.

## Links

- Reticle math: `commitRoiFromReticle()` in `app.js`.
- CSS: `.reticle` + `body[data-aiming="true"] …` rules in `style.css`.
- Viewport limits: `minZ`/`maxZ` in `viewport.js`.
