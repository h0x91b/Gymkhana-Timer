// Pinch-zoom + two-finger pan on a transformable element.
//
// Applies a CSS `translate(tx, ty) scale(z)` to the target element
// with transform-origin 0 0 (the math below assumes this). The target
// should wrap both the <video> and the ROI overlay so they stay in
// sync visually and share the same coordinate space.
//
// Two input paths:
//   - Pointer events on mobile: track 2 active pointers, derive pinch
//     distance + midpoint for zoom and pan.
//   - Wheel events on desktop (incl. macOS trackpad): ctrl+wheel is the
//     browser-emulated pinch gesture (zoom); plain wheel is pan (deltaX
//     horizontal scroll, deltaY vertical scroll).
//
// While a 2-pointer gesture is in progress we set
// `document.body.dataset.gesturing = 'true'` so other listeners (e.g. the
// ROI picker) can ignore the event stream until fingers lift.

export class Viewport {
  constructor(el) {
    this.el = el;
    this.z = 1;
    this.tx = 0;
    this.ty = 0;
    this.minZ = 1;
    // maxZ 12× lets a rider prop the phone far from the gate and still frame
    // a narrow ROI around just the start/finish line. 6× was fine for close
    // setups but hit the ceiling from across the lot (decision 010).
    this.maxZ = 12;
    this.pointers = new Map();
    this._gesture = null;
    this._attached = false;
    this._onChangeCb = null;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    const el = this.el;
    // Note: relying on pointer events means we lose a tiny bit of
    // simultaneity on very old Android Chromium, but every browser
    // we care about implements the spec correctly now.
    el.addEventListener('pointerdown', this._onPointerDown, { passive: false });
    el.addEventListener('pointermove', this._onPointerMove, { passive: false });
    el.addEventListener('pointerup', this._onPointerUp, { passive: true });
    el.addEventListener('pointercancel', this._onPointerUp, { passive: true });
    // `{ passive: false }` so preventDefault() sticks — otherwise Chrome
    // on macOS keeps scrolling the page on ctrl-wheel even when we
    // handle the zoom ourselves.
    el.addEventListener('wheel', this._onWheel, { passive: false });
    this._apply();
  }

  detach() {
    if (!this._attached) return;
    const el = this.el;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointercancel', this._onPointerUp);
    el.removeEventListener('wheel', this._onWheel);
    this._attached = false;
  }

  onChange(cb) {
    this._onChangeCb = cb;
  }

  isGesturing() {
    return this.pointers.size >= 2;
  }

  intrinsicWidth() {
    return this.el.offsetWidth;
  }

  intrinsicHeight() {
    return this.el.offsetHeight;
  }

  // Convert a viewport/mouse clientX/clientY into the element's
  // *intrinsic* (pre-transform) coordinate space. This is what ROI
  // picking wants so the stored ROI is stable across zoom changes.
  cssToIntrinsic(clientX, clientY) {
    const parent = this.el.offsetParent || this.el.parentElement;
    const prect = parent.getBoundingClientRect();
    const localX = clientX - prect.left;
    const localY = clientY - prect.top;
    return {
      x: (localX - this.tx) / this.z,
      y: (localY - this.ty) / this.z,
    };
  }

  reset() {
    this.z = 1;
    this.tx = 0;
    this.ty = 0;
    this._apply();
  }

  _apply() {
    this.el.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.z})`;
    if (this._onChangeCb) this._onChangeCb();
  }

  // Pin translation so the transformed element never leaves a gap inside
  // its parent — at zoom z=1 this snaps back to (0,0); at higher zooms
  // the allowed range is [W(1-z), 0] along each axis.
  _clamp() {
    const W = this.intrinsicWidth();
    const H = this.intrinsicHeight();
    const minTx = W * (1 - this.z);
    const minTy = H * (1 - this.z);
    if (this.tx > 0) this.tx = 0;
    if (this.tx < minTx) this.tx = minTx;
    if (this.ty > 0) this.ty = 0;
    if (this.ty < minTy) this.ty = minTy;
  }

  // Zoom toward a specific screen point (keeps the pixel under the cursor
  // stable, which is how both trackpad pinch and mouse-wheel zoom should feel).
  _zoomAround(clientX, clientY, newZ) {
    newZ = Math.max(this.minZ, Math.min(this.maxZ, newZ));
    const parent = this.el.offsetParent || this.el.parentElement;
    const prect = parent.getBoundingClientRect();
    const localX = clientX - prect.left;
    const localY = clientY - prect.top;
    // Intrinsic point under the cursor *before* the zoom.
    const ix = (localX - this.tx) / this.z;
    const iy = (localY - this.ty) / this.z;
    this.z = newZ;
    // After zoom: we want (ix*newZ + tx') === localX.
    this.tx = localX - ix * newZ;
    this.ty = localY - iy * newZ;
    this._clamp();
    this._apply();
  }

  _onPointerDown = (ev) => {
    // Only touch/pen contribute to pinch. Mouse uses wheel.
    if (ev.pointerType === 'mouse') return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try {
      this.el.setPointerCapture?.(ev.pointerId);
    } catch {
      /* setPointerCapture can throw in rare browser states — safe to ignore */
    }
    if (this.pointers.size === 2) {
      this._startGesture();
      document.body.dataset.gesturing = 'true';
    }
  };

  _onPointerMove = (ev) => {
    if (!this.pointers.has(ev.pointerId)) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size === 2 && this._gesture) {
      ev.preventDefault();
      this._updateGesture();
    }
  };

  _onPointerUp = (ev) => {
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size < 2) {
      this._gesture = null;
      // Defer clearing the flag by one frame so the ROI picker's own
      // pointerup doesn't see `gesturing=false` and count the lift as
      // a tap.
      requestAnimationFrame(() => {
        if (this.pointers.size < 2) {
          document.body.dataset.gesturing = 'false';
        }
      });
    }
  };

  _startGesture() {
    const [p1, p2] = [...this.pointers.values()];
    const midClient = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const parent = this.el.offsetParent || this.el.parentElement;
    const prect = parent.getBoundingClientRect();
    const midLocal = { x: midClient.x - prect.left, y: midClient.y - prect.top };
    const midIntrinsic = {
      x: (midLocal.x - this.tx) / this.z,
      y: (midLocal.y - this.ty) / this.z,
    };
    this._gesture = {
      initialDist: dist || 1,
      initialZ: this.z,
      midIntrinsic,
    };
  }

  _updateGesture() {
    const [p1, p2] = [...this.pointers.values()];
    const midClient = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const parent = this.el.offsetParent || this.el.parentElement;
    const prect = parent.getBoundingClientRect();
    const midLocal = { x: midClient.x - prect.left, y: midClient.y - prect.top };

    const rawZ = this._gesture.initialZ * (dist / this._gesture.initialDist);
    const newZ = Math.max(this.minZ, Math.min(this.maxZ, rawZ));
    const { midIntrinsic } = this._gesture;
    this.z = newZ;
    // Anchor the chosen intrinsic point under the current midpoint —
    // this naturally produces both pinch (distance change) and pan
    // (midpoint drift) with a single formula.
    this.tx = midLocal.x - midIntrinsic.x * newZ;
    this.ty = midLocal.y - midIntrinsic.y * newZ;
    this._clamp();
    this._apply();
  }

  // macOS trackpad pinch arrives as wheel+ctrlKey (browser convention).
  // Regular two-finger scroll arrives as wheel with deltaX/deltaY and no
  // ctrlKey. Mouse-wheel up/down without ctrl also pans — fine for us.
  _onWheel = (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey) {
      // Exponential mapping so the gesture feels natural at any current zoom.
      const factor = Math.exp(-ev.deltaY * 0.01);
      this._zoomAround(ev.clientX, ev.clientY, this.z * factor);
    } else {
      this.tx -= ev.deltaX;
      this.ty -= ev.deltaY;
      this._clamp();
      this._apply();
    }
  };
}
