// English is the source of truth. Keys added here must also exist in ru.js and es.js.
export default {
  'app.title': 'Gymkhana Timer',

  // Session-mode phase labels (tiny diagnostic pill; not the primary channel).
  'status.idle': 'IDLE',
  'status.observing': 'OBSERVING',
  'status.armed': 'ARMED',
  'status.running': 'RUNNING',
  'status.finished': 'FINISHED',
  'status.cooldown': 'COOLDOWN',
  'status.error': 'CHECK CAMERA',

  'ui.startCamera': 'Start camera',
  'ui.setRoi': 'Set ROI',
  // The one and only button that hands control over to the hands-free loop.
  'ui.startSession': 'Start session',
  'ui.stopSession': 'Stop session',
  'ui.cancel': 'Cancel',
  'ui.gestureHint': 'Pinch to zoom · Two-finger drag to pan',
  'ui.threshold': 'Threshold',
  'ui.debug': 'Debug',
  'ui.language': 'Language',
  'ui.update': 'Update',
  // {fps} is the measured frame rate, {ms} the half-frame timing uncertainty.
  'ui.fpsReadout': '{fps} FPS · ±{ms} ms',
  // Secondary timer sub-line messages — all shown small under the big time.
  'ui.readyToGo': 'Ready to go',
  // {seconds} is the whole-second countdown (e.g. "14", "13", …) during the
  // 15-second between-runs cooldown.
  'ui.nextInSeconds': 'Next run in {seconds}s',
  'ui.observing': 'Waiting for clear frame…',
  'ui.error.observingStuck': 'ROI not stable. Check the camera.',
  'ui.previousRun': 'Previous: {seconds}s',

  'voice.start': 'Start',
  'voice.finish': 'Finish. {seconds} seconds',
  'voice.readyToGo': 'Ready to go',

  'history.runCount_one': '{count} run',
  'history.runCount_other': '{count} runs',
};
