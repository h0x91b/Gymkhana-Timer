// Main entry: wires UI, camera, detector, timer, storage, i18n.
//
// Hands-free session lifecycle (the core UX contract — see AGENTS.md →
// "Session mode" and TZ.md → "Hands-free session mode"):
//
//   IDLE
//     └── user taps "Start session" (once, after the manual camera+ROI setup)
//   OBSERVING
//     │    detector.observeStillness() probes frame-to-frame delta;
//     │    once the ROI has been empty/still for STABILITY_DURATION seconds
//     │    we call detector.captureReference() and wait for it to finish
//     │    building the averaged reference (REFERENCE_FRAMES).
//     │    If > OBSERVING_ERROR_TIMEOUT seconds pass without stability, the
//     │    signal phase flips to "error" (bright coral background) while
//     │    logic stays in OBSERVING — the rider will notice and intervene.
//     └── reference built
//   ARMED
//     │    detector.process() is trusted; first motion trigger starts a run.
//     │    Phase = "armed" (lime-green background, slow pulse).
//     └── motion detected
//   RUNNING
//     │    timer.start() ticks live. Background drops to neutral parchment
//     │    — we don't want the rider's eye yanked around mid-run.
//     └── second motion trigger (after detector cooldown)
//   FINISHED
//     │    timer.stop(elapsed) freezes the true mediaTime-based result,
//     │    voice announces "finish, N.N seconds", run saved to storage,
//     │    phase briefly flashes ivory.
//     └── FINISHED_FLASH seconds elapse
//   COOLDOWN (2.5s)
//     │    Big timer keeps the last run's time displayed. The cooldown pill
//     │    below the timer shows a draining progress bar and countdown.
//     │    Phase = "cooldown" (amber background). After 2.5s we
//     │    loop back to OBSERVING. The rider NEVER has to walk up to the
//     │    phone in this loop — that's the whole point.
//     └── 2.5s done
//   OBSERVING → ARMED → …
//
// Stop session is the only thing that exits the loop; a tap anywhere during
// hands-free reveals the controls briefly so the rider can hit it.

import { Camera } from './camera.js';
import { Detector } from './detector.js';
import { BUILD_INFO } from './build-info.js';
// RoiPicker (two-tap corner picker) is deliberately unused. Keeping the
// file around for reference — the two-tap flow was replaced with
// "zoom-as-ROI": the visible viewport (after pinch/pan) IS the ROI. See
// the btnSetRoi handler below for the single-function conversion.
// Reason for the switch: the tap picker raced with the Viewport pinch
// gesture — the first finger's pointerdown fired before the second
// finger could set `body.dataset.gesturing=true`, so a pinch always
// registered a stray corner-tap before the zoom kicked in.
import { Timer } from './timer.js';
import { Storage } from './storage.js';
import { Viewport } from './viewport.js';
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
  IDLE: 'IDLE',           // pre-session; also after Stop session
  OBSERVING: 'OBSERVING', // session running; waiting for stable ROI + reference
  ARMED: 'ARMED',         // reference captured, waiting for first motion
  RUNNING: 'RUNNING',     // actively timing a run
  FINISHED: 'FINISHED',   // brief post-finish flash
  COOLDOWN: 'COOLDOWN',   // 2.5s between-runs countdown
  ERROR: 'ERROR',         // not a true state — a visual overlay on OBSERVING
});

// Hands-free timing parameters. Tuned for gymkhana practice outdoors.
// See AGENTS.md → "Session mode" for the rationale.
const STABILITY_THRESHOLD = 0.04;        // ≤ 4% pixel delta between frames = "still"
const STABILITY_DURATION = 2.0;          // seconds of continuous stillness to arm
const OBSERVING_ERROR_TIMEOUT = 20.0;    // seconds; past this OBSERVING flips to coral "come over" signal
const BETWEEN_RUNS_COOLDOWN = 2.5;       // seconds between FINISHED and the next OBSERVING
const FINISHED_FLASH = 1.0;              // seconds of ivory flash right after finish
const TAP_REVEAL_MS = 5000;              // controls stay visible this long after a tap during hands-free
const NOT_READY_VOICE_INTERVAL = 15.0;   // seconds; spoken while the session is active but not yet ARMED
const ROI_PREVIEW_FPS = 8;               // thumbnail is a framing aid, not a precision signal
const DEBUG_RENDER_INTERVAL = 0.25;       // seconds; avoid per-frame string churn
const REFERENCE_REFRESH_CLEAR_RATIO = 0.04;      // only frames far below trigger threshold can update reference
const REFERENCE_REFRESH_STILLNESS = 0.03;        // stricter than OBSERVING stability; refresh must be boring
const REFERENCE_REFRESH_DURATION = 1.5;          // seconds of clean frames before applying a candidate
const REFERENCE_REFRESH_MIN_FRAMES = 8;          // protects very low-FPS streams from one-frame refreshes
const ARMED_REFERENCE_REFRESH_INTERVAL = 10.0;   // seconds between hard swaps while waiting to start
const RUNNING_REFERENCE_REFRESH_INTERVAL = 8.0;  // seconds between slow blends during long runs
const RUNNING_REFERENCE_REFRESH_GUARD = 8.0;     // never adapt while the bike may still be clearing the line
const RUNNING_REFERENCE_REFRESH_BLEND = 0.06;    // slow drift correction; finish detection stays dominant

const els = {
  video: document.getElementById('cam'),
  overlay: document.getElementById('overlay'),
  buildStamp: document.getElementById('build-stamp'),
  roiView: document.getElementById('roi-view'),
  timer: document.getElementById('timer'),
  timerSubline: document.getElementById('timer-subline'),
  status: document.getElementById('status'),
  fpsReadout: document.getElementById('fps-readout'),
  cooldown: document.getElementById('cooldown'),
  cooldownText: document.getElementById('cooldown-text'),
  cooldownFill: document.getElementById('cooldown-fill'),
  debug: document.getElementById('debug'),
  btnStartCamera: document.getElementById('btn-start-camera'),
  btnSetRoi: document.getElementById('btn-set-roi'),
  btnSession: document.getElementById('btn-session'),
  btnUpdate: document.getElementById('btn-update'),
  runHistory: document.getElementById('run-history'),
  threshold: document.getElementById('threshold'),
  debugToggle: document.getElementById('debug-toggle'),
  langSelect: document.getElementById('lang-select'),
  viewport: document.getElementById('viewport'),
  gestureHint: document.getElementById('gesture-hint'),
  reticle: document.getElementById('reticle'),
  controls: document.getElementById('controls'),
};

const roiViewCtx = els.roiView.getContext('2d');
let currentRoi = null; // video-intrinsic coordinates

const camera = new Camera(els.video);
const detector = new Detector();
const timer = new Timer(els.timer);
const storage = new Storage();
const viewport = new Viewport(els.viewport);
viewport.attach();

let state = STATE.IDLE;
let t0 = 0;
let startedAt = 0;
let wakeLock = null;
// The browser auto-releases the Wake Lock when the page goes hidden (tab
// switch, phone lock, incoming call). We re-request on `visibilitychange`
// so the screen stays awake across interruptions — but only if the user
// ever started the camera in this session. Without this flag we'd grab a
// lock on page load, which is wasteful and not what the user asked for.
let wakeLockDesired = false;

// Session-loop bookkeeping. All time values are frame mediaTime (seconds),
// NOT performance.now() / Date.now(). The frame clock is the source of truth
// for every timing-sensitive decision we make — see TZ.md "Timing".
let sessionActive = false;
let observingStartedAt = 0;      // when we last entered OBSERVING
let stableSince = 0;             // mediaTime when the current stillness streak began (0 = broken)
let cooldownStartedAt = 0;       // mediaTime when we entered COOLDOWN
let finishedFlashUntil = 0;      // mediaTime after which FINISHED transitions to COOLDOWN
let lastFrameMediaTime = 0;      // last frame's mediaTime, cached for non-frame callers
let lastRunElapsed = null;       // seconds; shown on the big timer between runs
let tapRevealTimer = 0;          // setTimeout handle for controls auto-hide
let nextNotReadyVoiceAt = 0;     // mediaTime when we should next speak "not ready" (0 = disabled / session off)
let roiPreviewLastDrawAt = -Infinity;
let debugLastRenderAt = -Infinity;
let cooldownLastText = '';
let cooldownLastPct = null;
let sublineLastVisible = null;
let sublineLastText = '';

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
  updateBuildStamp();
  // Status element has a dynamic key — re-resolve from its current data-status.
  els.status.textContent = t(statusKey(els.status.dataset.status));
  // The session button is "Start session" vs "Stop session" depending on
  // whether the hands-free loop is active. Its label is swapped via the
  // data-i18n-key on the same element; re-render on locale change.
  refreshSessionButton();
  // FPS readout uses interpolation — re-render with the last measured values.
  if (!els.fpsReadout.hidden) {
    els.fpsReadout.textContent = t('ui.fpsReadout', {
      fps: fpsLastFps,
      ms: fpsLastPrecisionMs,
    });
  }
  // The timer sub-line ("ready to go", previous run time, observing hint)
  // pulls its text from translations on every frame during the session;
  // force an immediate re-render so a mid-session language swap doesn't
  // leave a stale string visible for up to one frame.
  updateSubline(lastFrameMediaTime);
  document.documentElement.lang = getLocale();
}

function formatBuildVersion(version) {
  const raw = String(version || '').trim();
  if (!raw) return t('ui.buildLocal');
  const numeric = raw.match(/(?:^|-)v?(\d+(?:\.\d+)*)$/);
  return numeric ? `v${numeric[1]}` : raw;
}

function formatBuildTime(value) {
  if (!value) return t('ui.buildLocal');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return t('ui.buildUnknown');
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    '-',
    pad(date.getUTCMonth() + 1),
    '-',
    pad(date.getUTCDate()),
    ' ',
    pad(date.getUTCHours()),
    ':',
    pad(date.getUTCMinutes()),
    'Z',
  ].join('');
}

function updateBuildStamp() {
  const version = formatBuildVersion(BUILD_INFO.version);
  const builtAt = formatBuildTime(BUILD_INFO.builtAt);
  const commit = BUILD_INFO.commit ? String(BUILD_INFO.commit).slice(0, 12) : t('ui.buildLocal');
  els.buildStamp.textContent = `${version} · ${builtAt}`;
  const label = t('ui.buildStampLabel', { version, builtAt, commit });
  els.buildStamp.setAttribute('aria-label', label);
  els.buildStamp.title = label;
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
  updatePhase();
  refreshSessionButton();
}

// Single lifecycle button at the bottom:
//   IDLE (pre-session), ROI ready     → "Start session" — enters hands-free loop.
//   IDLE, ROI not ready               → disabled (need to pick a ROI first).
//   Any in-session state              → "Stop session" — exits the loop.
function refreshSessionButton() {
  const btn = els.btnSession;
  const key = sessionActive ? 'ui.stopSession' : 'ui.startSession';
  btn.dataset.i18nKey = key;
  btn.textContent = t(key);
  // Stop is always clickable while the session runs; Start needs a ROI.
  btn.disabled = !sessionActive && !currentRoi;
  btn.classList.add('primary');
}

// Apply the data-phase attribute that drives the signal-background CSS.
// The phase is derived from state + wall-time spent in OBSERVING so the
// rider sees a bright-coral "come over" cue once we've been stuck looking
// for a clean frame for more than OBSERVING_ERROR_TIMEOUT seconds.
function updatePhase() {
  let phase;
  if (!sessionActive) {
    // Before/after a session we're in manual-setup territory. The parchment
    // default is shown and the controls panel is visible.
    phase = 'setup';
  } else {
    switch (state) {
      case STATE.OBSERVING: {
        const elapsed = lastFrameMediaTime - observingStartedAt;
        phase = elapsed > OBSERVING_ERROR_TIMEOUT ? 'error' : 'observing';
        break;
      }
      case STATE.ARMED:    phase = 'armed'; break;
      case STATE.RUNNING:  phase = 'running'; break;
      case STATE.FINISHED: phase = 'finished'; break;
      case STATE.COOLDOWN: phase = 'cooldown'; break;
      default:             phase = 'setup';
    }
  }
  if (document.body.dataset.phase !== phase) {
    document.body.dataset.phase = phase;
  }
}

async function requestWakeLock() {
  wakeLockDesired = true;
  if (!('wakeLock' in navigator)) return;
  // Already have a live lock — nothing to do. `released` flips to true after
  // the browser auto-releases it on visibility change.
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // The `release` event fires whether the release was ours or the browser's
    // (page hidden, battery-saver kick-in). Clear the ref so the next
    // visibility-return path grabs a fresh lock cleanly.
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (err) {
    // Typical cause: page not visible at the moment of request. That's fine
    // — the visibilitychange handler will retry when we're visible again.
    console.warn('Wake lock failed:', err);
  }
}

// Re-acquire the screen wake lock when the tab becomes visible again.
// The browser releases it automatically on hide (tab switch, phone lock,
// app-switcher, incoming call) and there is no way to prevent that; the
// only fix is to ask again on return. Guarded by `wakeLockDesired` so we
// don't grab a lock before the user has ever started the camera.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLockDesired) {
    requestWakeLock();
  }
});

/**
 * Convert a rectangle picked in the viewport's intrinsic CSS pixel space
 * into the video's intrinsic pixel coordinate system — what drawImage's
 * source-rect arguments expect.
 *
 * The viewport (W × H CSS pixels before any pinch transform) contains the
 * <video>, which uses object-fit: cover. So the intrinsic video content
 * is scaled by s = max(W/Vw, H/Vh) and centered. Anything outside the
 * visible sub-rectangle is cropped by object-fit.
 *
 * Because the ROI is captured in pre-transform CSS pixels (see
 * viewport.cssToIntrinsic), pinch-zooming after picking does NOT shift
 * the ROI — it's a pure UX affordance, not a source of truth.
 */
function mapCssRoiToVideoRoi(cssRoi, video, W, H) {
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
  els.roiView.hidden = false;
  document.body.dataset.roiActive = 'true';
  // Reset the pinch transform now that the ROI is locked in. The zoomed
  // camera view isn't useful in the ROI-active layout (the camera is
  // hidden anyway), and resetting ensures the next "Set ROI" pass starts
  // from 1× instead of inheriting the previous zoom state.
  viewport.reset();
  clearOverlay();
  // The layout flip (ROI pill shrinks to the corner, timer grows to hero size)
  // is CSS-driven and animates over ~220ms. The canvas pixel buffer must match
  // its *final* CSS box so the ROI crop renders sharp. We resize once now
  // (so it doesn't render at stage-size for one frame), then again after the
  // transition completes to pick up the shrunken size.
  resizeRoiViewCanvas();
  setTimeout(resizeRoiViewCanvas, 260);
}

function deactivateRoiView() {
  currentRoi = null;
  els.roiView.hidden = true;
  document.body.dataset.roiActive = 'false';
  roiViewCtx.clearRect(0, 0, els.roiView.width, els.roiView.height);
}

// Sync the ROI-view canvas pixel buffer to its current CSS bounding box.
// Called after ROI activation, after the CSS transition settles, and on
// viewport resize / orientation change.
function resizeRoiViewCanvas() {
  if (els.roiView.hidden) return;
  const rect = els.roiView.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * devicePixelRatio));
  const h = Math.max(1, Math.round(rect.height * devicePixelRatio));
  if (els.roiView.width !== w) els.roiView.width = w;
  if (els.roiView.height !== h) els.roiView.height = h;
}

window.addEventListener('resize', resizeRoiViewCanvas);
window.addEventListener('orientationchange', resizeRoiViewCanvas);

/**
 * Cooldown pill — the canonical between-runs indicator. The pill
 * is intentionally prominent (bigger text, thicker bar) because it's a
 * first-class rider-facing signal, not a debug affordance. Rendered only
 * while we are actually in STATE.COOLDOWN.
 *
 * The pill is the ONLY place the countdown is displayed — during
 * COOLDOWN the text sub-line above is suppressed so the rider has a single
 * unambiguous read (see updateSubline).
 */
function updateCooldownIndicator(mediaTime) {
  if (state !== STATE.COOLDOWN) {
    if (!els.cooldown.hidden) els.cooldown.hidden = true;
    cooldownLastText = '';
    cooldownLastPct = null;
    return;
  }
  const remaining = Math.max(0, BETWEEN_RUNS_COOLDOWN - (mediaTime - cooldownStartedAt));
  if (els.cooldown.hidden) els.cooldown.hidden = false;

  const text = `${remaining.toFixed(1)}s`;
  if (text !== cooldownLastText) {
    cooldownLastText = text;
    els.cooldownText.textContent = text;
  }

  const pct = Math.round(Math.max(0, Math.min(100, (remaining / BETWEEN_RUNS_COOLDOWN) * 100)));
  if (pct !== cooldownLastPct) {
    cooldownLastPct = pct;
    els.cooldownFill.style.width = `${pct}%`;
  }
}

// The secondary read-out under the big timer. Content is purely a function of
// state + time; kept intentionally short so a rider can glance at it from
// across the lot and understand it in a single fixation.
function updateSubline(mediaTime) {
  const el = els.timerSubline;
  if (!sessionActive) {
    if (sublineLastVisible !== false) {
      sublineLastVisible = false;
      el.hidden = true;
    }
    sublineLastText = '';
    return;
  }
  let text = '';
  let visible = true;
  switch (state) {
    case STATE.OBSERVING: {
      const elapsed = mediaTime - observingStartedAt;
      text = elapsed > OBSERVING_ERROR_TIMEOUT
        ? t('ui.error.observingStuck')
        : t('ui.observing');
      break;
    }
    case STATE.ARMED:
      text = t('ui.readyToGo');
      break;
    case STATE.RUNNING:
      if (lastRunElapsed != null) {
        text = t('ui.previousRun', { seconds: lastRunElapsed.toFixed(2) });
      } else {
        visible = false;
      }
      break;
    case STATE.COOLDOWN:
      // The cooldown pill (below the timer) is the authoritative countdown
      // indicator — hide the text sub-line to avoid a redundant read.
      visible = false;
      break;
    case STATE.FINISHED:
    default:
      visible = false;
  }
  if (visible !== sublineLastVisible) {
    sublineLastVisible = visible;
    el.hidden = !visible;
  }
  if (visible && text !== sublineLastText) {
    sublineLastText = text;
    el.textContent = text;
  }
  if (!visible) sublineLastText = '';
}

// Render the last N runs from storage. Fills the HUD space below the timer
// with a compact "recent results" list so the rider can compare the current
// run to their recent history without opening a separate screen.
const RUN_HISTORY_MAX = 5;
function renderRunHistory() {
  const runs = storage.load();
  if (runs.length === 0) {
    els.runHistory.hidden = true;
    els.runHistory.textContent = '';
    return;
  }
  // Most recent first.
  const recent = runs.slice(-RUN_HISTORY_MAX).reverse();
  const latestIndex = runs.length; // 1-based ordinal of the newest run
  const rows = recent.map((run, i) => {
    const ordinal = latestIndex - i;
    const seconds = Number.isFinite(run.elapsed) ? run.elapsed.toFixed(2) : '—';
    return (
      `<div class="run-history-row">` +
        `<span class="run-history-idx">#${ordinal}</span>` +
        `<span class="run-history-time">${seconds}s</span>` +
      `</div>`
    );
  }).join('');
  els.runHistory.innerHTML = rows;
  els.runHistory.hidden = false;
}

// Hands-free loop state transitions. Each helper is the one place that knows
// how to enter its phase — centralised so we can add side effects (voice
// cues, detector resets, background signal) without hunting through onFrame.

function enterObserving(mediaTime) {
  detector.captureReference();    // next process() calls will rebuild the averaged reference
  detector.resetStillness();      // fresh previous-frame snapshot for stillness probing
  // 0 is our sentinel for "no frame yet" — the OBSERVING branch of stepSession
  // re-anchors the timer on the first real frame. Using mediaTime directly is
  // fine for mid-session transitions (e.g. after COOLDOWN) where lastFrameMediaTime
  // is already the current frame's clock.
  observingStartedAt = mediaTime || 0;
  // Schedule the first "not ready" voice cue. Intentionally lags entering
  // OBSERVING by the full interval — a normal observing pass resolves in
  // 2–3 s so a clean cycle stays silent; only genuinely stuck observations
  // (rider in frame, shadow, etc.) earn the audio nudge.
  nextNotReadyVoiceAt = (mediaTime || 0) + NOT_READY_VOICE_INTERVAL;
  stableSince = 0;
  setState(STATE.OBSERVING);
}

function enterArmed() {
  detector.resetStillness();
  setState(STATE.ARMED);
  timer.speak(t('voice.readyToGo'));
}

function enterRunning(mediaTime) {
  t0 = mediaTime;
  startedAt = Date.now();
  detector.resetStillness();
  timer.start(t0);
  timer.speak(t('voice.start'));
  setState(STATE.RUNNING);
}

function enterFinished(elapsed, mediaTime) {
  timer.stop(elapsed);
  lastRunElapsed = elapsed;
  timer.speak(t('voice.finish', { seconds: elapsed.toFixed(2) }));
  storage.save({ elapsed, startedAt, finishedAt: Date.now() });
  // Refresh the on-screen run history with the newly-saved run so the rider
  // sees it in the "recent" list by the time the cooldown begins.
  renderRunHistory();
  finishedFlashUntil = mediaTime + FINISHED_FLASH;
  setState(STATE.FINISHED);
}

function enterCooldown(mediaTime) {
  cooldownStartedAt = mediaTime;
  setState(STATE.COOLDOWN);
}

function startSession() {
  if (sessionActive) return;
  if (!currentRoi) return;        // defensive — button should already be disabled
  sessionActive = true;
  // Seed the big number with the previous run's time (if any) so the rider
  // sees something meaningful on transition rather than a stale "0.000".
  const runs = storage.load();
  if (runs.length > 0) {
    lastRunElapsed = runs[runs.length - 1].elapsed;
    timer.set(lastRunElapsed);
  } else {
    lastRunElapsed = null;
    timer.set(0);
  }
  enterObserving(lastFrameMediaTime);
  refreshSessionButton();
}

function stopSession() {
  if (!sessionActive) return;
  sessionActive = false;
  timer.reset();                  // cancels any live tick
  stableSince = 0;
  setState(STATE.IDLE);           // also clears the phase via updatePhase()
  refreshSessionButton();
  // If a stop came in during RUNNING, the last partially-observed elapsed is
  // stale — drop it so the sub-line doesn't show a half-finished number next
  // session. (lastRunElapsed is re-seeded from storage on the next
  // startSession() anyway; this is just the in-memory copy.)
  if (tapRevealTimer) {
    clearTimeout(tapRevealTimer);
    tapRevealTimer = 0;
  }
  els.controls.classList.remove('tap-revealed');
}

function drawRoiView(video, mediaTime) {
  if (!currentRoi) return;
  if (mediaTime - roiPreviewLastDrawAt < 1 / ROI_PREVIEW_FPS) return;
  roiPreviewLastDrawAt = mediaTime;

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
  const mt = metadata.mediaTime;
  lastFrameMediaTime = mt;
  updateFpsReadout(mt);
  // Render the ROI crop (no-op if the user hasn't set a ROI yet).
  drawRoiView(frame, mt);
  // The small detector-cooldown pill (debug only) ticks every frame.
  updateCooldownIndicator(mt);

  if (sessionActive) {
    stepSession(frame, metadata);
  }

  // Keep phase + sub-line in sync every frame — cheap, and the ERROR flip
  // is purely time-based (OBSERVING > 20s) so we need to re-evaluate each frame.
  updatePhase();
  updateSubline(mt);

  if (!els.debug.hidden && mt - debugLastRenderAt >= DEBUG_RENDER_INTERVAL) {
    debugLastRenderAt = mt;
    els.debug.textContent = detector.debugLine();
  }
}

function refreshReferenceIfSafe(frame, metadata, mode) {
  const isRunning = mode === 'running';
  const clearRatioThreshold = Math.min(
    REFERENCE_REFRESH_CLEAR_RATIO,
    detector.threshold * 0.2,
  );
  detector.refreshReferenceSafely(frame, metadata, {
    clearRatioThreshold,
    stillnessThreshold: REFERENCE_REFRESH_STILLNESS,
    stableDuration: REFERENCE_REFRESH_DURATION,
    minFrames: REFERENCE_REFRESH_MIN_FRAMES,
    minInterval: isRunning
      ? RUNNING_REFERENCE_REFRESH_INTERVAL
      : ARMED_REFERENCE_REFRESH_INTERVAL,
    mode: isRunning ? 'blend' : 'replace',
    blendAlpha: isRunning ? RUNNING_REFERENCE_REFRESH_BLEND : 1,
  });
}

// One frame's worth of hands-free-loop work. Split out of onFrame() so the
// camera/FPS/HUD plumbing stays readable and so this function can focus on
// the actual state transitions.
function stepSession(frame, metadata) {
  const mt = metadata.mediaTime;

  switch (state) {
    case STATE.OBSERVING: {
      // If Start session fired before any frame arrived, observingStartedAt
      // was seeded with the stale lastFrameMediaTime (possibly 0 or a large
      // value captured during setup). Re-anchor on the first real frame so
      // the 20-second error-timeout measures actual observing wall time.
      if (!observingStartedAt) {
        observingStartedAt = mt;
        nextNotReadyVoiceAt = mt + NOT_READY_VOICE_INTERVAL;
      }
      // Periodic voice reminder: while we're stuck in OBSERVING (either the
      // normal wait or the post-20s error visual), say "not ready" every
      // NOT_READY_VOICE_INTERVAL seconds so the rider stays in the loop
      // without looking at the phone.
      if (mt >= nextNotReadyVoiceAt) {
        timer.speak(t('voice.notReady'));
        nextNotReadyVoiceAt = mt + NOT_READY_VOICE_INTERVAL;
      }
      const still = detector.observeStillness(frame, STABILITY_THRESHOLD);
      if (still < STABILITY_THRESHOLD) {
        if (!stableSince) stableSince = mt;
        // Stable for long enough → start capturing reference. process()
        // spends the first REFERENCE_FRAMES calls averaging; we hand off
        // to ARMED once the reference is actually built.
        if (mt - stableSince >= STABILITY_DURATION) {
          detector.process(frame, metadata);
          if (detector.hasReference()) {
            enterArmed();
          }
        }
      } else {
        // Motion breaks the stability streak.
        // If we had already started calling process() to build the reference
        // (stableSince was past STABILITY_DURATION), discard the partial
        // accumulation. Without this, the next stable window would continue
        // from a half-built average that mixes pre- and post-motion frames,
        // potentially producing a noisy or incorrect reference.
        if (stableSince && (mt - stableSince) >= STABILITY_DURATION && !detector.hasReference()) {
          detector.captureReference();
        }
        stableSince = 0;
      }
      break;
    }

    case STATE.ARMED: {
      if (detector.process(frame, metadata)) {
        enterRunning(mt);
      } else {
        refreshReferenceIfSafe(frame, metadata, 'armed');
      }
      break;
    }

    case STATE.RUNNING: {
      if (detector.process(frame, metadata)) {
        enterFinished(mt - t0, mt);
      } else if (mt - t0 >= RUNNING_REFERENCE_REFRESH_GUARD) {
        refreshReferenceIfSafe(frame, metadata, 'running');
      }
      break;
    }

    case STATE.FINISHED: {
      if (mt >= finishedFlashUntil) {
        enterCooldown(mt);
      }
      break;
    }

    case STATE.COOLDOWN: {
      if (mt - cooldownStartedAt >= BETWEEN_RUNS_COOLDOWN) {
        enterObserving(mt);
      }
      break;
    }

    default:
      // IDLE inside a session should be unreachable; guard just in case
      // (e.g. if stopSession() fires mid-frame we'll land here for one tick).
      break;
  }
}

els.btnStartCamera.addEventListener('click', async () => {
  await camera.start();
  await requestWakeLock();
  camera.onFrame(onFrame);
  els.btnStartCamera.disabled = true;
  els.btnSetRoi.disabled = false;
  showGestureHint();
  // Camera is live → drop straight into aim mode. From here the rider has
  // exactly one action: frame the gate inside the green reticle and tap
  // Confirm ROI. The rest of the HUD/controls is hidden (CSS keys off
  // body[data-aiming]) so nothing competes with the viewfinder.
  enterAimMode();
});

// Aim mode: body[data-aiming="true"] drives the CSS that hides HUD +
// chrome and reveals the reticle. Entered when the camera first starts
// and whenever the rider re-frames (tap thumbnail → stopSession →
// deactivateRoiView → enterAimMode). Left when Confirm ROI commits.
function enterAimMode() {
  document.body.dataset.aiming = 'true';
}
function exitAimMode() {
  document.body.dataset.aiming = 'false';
}

els.btnSetRoi.addEventListener('click', commitRoiFromReticle);

// "Reticle-as-ROI": the green square in the middle of the screen is the
// WYSIWYG target. The rider moves the video UNDER the reticle with
// pinch/pan; whatever ends up inside the reticle at Confirm time becomes
// the detector's ROI. This replaces the earlier "whole visible viewport =
// ROI" flow (decision 008 evolution → decision 010) for two reasons:
//   1. Large zoom-as-ROI rectangles held the subject in the ROI past the
//      cooldown (see decision 009). A fixed reticle is smaller by default
//      and forces deliberate targeting — fewer false 3 s finishes.
//   2. Visually explicit: the rider sees EXACTLY what will be timed. No
//      "is my whole screen the ROI?" guessing.
//
// Math. The reticle is a sibling of #viewport, fixed in screen space
// (never transformed). The viewport applies `translate(tx,ty) scale(z)`
// with origin 0,0 to its content. Screen point (sx, sy) corresponds to
// content-intrinsic point ((sx-tx)/z, (sy-ty)/z). Reading the reticle's
// screen rect via getBoundingClientRect and inverting the transform gives
// the intrinsic CSS rect directly; mapCssRoiToVideoRoi then handles the
// object-fit:cover conversion into video-pixel ROI as before.
function commitRoiFromReticle() {
  // Capture viewport transform BEFORE activateRoiView() — that call
  // internally does viewport.reset() which zeroes tx/ty/z. If we read
  // after, we'd always compute "full-frame ROI at z=1" regardless of how
  // the rider aimed.
  const W = viewport.intrinsicWidth();
  const H = viewport.intrinsicHeight();
  const z = viewport.z;
  const tx = viewport.tx;
  const ty = viewport.ty;
  const r = els.reticle.getBoundingClientRect();
  // #stage is position:fixed inset:0 and #viewport is inset:0 inside it,
  // so the viewport's pre-transform origin lives at screen (0, 0). No
  // need to subtract a stage offset here.
  const cssRoi = {
    x: (r.left - tx) / z,
    y: (r.top - ty) / z,
    w: r.width / z,
    h: r.height / z,
  };

  const videoRoi = mapCssRoiToVideoRoi(cssRoi, els.video, W, H);

  // Re-committing mid-session implies re-configuring the camera — stop
  // the current session so its averaged reference frame and observing
  // streak don't get inherited into the new ROI.
  if (sessionActive) stopSession();
  deactivateRoiView();
  exitAimMode();
  detector.setRoi(videoRoi);
  activateRoiView(videoRoi);
  detector.setThreshold(parseFloat(els.threshold.value));
  startSession();
  refreshSessionButton();
}

// Tap the ROI thumbnail during a hands-free session to re-frame the ROI.
// stopSession() + deactivateRoiView() + enterAimMode() bring the rider
// back to the live camera with the reticle showing, so they can re-aim
// and press Confirm again. The pinch-zoom transform has been reset to
// 1× by the previous activateRoiView() call, so aiming starts fresh.
els.roiView.addEventListener('pointerdown', (ev) => {
  if (!currentRoi) return;
  // Stop propagation so the body listener doesn't also run revealControls()
  // — the session is about to stop anyway, and the dueling state changes
  // would flicker the controls panel in and out.
  ev.stopPropagation();
  if (sessionActive) stopSession();
  deactivateRoiView();
  enterAimMode();
  refreshSessionButton();
});

// Session lifecycle button. Label swaps between "Start session" and
// "Stop session" via refreshSessionButton(); the click handler just toggles.
els.btnSession.addEventListener('click', () => {
  if (sessionActive) {
    stopSession();
  } else {
    // Ensure the detector uses whatever threshold the user currently has on
    // the slider — that's the only per-session knob in the fast path.
    detector.setThreshold(parseFloat(els.threshold.value));
    startSession();
  }
});

// During hands-free, the controls panel is hidden so the timer owns the
// screen. Any tap on the viewport (not on the controls themselves) reveals
// the panel for TAP_REVEAL_MS — long enough to read and press Stop session,
// short enough that an accidental tap mid-run doesn't leave Stop exposed
// for the rest of the session.
document.body.addEventListener('pointerdown', (ev) => {
  if (!sessionActive) return;
  // Taps on the controls panel keep it visible (don't restart the timer on
  // a click inside the panel — that'd stop the hide from kicking in if the
  // user takes a moment to scroll the threshold slider).
  if (els.controls.contains(ev.target)) return;
  revealControls();
}, { passive: true });

function revealControls() {
  els.controls.classList.add('tap-revealed');
  if (tapRevealTimer) clearTimeout(tapRevealTimer);
  tapRevealTimer = setTimeout(() => {
    els.controls.classList.remove('tap-revealed');
    tapRevealTimer = 0;
  }, TAP_REVEAL_MS);
}

// Surface a brief "pinch to zoom · two-finger drag to pan" hint after the
// camera comes on, so the rider discovers the gesture without cluttering
// the HUD permanently. Shown at most once per page load; fades out on
// its own after ~3.5 seconds.
let gestureHintShown = false;
function showGestureHint() {
  if (gestureHintShown) return;
  gestureHintShown = true;
  els.gestureHint.hidden = false;
  // Trigger the CSS fade-in on the next frame so the initial render
  // starts with opacity 0 and animates up.
  requestAnimationFrame(() => els.gestureHint.classList.add('visible'));
  setTimeout(() => {
    els.gestureHint.classList.remove('visible');
    // Hide it completely after the fade so it can't eat pointer events.
    setTimeout(() => {
      els.gestureHint.hidden = true;
    }, 400);
  }, 3500);
}

els.threshold.addEventListener('input', () => {
  detector.setThreshold(parseFloat(els.threshold.value));
});

els.debugToggle.addEventListener('change', () => {
  els.debug.hidden = !els.debugToggle.checked;
  document.body.dataset.debug = String(els.debugToggle.checked);
});

els.langSelect.addEventListener('change', () => {
  setLocale(els.langSelect.value);
});

onLocaleChange(applyTranslations);

// Initial UI paint.
populateLangSelect();
applyTranslations();
setState(STATE.IDLE);
// Seed the big number with the last run's time from storage — TZ.md §"Идея"
// places "previous run time visible even before a fresh session" on the main
// screen. On a first-ever install with an empty history we fall back to 0.000.
(function seedTimerFromHistory() {
  const runs = storage.load();
  if (runs.length > 0) {
    lastRunElapsed = runs[runs.length - 1].elapsed;
    timer.set(lastRunElapsed);
  }
})();
updatePhase();
renderRunHistory();

// Sync the body[data-debug] flag with the debug toggle so CSS rules that
// surface developer-only HUD elements (status pill, debug line) can key
// off the body rather than each element separately.
document.body.dataset.debug = String(els.debugToggle.checked);

// ---------------------------------------------------------------------------
// Service worker registration + in-app update flow.
//
// Goals:
//   1. Install the SW so the app works offline and is installable as PWA.
//   2. Detect new SW versions while the app is running and apply them without
//      forcing the user to "clear site data" or reinstall the PWA.
//   3. Never reload mid-run: outside an active session (IDLE, or anything
//      FINISHED-adjacent) we auto-apply the update silently; while the
//      hands-free loop is live (OBSERVING / ARMED / RUNNING / FINISHED /
//      COOLDOWN) we show a small "Update" button and let the rider press
//      it when safe.
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
// "Safe" = not inside an active hands-free session. During a session we let
// the rider finish and press Update themselves — no surprise reloads mid-run.
function onUpdateReady(worker) {
  const safe = !sessionActive;
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
