// ROI picker: user taps 2 opposite corners on the overlay canvas.
// Returns an axis-aligned rectangle in video-pixel coordinates.
// Upgrade path: collect 4 taps and build a polygon mask.

export class RoiPicker {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  pick() {
    return new Promise((resolve) => {
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width * devicePixelRatio;
      this.canvas.height = rect.height * devicePixelRatio;
      this.ctx.scale(devicePixelRatio, devicePixelRatio);

      const points = [];
      const onTap = (ev) => {
        const x = (ev.touches?.[0]?.clientX ?? ev.clientX) - rect.left;
        const y = (ev.touches?.[0]?.clientY ?? ev.clientY) - rect.top;
        points.push({ x, y });
        this._draw(points);
        if (points.length === 2) {
          this.canvas.removeEventListener('pointerdown', onTap);
          const [a, b] = points;
          const roi = {
            // Caller must scale this into video-pixel coords using the video's
            // intrinsic size vs. the canvas CSS size.
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
