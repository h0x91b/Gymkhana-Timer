# Техническое задание: переписка приложения на WebGL pipeline (с нуля)

> Сопровождает [`TZ.md`](./TZ.md) — это документ описывает следующую большую переделку, не перерабатывает исходный спек.

## Контекст

В репозитории сейчас живут параллельно три страницы:

- `canvas-app.html` — старое работающее приложение, детектор на 2D-canvas + `getImageData`. Стабильно, но упирается в ~45 FPS на 60 FPS-камере, потому что 80% времени уходит на `getImageData`.
- `webgl-bench.html` — отдельный стенд, где собран чистый GPU-pipeline: `texImage2D` → ROI crop → diff vs reference → `generateMipmap` → `readPixels(1×1)`. На Samsung и Xiaomi стабильно даёт **60 FPS**, движение вне ROI не цепляется.
- `webgl-app.html` + `app-webgl.js` + `webgl-detector.js` — попытка вкрутить тот же GPU-pipeline в существующий канвасный `app.js`. После нескольких итераций работает «в общем», но в покое motion ratio ≈ 0.25 (должно быть ~0), не 60 FPS под нагрузкой, и логика OBSERVING/refresh-reference не дружит с GPU-моделью.

**Итог переходного периода:** мы убедились, что pipeline `webgl-bench.html` правильный. Дальнейшие итерации поверх старого `app.js` — это попытка натянуть GPU на canvas-style state machine. Это даёт ту же сложность, что и canvas, плюс новый класс багов от шейдеров.

## Что переписываем

Переписываем **новое приложение** с нуля поверх pipeline'а из `webgl-bench.html`. Существующее `canvas-app.html` оставляем нетронутым как fallback. Существующий `webgl-bench.html` оставляем нетронутым как perf-полигон.

### Файлы, создаваемые в этой переделке

| Файл | Содержит |
|---|---|
| `webgl-app.html` (полностью переписать) | UI shell нового приложения — таймер, signal-фон, controls |
| `app-webgl.js` (полностью переписать) | State machine, voice, storage, ROI picker, привязка детектора |
| `webgl-detector.js` (полностью переписать или удалить) | GPU-детектор API в стиле bench, без stillness и adaptive refresh |
| `style.css` или новый `webgl-app.css` | Стили (можно переиспользовать существующие токены `style.css`) |

Существующие `app.js`, `detector.js`, `camera.js`, `viewport.js`, `roi.js`, `timer.js`, `storage.js`, `i18n/*` остаются как есть для canvas-app.

`webgl-app.html` начинается **из копии `webgl-bench.html`** (как стартовая точка) — у него уже работает камера, WebGL2 init, метрики, error reporting, hard refresh и log-toggle.

## Цели и не-цели

### Цели

1. **60 FPS на тех же устройствах**, где `canvas-app.html` даёт 45.
2. Сохранить **главный UX-инвариант**: hands-free session loop. Райдер не подходит к телефону между заездами.
3. Сохранить **главный UI-инвариант**: огромный таймер по центру + signal-фон, меняющий цвет в зависимости от фазы.
4. ROI выбирается **через pinch+pan + reticle**, как сейчас в canvas-app (decision 010 — reticle-as-ROI).
5. Все детектор-вычисления — на GPU. CPU читает максимум 4 байта на кадр.

### Не-цели (явно ВЫКИНУТЬ или отложить)

- ❌ **Stillness vs предыдущего кадра.** Не нужен. Логика «ждать пока сцена замрёт» решается фиксированным таймером (см. ниже).
- ❌ **Adaptive mid-run refresh reference.** Reference замораживается на одну итерацию OBSERVING→ARMED→…→OBSERVING; обновляется только при ВХОДЕ в новый OBSERVING.
- ❌ **5-frame averaging для reference.** Один кадр — этого достаточно после `generateMipmap` reduction по 256² фрагментов.
- ❌ **Custom UI компоненты сверх минимума.** Никаких отдельных пилюль для статуса, никаких build-stamp'ов, никаких dropdown'ов настроек, кроме threshold. Всё что мешает таймеру — выкинуть.
- ❌ **Service Worker / PWA / offline.** Не подключаем `sw.js`. Если в продакшен-приложении это понадобится, добавляем потом.
- ❌ **i18n.** Один язык — английский (как в bench). Локализация добавляется позже, после того как ядро работает.
- ❌ **Run history / localStorage.** В первой версии — только текущий и предыдущий результат в памяти. Долговременное хранение добавим позже.
- ❌ **Lang-select / debug toggle / threshold slider в UI.** Threshold — константа в коде на старте. Debug — toggle в URL (`?debug=1`).

## UI требования

### Критические

1. **Таймер занимает ~50vh в центре экрана.** Цифры — `Anthropic Serif` (или Georgia как fallback), font-weight 500, `font-variant-numeric: tabular-nums`. Никакого bold.
2. **Сигнальный задний фон** меняется по состоянию:
   - `OBSERVING` (первые 20с) — оранжевый `#ff8c00`
   - `OBSERVING` (после 20с без захвата ref) — красный `#ff2020`
   - `ARMED` — насыщённо-зелёный `#00d851`
   - `RUNNING` — нейтральный parchment `#f5f4ed`
   - `FINISHED` (1 секунда вспышка) — ivory `#faf9f5`
   - `COOLDOWN` — оранжевый
3. **Цифры таймера читаемы с 10 метров** на ярком солнце. Контраст важнее декора.

### Что показывается под таймером (мелким)

- В `RUNNING` — последнее завершённое время (для самосравнения «лучше/хуже»).
- В `COOLDOWN` — обратный отсчёт `2.5 → 0.0 s` + узкая drain-полоса прогресса.
- В `ARMED` — текст `Ready to go`.
- В `OBSERVING` — текст `Waiting…` (или после 20с `Move out of frame`).

### Содержимое таймера по фазам

- `RUNNING` — текущее живое время (тикает).
- Все остальные фазы — последний завершённый результат (или `0.000` если результата ещё не было).

### Чего на экране быть не должно

- Подписей с FPS, ms, ratio в основном UI. Они только в debug overlay (`?debug=1` в URL).
- Логотипа, build-stamp, языковой плашки.
- Любых украшающих элементов, не несущих смысла для райдера.

### Гипотеза по инструментам в шапке

Из bench оставить:
- `Hard refresh` — кнопка для чистки кэша при странных проблемах.
- `Log` toggle — для отладки.

Stop session — overlay, появляется по тапу в любом месте экрана; кнопка скрыта, чтобы не мешать видимости таймера.

## State machine

```
IDLE
  └── camera permission granted, ROI confirmed
       │
OBSERVING ──────── (timeout 20s) ─────→ visual=ERROR (фон красный, voice "not ready" каждые 15s)
  │ wait STABILITY_DURATION = 2 s
  │ captureReference (single GPU copy)
  ▼
ARMED  (фон зелёный, voice "ready to go")
  │ detector.process() возвращает true → motion vs ref пересёк threshold
  ▼
RUNNING  (фон parchment, таймер тикает)
  │ detector.process() возвращает true (после 3-секундного cooldown) → второе пересечение
  ▼
FINISHED  (фон ivory, voice "finish, N.N seconds", flash 1 s)
  ▼
COOLDOWN  (фон оранжевый, 2.5s обратный отсчёт)
  ▼
OBSERVING  → … (back to top)
```

**Важно:**
- `detector.observeStillness()` нет. Просто `setTimeout`-style ожидание `STABILITY_DURATION` от mediaTime.
- Если в момент captureReference rider всё ещё в ROI — следующий ARMED триггернёт мгновенно (motion vs «грязный ref» большой), и мы упадём в FINISHED → COOLDOWN → OBSERVING. Через ещё одну итерацию reference будет нормальный. Это приемлемое поведение, **проще** чем измерять stillness.
- Stop session — тап показывает overlay; кнопка Stop переводит в IDLE.

## Тайминг (как в TZ.md)

- Источник истины — `metadata.mediaTime` из `requestVideoFrameCallback`. Sub-millisecond precision.
- Финальный elapsed для отображения и сохранения = `t1.mediaTime − t0.mediaTime`.
- `performance.now()` допустимо только для cosmetic smooth tick во время RUNNING.
- Web frame-rate ceiling — 30 FPS quantization (33 ms). Запрашиваем 60 FPS через camera constraints, не полагаемся.

## Детектор: API и pipeline

### API (минимум)

```js
class Detector {
  constructor()
  setRoi({x, y, w, h})            // в video-pixel coords
  setThreshold(value)             // 0..1
  captureReference()              // следующий process() кадр копирует cropped → ref
  hasReference()                  // bool
  process(video, metadata)        // возвращает true если триггер сработал
  cooldownRemaining(mediaTime)    // секунды до конца debounce, 0 если уже вне
  lastMotionRatio()               // [0..1], для debug overlay
  debugLine()                     // одна строка для overlay
}
```

Никаких `observeStillness`, `refreshReferenceSafely`, `resetStillness`, `lastStillnessRatio`, `clearReferenceRefreshStatus`, `pixelDiffThreshold`. Не существует.

### Pipeline (на каждый кадр)

1. **Upload.** `texImage2D(_texCur, video)`. `UNPACK_FLIP_Y_WEBGL=true`. Кэш по `video.currentTime` — повторный вызов на одном кадре пропускается.
2. **ROI crop.** Шейдер `FS_COPY` сэмплирует `_texCur` с UV из ROI, пишет в `_texCurCropped` 256×256 (FBO_SIZE). Vertex attributes — `layout(location=0)` для `aPos`, `layout(location=1)` для `aUv` (без этого ломается).
3. **Metrics pass.** Шейдер `FS_METRICS`:
   ```glsl
   float la = dot(texture(uA, vUv).rgb, LUMA);   // current cropped
   float lb = dot(texture(uB, vUv).rgb, LUMA);   // reference
   float diff = la - lb;
   float compensated = diff - uBrightnessOffset; // компенсация дрейфа экспозиции
   float moved = step(uThreshold, abs(compensated));
   outColor = vec4(moved, diff*0.5+0.5, la, 1.0);
   ```
4. **Reduction.** `gl.generateMipmap(_texMotion)` сворачивает 256² → 1×1.
5. **Readback.** `gl.readPixels(0, 0, 1, 1)` → 4 байта. Декодирование:
   - `motion = R/255` — доля «двинутых» пикселей
   - `drift = (G/255 - 0.5) * 2` — signed mean Δluma
   - `avgLuma = B/255`
6. **На следующем кадре** drift из шага 5 идёт в uniform `uBrightnessOffset` шага 3 — это убирает реакцию на равномерный сдвиг яркости.

### Триггер

Обычная rising-edge + cooldown логика, как в `detector.js:273–333`:

- `ratio < threshold` → ROI чистый → `_clearSinceTrigger = true`, return false.
- `ratio >= threshold` → проверяем gate (`_clearSinceTrigger`) и cooldown (3 секунды).
- Триггер сработал → `_clearSinceTrigger = false`, ставим `_lastTriggerAt = mediaTime`, return true.

### Параметры

- `FBO_SIZE = 256` (power-of-two для mipmap reduction).
- `COOLDOWN_SECONDS = 3` (debounce между триггерами).
- `threshold = 0.20` (стартовое значение; настраивается query param `?thr=0.25` если нужно).

## ROI selection

Виджет полностью копируется из `canvas-app` / decision 010:

- `viewport` — `<div>` поверх `<video>`, на нём pinch+pan через `Viewport` класс.
- `reticle` — фиксированный прямоугольник в центре экрана (~40vw × 30vh), CSS-стилизованный, position:fixed.
- При тапе **Confirm ROI**: текущая клиентская позиция reticle конвертируется в video-pixel rect (через intrinsic size + object-fit:cover преобразование), результат идёт в `detector.setRoi(...)`.
- После Confirm — viewport.reset() и приложение переходит в OBSERVING.

Логика преобразования координат — буквально `mapCssRoiToVideoRoi` из `app.js:377-399` + `commitRoiFromReticle` из `app.js:855-889`. **Не переписывать с нуля**, копировать рабочий код.

## Voice cues

Всё через `speechSynthesis`. Ключевые фразы:

- `start` — первое пересечение
- `finish, N.N seconds` — второе пересечение
- `ready to go` — вход в ARMED
- `not ready` — каждые 15 секунд пока в OBSERVING

Без локализации в первой версии: голос английский. `document.documentElement.lang = 'en'`.

## Что НЕ делаем в первой версии

| Фича | Почему отложена |
|---|---|
| Service worker / offline / PWA install | Сначала ядро. PWA добавим после стабилизации. |
| Run history > 1 запись | Перегружает UI. Один последний результат под таймером — этого хватает. |
| Adaptive reference refresh | Источник 90% багов в текущей webgl-app итерации. Reference замораживается на цикл, обновляется на новый OBSERVING. |
| Stillness vs prev frame | Источник остальных багов. Не нужен — таймер 2 секунды решает. |
| i18n | Один язык в первой версии. |
| 5-frame reference averaging | Mipmap reduce по 65k фрагментов уже усредняет. |
| Threshold slider в UI | Константа в коде / URL parameter. |
| Wake Lock / orientation lock | Bench работает без них; добавим если экран будет гаснуть в полевых тестах. |

## Критерии готовности (acceptance)

1. На Samsung и Xiaomi — стабильные **60 FPS** в RUNNING (debug overlay показывает frame Δt ≈ 16.7 ms).
2. В покое (камера на штативе, ничего не двигается) `motion ratio` < 0.05 на десятки секунд подряд.
3. Триггер срабатывает на пересечение рукой ROI и не срабатывает на движение **вне** ROI (как уже работает в bench).
4. `Hands-free loop` крутится без вмешательств: проехал → finish → cooldown → ready to go → проехал → … . Ни одна пауза не требует тыкать в экран.
5. Камера переживает Alt-Tab/lock-screen → возврат: **либо** работает дальше, **либо** показывает понятный alert и предложение нажать Hard refresh (см. decision 014 — мы уже знаем что Chrome для Android может полностью убить камеру до перезапуска браузера).

## Порядок работы

Следующий заход начинается с этого:

1. `cp webgl-bench.html webgl-app.html` — старт от рабочей точки.
2. Из webgl-bench выкинуть всё что про метрики (ms на стадии, samples, p50/p95).
3. Сохранить: error reporting, log panel + toggle, hard refresh, camera setup.
4. Добавить state machine из `app.js` (упрощённую — без stillness/refresh).
5. Добавить ROI picker (pinch + reticle) из `app.js`.
6. Добавить большой таймер + signal-фон.
7. Добавить voice cues.
8. Прогнать acceptance critera.

Полностью отдельная сессия — не пытаться смержить с текущим `app-webgl.js`. Текущий `webgl-detector.js` тоже скорее выкидывается чем переиспользуется (он мутный).
