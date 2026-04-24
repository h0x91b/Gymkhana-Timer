# 011 — Normalize ROI brightness drift before motion diff

## Context

On current master, debug `ratio` can climb frame-by-frame after a run starts even when the ROI looks empty. The detector compares each current grayscale pixel against a static reference, so mobile camera auto-exposure or white-balance drift after arming can look like motion across more and more pixels.

## Investigation

The rising-edge gate correctly prevents repeated triggers while the ROI stays dirty, but it does not solve a slow global brightness shift. Raising `pixelDiffThreshold` hides the symptom only on some devices and also makes real crossings less sensitive. Re-capturing the reference during `RUNNING` is unsafe because it could absorb the finish crossing into the background.

## Decision

Keep the static reference, but compare pixels after subtracting the frame-wide mean luma offset: `(current - reference) - (currentMean - referenceMean)`. A uniform exposure drift then contributes near zero motion, while local shape changes in the ROI still exceed `pixelDiffThreshold`.

## Risks

If the moving object fills most of the ROI, mean normalization can subtract part of the object's contrast. The fixed reticle intentionally keeps the ROI focused on the gate line, so this is preferable to treating camera exposure hunting as motion.

## Alternatives considered

Higher thresholds reduce false drift but lose sensitivity. Slow reference adaptation during `RUNNING` risks learning the rider or finish crossing as background. Locking camera exposure would be ideal, but browser support for manual exposure constraints is inconsistent on mobile.
