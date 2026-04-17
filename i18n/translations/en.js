// English is the source of truth. Keys added here must also exist in ru.js and es.js.
export default {
  'app.title': 'Gymkhana Timer',

  'status.idle': 'IDLE',
  'status.waitingStart': 'WAITING START',
  'status.running': 'RUNNING',
  'status.finished': 'FINISHED',

  'ui.startCamera': 'Start camera',
  'ui.setRoi': 'Set ROI',
  'ui.arm': 'Arm',
  'ui.reset': 'Reset',
  'ui.threshold': 'Threshold',
  'ui.debug': 'Debug',
  'ui.language': 'Language',
  // {fps} is the measured frame rate (integer), {ms} is half the frame interval,
  // i.e. the per-event timing uncertainty of motion detection.
  'ui.fpsReadout': '{fps} FPS · ±{ms} ms',

  'voice.start': 'Start',
  'voice.finish': 'Finish. {seconds} seconds',

  // Plural example for future use (run history UI).
  'history.runCount_one': '{count} run',
  'history.runCount_other': '{count} runs',
};
