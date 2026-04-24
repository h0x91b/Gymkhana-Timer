# Safe reference refresh

## Context

Long waits before a start and 90-120 second routes can outlive the original still frame because outdoor light, shadows, and camera exposure drift. Calling `Detector.captureReference()` while `app.js` is in `ARMED` or `RUNNING` would temporarily clear the active reference and create a blind detection window.

## Investigation

`Detector.process()` already compensates uniform brightness drift by subtracting the mean luma offset, but local shadows and non-uniform exposure changes can still move enough pixels to matter. The existing `captureReference()` path is safe in `OBSERVING` because no start/finish trigger is expected yet, but it is unsafe once the app is armed or timing.

## Decision

Keep the active reference live for every start and finish check, with a default trigger threshold of 0.35. Build a separate candidate through `Detector.refreshReferenceSafely()` only when active motion ratio has drifted above 0.10 but remains safely below the trigger threshold. `ARMED` can hard-replace the active reference after a stable drift window, while `RUNNING` only blends a small percentage of the candidate after an initial guard period; successful promotions are rate-limited to at most once every 5 seconds.

## Risks

A very slow object entering the ROI could still contribute a few stable-looking pixels to the candidate before crossing the trigger threshold. The refresh band therefore starts at 0.10 but caps below the active trigger threshold, and running-mode promotion uses a small blend rather than a hard swap.

## Alternatives considered

Periodic full re-arm was rejected because it makes detection blind for several frames. Timer-only refresh was rejected because it can do work while ratio is still healthy and miss the moment when drift actually appears. Continuous exponential averaging of every clear-ish frame was rejected because it can learn the rider or a shadow into the background too aggressively.
