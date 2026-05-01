// WebGL2 background-subtraction detector.
//
// Public API mirrors the canvas-based Detector in detector.js so app.js
// can swap between them without changes. The internals are different:
// the camera frame is uploaded to a GPU texture, motion ratio (vs the
// reference) and stillness ratio (vs the previous frame) are computed
// by fragment shaders, reduced via generateMipmap to a 1×1 pixel, and
// read back via gl.readPixels(1, 1) — so each frame returns a SINGLE
// number to the CPU instead of dragging the whole ROI through
// getImageData. webgl-bench.html proves this path holds 60 FPS where
// the canvas path saturates at ~45.
//
// Pipeline per call (process / observeStillness / refreshReferenceSafely):
//   1. texImage2D(_texCur, video)         — upload current camera frame.
//   2. crop pass: _texCur (ROI sub-rect) → _texCurCropped (FBO_SIZE²).
//      After this everything below samples at fullscreen 0..1 UV.
//   3. diff pass: _texCurCropped vs (_texRef|_texPrev) → _texMotion.
//   4. generateMipmap(_texMotion) reduces FBO_SIZE → 1×1.
//   5. readPixels(0, 0, 1, 1) returns the motion ratio (R channel).
//
// Simplifications vs the canvas detector (acceptable for v1):
//   - Reference is a single uploaded frame (no 5-frame averaging). The
//     GPU's mipmap reduction over 256² fragments already smooths sensor
//     noise enough; if averaging turns out to matter we can add a
//     dedicated accumulation FBO later.
//   - Brightness offset compensation (mean-luma drift normalisation)
//     is omitted in v1. If outdoor exposure drift causes false
//     triggers, add a uniform on FS_DIFF computed from a 1×1 mipmap of
//     luma.
//   - refreshReferenceSafely treats every successful refresh as a
//     'replace' or 'blend' — no minFrames accumulation across frames.

const COOLDOWN_SECONDS = 3;
const FBO_SIZE = 256;                            // power-of-two for mipmap reduction
const FBO_MIP_LEVEL = Math.log2(FBO_SIZE) | 0;   // 8 → 1×1 pixel level

const VS = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUv = aUv;
}`;

// Diff: emits 1.0 where |luma(a) - luma(b)| > threshold else 0.0.
// Mipmap reduction averages → final 1×1 pixel = motion ratio.
const FS_DIFF = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main() {
  float la = dot(texture(uA, vUv).rgb, LUMA);
  float lb = dot(texture(uB, vUv).rgb, LUMA);
  float moved = step(uThreshold, abs(la - lb));
  outColor = vec4(moved, moved, moved, 1.0);
}`;

// Passthrough: writes texture A to the bound FBO. Used to crop the ROI
// sub-rect of the camera frame into a fullscreen FBO, and to seed the
// reference / previous-frame textures.
const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D uA;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(uA, vUv); }`;

// Blend: outputs mix(B, A, alpha). Used by refreshReferenceSafely's
// 'blend' mode for slow exposure-drift correction.
const FS_BLEND = `#version 300 es
precision highp float;
uniform sampler2D uA;       // current cropped frame
uniform sampler2D uB;       // existing reference
uniform float uAlpha;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = mix(texture(uB, vUv), texture(uA, vUv), uAlpha); }`;

export class Detector {
  constructor() {
    this.roi = null;
    this.threshold = 0.35;
    this.pixelDiffThreshold = 28 / 255; // canvas detector used 28/255 in luma
    this.cooldownSeconds = COOLDOWN_SECONDS;

    this._hasReference = false;
    this._captureRequested = false;
    this._hasPrevFrame = false;

    this._lastTriggerAt = -Infinity;
    this._lastRatio = 0;
    this._prevStillnessRatio = 1;
    this._clearSinceTrigger = true;

    this._lastReferenceRefreshAt = -Infinity;
    this._lastReferenceRefreshState = 'idle';
    this._lastBrightnessOffset = 0;

    this._uploadW = 0;
    this._uploadH = 0;

    this._initGl();
  }

  // ===== public API (mirrors detector.js) ==================================

  setRoi(roi) {
    this.roi = roi;
    this._hasReference = false;
    this._captureRequested = false;
    this._hasPrevFrame = false;
    this._lastReferenceRefreshAt = -Infinity;
    this._lastReferenceRefreshState = 'idle';
    this._clearSinceTrigger = true;
  }

  setThreshold(value) {
    this.threshold = value;
  }

  captureReference() {
    // Defer the actual GPU copy until process() runs with a fresh
    // camera frame. Same contract as the canvas detector ("next process
    // calls build the reference"), collapsed to N=1 here.
    this._hasReference = false;
    this._captureRequested = true;
    this._clearSinceTrigger = true;
  }

  hasReference() {
    return this._hasReference;
  }

  observeStillness(video /* , stillnessThreshold = 1 */) {
    if (!this.roi) return 1;
    if (!video || !video.videoWidth) return 1;

    this._uploadCurrent(video);
    this._cropCurrent();
    let ratio;
    if (!this._hasPrevFrame) {
      // First observation — no comparison possible. Match canvas
      // detector's "always returns 1 on the first call" semantics.
      ratio = 1;
    } else {
      ratio = this._diffCroppedAgainst(this._texPrev, this.pixelDiffThreshold);
    }
    this._copyCroppedTo(this._fboPrev);
    this._hasPrevFrame = true;
    this._prevStillnessRatio = ratio;
    return ratio;
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

  resetStillness() {
    this._hasPrevFrame = false;
    this._prevStillnessRatio = 1;
  }

  refreshReferenceSafely(video, metadata, {
    driftRatioThreshold,
    maxRatioThreshold,
    stillnessThreshold,
    /* stableDuration, minFrames — not used in this single-frame impl */
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

    this._uploadCurrent(video);
    this._cropCurrent();
    const motion = this._diffCroppedAgainst(this._texRef, this.threshold);
    const stillness = this._hasPrevFrame
      ? this._diffCroppedAgainst(this._texPrev, this.pixelDiffThreshold)
      : 1;

    if (motion < driftRatioThreshold) {
      this._lastReferenceRefreshState = 'idle';
      this._copyCroppedTo(this._fboPrev);
      this._hasPrevFrame = true;
      return false;
    }
    if (motion >= maxRatioThreshold) {
      this._lastReferenceRefreshState = 'blocked:high';
      this._copyCroppedTo(this._fboPrev);
      this._hasPrevFrame = true;
      return false;
    }
    if (stillness >= stillnessThreshold) {
      this._lastReferenceRefreshState = 'blocked:motion';
      this._copyCroppedTo(this._fboPrev);
      this._hasPrevFrame = true;
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
    this._copyCroppedTo(this._fboPrev);
    this._hasPrevFrame = true;
    this._lastReferenceRefreshAt = metadata.mediaTime;
    return true;
  }

  process(video, metadata) {
    if (!this.roi) return false;
    if (!video || !video.videoWidth) return false;

    this._uploadCurrent(video);
    this._cropCurrent();

    if (this._captureRequested) {
      this._copyCroppedTo(this._fboRef);
      this._copyCroppedTo(this._fboPrev);
      this._hasReference = true;
      this._hasPrevFrame = true;
      this._captureRequested = false;
      this._lastReferenceRefreshAt = metadata.mediaTime;
      this._clearSinceTrigger = true;
      return false;
    }

    if (!this._hasReference) return false;

    const ratio = this._diffCroppedAgainst(this._texRef, this.threshold);
    this._lastRatio = ratio;

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
    return `gpu ratio=${this._lastRatio.toFixed(3)} still=${this._prevStillnessRatio.toFixed(3)} thr=${this.threshold.toFixed(2)} ref=${this._hasReference ? 'ok' : 'building'} refresh=${this._lastReferenceRefreshState} gate=${gate}`;
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

    // Programs.
    this._progDiff = this._link(VS, FS_DIFF);
    this._locDiff = {
      a:    gl.getUniformLocation(this._progDiff, 'uA'),
      b:    gl.getUniformLocation(this._progDiff, 'uB'),
      thr:  gl.getUniformLocation(this._progDiff, 'uThreshold'),
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

    // Single VBO + VAO. UVs are filled per-draw so the same quad serves
    // both ROI-cropping (UV maps to ROI in video coords) and fullscreen
    // FBO-to-FBO passes (UV = 0..1).
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

    // Textures + FBOs.
    this._texCur = this._makeVideoTex();          // raw camera upload
    this._texCurCropped = this._makeFboTex(false); // ROI cropped fullscreen
    this._texRef = this._makeFboTex(false);        // reference frame
    this._texPrev = this._makeFboTex(false);       // prev frame for stillness
    this._texMotion = this._makeFboTex(true);      // diff result, mipmapped
    this._texScratch = this._makeFboTex(false);    // tmp for blend pass

    this._fboCurCropped = this._makeFbo(this._texCurCropped, 0);
    this._fboRef = this._makeFbo(this._texRef, 0);
    this._fboPrev = this._makeFbo(this._texPrev, 0);
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
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _makeFboTex(mip) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, mip ? FBO_MIP_LEVEL + 1 : 1, gl.RGBA8, FBO_SIZE, FBO_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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

  // Writes a quad with the given UV box into the VBO. Triangle-strip
  // order: bottom-left, bottom-right, top-left, top-right.
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
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, this._texCur);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    this._uploadW = video.videoWidth;
    this._uploadH = video.videoHeight;
  }

  // Crop the ROI sub-rect of _texCur into _texCurCropped (FBO_SIZE²).
  // After this, every subsequent pass samples at fullscreen 0..1 UV.
  _cropCurrent() {
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
  }

  // Diff _texCurCropped against another fullscreen FBO texture, reduce,
  // read back the 1×1 motion ratio.
  _diffCroppedAgainst(otherTex, threshold) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboMotion);
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE);
    gl.useProgram(this._progDiff);
    gl.bindVertexArray(this._vao);
    this._quad(0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCurCropped);
    gl.uniform1i(this._locDiff.a, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, otherTex);
    gl.uniform1i(this._locDiff.b, 1);
    gl.uniform1f(this._locDiff.thr, threshold);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texMotion);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboReadback);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuf);
    return this._readBuf[0] / 255;
  }

  // Full-UV passthrough copy from _texCurCropped into the given FBO.
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

  // Blend cropped current into reference: ref ← mix(ref, cropped, alpha).
  // Two-pass to avoid sample-from-and-write-to the same texture.
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
