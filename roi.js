// ROI picker: user taps 2 opposite corners on the overlay canvas.
// Returns an axis-aligned rectangle in the viewport's *intrinsic*
// (pre-transform) CSS pixel space. The caller then maps that rectangle
// into video-pixel coordinates before handing it to the detector.
//
// Upgrade path: collect 4 taps and build a polygon mask.

export class RoiPicker {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /**
   * @param {{ cssToIntrinsic: (clientX: number, clientY: number) => {x: number, y: number} }} viewport
   *        Source of truth for converting pointer positions into intrinsic
   *        (untransformed) coordinates. We can't use getBoundingClientRect
   *        here because the overlay's parent may be CSS-transformed for
   *        pinch-zoom, which would distort the rect.
   */
  pick(viewport) {
    return new Promise((resolve) => {
      // Use offsetWidth/Height for the canvas pixel buffer — CSS transforms
      // on the viewport parent scale the visual rect, not the element's
      // own layout box. Sizing by the layout box keeps the canvas sharp
      // at every zoom level.
      const W = this.canvas.offsetWidth;
      const H = this.canvas.offsetHeight;
      this.canvas.width = Math.max(1, Math.round(W * devicePixelRatio));
      this.canvas.height = Math.max(1, Math.round(H * devicePixelRatio));
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(devicePixelRatio, devicePixelRatio);

      const points = [];
      const onTap = (ev) => {
        // Ignore secondary touches so a pinch gesture's 2nd finger
        // doesn't accidentally land a ROI corner.
        if (!ev.isPrimary) return;
        if (document.body.dataset.gesturing === 'true') return;
        const { x, y } = viewport.cssToIntrinsic(ev.clientX, ev.clientY);
        points.push({ x, y });
        this._draw(points);
        if (points.length === 2) {
          this.canvas.removeEventListener('pointerdown', onTap);
          this.canvas.style.pointerEvents = '';
          const [a, b] = points;
          const roi = {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            w: Math.abs(b.x - a.x),
            h: Math.abs(b.y - a.y),
          };
          resolve(roi);
        }
      };
      this.canvas.style.pointerEvents = 'auto';
      this.canvas.addEventListener('pointerdown', onTap);
    });
  }

  _draw(points) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#00ff88';
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (points.length === 2) {
      const [a, b] = points;
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2;
      ctx.strokeRect(
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.abs(b.x - a.x),
        Math.abs(b.y - a.y),
      );
    }
  }
}
