// Background subtraction in ROI.
// - setRoi({x, y, w, h}) in video-pixel coordinates
// - captureReference() grabs the next N frames to build a reference image
// - process(video, metadata) returns true iff motion crossed threshold (respects cooldown)

const REFERENCE_FRAMES = 5;
const COOLDOWN_SECONDS = 3;
const DOWNSCALE_MAX = 240;

export class Detector {
  constructor() {
    this.roi = null; // {x, y, w, h} in video pixels
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.reference = null; // Uint8ClampedArray (grayscale downscaled)
    this._refAccum = null;
    this._refCount = 0;

    this.threshold = 0.25;
    this.pixelDiffThreshold = 28; // per-channel delta to count as motion
    this._lastTriggerAt = -Infinity;
    this.cooldownSeconds = COOLDOWN_SECONDS;
    this._lastRatio = 0;
    this._scale = 1;
    this._downW = 0;
    this._downH = 0;
  }

  setRoi(roi) {
    this.roi = roi;
    this.reference = null;
    this._refAccum = null;
    this._refCount = 0;

    const longSide = Math.max(roi.w, roi.h);
    this._scale = Math.min(1, DOWNSCALE_MAX / longSide);
    this._downW = Math.max(1, Math.round(roi.w * this._scale));
    this._downH = Math.max(1, Math.round(roi.h * this._scale));
    this.canvas.width = this._downW;
    this.canvas.height = this._downH;
  }

  setThreshold(value) {
    this.threshold = value;
  }

  captureReference() {
    this.reference = null;
    this._refAccum = null;
    this._refCount = 0;
  }

  _readRoiGray(video) {
    this.ctx.drawImage(
      video,
      this.roi.x, this.roi.y, this.roi.w, this.roi.h,
      0, 0, this._downW, this._downH,
    );
    const { data } = this.ctx.getImageData(0, 0, this._downW, this._downH);
    const len = this._downW * this._downH;
    const gray = new Uint8ClampedArray(len);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      // Luma (Rec. 601)
      gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
    return gray;
  }

  process(video, metadata) {
    if (!this.roi) return false;

    const gray = this._readRoiGray(video);

    // Still building reference average.
    if (!this.reference) {
      if (!this._refAccum) this._refAccum = new Float32Array(gray.length);
      for (let i = 0; i < gray.length; i++) this._refAccum[i] += gray[i];
      this._refCount++;
      if (this._refCount >= REFERENCE_FRAMES) {
        const ref = new Uint8ClampedArray(gray.length);
        for (let i = 0; i < gray.length; i++) {
          ref[i] = this._refAccum[i] / this._refCount;
        }
        this.reference = ref;
      }
      return false;
    }

    // Count motion pixels.
    let moved = 0;
    for (let i = 0; i < gray.length; i++) {
      if (Math.abs(gray[i] - this.reference[i]) > this.pixelDiffThreshold) moved++;
    }
    const ratio = moved / gray.length;
    this._lastRatio = ratio;

    if (ratio < this.threshold) return false;
    if (metadata.mediaTime - this._lastTriggerAt < COOLDOWN_SECONDS) return false;

    this._lastTriggerAt = metadata.mediaTime;
    return true;
  }

  // Seconds remaining in the post-trigger debounce window, or 0 if past it.
  // Pure read — does not mutate state. For UI feedback only.
  cooldownRemaining(mediaTime) {
    return Math.max(0, COOLDOWN_SECONDS - (mediaTime - this._lastTriggerAt));
  }

  debugLine() {
    return `ratio=${this._lastRatio.toFixed(3)} thr=${this.threshold.toFixed(2)} ref=${this.reference ? 'ok' : 'building'}`;
  }
}
