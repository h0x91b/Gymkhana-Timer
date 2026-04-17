// Main entry: wires UI, camera, detector, timer, storage, i18n.
// State machine: IDLE -> WAITING_START -> RUNNING -> FINISHED -> IDLE (on reset)

import { Camera } from './camera.js';
import { Detector } from './detector.js';
import { RoiPicker } from './roi.js';
import { Timer } from './timer.js';
import { Storage } from './storage.js';
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
  timer: document.getElementById('timer'),
  status: document.getElementById('status'),
  debug: document.getElementById('debug'),
  btnStartCamera: document.getElementById('btn-start-camera'),
  btnSetRoi: document.getElementById('btn-set-roi'),
  btnArm: document.getElementById('btn-arm'),
  btnReset: document.getElementById('btn-reset'),
  threshold: document.getElementById('threshold'),
  debugToggle: document.getElementById('debug-toggle'),
  langSelect: document.getElementById('lang-select'),
};

const camera = new Camera(els.video);
const detector = new Detector();
const roiPicker = new RoiPicker(els.overlay);
const timer = new Timer(els.timer);
const storage = new Storage();

let state = STATE.IDLE;
let t0 = 0;
let wakeLock = null;

function applyTranslations() {
  for (const el of document.querySelectorAll('[data-i18n-key]')) {
    el.textContent = t(el.dataset.i18nKey);
  }
  // Status element has a dynamic key — re-resolve from its current data-status.
  els.status.textContent = t(statusKey(els.status.dataset.status));
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

function onFrame(frame, metadata) {
  // metadata.mediaTime is the authoritative frame timestamp (seconds).
  if (state === STATE.IDLE || state === STATE.FINISHED) return;

  const triggered = detector.process(frame, metadata);

  if (els.debug.hidden === false) {
    els.debug.textContent = detector.debugLine();
  }

  if (!triggered) return;

  if (state === STATE.WAITING_START) {
    t0 = metadata.mediaTime;
    timer.start(t0);
    timer.speak(t('voice.start'));
    setState(STATE.RUNNING);
    return;
  }

  if (state === STATE.RUNNING) {
    const elapsed = metadata.mediaTime - t0;
    timer.stop(elapsed);
    timer.speak(t('voice.finish', { seconds: elapsed.toFixed(1) }));
    storage.save({ elapsed, at: Date.now() });
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
  const roi = await roiPicker.pick();
  detector.setRoi(roi);
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

// Register service worker for offline/PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}
