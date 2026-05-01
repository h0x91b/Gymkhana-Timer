// WebGL2 motion detector for the rebuilt webgl-app.
//
// API surface (TZ-webgl-rewrite.md §"Детектор: API"):
//   constructor(canvas)
//   init()                     — create GL2 context + programs + FBOs + textures
//   setRoi({x,y,w,h})          — video-pixel coords; the rest of the pipeline derives UVs from this
//   setThreshold(value)        — motion ratio at/above this value triggers (after debounce)
//   captureReference()         — flag: copy current ROI crop into the reference texture on the next process()
//   hasReference()             — bool
//   process(video, mediaTime)  — one full frame (upload → crop → metrics → mipmap → readPixels); returns true on rising-edge trigger
//   drawDisplay(video)         — full-screen camera preview with a tinted ROI box (debug aid + reticle reference)
//   cooldownRemaining(mt)      — seconds until the post-trigger debounce window expires
//   lastMotionRatio()          — [0..1], for the on-page debug overlay
//   debugLine()                — one short line summarising current state
//
// Pipeline (per process() call):
//   1. Upload the current video frame into _texCur (texImage2D, UNPACK_FLIP_Y).
//      Deduplicated by video.currentTime so two callers in the same frame
//      don't double-upload.
//   2. ROI crop: FS_COPY samples _texCur with UVs derived from the active
//      ROI and renders into _fboCropped (256×256 RGBA8, NEAREST). NEAREST is
//      critical — LINEAR filtering plus sub-pixel jitter between frames
//      manifests as fake motion in the metrics pass.
//   3. If captureReference() was requested, copyTexSubImage2D bit-blits
//      _texCropped into _texRef. _hasRef flips to true. The very first
//      capture happens before any metrics pass, so this frame returns false.
//   4. Metrics: FS_METRICS samples (_texCropped, _texRef) once per pixel,
//      computes (signed Δluma − previous-frame's mean drift) and emits
//      RGBA = (movedMask, signedΔ rebiased to 0..1, currentLuma, 1). One
//      shader pass produces motion ratio + drift + brightness simultaneously.
//   5. generateMipmap on _texMotion box-averages 256² → 1×1 across 8 levels.
//      The 1×1 pixel's R channel ends up holding the fraction of fragments
//      that crossed the threshold — i.e. the motion ratio.
//   6. readPixels(0,0,1,1) on the smallest mip blocks until the GPU has
//      finished, copies four bytes back, and that's the only CPU-visible
//      data crossing the boundary each frame. Decode → motion / drift /
//      luma. The drift is fed back into uBrightnessOffset on the next
//      process() so a uniform exposure shift (sun moving behind cloud)
//      doesn't masquerade as motion.
//   7. Trigger logic: rising edge with a 3 s cooldown. Before any trigger
//      can fire, the ROI must have been "clear" (motion < threshold) at
//      least once since the previous trigger — this prevents a single
//      sustained motion from firing both start and finish on the same pass.
//
// Display pass (drawDisplay) draws _texCur full-screen onto the visible
// canvas with a tinted ROI rectangle so the rider can see exactly where
// the detector is looking. Not part of the metrics pipeline timing-wise.

const FBO_SIZE = 256;
const FBO_MIP_LEVELS = Math.log2(FBO_SIZE) | 0; // 8 → index of the 1×1 mip
const COOLDOWN_SECONDS = 3.0;

const VS = `#version 300 es
// Explicit attribute locations are non-negotiable: without them the linker
// is free to swap aPos and aUv on quirky drivers, leading to a vertex
// shader that samples UV from position bytes and produces nonsense in
// the diff pass. Spent a session debugging exactly this — pin them.
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
out vec2 vUv;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUv = aUv;
}`;

// ROI crop. UVs supplied by the host pick the sub-region of the camera
// frame; the fragment just samples it. Output goes to _fboCropped (256²)
// so subsequent passes always operate on a fixed-size texture regardless
// of the camera's native resolution.
const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv);
}`;

// Metrics pass. One sample of A (current cropped) and B (reference) per
// fragment. Emits three independent measurements packed into RGBA so the
// downstream mipmap reduce + readPixels(1×1) gives us motion ratio, mean
// drift, and mean luma in a single GPU sync stall.
//
//   R = motion mask  — step(threshold, |Δluma − offset|), so the mipmap
//       average across 256² fragments is the fraction of "moved" pixels.
//   G = signed Δluma rebiased to 0..1  — averaged this becomes the mean
//       drift, used next frame to compensate for ambient-light shifts.
//   B = current luma — averaged this is the ROI's mean brightness, useful
//       for sanity checks but not currently consumed by app-webgl.
const FS_METRICS = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uThreshold;
uniform float uBrightnessOffset;
in vec2 vUv;
out vec4 outColor;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main() {
  float la = dot(texture(uA, vUv).rgb, LUMA);
  float lb = dot(texture(uB, vUv).rgb, LUMA);
  float diff = la - lb;
  float compensated = diff - uBrightnessOffset;
  float moved = step(uThreshold, abs(compensated));
  outColor = vec4(moved, diff * 0.5 + 0.5, la, 1.0);
}`;

// Display: full-screen video with a thick red outline around the ROI.
// Red because (a) it doesn't collide with the green ARMED background,
// (b) it reads as a clear "this is the active detection zone" cue
// rather than something neutral. fwidth() is multiplied by ~10 to give
// a chunky ~10 px border that's visible on a phone clamped to a tripod
// from across the lot. Earlier 2-3 px green border was too thin to
// notice in practice. A faint red-tinted halo just outside the inner
// edge fattens the perceived line further without losing the camera
// detail inside.
const FS_DISPLAY = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uRoi;          // (left, top, right, bottom) in display UVs (Y-flipped)
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  // Border thickness in UV — fwidth gives "1 pixel in UV". Multiply by
  // ~10 for a substantial line; px.x and px.y differ on non-square
  // canvases so the border stays visually consistent on both axes.
  vec2 px = fwidth(vUv) * 10.0;
  bool inside = vUv.x >= uRoi.x && vUv.x <= uRoi.z
             && vUv.y >= uRoi.y && vUv.y <= uRoi.w;
  bool insideInner = vUv.x >= uRoi.x + px.x && vUv.x <= uRoi.z - px.x
                  && vUv.y >= uRoi.y + px.y && vUv.y <= uRoi.w - px.y;
  if (inside && !insideInner) {
    // Saturated red border. Slight darken at the corners is acceptable
    // — we want a brick-coloured "frame" around the ROI, not a glow.
    c = vec3(0.95, 0.10, 0.10);
  } else if (inside) {
    // Light red tint inside so the boundary band has a halo on the
    // inside edge as well — doubles the perceived border width.
    c = mix(c, vec3(0.95, 0.20, 0.18), 0.12);
  }
  outColor = vec4(c, 1.0);
}`;

export class WebglDetector {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;

    // Tunables
    this._threshold = 0.20;
    this._cooldownSeconds = COOLDOWN_SECONDS;

    // ROI in video-pixel coords. Set by setRoi() once the rider confirms.
    this._roi = null;

    // Reference state
    this._captureRefPending = false;
    this._hasRef = false;

    // Trigger state machine — see process()
    this._lastTriggerAt = -Infinity;
    this._clearSinceTrigger = true;

    // Last metrics (for debug + drift compensation)
    this._lastMotion = 0;
    this._lastDrift = 0;     // signed [-1..1]; uniform offset on next frame
    this._lastLuma = 0;

    // Frame-dedup: process() may be called more than once per frame in
    // some code paths; the upload + GPU work shouldn't happen twice.
    this._lastProcessedMediaTime = -1;

    // Pre-allocated readback target
    this._readback = new Uint8Array(4);

    // GL resources, all populated by init()
    this._progCopy = null;
    this._progMetrics = null;
    this._progDisplay = null;
    this._locCopy = null;
    this._locMetrics = null;
    this._locDisplay = null;
    this._vbo = null;
    this._vao = null;
    this._texCur = null;
    this._texCropped = null;
    this._texRef = null;
    this._texMotion = null;
    this._fboCropped = null;
    this._fboMotion = null;
    this._fboRead = null;
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: false,
      alpha: false,
    });
    if (!gl) throw new Error('WebGL2 not available on this device.');
    this.gl = gl;

    this._progCopy = link(gl, VS, FS_COPY);
    this._progMetrics = link(gl, VS, FS_METRICS);
    this._progDisplay = link(gl, VS, FS_DISPLAY);

    this._locCopy = {
      tex: gl.getUniformLocation(this._progCopy, 'uTex'),
    };
    this._locMetrics = {
      a: gl.getUniformLocation(this._progMetrics, 'uA'),
      b: gl.getUniformLocation(this._progMetrics, 'uB'),
      thr: gl.getUniformLocation(this._progMetrics, 'uThreshold'),
      offset: gl.getUniformLocation(this._progMetrics, 'uBrightnessOffset'),
    };
    this._locDisplay = {
      tex: gl.getUniformLocation(this._progDisplay, 'uTex'),
      roi: gl.getUniformLocation(this._progDisplay, 'uRoi'),
    };

    // VBO holds one quad — four interleaved (xy, uv) vertices in triangle
    // strip order. Filled in fillQuad() once per pass with the chosen UVs.
    this._vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(16), gl.DYNAMIC_DRAW);

    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    // Locations 0/1 are guaranteed by the layout(location=N) directives in VS.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    this._texCur = makeTex(gl);          // raw camera frame, NEAREST
    this._texCropped = makeFboTex(gl);   // 256² ROI crop, NEAREST
    this._texRef = makeFboTex(gl);       // 256² reference, NEAREST

    // Motion target — texStorage2D so generateMipmap reduces cleanly to 1×1.
    this._texMotion = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texMotion);
    gl.texStorage2D(gl.TEXTURE_2D, FBO_MIP_LEVELS + 1, gl.RGBA8, FBO_SIZE, FBO_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this._fboCropped = makeFbo(gl, this._texCropped, 0);
    this._fboMotion = makeFbo(gl, this._texMotion, 0);
    this._fboRead = makeFbo(gl, this._texMotion, FBO_MIP_LEVELS); // 1×1 mip
  }

  setRoi(roi) { this._roi = roi; }
  setThreshold(v) { this._threshold = v; }
  captureReference() { this._captureRefPending = true; }
  hasReference() { return this._hasRef; }

  // Forget the captured reference. Called when the active ROI changes
  // (Reset ROI button) so the next OBSERVING re-captures against the
  // new region rather than comparing the new crop to a stale ref from
  // the previous ROI — which would otherwise look like a giant motion
  // event the moment the new ROI gets sampled.
  resetReferenceForRoiChange() {
    this._hasRef = false;
    this._captureRefPending = false;
    this._lastMotion = 0;
    this._lastDrift = 0;
    this._clearSinceTrigger = true;
    this._lastTriggerAt = -Infinity;
  }

  cooldownRemaining(mt) {
    return Math.max(0, (this._lastTriggerAt + this._cooldownSeconds) - mt);
  }

  lastMotionRatio() { return this._lastMotion; }

  debugLine() {
    const driftSign = this._lastDrift >= 0 ? '+' : '−';
    return `motion=${this._lastMotion.toFixed(3)} `
         + `drift=${driftSign}${Math.abs(this._lastDrift).toFixed(3)} `
         + `luma=${this._lastLuma.toFixed(3)} `
         + `ref=${this._hasRef ? 'yes' : 'no'} `
         + `clear=${this._clearSinceTrigger ? '1' : '0'}`;
  }

  process(video, mediaTime) {
    const gl = this.gl;
    if (!gl || !video.videoWidth || !this._roi) return false;

    // Frame-dedupe so two callers in the same frame don't double-pay.
    // process() returns the cached trigger result on the second call, but
    // that's fine because no caller currently inspects the return on a
    // dedup-hit path.
    const VW = video.videoWidth;
    const VH = video.videoHeight;
    const sameFrame = mediaTime === this._lastProcessedMediaTime;

    // ROI in UVs. CRITICAL: UNPACK_FLIP_Y_WEBGL flips the texture rows
    // on upload, so the texture's V=0 is the BOTTOM of the source video
    // and V=1 is the TOP. To sample video pixel y=r.y we therefore need
    // texture V = 1 - r.y/VH (and similarly for r.y+r.h).
    //
    // Without this flip, FS_COPY ends up cropping a vertically-mirrored
    // region from somewhere else in the frame — the detector then
    // watches a slice that doesn't correspond to the red border drawn
    // by FS_DISPLAY, which DOES use the 1-y/VH convention. Symptom:
    // motion outside the visible ROI seemingly triggers; motion inside
    // the visible ROI is hit-or-miss. Vertical-only — the X axis is
    // unaffected by FLIP_Y.
    const r = this._roi;
    const uvL = r.x / VW;
    const uvR = (r.x + r.w) / VW;
    const uvT = 1 - r.y / VH;            // top of ROI (smaller video y) → larger v
    const uvB = 1 - (r.y + r.h) / VH;    // bottom of ROI → smaller v

    if (!sameFrame) {
      // STAGE 1 — upload current camera frame.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texCur);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

      // STAGE 2 — ROI crop into _fboCropped at 256².
      this._fillQuad(uvL, uvT, uvR, uvB);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboCropped);
      gl.viewport(0, 0, FBO_SIZE, FBO_SIZE);
      gl.useProgram(this._progCopy);
      gl.bindVertexArray(this._vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texCur);
      gl.uniform1i(this._locCopy.tex, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // STAGE 3 — capture reference if the host requested it. Bit-blit
      // from _fboCropped into _texRef using the FBO that's already bound
      // as the read source. Cheap and stays entirely on the GPU.
      if (this._captureRefPending) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texRef);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, FBO_SIZE, FBO_SIZE);
        this._captureRefPending = false;
        this._hasRef = true;
        // First frame after capture: motion vs ref is identically 0, so
        // skip the metrics pass to avoid emitting a stale-but-valid
        // motion=0 readback that the trigger gate would interpret as
        // "ROI is clear" (which we want, but for the right reason —
        // because we just snapshotted it).
        this._lastProcessedMediaTime = mediaTime;
        this._lastMotion = 0;
        this._lastDrift = 0;
        this._clearSinceTrigger = true;
        return false;
      }

      if (!this._hasRef) {
        this._lastProcessedMediaTime = mediaTime;
        return false;
      }

      // STAGE 4 — metrics pass: (cropped, ref) → motion mask.
      // The cropped texture covers the ROI's full 256² in NEAREST,
      // so the metrics shader samples 0..1 across the whole crop.
      this._fillQuad(0, 0, 1, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboMotion);
      gl.viewport(0, 0, FBO_SIZE, FBO_SIZE);
      gl.useProgram(this._progMetrics);
      gl.bindVertexArray(this._vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texCropped);
      gl.uniform1i(this._locMetrics.a, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._texRef);
      gl.uniform1i(this._locMetrics.b, 1);
      gl.uniform1f(this._locMetrics.thr, this._threshold);
      gl.uniform1f(this._locMetrics.offset, this._lastDrift);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // STAGE 5 — reduce 256² → 1×1 via a chain of 2×2 box averages.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texMotion);
      gl.generateMipmap(gl.TEXTURE_2D);

      // STAGE 6 — readback of the 1×1 result. This is the GPU sync stall;
      // until it returns we don't know what the previous five stages saw.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboRead);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readback);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._lastMotion = this._readback[0] / 255;
      // G channel was packed as diff*0.5 + 0.5, so the rebiased value
      // averaged across the ROI gives mean drift in [-1..+1].
      this._lastDrift = (this._readback[1] / 255 - 0.5) * 2;
      this._lastLuma = this._readback[2] / 255;

      this._lastProcessedMediaTime = mediaTime;
    }

    if (!this._hasRef) return false;

    // STAGE 7 — trigger gate. Standard rising-edge debouncer:
    //   • Below threshold → mark ROI "clear" since the last trigger and
    //     return false.
    //   • At/above threshold → fire ONLY if ROI was clear at some point
    //     since the previous trigger, AND we're past the 3 s cooldown
    //     window. This prevents a single long pass (the bike crossing
    //     the gate over multiple frames) from firing both start and
    //     finish on the same motion event.
    if (this._lastMotion < this._threshold) {
      this._clearSinceTrigger = true;
      return false;
    }
    if (!this._clearSinceTrigger) return false;
    if (mediaTime - this._lastTriggerAt < this._cooldownSeconds) return false;
    this._clearSinceTrigger = false;
    this._lastTriggerAt = mediaTime;
    return true;
  }

  // Display pass — draw the camera into the visible canvas with a tinted
  // ROI rectangle. Called every frame regardless of session state so the
  // rider always has a smooth preview to aim with.
  //
  // mediaTime is passed by the caller (rVFC metadata) and used to dedupe
  // the texture upload against process(): when the session is active and
  // process() ran first this frame, _lastProcessedMediaTime already
  // matches and we skip the redundant texImage2D.
  drawDisplay(video, mediaTime) {
    const gl = this.gl;
    if (!gl || !video.videoWidth) return;
    this._resizeDisplayCanvas();

    if (mediaTime === undefined || mediaTime !== this._lastProcessedMediaTime) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texCur);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      if (mediaTime !== undefined) this._lastProcessedMediaTime = mediaTime;
    }

    // Compute the ROI in display UVs. The display draws the full camera
    // frame fullscreen; UVs map 1:1 to video UVs. After UNPACK_FLIP_Y,
    // display Y is bottom-up, so flip uvT/uvB before passing to the shader.
    let roiUv = null;
    if (this._roi) {
      const VW = video.videoWidth;
      const VH = video.videoHeight;
      roiUv = [
        this._roi.x / VW,
        1 - (this._roi.y + this._roi.h) / VH,
        (this._roi.x + this._roi.w) / VW,
        1 - this._roi.y / VH,
      ];
    } else {
      // No ROI yet → tint nothing.
      roiUv = [2, 2, 3, 3];
    }

    // Display draws Y-flipped UVs because UNPACK_FLIP_Y already flipped the
    // texture on upload; without the inverse flip here the preview would
    // appear upside-down.
    this._fillQuad(0, 1, 1, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this._progDisplay);
    gl.bindVertexArray(this._vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCur);
    gl.uniform1i(this._locDisplay.tex, 0);
    gl.uniform4f(this._locDisplay.roi, roiUv[0], roiUv[1], roiUv[2], roiUv[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _fillQuad(uvL, uvT, uvR, uvB) {
    // Triangle-strip quad (clip-space corners, with UVs of the chosen
    // sub-region). UV-Top maps to clip +1 (top of FBO), UV-Bottom maps
    // to clip −1 (bottom of FBO).
    const gl = this.gl;
    const data = new Float32Array([
      -1, -1, uvL, uvB,
       1, -1, uvR, uvB,
      -1,  1, uvL, uvT,
       1,  1, uvR, uvT,
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  _resizeDisplayCanvas() {
    const c = this.canvas;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, (c.clientWidth | 0) * dpr);
    const h = Math.max(1, (c.clientHeight | 0) * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }
}

/* ----- helpers (module-private) ----- */

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) || 'shader compile failed';
    gl.deleteShader(sh);
    throw new Error(info);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p) || 'program link failed';
    gl.deleteProgram(p);
    throw new Error(info);
  }
  return p;
}

function makeTex(gl) {
  // NEAREST throughout: even sub-pixel UV jitter between frames will
  // produce ghost-motion under LINEAR. Camera native resolution is far
  // higher than our 256² FBO so we don't gain anything from interpolation
  // anyway.
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function makeFboTex(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, FBO_SIZE, FBO_SIZE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function makeFbo(gl, tex, level) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, level);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`FBO incomplete (level=${level})`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}
