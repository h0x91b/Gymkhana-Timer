// Background subtraction in ROI.
// - setRoi({x, y, w, h}) in video-pixel coordinates
// - captureReference() grabs the next N frames to build a reference image
// - process(video, metadata) returns true iff motion crossed threshold (respects cooldown)
// - observeStillness(video) returns frame-to-frame delta ratio (no reference
//   needed). Used by the session-mode OBSERVING state to decide when the ROI
//   has been empty long enough to safely capture a new reference and arm.

const REFERENCE_FRAMES = 5;
const COOLDOWN_SECONDS = 3;
const DOWNSCALE_MAX = 240;

export class Detector {
  constructor() {
    this.roi = null; // {x, y, w, h} in video pixels
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.reference = null; // Uint8ClampedArray (grayscale downscaled)
    this._hasReference = false;
    this._refAccum = null;
    this._refCount = 0;
    this._gray = null;
    this._grayMean = 0;
    this._referenceMean = 0;
    this._lastBrightnessOffset = 0;

    this.threshold = 0.25;
    this.pixelDiffThreshold = 28; // per-channel delta to count as motion
    this._lastTriggerAt = -Infinity;
    this.cooldownSeconds = COOLDOWN_SECONDS;
    this._lastRatio = 0;
    // Rising-edge gate. A trigger is only accepted when the ROI has dipped
    // back to "clear" (ratio < threshold) since the previous trigger, so a
    // subject that lingers in the ROI past the cooldown does NOT spuriously
    // fire a second trigger at cooldown-end. Default true so the FIRST
    // trigger after arming is free. See decisions/009-rising-edge-trigger.md.
    this._clearSinceTrigger = true;
    this._scale = 1;
    this._downW = 0;
    this._downH = 0;

    // Rolling previous-frame snapshot used by observeStillness() to measure
    // frame-to-frame delta without needing a reference. Kept separate from
    // `reference` so an OBSERVING-phase stability check cannot pollute the
    // reference that process() will use after arming.
    this._prevGray = null;
    this._hasPrevGray = false;
    this._prevStillnessRatio = 1;
  }

  setRoi(roi) {
    this.roi = roi;
    this._hasReference = false;
    this._refCount = 0;

    const longSide = Math.max(roi.w, roi.h);
    this._scale = Math.min(1, DOWNSCALE_MAX / longSide);
    this._downW = Math.max(1, Math.round(roi.w * this._scale));
    this._downH = Math.max(1, Math.round(roi.h * this._scale));
    this.canvas.width = this._downW;
    this.canvas.height = this._downH;

    const len = this._downW * this._downH;
    this._gray = new Uint8ClampedArray(len);
    this._prevGray = new Uint8ClampedArray(len);
    this.reference = new Uint8ClampedArray(len);
    this._refAccum = new Uint32Array(len);
    this._hasPrevGray = false;
    this._grayMean = 0;
    this._referenceMean = 0;
    this._lastBrightnessOffset = 0;
  }

  setThreshold(value) {
    this.threshold = value;
  }

  captureReference() {
    this._hasReference = false;
    if (this._refAccum) this._refAccum.fill(0);
    this._refCount = 0;
    // Fresh reference ⇒ the rising-edge gate must be open so the NEXT
    // "clear → dirty" transition (the bike entering the ROI) fires a
    // trigger without first needing a below-threshold reading.
    this._clearSinceTrigger = true;
  }

  // True once captureReference() has completed (REFERENCE_FRAMES averaged).
  // Used by app.js to decide when OBSERVING can hand off to ARMED — we need a
  // valid reference in place before we start trusting process() triggers.
  hasReference() {
    return this._hasReference;
  }

  // Frame-to-frame stillness probe. Returns the ratio of pixels that changed
  // vs. the previous captured frame; 0 = perfectly still, 1 = fully different.
  // Ignores cooldown/threshold entirely — this is an information channel for
  // app.js, not a trigger. Must be called on every frame during OBSERVING so
  // the internal "previous" snapshot stays fresh.
  observeStillness(video, stillnessThreshold = 1) {
    if (!this.roi) return 1;
    const gray = this._readRoiGray(video);
    if (!this._hasPrevGray) {
      this._prevGray.set(gray);
      this._hasPrevGray = true;
      return 1;
    }
    let moved = 0;
    const movedLimit = Math.floor(gray.length * stillnessThreshold);
    for (let i = 0; i < gray.length; i++) {
      if (Math.abs(gray[i] - this._prevGray[i]) > this.pixelDiffThreshold) {
        moved++;
        if (moved > movedLimit) {
          this._prevGray.set(gray);
          this._prevStillnessRatio = moved / gray.length;
          return this._prevStillnessRatio;
        }
      }
    }
    const ratio = moved / gray.length;
    this._prevGray.set(gray);
    this._prevStillnessRatio = ratio;
    return ratio;
  }

  // Last stillness ratio reported by observeStillness(). For debug overlays.
  lastStillnessRatio() {
    return this._prevStillnessRatio;
  }

  // Forget the previous-frame snapshot so the next observeStillness() call
  // starts fresh. Call this on phase transitions (e.g. when leaving FINISHED
  // for COOLDOWN) so a stale snapshot from two phases ago does not dominate
  // the first stillness reading of the new phase.
  resetStillness() {
    this._hasPrevGray = false;
    this._prevStillnessRatio = 1;
  }

  _readRoiGray(video) {
    this.ctx.drawImage(
      video,
      this.roi.x, this.roi.y, this.roi.w, this.roi.h,
      0, 0, this._downW, this._downH,
    );
    const { data } = this.ctx.getImageData(0, 0, this._downW, this._downH);
    const len = this._downW * this._downH;
    const gray = this._gray;
    let sum = 0;
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      // Luma (Rec. 601)
      const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      gray[j] = luma;
      sum += luma;
    }
    this._grayMean = sum / len;
    return gray;
  }

  process(video, metadata) {
    if (!this.roi) return false;

    const gray = this._readRoiGray(video);

    // Still building reference average.
    if (!this._hasReference) {
      for (let i = 0; i < gray.length; i++) this._refAccum[i] += gray[i];
      this._refCount++;
      if (this._refCount >= REFERENCE_FRAMES) {
        let refSum = 0;
        for (let i = 0; i < gray.length; i++) {
          const ref = this._refAccum[i] / this._refCount;
          this.reference[i] = ref;
          refSum += ref;
        }
        this._referenceMean = refSum / gray.length;
        this._hasReference = true;
        // Reference just became valid — open the rising-edge gate so the
        // first armed trigger is free (no need for the subject to first
        // cross the ROI clear, which would be impossible before the first
        // run since nothing has ever been there).
        this._clearSinceTrigger = true;
      }
      return false;
    }

    // Count motion pixels.
    let moved = 0;
    const movedNeeded = Math.ceil(gray.length * this.threshold);
    // Phone cameras keep adjusting exposure/white balance after arming. A
    // uniform luma shift across the ROI is not motion, so remove the current
    // frame's mean brightness drift before comparing per-pixel differences.
    const brightnessOffset = this._grayMean - this._referenceMean;
    this._lastBrightnessOffset = brightnessOffset;
    for (let i = 0; i < gray.length; i++) {
      if (Math.abs((gray[i] - this.reference[i]) - brightnessOffset) > this.pixelDiffThreshold) {
        moved++;
        if (moved >= movedNeeded) break;
      }
    }
    const ratio = moved / gray.length;
    this._lastRatio = ratio;

    // ROI is currently clear — open the gate for the NEXT threshold crossing.
    // Returning false is correct: a quiet ROI never triggers by itself.
    if (ratio < this.threshold) {
      this._clearSinceTrigger = true;
      return false;
    }

    // ratio >= threshold from here on.
    // Rising-edge gate: refuse to trigger if the ROI has not returned to
    // "clear" since the previous trigger. This is the fix for the 3-second
    // false-finish the user reported with larger zoom-as-ROI rectangles —
    // when the bike is still mid-crossing at COOLDOWN_SECONDS, the old code
    // fired a second trigger immediately at cooldown-end. Now we require the
    // ROI to actually have been seen empty (subject left the frame) before
    // the next trigger is allowed.
    if (!this._clearSinceTrigger) return false;

    // Debounce window: suppresses sub-second bouncing around the threshold
    // during a single crossing (sensor noise, shadow edges, etc.). Distinct
    // from the rising-edge gate above: cooldown is a time-based guard against
    // noise chatter, rising-edge is a state-based guard against "stuck high".
    if (metadata.mediaTime - this._lastTriggerAt < COOLDOWN_SECONDS) return false;

    this._lastTriggerAt = metadata.mediaTime;
    this._clearSinceTrigger = false;
    return true;
  }

  // Seconds remaining in the post-trigger debounce window, or 0 if past it.
  // Pure read — does not mutate state. For UI feedback only.
  cooldownRemaining(mediaTime) {
    return Math.max(0, COOLDOWN_SECONDS - (mediaTime - this._lastTriggerAt));
  }

  debugLine() {
    const gate = this._clearSinceTrigger ? 'open' : 'shut';
    return `ratio=${this._lastRatio.toFixed(3)} still=${this._prevStillnessRatio.toFixed(3)} drift=${this._lastBrightnessOffset.toFixed(1)} thr=${this.threshold.toFixed(2)} ref=${this._hasReference ? 'ok' : 'building'} gate=${gate}`;
  }
}
