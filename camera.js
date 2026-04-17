// Wraps getUserMedia + requestVideoFrameCallback.
// Delivers raw frames to a callback along with the frame's mediaTime timestamp.

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this._callback = null;
    this._rvfcId = null;
  }

  async start({ facingMode = 'environment', frameRate = 60 } = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode,
        frameRate: { ideal: frameRate },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop() {
    if (this._rvfcId && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this._rvfcId);
    }
    this._callback = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }

  // Returns {min, max, step, current} if the device/browser supports hardware zoom
  // via MediaStreamTrack capabilities, otherwise null. This is Chrome/Android's
  // native optical-or-digital camera zoom — transparent to detection, because
  // the frames we receive are already zoomed at capture time.
  getZoomCapabilities() {
    const track = this.stream?.getVideoTracks?.()[0];
    if (!track || typeof track.getCapabilities !== 'function') return null;
    const caps = track.getCapabilities();
    if (!caps.zoom) return null;
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    return {
      min: caps.zoom.min,
      max: caps.zoom.max,
      step: caps.zoom.step ?? 0.1,
      current: settings.zoom ?? caps.zoom.min,
    };
  }

  // Apply a zoom factor. Resolves true on success, false if unsupported or rejected.
  async setZoom(value) {
    const track = this.stream?.getVideoTracks?.()[0];
    if (!track || typeof track.applyConstraints !== 'function') return false;
    try {
      await track.applyConstraints({ advanced: [{ zoom: value }] });
      return true;
    } catch (err) {
      console.warn('Zoom apply failed:', err);
      return false;
    }
  }

  // cb(video, metadata) where metadata.mediaTime is a seconds-precise frame timestamp.
  onFrame(cb) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
      console.warn('requestVideoFrameCallback not supported; falling back to rAF.');
      this._fallback(cb);
      return;
    }
    this._callback = cb;
    const loop = (_now, metadata) => {
      if (!this._callback) return;
      this._callback(this.video, metadata);
      this._rvfcId = this.video.requestVideoFrameCallback(loop);
    };
    this._rvfcId = this.video.requestVideoFrameCallback(loop);
  }

  _fallback(cb) {
    const start = performance.now();
    const loop = () => {
      cb(this.video, { mediaTime: (performance.now() - start) / 1000 });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
