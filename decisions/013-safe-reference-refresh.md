# Safe reference refresh

## Context

Long waits before a start and 90-120 second routes can outlive the original still frame because outdoor light, shadows, and camera exposure drift. Calling `Detector.captureReference()` while `app.js` is in `ARMED` or `RUNNING` would temporarily clear the active reference and create a blind detection window.

## Investigation

`Detector.process()` already compensates uniform brightness drift by subtracting the mean luma offset, but local shadows and non-uniform exposure changes can still move enough pixels to matter. The existing `captureReference()` path is safe in `OBSERVING` because no start/finish trigger is expected yet, but it is unsafe once the app is armed or timing.

## Decision

Keep the active reference live for every start and finish check, then build a separate clean candidate through `Detector.refreshReferenceSafely()`. `ARMED` can hard-replace the active reference after a stable clean window, while `RUNNING` only blends a small percentage of the candidate after an initial guard period.

## Risks

A very slow object entering the ROI could still contribute a few clean-looking pixels to the candidate before crossing the strict clear threshold. The refresh thresholds therefore stay far below the trigger threshold, and running-mode promotion uses a small blend rather than a hard swap.

## Alternatives considered

Periodic full re-arm was rejected because it makes detection blind for several frames. Continuous exponential averaging of every clear-ish frame was rejected because it can learn the rider or a shadow into the background too aggressively. Relying only on mean brightness normalization was rejected because it does not handle local light changes.
