// Main entry: wires UI, camera, detector, timer, storage, i18n.
// State machine: IDLE -> WAITING_START -> RUNNING -> FINISHED -> IDLE (on reset)

import { Camera } from './camera.js';
import { Detector } from './detector.js';
import { RoiPicker } from './roi.js';
import { Timer } from './timer.js';
import { Storage } from './storage.js';
import { renderVersionBadge } from './version.js';
import {
  ALL_LOCALES,
  LOCALE_LABELS,
  getLocale,
  setLocale,
  onLocaleChange,
  statusKey,
  t,
} from './i18n/index.js';

const STATE = Object.freeze({
  IDLE: 'IDLE',
  WAITING_START: 'WAITING_START',
  RUNNING: 'RUNNING',
  FINISHED: 'FINISHED',
});

const els = {
  video: document.getElementById('cam'),
  overlay: document.getElementById('overlay'),
  roiView: document.getElementById('roi-view'),
  timer: document.getElementById('timer'),
  status: document.getElementById('status'),
  fpsReadout: document.getElementById('fps-readout'),
  cooldown: document.getElementById('cooldown'),
  cooldownText: document.getElementById('cooldown-text'),
  cooldownFill: document.getElementById('cooldown-fill'),
  debug: document.getElementById('debug'),
  btnStartCamera: document.getElementById('btn-start-camera'),
  btnSetRoi: document.getElementById('btn-set-roi'),
  btnArm: document.getElementById('btn-arm'),
  btnReset: document.getElementById('btn-reset'),
  btnUpdate: document.getElementById('btn-update'),
  versionBadge: document.getElementById('version-badge'),
  threshold: document.getElementById('threshold'),
  debugToggle: document.getElementById('debug-toggle'),
  langSelect: document.getElementById('lang-select'),
};

const roiViewCtx = els.roiView.getContext('2d');
let currentRoi = null; // video-intrinsic coordinates

const camera = new Camera(els.video);
const detector = new Detector();
const roiPicker = new RoiPicker(els.overlay);
const timer = new Timer(els.timer);
const storage = new Storage();

let state = STATE.IDLE;
let t0 = 0;
let startedAt = 0;
let wakeLock = null;

// FPS / timing-precision tracking.
// Rolling buffer of the last N frame intervals (seconds), sourced from
// metadata.mediaTime — the authoritative frame clock from rVFC.
// Timing precision for a single detection event is half the frame interval
// (uniform uncertainty over the [prev frame, current frame] window).
const FPS_WINDOW = 30;
const fpsBuf = new Float32Array(FPS_WINDOW);
let fpsIdx = 0;
let fpsFilled = 0;
let fpsPrevMediaTime = 0;
let fpsLastRenderMs = 0;
let fpsLastFps = 0;
let fpsLastPrecisionMs = 0;

function updateFpsReadout(frameMediaTime) {
  if (fpsPrevMediaTime) {
    const dt = frameMediaTime - fpsPrevMediaTime;
    // Guard against video-seek / track-swap anomalies: only accept plausible
    // intra-stream deltas (roughly 1 FPS .. 240 FPS).
    if (dt > 0.004 && dt < 1) {
      fpsBuf[fpsIdx] = dt;
      fpsIdx = (fpsIdx + 1) % FPS_WINDOW;
      if (fpsFilled < FPS_WINDOW) fpsFilled++;
    }
  }
  fpsPrevMediaTime = frameMediaTime;

  if (fpsFilled < 5) return;
  const nowMs = performance.now();
  if (nowMs - fpsLastRenderMs < 250) return;
  fpsLastRenderMs = nowMs;

  let sum = 0;
  for (let i = 0; i < fpsFilled; i++) sum += fpsBuf[i];
  const avgDt = sum / fpsFilled;
  const fps = Math.round(1 / avgDt);
  const precisionMs = Math.round((avgDt * 1000) / 2);
  if (fps === fpsLastFps && precisionMs === fpsLastPrecisionMs) return;
  fpsLastFps = fps;
  fpsLastPrecisionMs = precisionMs;
  els.fpsReadout.textContent = t('ui.fpsReadout', { fps, ms: precisionMs });
  els.fpsReadout.hidden = false;
}

function applyTranslations() {
  for (const el of document.querySelectorAll('[data-i18n-key]')) {
    el.textContent = t(el.dataset.i18nKey);
  }
  // Status element has a dynamic key — re-resolve from its current data-status.
  els.status.textContent = t(statusKey(els.status.dataset.status));
  // FPS readout uses interpolation — re-render with the last measured values.
  if (!els.fpsReadout.hidden) {
    els.fpsReadout.textContent = t('ui.fpsReadout', {
      fps: fpsLastFps,
      ms: fpsLastPrecisionMs,
    });
  }
  // Cooldown text also uses interpolation; render a zero-state placeholder
  // so the label is already localized before the first countdown frame.
  // While the cooldown is actively counting down, the next onFrame will
  // overwrite this within one frame, so no visible flicker.
  if (els.cooldown.hidden) {
    els.cooldownText.textContent = t('ui.cooldown', { seconds: '0.0' });
  }
  document.documentElement.lang = getLocale();
}

function populateLangSelect() {
  els.langSelect.innerHTML = '';
  for (const loc of ALL_LOCALES) {
    const opt = document.createElement('option');
    opt.value = loc;
    opt.textContent = LOCALE_LABELS[loc];
    els.langSelect.appendChild(opt);
  }
  els.langSelect.value = getLocale();
}

function setState(next) {
  state = next;
  els.status.dataset.status = next;
  els.status.textContent = t(statusKey(next));
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (err) {
    console.warn('Wake lock failed:', err);
  }
}

/**
 * Convert a rectangle picked on the overlay (CSS pixels of the overlay element)
 * to the video's intrinsic pixel coordinate system, which is what drawImage's
 * source-rect arguments expect.
 *
 * The overlay covers the stage; the <video> uses object-fit: cover, so the
 * intrinsic video content is scaled by s = max(W/Vw, H/Vh) and centered.
 * Anything outside the visible sub-rectangle is cropped by object-fit.
 */
function mapCssRoiToVideoRoi(cssRoi, video, overlay) {
  const rect = overlay.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  const Vw = video.videoWidth;
  const Vh = video.videoHeight;
  if (!Vw || !Vh) return cssRoi; // video not ready — unlikely, guard anyway

  const s = Math.max(W / Vw, H / Vh);
  const scaledW = Vw * s;
  const scaledH = Vh * s;
  const offsetX = (W - scaledW) / 2;
  const offsetY = (H - scaledH) / 2;

  const rawX = (cssRoi.x - offsetX) / s;
  const rawY = (cssRoi.y - offsetY) / s;
  const rawW = cssRoi.w / s;
  const rawH = cssRoi.h / s;

  // Clamp into the intrinsic video rectangle.
  const x = Math.max(0, Math.min(Vw, rawX));
  const y = Math.max(0, Math.min(Vh, rawY));
  const w = Math.max(1, Math.min(Vw - x, rawW));
  const h = Math.max(1, Math.min(Vh - y, rawH));
  return { x, y, w, h };
}

function clearOverlay() {
  const octx = els.overlay.getContext('2d');
  octx.clearRect(0, 0, els.overlay.width, els.overlay.height);
}

function activateRoiView(roi) {
  currentRoi = roi;
  const stage = document.getElementById('stage');
  const stageRect = stage.getBoundingClientRect();
  // Match canvas pixel buffer to its CSS size for a crisp render.
  els.roiView.width = Math.max(1, Math.round(stageRect.width * devicePixelRatio));
  els.roiView.height = Math.max(1, Math.round(stageRect.height * devicePixelRatio));
  els.roiView.hidden = false;
  document.body.dataset.roiActive = 'true';
  clearOverlay();
}

function deactivateRoiView() {
  currentRoi = null;
  els.roiView.hidden = true;
  document.body.dataset.roiActive = 'false';
  roiViewCtx.clearRect(0, 0, els.roiView.width, els.roiView.height);
}

/**
 * Show/hide the cooldown pill and update its countdown + progress bar.
 * Only relevant while the run is actively expecting triggers
 * (WAITING_START or RUNNING) — during IDLE/FINISHED the indicator stays hidden.
 */
function updateCooldownIndicator(mediaTime) {
  const remaining = detector.cooldownRemaining(mediaTime);
  const active =
    remaining > 0 &&
    (state === STATE.WAITING_START || state === STATE.RUNNING);

  if (!active) {
    if (!els.cooldown.hidden) els.cooldown.hidden = true;
    return;
  }

  els.cooldown.hidden = false;
  els.cooldownText.textContent = t('ui.cooldown', {
    seconds: remaining.toFixed(1),
  });
  const pct = Math.max(0, Math.min(100, (remaining / detector.cooldownSeconds) * 100));
  els.cooldownFill.style.width = `${pct}%`;
}

function drawRoiView(video) {
  if (!currentRoi) return;
  const { width: cw, height: ch } = els.roiView;
  roiViewCtx.clearRect(0, 0, cw, ch);
  // Letterbox — preserve the ROI's aspect ratio so the image doesn't stretch.
  const scale = Math.min(cw / currentRoi.w, ch / currentRoi.h);
  const dw = currentRoi.w * scale;
  const dh = currentRoi.h * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  roiViewCtx.drawImage(
    video,
    currentRoi.x, currentRoi.y, currentRoi.w, currentRoi.h,
    dx, dy, dw, dh,
  );
}

function onFrame(frame, metadata) {
  // metadata.mediaTime is the authoritative frame timestamp (seconds).
  // Measure FPS/precision on every frame regardless of state, so the user
  // can see current timing quality even before arming a run.
  updateFpsReadout(metadata.mediaTime);
  // Render the ROI crop (no-op if the user hasn't set a ROI yet).
  drawRoiView(frame);
  // Show/tick the cooldown pill — must run each frame so the countdown is live.
  updateCooldownIndicator(metadata.mediaTime);

  if (state === STATE.IDLE || state === STATE.FINISHED) return;

  const triggered = detector.process(frame, metadata);

  if (els.debug.hidden === false) {
    els.debug.textContent = detector.debugLine();
  }

  if (!triggered) return;

  if (state === STATE.WAITING_START) {
    t0 = metadata.mediaTime;
    startedAt = Date.now();
    timer.start(t0);
    timer.speak(t('voice.start'));
    setState(STATE.RUNNING);
    return;
  }

  if (state === STATE.RUNNING) {
    const elapsed = metadata.mediaTime - t0;
    timer.stop(elapsed);
    timer.speak(t('voice.finish', { seconds: elapsed.toFixed(2) }));
    storage.save({ elapsed, startedAt, finishedAt: Date.now() });
    setState(STATE.FINISHED);
  }
}

els.btnStartCamera.addEventListener('click', async () => {
  await camera.start();
  await requestWakeLock();
  camera.onFrame(onFrame);
  els.btnStartCamera.disabled = true;
  els.btnSetRoi.disabled = false;
});

els.btnSetRoi.addEventListener('click', async () => {
  // Re-show the full camera so the user can see what they're selecting.
  deactivateRoiView();
  const cssRoi = await roiPicker.pick();
  const videoRoi = mapCssRoiToVideoRoi(cssRoi, els.video, els.overlay);
  detector.setRoi(videoRoi);
  activateRoiView(videoRoi);
  els.btnArm.disabled = false;
});

els.btnArm.addEventListener('click', () => {
  detector.captureReference();
  detector.setThreshold(parseFloat(els.threshold.value));
  timer.reset();
  setState(STATE.WAITING_START);
  els.btnReset.disabled = false;
});

els.btnReset.addEventListener('click', () => {
  timer.reset();
  setState(STATE.IDLE);
});

els.threshold.addEventListener('input', () => {
  detector.setThreshold(parseFloat(els.threshold.value));
});

els.debugToggle.addEventListener('change', () => {
  els.debug.hidden = !els.debugToggle.checked;
});

els.langSelect.addEventListener('change', () => {
  setLocale(els.langSelect.value);
});

onLocaleChange(applyTranslations);

// Initial UI paint.
populateLangSelect();
applyTranslations();
setState(STATE.IDLE);
renderVersionBadge(els.versionBadge);

// ---------------------------------------------------------------------------
// Service worker registration + in-app update flow.
//
// Goals:
//   1. Install the SW so the app works offline and is installable as PWA.
//   2. Detect new SW versions while the app is running and apply them without
//      forcing the user to "clear site data" or reinstall the PWA.
//   3. Never reload mid-run: if state is IDLE or FINISHED we auto-apply the
//      update silently; if WAITING_START or RUNNING we show a small "Update"
//      button in the controls row and let the rider press it when safe.
//
// Mechanics:
//   - sw.js no longer calls skipWaiting() in 'install'; new versions sit in
//     `waiting` until we post { type: 'SKIP_WAITING' }. That keeps the
//     decision on the client side.
//   - We poll registration.update() periodically and on tab re-focus so that
//     new versions are discovered promptly (browsers otherwise re-check the
//     SW file only on navigation, and at most every 24h).
//   - Once a new SW is 'installed' with an existing controller, we either
//     activate it immediately (safe state) or expose the Update button.
//   - A 'controllerchange' listener performs the one-shot reload once the
//     new SW takes over — but only if there was a controller before, so
//     first-load doesn't trigger a spurious reload when clients.claim() runs.
//
// Dev-mode note: the dev server's live-reload shim unregisters the SW and
// nukes caches on every file change (scripts/dev-server.ts), so this update
// flow does not fire under the default `bun run start`. To exercise it end
// to end, start with DEV_RELOAD=0 bun run start, bump CACHE_VERSION in
// sw.js, hit refresh once to install the new worker, and watch for either
// the silent reload or the Update button depending on state.
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    registerServiceWorker();
  });
}

function registerServiceWorker() {
  // Capture whether the page is already controlled before registration — we
  // only want 'controllerchange' to trigger a reload for genuine updates,
  // not for the first-ever install where clients.claim() transitions a
  // previously-uncontrolled page to controlled.
  const hadController = Boolean(navigator.serviceWorker.controller);

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker
    .register('./sw.js')
    .then((registration) => {
      // Case 1: page loaded and a waiting SW was already present from a
      // previous session (user opened the PWA, closed it before deciding to
      // update, reopened now).
      if (registration.waiting && navigator.serviceWorker.controller) {
        onUpdateReady(registration.waiting);
      }

      // Case 2: a new SW starts installing while the page is live.
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            onUpdateReady(installing);
          }
        });
      });

      // Poll for new SW files periodically and when the tab regains focus.
      const pollMs = 60_000;
      setInterval(() => registration.update().catch(() => {}), pollMs);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) registration.update().catch(() => {});
      });
    })
    .catch((err) => {
      console.warn('SW registration failed:', err);
    });
}

// Called exactly once per pending SW version. Either applies the update
// silently (safe state) or wires up the Update button for manual apply.
function onUpdateReady(worker) {
  const safe = state === STATE.IDLE || state === STATE.FINISHED;
  if (safe) {
    worker.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  showUpdateButton(() => worker.postMessage({ type: 'SKIP_WAITING' }));
}

function showUpdateButton(onClick) {
  els.btnUpdate.hidden = false;
  // Replace the node to discard any previous click handler so repeated
  // updatefound events don't stack listeners.
  const fresh = els.btnUpdate.cloneNode(true);
  els.btnUpdate.replaceWith(fresh);
  els.btnUpdate = fresh;
  els.btnUpdate.addEventListener('click', () => {
    els.btnUpdate.disabled = true;
    onClick();
  }, { once: true });
}
