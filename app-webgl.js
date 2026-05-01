// app-webgl.js — entry for the rebuilt WebGL gymkhana timer.
//
// Hands-free lifecycle (TZ-webgl-rewrite.md §State machine):
//
//   IDLE ──(camera + ROI)──▶ OBSERVING ──(2 s elapsed)──▶ capture ref ──▶ ARMED
//   ARMED ──(motion ≥ thr)──▶ RUNNING ──(motion ≥ thr after 3 s cd)──▶ FINISHED
//   FINISHED ──(1 s flash)──▶ COOLDOWN(2.5 s) ──▶ OBSERVING (next run)
//
// The rider only ever interacts with the app twice per session: tap
// "Start camera" to grant permission, frame the gate inside the green
// reticle and tap "Confirm ROI". Everything after that is automated;
// the controls hide and the rider drives. Stop is via tap-to-reveal.
//
// Voice is the primary feedback channel because the phone sits ~10 m
// away on a tripod: "ready to go" / "start" / "finish, NN.NN seconds"
// / "not ready" (every 15 s while observing).
//
// The detector lives in webgl-detector.js as a self-contained class.
// We never reach into its internals — only call setRoi/setThreshold/
// captureReference/process/hasReference/cooldownRemaining/lastMotionRatio.

import { Viewport } from './viewport.js';
import { Timer } from './timer.js';
import { WebglDetector } from './webgl-detector.js';
import { BUILD_INFO } from './build-info.js';

/* ------------------------------------------------------------------ *
 * URL parameters and tunables                                        *
 * ------------------------------------------------------------------ */
const URL_PARAMS = new URL(location.href).searchParams;
// Debug overlay is ON by default — the rider needs to see ratio, FPS,
// and threshold while tuning. Use ?debug=0 to hide it.
const DEBUG = URL_PARAMS.get('debug') !== '0';
const INITIAL_THRESHOLD = clampNumber(parseFloat(URL_PARAMS.get('thr')), 0.20, 0.05, 0.80);
const HISTORY_KEY = 'gymkhana-webgl-history';
const HISTORY_MAX = 10;

const STATE = Object.freeze({
  IDLE: 'IDLE',
  OBSERVING: 'OBSERVING',
  ARMED: 'ARMED',
  RUNNING: 'RUNNING',
  FINISHED: 'FINISHED',
  COOLDOWN: 'COOLDOWN',
});

// Hands-free timing parameters. Match TZ-webgl-rewrite.md and the canvas
// app's tuning so muscle memory carries over between the two variants.
const STABILITY_DURATION = 2.0;          // seconds in OBSERVING before we capture reference
const OBSERVING_ERROR_TIMEOUT = 20.0;    // past this OBSERVING flips to red signal
const BETWEEN_RUNS_COOLDOWN = 2.5;       // seconds of countdown after FINISHED
const FINISHED_FLASH = 1.0;              // ivory flash duration
const TAP_REVEAL_MS = 5000;              // controls stay visible this long after a session-mode tap
const NOT_READY_VOICE_INTERVAL = 15.0;   // periodic "not ready" cue while OBSERVING
const DEBUG_RENDER_INTERVAL = 0.25;      // seconds between debug-text refreshes
const FPS_WINDOW = 60;                   // rolling Δt samples for the debug FPS readout

const SIGNAL = {
  setup:     'transparent',
  observing: '#ff8c00',  // orange — waiting
  error:     '#ff2020',  // red — stuck observing
  armed:     '#00d851',  // green — ready
  running:   '#f5f4ed',  // parchment — neutral
  finished:  '#faf9f5',  // ivory — flash
  cooldown:  '#ff8c00',  // orange — between runs
};

const CAMERA_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: 'environment',
    frameRate: { ideal: 60 },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

/* ------------------------------------------------------------------ *
 * Global error surfacing — same idea as webgl-bench. A single                *
 * screenshot of the on-page label + alert is enough to diagnose      *
 * device-specific failures (Xiaomi MIUI WebView, Samsung Browser).   *
 * Recovery / Hard-refresh logic was intentionally dropped from the   *
 * bench when porting here — we don't try to revive a dead camera;    *
 * the user restarts the page (or Chrome) themselves.                 *
 * ------------------------------------------------------------------ */
const errEl = document.getElementById('err');
function reportError(scope, err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  const text = `[${scope}] ${msg}`;
  if (errEl) errEl.textContent = text;
  Promise.resolve().then(() => {
    try { alert(text); } catch (_) { /* alert can be blocked in fullscreen PWAs */ }
  });
  console.error(text);
}
window.addEventListener('error', (ev) => {
  reportError('window.error', ev.error || ev.message);
});
window.addEventListener('unhandledrejection', (ev) => {
  reportError('unhandledrejection', ev.reason);
});

/* ------------------------------------------------------------------ *
 * Log panel — same as bench. Toggled by the Log button. Every        *
 * lifecycle milestone goes through logLine() so a phone screenshot   *
 * tells us what happened.                                            *
 * ------------------------------------------------------------------ */
const logEl = document.getElementById('log');
const btnToggleLog = document.getElementById('btn-toggle-log');
btnToggleLog.addEventListener('click', () => {
  logEl.hidden = !logEl.hidden;
});
function logLine(...parts) {
  const t = new Date().toISOString().slice(11, 23);
  const line = `${t}  ${parts.join(' ')}`;
  if (logEl) {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  console.log(line);
}

/* ------------------------------------------------------------------ *
 * DOM refs                                                           *
 * ------------------------------------------------------------------ */
const els = {
  video:        document.getElementById('cam'),
  display:      document.getElementById('display'),
  viewport:     document.getElementById('viewport'),
  reticle:      document.getElementById('reticle'),
  bgSignal:     document.getElementById('bg-signal'),
  hud:          document.getElementById('hud'),
  timer:        document.getElementById('timer'),
  subline:      document.getElementById('subline'),
  cooldown:     document.getElementById('cooldown'),
  cooldownText: document.getElementById('cooldown-text'),
  cooldownFill: document.getElementById('cooldown-fill'),
  topbar:       document.getElementById('topbar'),
  btnStart:     document.getElementById('btn-start-camera'),
  btnSetRoi:    document.getElementById('btn-set-roi'),
  threshold:    document.getElementById('threshold'),
  thrVal:       document.getElementById('thr-val'),
  history:      document.getElementById('history'),
  debug:        document.getElementById('debug'),
  buildStamp:   document.getElementById('build-stamp'),
};

if (DEBUG) document.body.dataset.debug = 'true';

/* ------------------------------------------------------------------ *
 * Modules                                                            *
 * ------------------------------------------------------------------ */
const viewport = new Viewport(els.viewport);
viewport.attach();
const timer = new Timer(els.timer);
const detector = new WebglDetector(els.display);
detector.init();

// Threshold slider — bound to detector. URL param ?thr= seeds the
// initial value; the slider is the live source of truth from there on.
let currentThreshold = INITIAL_THRESHOLD;
els.threshold.value = String(currentThreshold);
els.thrVal.textContent = currentThreshold.toFixed(2);
detector.setThreshold(currentThreshold);
els.threshold.addEventListener('input', () => {
  const v = clampNumber(parseFloat(els.threshold.value), currentThreshold, 0.05, 0.95);
  currentThreshold = v;
  els.thrVal.textContent = v.toFixed(2);
  detector.setThreshold(v);
});

/* ------------------------------------------------------------------ *
 * Session state                                                      *
 * ------------------------------------------------------------------ */
let state = STATE.IDLE;
let sessionActive = false;
let currentRoi = null;
let cameraStarted = false;
let lastFrameMediaTime = 0;
let lastRunElapsed = null;
let runStartMediaTime = 0;

let observingStartedAt = 0;
let stableSince = 0;            // unused in this rebuild — kept for future stillness re-introduction
let cooldownStartedAt = 0;
let finishedFlashUntil = 0;
let nextNotReadyVoiceAt = 0;

let tapRevealTimer = 0;
let lastPhase = '';
let lastSublineText = '';
let cooldownLastText = '';
let cooldownLastPct = null;
let debugLastRenderAt = -Infinity;

// Δt rolling buffer for the debug FPS readout
const dtSamples = new Float32Array(FPS_WINDOW);
let dtIdx = 0;
let dtCount = 0;
let prevMediaTime = 0;

/* ------------------------------------------------------------------ *
 * State machine helpers                                              *
 * ------------------------------------------------------------------ */
function setState(next) {
  if (state === next) return;
  logLine(`state ${state} → ${next}`);
  state = next;
}

function enterObserving(mt) {
  detector.captureReference();   // arm: next process() will copy crop → ref
  observingStartedAt = mt || 0;
  nextNotReadyVoiceAt = (mt || 0) + NOT_READY_VOICE_INTERVAL;
  stableSince = 0;
  setState(STATE.OBSERVING);
}

function enterArmed() {
  setState(STATE.ARMED);
  timer.speak('ready to go');
}

function enterRunning(mt) {
  runStartMediaTime = mt;
  timer.start(mt);
  timer.speak('start');
  setState(STATE.RUNNING);
}

function enterFinished(elapsed, mt) {
  timer.stop(elapsed);
  lastRunElapsed = elapsed;
  // SpeechSynthesis swallows the comma if we don't pause briefly; the
  // phrasing matches canvas-app for muscle memory.
  timer.speak(`finish, ${elapsed.toFixed(2)} seconds`);
  finishedFlashUntil = mt + FINISHED_FLASH;
  pushHistory(elapsed);
  renderHistory();
  setState(STATE.FINISHED);
}

function enterCooldown(mt) {
  cooldownStartedAt = mt;
  setState(STATE.COOLDOWN);
}

function startSession() {
  if (sessionActive) return;
  if (!currentRoi) return;
  sessionActive = true;
  document.body.dataset.session = 'true';
  // Seed the big numerals with the most recent run (from history if it
  // survived a reload) so the rider sees something meaningful between
  // sessions instead of "0.000".
  const hist = loadHistory();
  if (hist.length > 0) {
    lastRunElapsed = hist[hist.length - 1].elapsed;
    timer.set(lastRunElapsed);
  } else {
    lastRunElapsed = null;
    timer.set(0);
  }
  renderHistory();
  enterObserving(lastFrameMediaTime);
}

function stopSession() {
  if (!sessionActive) return;
  sessionActive = false;
  document.body.dataset.session = 'false';
  timer.reset();
  stableSince = 0;
  setState(STATE.IDLE);
  if (tapRevealTimer) {
    clearTimeout(tapRevealTimer);
    tapRevealTimer = 0;
  }
  els.topbar.classList.remove('revealed');
}

/* ------------------------------------------------------------------ *
 * Per-frame work                                                     *
 * ------------------------------------------------------------------ */
function stepSession(video, metadata) {
  const mt = metadata.mediaTime;
  switch (state) {
    case STATE.OBSERVING: {
      // The rebuilt OBSERVING is intentionally dumb — no stillness
      // measurement, no adaptive blend. Wait STABILITY_DURATION seconds
      // from entering this state, then captureReference() (already armed
      // in enterObserving), call detector.process() to actually copy the
      // crop into the reference texture, and roll into ARMED. If the
      // rider was still in the ROI at capture, the next ARMED will
      // trigger immediately → FINISHED → COOLDOWN → fresh OBSERVING with
      // a clean reference. That's strictly simpler than measuring
      // stillness and proved sufficient on the bench.
      if (!observingStartedAt) {
        observingStartedAt = mt;
        nextNotReadyVoiceAt = mt + NOT_READY_VOICE_INTERVAL;
      }
      if (mt >= nextNotReadyVoiceAt) {
        timer.speak('not ready');
        nextNotReadyVoiceAt = mt + NOT_READY_VOICE_INTERVAL;
      }
      if (!detector.hasReference() && mt - observingStartedAt >= STABILITY_DURATION) {
        // process() consumes the captureReference() request and returns
        // false on the same frame (the metrics pass is skipped while the
        // reference is being captured). The next frame transitions us to
        // ARMED via the hasReference() check below.
        detector.process(video, mt);
      }
      if (detector.hasReference()) enterArmed();
      break;
    }

    case STATE.ARMED: {
      if (detector.process(video, mt)) {
        enterRunning(mt);
      }
      break;
    }

    case STATE.RUNNING: {
      if (detector.process(video, mt)) {
        enterFinished(mt - runStartMediaTime, mt);
      }
      break;
    }

    case STATE.FINISHED: {
      if (mt >= finishedFlashUntil) enterCooldown(mt);
      break;
    }

    case STATE.COOLDOWN: {
      if (mt - cooldownStartedAt >= BETWEEN_RUNS_COOLDOWN) enterObserving(mt);
      break;
    }

    default:
      break;
  }
}

function updatePhase() {
  let phase;
  if (!sessionActive) {
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
  if (phase === lastPhase) return;
  lastPhase = phase;
  els.bgSignal.style.background = SIGNAL[phase] || 'transparent';
  // setup keeps the tint hidden so the camera reads cleanly during ROI aim.
  els.bgSignal.style.opacity = phase === 'setup' ? '0' : '0.55';
}

function updateSubline(mt) {
  let text = '';
  let visible = true;
  if (!sessionActive) {
    visible = false;
  } else {
    switch (state) {
      case STATE.OBSERVING: {
        const elapsed = mt - observingStartedAt;
        text = elapsed > OBSERVING_ERROR_TIMEOUT
          ? 'Move out of frame'
          : 'Waiting…';
        break;
      }
      case STATE.ARMED:
        text = 'Ready to go';
        break;
      case STATE.RUNNING:
        if (lastRunElapsed != null) {
          text = `Previous: ${lastRunElapsed.toFixed(2)}s`;
        } else {
          visible = false;
        }
        break;
      case STATE.FINISHED:
        // Subline silent during the ivory flash — the timer is the show.
        visible = false;
        break;
      case STATE.COOLDOWN:
        // The cooldown countdown sits in its own pill; subline is silent.
        visible = false;
        break;
      default:
        visible = false;
    }
  }
  if (!visible) {
    if (lastSublineText !== '') {
      lastSublineText = '';
      els.subline.textContent = '';
    }
    return;
  }
  if (text !== lastSublineText) {
    lastSublineText = text;
    els.subline.textContent = text;
  }
}

function updateCooldownIndicator(mt) {
  if (state !== STATE.COOLDOWN) {
    if (!els.cooldown.hidden) els.cooldown.hidden = true;
    cooldownLastText = '';
    cooldownLastPct = null;
    return;
  }
  const remaining = Math.max(0, BETWEEN_RUNS_COOLDOWN - (mt - cooldownStartedAt));
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

function recordDtSample(mt) {
  if (prevMediaTime > 0) {
    const dt = (mt - prevMediaTime) * 1000;
    dtSamples[dtIdx] = dt;
    dtIdx = (dtIdx + 1) % FPS_WINDOW;
    if (dtCount < FPS_WINDOW) dtCount++;
  }
  prevMediaTime = mt;
}

function dtStats() {
  if (dtCount === 0) return { median: 0, jitter: 0 };
  // tiny-N stats: copy then sort; FPS_WINDOW = 60 so this is cheap.
  const arr = dtSamples.slice(0, dtCount);
  arr.sort();
  const median = arr[(dtCount / 2) | 0];
  // Half-range = (max − min) / 2. The right shape for "Δt accuracy"
  // because the timing error contributed by frame quantization is
  // bounded by half the slowest frame Δt.
  const jitter = (arr[dtCount - 1] - arr[0]) / 2;
  return { median, jitter };
}

function renderDebug() {
  const { median, jitter } = dtStats();
  const fps = median > 0 ? (1000 / median).toFixed(1) : '—';
  // Two-line layout — top line: motion + threshold, bottom line: timing
  // and state. Keeping it short enough to read at a glance from the
  // tripod position.
  els.debug.textContent =
    `motion=${detector.lastMotionRatio().toFixed(3)}  thr=${currentThreshold.toFixed(2)}  ratio/thr=${(detector.lastMotionRatio() / currentThreshold).toFixed(2)}\n` +
    `${fps}fps  Δt=${median.toFixed(1)}±${jitter.toFixed(1)}ms  state=${state}  ref=${detector.hasReference() ? 'yes' : 'no'}`;
}

/* ------------------------------------------------------------------ *
 * ROI selection — copied verbatim from app.js with the              *
 * canvas-specific bits removed (no #roi-view thumbnail in v1).      *
 * ------------------------------------------------------------------ */

// Convert a CSS-pixel ROI on the viewport into video-pixel coords. The
// viewport's child <canvas#display> uses 100%×100% to fill, so the same
// math that worked for object-fit:cover on canvas-app's <video> applies
// here: scale = max(W/Vw, H/Vh), then clamp.
function mapCssRoiToVideoRoi(cssRoi, video, W, H) {
  const Vw = video.videoWidth;
  const Vh = video.videoHeight;
  if (!Vw || !Vh) return cssRoi;

  const s = Math.max(W / Vw, H / Vh);
  const scaledW = Vw * s;
  const scaledH = Vh * s;
  const offsetX = (W - scaledW) / 2;
  const offsetY = (H - scaledH) / 2;

  const rawX = (cssRoi.x - offsetX) / s;
  const rawY = (cssRoi.y - offsetY) / s;
  const rawW = cssRoi.w / s;
  const rawH = cssRoi.h / s;

  const x = Math.max(0, Math.min(Vw, rawX));
  const y = Math.max(0, Math.min(Vh, rawY));
  const w = Math.max(1, Math.min(Vw - x, rawW));
  const h = Math.max(1, Math.min(Vh - y, rawH));
  return { x, y, w, h };
}

function enterAimMode() { document.body.dataset.aim = 'true'; }
function exitAimMode()  { document.body.dataset.aim = 'false'; }

function commitRoiFromReticle() {
  // Read viewport transform BEFORE viewport.reset() — otherwise we'd
  // always compute "full-frame ROI at z=1" regardless of how the rider
  // pinched. The reticle is in screen coords; (sx-tx)/z is the
  // pre-transform CSS point on #viewport, then mapCssRoiToVideoRoi
  // does the object-fit:cover conversion to video pixels.
  const W = viewport.intrinsicWidth();
  const H = viewport.intrinsicHeight();
  const z = viewport.z;
  const tx = viewport.tx;
  const ty = viewport.ty;
  const r = els.reticle.getBoundingClientRect();
  const cssRoi = {
    x: (r.left - tx) / z,
    y: (r.top - ty) / z,
    w: r.width / z,
    h: r.height / z,
  };
  const videoRoi = mapCssRoiToVideoRoi(cssRoi, els.video, W, H);

  if (sessionActive) stopSession();
  exitAimMode();
  viewport.reset();
  currentRoi = videoRoi;
  detector.setRoi(videoRoi);
  detector.setThreshold(currentThreshold);
  startSession();
}

/* ------------------------------------------------------------------ *
 * Camera startup (no recovery — by user request the bench's            *
 * Hard-refresh / track.onended re-acquire / contextlost reload         *
 * branches are intentionally absent here).                             *
 * ------------------------------------------------------------------ */
async function startCamera() {
  els.btnStart.disabled = true;
  els.btnStart.textContent = 'Starting…';
  logLine('UA:', navigator.userAgent);
  logLine('rVFC supported:', 'requestVideoFrameCallback' in HTMLVideoElement.prototype);

  els.video.addEventListener('loadedmetadata', () => {
    logLine('event loadedmetadata:', els.video.videoWidth + '×' + els.video.videoHeight);
  }, { once: true });
  els.video.addEventListener('playing', () => logLine('event playing'), { once: true });
  els.video.addEventListener('error', () => {
    logLine('event video error: code=' + (els.video.error && els.video.error.code));
  });

  try {
    logLine('getUserMedia: requesting');
    const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    const track = stream.getVideoTracks()[0];
    const settings = track ? track.getSettings() : {};
    logLine('getUserMedia: ok ' + JSON.stringify({
      label: track && track.label,
      w: settings.width, h: settings.height,
      fps: settings.frameRate, facing: settings.facingMode,
    }));
    els.video.srcObject = stream;
    logLine('video.play(): calling');
    await els.video.play();
    logLine('video.play(): resolved, videoWidth=' + els.video.videoWidth);
    els.btnStart.disabled = true;
    els.btnStart.textContent = 'Camera on';
    els.btnSetRoi.disabled = false;
    cameraStarted = true;
    enterAimMode();

    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      els.video.requestVideoFrameCallback(onFrame);
    } else {
      // Desktop fallback — browsers without rVFC still need a tick. The
      // tick produces a synthetic mediaTime good enough for elapsed
      // measurement when the developer is just verifying on a webcam.
      const tick = () => {
        onFrame(performance.now(), { mediaTime: performance.now() / 1000 });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  } catch (err) {
    els.btnStart.disabled = false;
    els.btnStart.textContent = 'Start camera';
    reportError('startCamera', err);
  }
}
els.btnStart.addEventListener('click', startCamera);
els.btnSetRoi.addEventListener('click', commitRoiFromReticle);

/* ------------------------------------------------------------------ *
 * Frame loop                                                         *
 * ------------------------------------------------------------------ */
function onFrame(_now, metadata) {
  // rVFC swallows any thrown exception silently — without this wrapper a
  // device-specific failure would freeze the page with no diagnostics.
  try {
    onFrameImpl(metadata);
  } catch (err) {
    reportError('onFrame', err);
  }
}
function onFrameImpl(metadata) {
  if (!els.video.videoWidth) {
    els.video.requestVideoFrameCallback(onFrame);
    return;
  }
  const mt = metadata.mediaTime;
  lastFrameMediaTime = mt;
  recordDtSample(mt);

  // Run the detector pipeline FIRST when a session is active — process()
  // does the texImage2D upload and caches it by mediaTime, so the
  // subsequent drawDisplay() with the same mediaTime skips re-uploading.
  // Outside a session, drawDisplay() handles the upload itself.
  if (sessionActive) stepSession(els.video, metadata);
  detector.drawDisplay(els.video, mt);

  updatePhase();
  updateSubline(mt);
  updateCooldownIndicator(mt);

  if (DEBUG && mt - debugLastRenderAt >= DEBUG_RENDER_INTERVAL) {
    debugLastRenderAt = mt;
    renderDebug();
  }

  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    els.video.requestVideoFrameCallback(onFrame);
  }
}

/* ------------------------------------------------------------------ *
 * Tap-to-reveal controls                                             *
 *                                                                    *
 * During a hands-free session the topbar is hidden so it doesn't     *
 * compete with the timer. A tap anywhere on the page reveals it for  *
 * TAP_REVEAL_MS so the rider can stop the session if needed. Pinch   *
 * gestures (≥2 pointers) on #viewport must NOT reveal the topbar —   *
 * that would flicker controls in/out every time the rider re-frames. *
 * ------------------------------------------------------------------ */
document.body.addEventListener('pointerdown', (ev) => {
  if (!sessionActive) return;
  if (viewport.isGesturing()) return;
  // Don't toggle controls when the rider is dragging the threshold
  // slider — the slider itself is inside #topbar; a pointerdown there
  // means they're already interacting with controls. Re-arming the
  // hide timer on every input event would also cause the slider to
  // disappear mid-drag.
  if (ev.target && ev.target.closest && ev.target.closest('#topbar')) return;
  els.topbar.classList.add('revealed');
  if (tapRevealTimer) clearTimeout(tapRevealTimer);
  tapRevealTimer = setTimeout(() => {
    els.topbar.classList.remove('revealed');
    tapRevealTimer = 0;
  }, TAP_REVEAL_MS);
});

/* ------------------------------------------------------------------ *
 * Run history (last 10 finished runs, persisted to localStorage)     *
 *                                                                    *
 * Stored as `gymkhana-webgl-history` = JSON array of                  *
 * {elapsed, finishedAt} entries, oldest first. Capped at HISTORY_MAX.*
 * Survives reloads so a rider can review their runs after a quick    *
 * page refresh / accidental tab close.                                *
 * ------------------------------------------------------------------ */
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((e) => e && Number.isFinite(e.elapsed)) : [];
  } catch (_) {
    return [];
  }
}

function pushHistory(elapsed) {
  const runs = loadHistory();
  runs.push({ elapsed, finishedAt: Date.now() });
  // Trim from the front so we keep the MOST RECENT HISTORY_MAX entries.
  while (runs.length > HISTORY_MAX) runs.shift();
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(runs));
  } catch (err) {
    // Quota exceeded / private mode — log and continue. The in-memory
    // copy is still good for rendering this session.
    logLine('history.save failed: ' + (err.message || err));
  }
}

function renderHistory() {
  const runs = loadHistory();
  els.history.innerHTML = '';
  if (runs.length === 0) return;
  // Best (smallest) elapsed gets a highlighted row so the rider can
  // tell at a glance whether the most recent run beat their PB.
  let best = Infinity;
  for (const r of runs) if (r.elapsed < best) best = r.elapsed;
  // Render newest at the top — the rider's eye lands there first. Show
  // a "#1" label on the newest, "#2" on the next, etc. so the rider can
  // quickly count back through the session.
  const total = runs.length;
  for (let i = total - 1; i >= 0; i--) {
    const r = runs[i];
    const isBest = r.elapsed === best;
    const recencyRank = total - i; // 1 = newest
    const row = document.createElement('div');
    row.className = 'row' + (isBest ? ' best' : '');
    const rankSpan = document.createElement('span');
    rankSpan.className = 'rank';
    rankSpan.textContent = `#${recencyRank}`;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = `${r.elapsed.toFixed(3)}s`;
    row.appendChild(rankSpan);
    row.appendChild(timeSpan);
    els.history.appendChild(row);
  }
}

// Render any persisted history before the first frame so the rider sees
// previous results immediately on a fresh page load.
renderHistory();

/* ------------------------------------------------------------------ *
 * Build stamp — top-right corner.                                     *
 *                                                                     *
 * BUILD_INFO is rewritten by CI on the GitHub Pages deploy step       *
 * (see decisions/004 + the deploy workflow). Locally everything is    *
 * null / "gymkhana-local" so we fall back to the page-load timestamp  *
 * — a fresh dev iteration produces a fresh stamp on every live-reload,*
 * and the user can correlate a screenshot with the moment they tested.*
 * ------------------------------------------------------------------ */
function pad2(n) { return String(n).padStart(2, '0'); }
function formatBuildStamp() {
  const v = String(BUILD_INFO.version || '').trim();
  const at = BUILD_INFO.builtAt;
  const isLocal = !at || /^gymkhana-local$/i.test(v);
  if (isLocal) {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} `
                + `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    return `local · ${stamp}`;
  }
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return v;
  const built = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} `
              + `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}Z`;
  const numeric = v.match(/(?:^|-)v?(\d+(?:\.\d+)*)$/);
  const short = numeric ? `v${numeric[1]}` : v;
  return `${short} · ${built}`;
}
els.buildStamp.textContent = formatBuildStamp();

/* ------------------------------------------------------------------ *
 * Helpers                                                            *
 * ------------------------------------------------------------------ */
function clampNumber(v, fallback, min, max) {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

logLine('app-webgl boot. threshold=' + INITIAL_THRESHOLD.toFixed(3) + ' debug=' + DEBUG);
