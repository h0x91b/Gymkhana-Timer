export default {
  'app.title': 'Таймер джимханы',

  'status.idle': 'ПРОСТОЙ',
  'status.observing': 'НАБЛЮДЕНИЕ',
  'status.armed': 'ГОТОВ',
  'status.running': 'ИДЁТ ЗАЕЗД',
  'status.finished': 'ФИНИШ',
  'status.cooldown': 'ПЕРЕРЫВ',
  'status.error': 'ПРОВЕРЬ КАМЕРУ',

  'ui.startCamera': 'Включить камеру',
  'ui.setRoi': 'Задать ROI',
  'ui.startSession': 'Начать сессию',
  'ui.stopSession': 'Остановить',
  'ui.cancel': 'Отмена',
  'ui.gestureHint': 'Щипок — зум на створ · Два пальца — двигать · Нажми «Задать ROI»',
  'ui.threshold': 'Порог',
  'ui.debug': 'Отладка',
  'ui.language': 'Язык',
  'ui.update': 'Обновить',
  'ui.fpsReadout': '{fps} FPS · ±{ms} мс',
  'ui.readyToGo': 'Готов к старту',
  'ui.observing': 'Жду чистого кадра…',
  'ui.error.observingStuck': 'ROI не стабилизируется. Проверь камеру.',
  'ui.previousRun': 'Прошлый: {seconds}с',

  'voice.start': 'Старт',
  // Fractional seconds always take "секунды" in Russian speech, so no plural split here.
  'voice.finish': 'Финиш. {seconds} секунды',
  'voice.readyToGo': 'Готов',
  'voice.notReady': 'Не готов',

  'history.runCount_one': '{count} заезд',
  'history.runCount_few': '{count} заезда',
  'history.runCount_many': '{count} заездов',
  'history.runCount_other': '{count} заезда',
};
