# 006 — Hands-free session mode with auto re-arm

## Context

Until now the app required the rider to walk up to the phone between every run: tap Arm → ride → tap Reset → tap Arm again. For real gymkhana practice that's ~10–20 wasted seconds per run plus the friction of dismounting. The core value proposition is a self-driving timer: set it up once, mount the bike, do N runs without touching the phone.

## Investigation

Three trigger strategies considered for "when is it safe to re-arm?":

- **Fixed timer** — after FINISHED wait N seconds, auto re-arm. Simple, but if the rider is still in the ROI (clearing the course, turning around) we'd capture a tainted reference frame and immediately fire a false start on the next pass.
- **Detector-cooldown-based** — just reuse the existing 3-second `detector.cooldownRemaining()` window. Too short, and the cooldown is about *trigger debounce*, not scene clearance — still has the tainted-reference problem.
- **ROI stability observation** — every frame, measure frame-to-frame delta in the ROI. Once the delta has stayed below a threshold for a couple of seconds, the scene is truly still and we can safely rebuild the reference and arm. Handles both "rider still in frame" and "ambient light drifted between runs" in one mechanism.

## Decision

**ROI stability observation**, wrapped in a 10-second between-runs cooldown that the rider can visually read ("Next run in 9s"). Full state machine:

```
IDLE → (Start session) → OBSERVING → (stable ≥ 2s) → ARMED
  ARMED → (motion) → RUNNING → (motion, after detector cooldown) → FINISHED
  FINISHED → (~1s flash) → COOLDOWN(15s) → OBSERVING → ARMED → …
  anything → (Stop session) → IDLE
```

Implementation touches:

- `detector.observeStillness(video)` — frame-to-frame delta ratio (kept separate from the trigger-oriented `process()` so OBSERVING can't poison the reference).
- `detector.hasReference()` — lets `app.js` wait for the REFERENCE_FRAMES-averaged reference to finish building before arming.
- `app.js` — new state enum, `stepSession()` dispatcher, `enterObserving / enterArmed / enterRunning / enterFinished / enterCooldown`.
- UI: bright daylight-readable signal backgrounds (`--signal-go`, `--signal-wait`, `--signal-error`) driven by `body[data-phase]`; timer stays on the last result until a new RUNNING starts; sub-line renders the 15-second countdown, "Ready to go", or previous-run time depending on phase; controls hide during the session and re-appear for `TAP_REVEAL_MS` on any tap so Stop session stays reachable without cluttering the display.

Constants (chosen from gymkhana practice observation, tunable in `app.js`):

- `STABILITY_THRESHOLD = 0.04`
- `STABILITY_DURATION = 2.0` s
- `OBSERVING_ERROR_TIMEOUT = 20.0` s (flips background to coral to cue the rider)
- `BETWEEN_RUNS_COOLDOWN = 10.0` s
- `FINISHED_FLASH = 1.0` s
- `NOT_READY_VOICE_INTERVAL = 15.0` s (spoken cue while the session is active but not yet ARMED)

## Risks

- **Bright lighting changes mid-observation** could fail the stability check forever. Mitigated: after 20 s the background flips to coral signal-error so the rider knows to come over and lower the threshold or re-pick the ROI.
- **False stability** (scene is actually moving, but at a sub-threshold magnitude that happens to stay below `STABILITY_THRESHOLD`). Mitigated in principle by REFERENCE_FRAMES averaging — the reference absorbs the residual motion; in practice if this bites us the fix is to raise STABILITY_THRESHOLD or shorten STABILITY_DURATION.
- **Voice cue overload** — "start" + "finish" + "ready to go" on every run, every ~30 s. If it becomes annoying we can make `voice.readyToGo` opt-out via a toggle.

## Alternatives considered

- Voice-activated arm (rider yells "ready"). Rejected: helmet + engine + wind = useless under real conditions.
- NFC tag on handlebars tapped to the phone. Rejected: still requires riding up to the phone, defeats the whole point.
- Bluetooth remote / pedal. Out of scope for a web PWA (WebBluetooth support is patchy and requires an initial user gesture per session anyway).
