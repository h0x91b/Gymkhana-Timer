# 009 — Rising-edge trigger gate in the detector

## Context

The session reported "finish at exactly 3.000s" on the second run after
switching to zoom-as-ROI (decision 008). With the old tap-picker users
drew narrow ROIs around the gate line; with zoom-as-ROI they often set
much larger rectangles (the whole visible viewport after a light pinch).
A large ROI means the subject lingers inside it longer than the detector's
3-second post-trigger cooldown (`COOLDOWN_SECONDS = 3`). So at trigger +
3 s, `ratio` was still above threshold, and the old code fired the second
(finish) trigger immediately — producing a hard-coded 3.000 s run time
regardless of the actual route length.

## Investigation

The old accept condition in `detector.process()` was:

```js
if (ratio < threshold) return false;
if (mediaTime - lastTriggerAt < COOLDOWN_SECONDS) return false;
accept();
```

This is a level-triggered rule with a time-based lockout. Once the
lockout expires, *any* above-threshold frame fires — even one in the
middle of a continuous high-ratio stretch. That's exactly what happened
with a bike halfway through a wide ROI.

Three alternatives were considered:

1. **Bigger cooldown** — `COOLDOWN_SECONDS = 8` or similar. Only pushes
   the minimum run time up; still breaks on any route where the bike sits
   in ROI that long.
2. **Rising-edge gate** — require `ratio` to dip back under the threshold
   between triggers. The subject must actually leave the ROI before the
   next trigger is allowed. Cooldown stays as a sub-second debounce.
3. **Max-run watchdog** — after N seconds, auto-finish. Papers over the
   root cause; wrong time recorded either way.

## Decision

Option 2. Added `_clearSinceTrigger` to the detector: `true` by default,
reset to `true` on every `captureReference()` and on every below-threshold
frame, set to `false` at each accepted trigger. `process()` now reads:

```js
if (ratio < threshold) { _clearSinceTrigger = true; return false; }
if (!_clearSinceTrigger) return false;           // rising-edge gate
if (mediaTime - lastTriggerAt < COOLDOWN) return false;
accept(); _clearSinceTrigger = false; return true;
```

Cooldown stays — it is still needed to suppress sub-second bouncing at
the moment a subject crosses the threshold (sensor noise, shadow edges,
wheel spokes chopping a thin ROI band).

Debug line now reports `gate=open|shut` so this state is visible.

## Risks

- If the reference is bad (captured with motion) or ambient light shifts
  such that `ratio` never dips below threshold, RUNNING is stuck forever.
  Tap-to-reveal + Stop session remains the escape hatch. This is strictly
  better than the old behaviour, which fabricated a 3 s time.
- Very fast routes (< `COOLDOWN_SECONDS`) still can't be measured. That
  was already the case and is out of scope.

## Alternatives considered

See Investigation: (1) longer cooldown, (3) max-run watchdog. Both trade
one false outcome for another.
