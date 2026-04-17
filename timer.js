// Timer display + speech synthesis.
// Driven by the camera frame clock (mediaTime) rather than wall-clock rAF.

export class Timer {
  constructor(el) {
    this.el = el;
    this._t0 = 0;
    this._running = false;
    this._rafId = 0;
  }

  start(t0) {
    this._t0 = t0;
    this._running = true;
    const tick = () => {
      if (!this._running) return;
      // Display elapsed based on performance.now as a smooth proxy.
      // The stop() call overwrites with the true frame-accurate elapsed.
      const elapsed = (performance.now() / 1000) - (this._t0Wall ??= performance.now() / 1000);
      this._render(elapsed);
      this._rafId = requestAnimationFrame(tick);
    };
    this._t0Wall = performance.now() / 1000;
    this._rafId = requestAnimationFrame(tick);
  }

  stop(elapsedSeconds) {
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this._render(elapsedSeconds);
  }

  reset() {
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this._t0 = 0;
    this._t0Wall = undefined;
    this._render(0);
  }

  speak(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  _render(seconds) {
    this.el.textContent = seconds.toFixed(3);
  }
}
