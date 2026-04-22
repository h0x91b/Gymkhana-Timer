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
  'ui.gestureHint': 'Pinch to frame the gate · Two-finger drag to pan · Tap Set ROI when ready',
  'ui.threshold': 'Threshold',
  'ui.debug': 'Debug',
  'ui.language': 'Language',
  'ui.update': 'Update',
  // {fps} is the measured frame rate, {ms} the half-frame timing uncertainty.
  'ui.fpsReadout': '{fps} FPS · ±{ms} ms',
  // Secondary timer sub-line messages — all shown small under the big time.
  'ui.readyToGo': 'Ready to go',
  'ui.observing': 'Waiting for clear frame…',
  'ui.error.observingStuck': 'ROI not stable. Check the camera.',
  'ui.previousRun': 'Previous: {seconds}s',

  'voice.start': 'Start',
  'voice.finish': 'Finish. {seconds} seconds',
  'voice.readyToGo': 'Ready to go',
  // Spoken every NOT_READY_VOICE_INTERVAL seconds while the session is active
  // but not yet ARMED. Keeps the rider in sync with the phone's state without
  // asking them to glance at it.
  'voice.notReady': 'Not ready',

  'history.runCount_one': '{count} run',
  'history.runCount_other': '{count} runs',
};
