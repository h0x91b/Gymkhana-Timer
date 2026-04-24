// Wraps getUserMedia + requestVideoFrameCallback.
// Delivers raw frames to a callback along with the frame's mediaTime timestamp.

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this._callback = null;
    this._rvfcId = null;
    this._fallbackRafId = null;
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
    if (this._fallbackRafId) {
      cancelAnimationFrame(this._fallbackRafId);
      this._fallbackRafId = null;
    }
    this._callback = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
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
    this._callback = cb;
    const start = performance.now();
    const loop = () => {
      if (!this._callback) return;
      this._callback(this.video, { mediaTime: (performance.now() - start) / 1000 });
      this._fallbackRafId = requestAnimationFrame(loop);
    };
    this._fallbackRafId = requestAnimationFrame(loop);
  }
}
