// WebGL2 background-subtraction detector.
//
// Public API mirrors the canvas-based Detector in detector.js so app.js
// can swap between them without changes. The implementation is GPU-only
// from the camera all the way down to a single readPixels(1×1) per
// video frame.
//
// Pipeline per video frame:
//   1. texImage2D(_texCur, video)
//        Upload the current camera frame. Cached against
//        video.currentTime so app.js can call us multiple times per
//        frame without re-uploading.
//   2. ROI crop pass (FS_COPY)
//        Pull the ROI sub-rect out of _texCur into _texCurCropped, a
//        FBO_SIZE × FBO_SIZE FBO. After this every subsequent pass
//        samples at fullscreen 0..1 UV.
//   3. Metrics pass (FS_METRICS)
//        Single fragment shader that emits THREE channels at once:
//          R = motion mask        — step(uThreshold, |Δluma - drift|)
//          G = signed Δluma drift — (luma_cur - luma_ref)*0.5 + 0.5
//          B = current luma       — for autoscale / debug
//        The same shader handles brightness-offset compensation by
//        subtracting the last frame's signed drift before thresholding,
//        so a uniform exposure shift across the ROI is not counted as
//        motion.
//   4. generateMipmap(_texMotion)
//        Box-averages 256² → 1×1. Final pixel: R = fraction above
//        threshold (motion ratio), G = mean signed drift mapped to
//        0..1, B = mean current luma.
//   5. readPixels(0, 0, 1, 1)
//        Four bytes back to the CPU. ONE GPU sync stall per frame,
//        regardless of whether the caller wanted motion ratio,
//        stillness, or refresh-eligibility — they're all derived from
//        the same single read. This is the entire reason the WebGL
//        path holds 60 FPS where the canvas path saturates at ~45.
//
// Stillness vs prev frame is GONE.
//   The canvas detector measured "stillness" as a frame-to-frame diff
//   (cur vs the previous video frame) so OBSERVING could decide when
//   the ROI was empty enough to capture a fresh reference. After
//   debugging a stable 0.45 stillness reading on Samsung/Xiaomi
//   despite a perfectly still scene, the model was reworked: when a
//   reference exists, "still" simply means "the current frame is
//   close to the reference" (motion ratio low), and that single number
//   already tells us whether the ROI is empty. When NO reference
//   exists yet (very first OBSERVING), observeStillness returns 0 so
//   app.js's STABILITY_DURATION timer fires after the usual 2s and
//   captures the first reference.

const COOLDOWN_SECONDS = 3;
const FBO_SIZE = 256;
const FBO_MIP_LEVEL = Math.log2(FBO_SIZE) | 0;

// Explicit attribute locations. Without these the GLSL compiler is
// free to assign aPos and aUv in either order, which previously caused
// UV to receive position data ([-1..1]) and produced garbage sampling
// (a stable ~50% diff in a static scene).
const VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
out vec2 vUv;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUv = aUv;
}`;

// Combined metrics pass. Three independent measurements packed into
// the RGB channels of a single fragment output, so generateMipmap +
// one readPixels(1×1) returns all three at once.
//
//   R: motion mask, gated by threshold AFTER brightness-drift
//      compensation. Mipmap-averaged → motion ratio in [0..1].
//   G: signed Δluma per pixel, biased into [0..1] by *0.5 + 0.5 so
//      the mipmap average is interpretable. Decode on CPU as
//      (G_avg/255 - 0.5) * 2 → signed drift in [-1..1].
//   B: absolute current luma per pixel. Mipmap-averaged →
//      mean luma of the cropped ROI. Useful for autoscale and for
//      diagnostics; not used by the state machine in v1.
const FS_METRICS = `#version 300 es
precision highp float;
uniform sampler2D uA;             // current cropped
uniform sampler2D uB;             // reference
uniform float uThreshold;
uniform float uBrightnessOffset;  // signed drift from previous frame, [-1..1]
in vec2 vUv;
out vec4 outColor;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main() {
  float la = dot(texture(uA, vUv).rgb, LUMA);
  float lb = dot(texture(uB, vUv).rgb, LUMA);
  float signedDiff = la - lb;
  float compensated = signedDiff - uBrightnessOffset;
  float moved = step(uThreshold, abs(compensated));
  outColor = vec4(moved, signedDiff * 0.5 + 0.5, la, 1.0);
}`;

// Passthrough: writes texture A through to the bound FBO. Used to
// crop the ROI sub-rect of the camera frame into a fullscreen FBO,
// and to seed the reference texture.
const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D uA;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(uA, vUv); }`;

// Blend: outputs mix(B, A, alpha). Used by refreshReferenceSafely's
// 'blend' mode for slow exposure-drift correction of the reference.
const FS_BLEND = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uAlpha;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = mix(texture(uB, vUv), texture(uA, vUv), uAlpha); }`;

export class Detector {
  constructor() {
    this.roi = null;
    this.threshold = 0.35;
    this.cooldownSeconds = COOLDOWN_SECONDS;

    this._hasReference = false;
    this._captureRequested = false;

    this._lastTriggerAt = -Infinity;
    this._clearSinceTrigger = true;

    // Last metrics produced by _computeMetrics. Single source of truth
    // for both motion ratio (lastMotionRatio) and stillness
    // (lastStillnessRatio) — they read the same field.
    this._lastRatio = 0;
    this._prevStillnessRatio = 1;     // mirror of _lastRatio after observeStillness
    this._lastBrightnessOffset = 0;   // signed drift from previous frame
    this._lastAvgLuma = 0;            // mean luma in the ROI

    this._lastReferenceRefreshAt = -Infinity;
    this._lastReferenceRefreshState = 'idle';

    this._uploadW = 0;
    this._uploadH = 0;

    // Per-frame caches keyed by video.currentTime — app.js may call
    // process() and refreshReferenceSafely() back-to-back on the same
    // frame, and we'd rather skip the second upload + crop + diff +
    // readPixels than do them twice.
    this._lastUploadAt = -1;
    this._lastCropAt = -1;
    this._lastMetricsAt = -1;

    this._initGl();
  }

  // ===== public API (mirrors detector.js) ==================================

  setRoi(roi) {
    this.roi = roi;
    this._hasReference = false;
    this._captureRequested = false;
    this._lastReferenceRefreshAt = -Infinity;
    this._lastReferenceRefreshState = 'idle';
    this._clearSinceTrigger = true;
    this._lastBrightnessOffset = 0;
  }

  setThreshold(value) {
    this.threshold = value;
  }

  captureReference() {
    this._hasReference = false;
    this._captureRequested = true;
    this._clearSinceTrigger = true;
    this._lastBrightnessOffset = 0;
  }

  hasReference() {
    return this._hasReference;
  }

  // OBSERVING uses this to decide when the ROI is "calm enough" to
  // capture a fresh reference. The new model: if a reference exists,
  // "calmness" is just motion ratio (cur vs ref). Before any
  // reference exists (very first OBSERVING in a session), return 0
  // so app.js's STABILITY_DURATION timer fires after 2s and we
  // capture the first one.
  observeStillness(video /* , stillnessThreshold = 1 */) {
    if (!this.roi) return 1;
    if (!this._hasReference) {
      this._prevStillnessRatio = 0;
      return 0;
    }
    if (!video || !video.videoWidth) return 1;
    const m = this._computeMetrics(video);
    this._prevStillnessRatio = m.motion;
    return m.motion;
  }

  lastStillnessRatio() {
    return this._prevStillnessRatio;
  }

  lastMotionRatio() {
    return this._lastRatio;
  }

  clearReferenceRefreshStatus() {
    this._lastReferenceRefreshState = 'idle';
  }

  // No-op kept for API compatibility with detector.js. The frame-to-
  // frame stillness model is gone; nothing to reset.
  resetStillness() {}

  refreshReferenceSafely(video, metadata, {
    driftRatioThreshold,
    maxRatioThreshold,
    /* stillnessThreshold — no longer needed, motion ratio is the same signal */
    /* stableDuration, minFrames — single-frame replace/blend in this impl */
    minInterval,
    mode,
    blendAlpha = 1,
  }) {
    if (!this.roi || !this._hasReference) return false;
    if (!video || !video.videoWidth) return false;
    if (metadata.mediaTime - this._lastReferenceRefreshAt < minInterval) {
      const remaining = minInterval - (metadata.mediaTime - this._lastReferenceRefreshAt);
      this._lastReferenceRefreshState = `wait:${remaining.toFixed(1)}s`;
      return false;
    }

    const m = this._computeMetrics(video);
    if (m.motion < driftRatioThreshold) {
      this._lastReferenceRefreshState = 'idle';
      return false;
    }
    if (m.motion >= maxRatioThreshold) {
      this._lastReferenceRefreshState = 'blocked:high';
      return false;
    }

    if (mode === 'blend') {
      const alpha = Math.max(0, Math.min(1, blendAlpha));
      this._blendCroppedIntoReference(alpha);
      this._lastReferenceRefreshState = 'blend';
    } else {
      this._copyCroppedTo(this._fboRef);
      this._lastReferenceRefreshState = 'replace';
    }
    this._lastReferenceRefreshAt = metadata.mediaTime;
    // After updating the reference, the brightness offset accumulated
    // against the OLD reference is no longer meaningful — reset.
    this._lastBrightnessOffset = 0;
    return true;
  }

  process(video, metadata) {
    if (!this.roi) return false;
    if (!video || !video.videoWidth) return false;

    if (this._captureRequested) {
      this._uploadCurrent(video);
      this._cropCurrent();
      this._copyCroppedTo(this._fboRef);
      this._hasReference = true;
      this._captureRequested = false;
      this._lastReferenceRefreshAt = metadata.mediaTime;
      this._clearSinceTrigger = true;
      this._lastBrightnessOffset = 0;
      return false;
    }

    if (!this._hasReference) return false;

    const m = this._computeMetrics(video);
    const ratio = m.motion;

    if (ratio < this.threshold) {
      this._clearSinceTrigger = true;
      return false;
    }
    if (!this._clearSinceTrigger) return false;
    if (metadata.mediaTime - this._lastTriggerAt < COOLDOWN_SECONDS) return false;

    this._lastTriggerAt = metadata.mediaTime;
    this._clearSinceTrigger = false;
    return true;
  }

  cooldownRemaining(mediaTime) {
    return Math.max(0, COOLDOWN_SECONDS - (mediaTime - this._lastTriggerAt));
  }

  debugLine() {
    const gate = this._clearSinceTrigger ? 'open' : 'shut';
    return (
      `gpu ratio=${this._lastRatio.toFixed(3)} ` +
      `still=${this._prevStillnessRatio.toFixed(3)} ` +
      `drift=${this._lastBrightnessOffset.toFixed(3)} ` +
      `luma=${this._lastAvgLuma.toFixed(2)} ` +
      `thr=${this.threshold.toFixed(2)} ` +
      `ref=${this._hasReference ? 'ok' : 'building'} ` +
      `refresh=${this._lastReferenceRefreshState} ` +
      `gate=${gate}`
    );
  }

  // ===== WebGL plumbing ====================================================

  _initGl() {
    const canvas = document.createElement('canvas');
    canvas.width = FBO_SIZE;
    canvas.height = FBO_SIZE;
    this._canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
    });
    if (!gl) {
      throw new Error('WebGL2 not available — webgl-detector cannot run.');
    }
    this.gl = gl;

    this._progMetrics = this._link(VS, FS_METRICS);
    this._locMetrics = {
      a:    gl.getUniformLocation(this._progMetrics, 'uA'),
      b:    gl.getUniformLocation(this._progMetrics, 'uB'),
      thr:  gl.getUniformLocation(this._progMetrics, 'uThreshold'),
      off:  gl.getUniformLocation(this._progMetrics, 'uBrightnessOffset'),
    };
    this._progCopy = this._link(VS, FS_COPY);
    this._locCopy = {
      a: gl.getUniformLocation(this._progCopy, 'uA'),
    };
    this._progBlend = this._link(VS, FS_BLEND);
    this._locBlend = {
      a:     gl.getUniformLocation(this._progBlend, 'uA'),
      b:     gl.getUniformLocation(this._progBlend, 'uB'),
      alpha: gl.getUniformLocation(this._progBlend, 'uAlpha'),
    };

    // Single VBO + VAO. UVs filled per-draw so the same quad serves
    // both ROI cropping (UV maps the ROI in video coords) and
    // fullscreen FBO-to-FBO passes (UV = 0..1).
    this._vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(16), gl.DYNAMIC_DRAW);

    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    this._texCur = this._makeVideoTex();
    this._texCurCropped = this._makeFboTex(false);
    this._texRef = this._makeFboTex(false);
    this._texMotion = this._makeFboTex(true);   // mipmapped: holds metrics output, reduced
    this._texScratch = this._makeFboTex(false); // tmp buffer for blend (sample+write would alias texRef)

    this._fboCurCropped = this._makeFbo(this._texCurCropped, 0);
    this._fboRef = this._makeFbo(this._texRef, 0);
    this._fboMotion = this._makeFbo(this._texMotion, 0);
    this._fboReadback = this._makeFbo(this._texMotion, FBO_MIP_LEVEL);
    this._fboScratch = this._makeFbo(this._texScratch, 0);

    this._readBuf = new Uint8Array(4);
  }

  _link(vs, fs) {
    const gl = this.gl;
    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    }
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('program link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  _makeVideoTex() {
    // NEAREST so the ROI crop pass doesn't blend across pixel
    // boundaries — LINEAR + sub-pixel UVs would inject phantom
    // differences between consecutive frames and inflate ratios for a
    // static scene.
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _makeFboTex(mip) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, mip ? FBO_MIP_LEVEL + 1 : 1, gl.RGBA8, FBO_SIZE, FBO_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_NEAREST : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _makeFbo(tex, level) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, level);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('FBO incomplete');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }

  _quad(uvL, uvT, uvR, uvB) {
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

  _uploadCurrent(video) {
    const ct = video.currentTime;
    if (ct === this._lastUploadAt) return;
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, this._texCur);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    this._uploadW = video.videoWidth;
    this._uploadH = video.videoHeight;
    this._lastUploadAt = ct;
    this._lastCropAt = -1;
    this._lastMetricsAt = -1;
  }

  _cropCurrent() {
    if (this._lastCropAt === this._lastUploadAt) return;
    const gl = this.gl;
    const uvL = this.roi.x / this._uploadW;
    const uvR = (this.roi.x + this.roi.w) / this._uploadW;
    const uvT = this.roi.y / this._uploadH;
    const uvB = (this.roi.y + this.roi.h) / this._uploadH;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboCurCropped);
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE);
    gl.useProgram(this._progCopy);
    gl.bindVertexArray(this._vao);
    this._quad(uvL, uvT, uvR, uvB);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCur);
    gl.uniform1i(this._locCopy.a, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this._lastCropAt = this._lastUploadAt;
  }

  // The single per-frame measurement: upload + crop + metrics shader +
  // mipmap reduce + readPixels. Returns {motion, drift, avgLuma},
  // cached for re-entrant calls in the same frame.
  _computeMetrics(video) {
    this._uploadCurrent(video);
    this._cropCurrent();
    if (this._lastMetricsAt === this._lastUploadAt) {
      return {
        motion: this._lastRatio,
        drift: this._lastBrightnessOffset,
        avgLuma: this._lastAvgLuma,
      };
    }

    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboMotion);
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE);
    gl.useProgram(this._progMetrics);
    gl.bindVertexArray(this._vao);
    this._quad(0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCurCropped);
    gl.uniform1i(this._locMetrics.a, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._texRef);
    gl.uniform1i(this._locMetrics.b, 1);
    gl.uniform1f(this._locMetrics.thr, this.threshold);
    // Use the previous frame's drift to compensate before thresholding,
    // so the motion mask doesn't react to a uniform exposure shift
    // across the whole ROI.
    gl.uniform1f(this._locMetrics.off, this._lastBrightnessOffset);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texMotion);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboReadback);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuf);

    const motion = this._readBuf[0] / 255;
    // Unbias the signed drift channel: the shader wrote (diff*0.5+0.5),
    // mipmap averaged that, so decoded value = (G/255 - 0.5) * 2.
    const drift = (this._readBuf[1] / 255 - 0.5) * 2.0;
    const avgLuma = this._readBuf[2] / 255;

    this._lastRatio = motion;
    this._lastBrightnessOffset = drift;
    this._lastAvgLuma = avgLuma;
    this._lastMetricsAt = this._lastUploadAt;

    return { motion, drift, avgLuma };
  }

  _copyCroppedTo(targetFbo) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE);
    gl.useProgram(this._progCopy);
    gl.bindVertexArray(this._vao);
    this._quad(0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCurCropped);
    gl.uniform1i(this._locCopy.a, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _blendCroppedIntoReference(alpha) {
    const gl = this.gl;
    // Pass 1: scratch ← mix(ref, cropped, alpha).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboScratch);
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE);
    gl.useProgram(this._progBlend);
    gl.bindVertexArray(this._vao);
    this._quad(0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCurCropped);
    gl.uniform1i(this._locBlend.a, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._texRef);
    gl.uniform1i(this._locBlend.b, 1);
    gl.uniform1f(this._locBlend.alpha, alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: ref ← scratch.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboRef);
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE);
    gl.useProgram(this._progCopy);
    this._quad(0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texScratch);
    gl.uniform1i(this._locCopy.a, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
