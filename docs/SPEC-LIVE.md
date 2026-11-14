# Build task: live production in the Clip recorder

Read REVIEW.md and CRITIQUE-FEATURES.md in this directory first (sections 1, 2, 3). They contain
measured findings from this machine's ffmpeg and browser behaviour. Extend the existing code; do
not rewrite it. Zero npm dependencies stays (`node:http`, `node:sqlite`, `node:fs`,
`node:child_process`). No server routes change in this increment.

Goal: a podcaster can switch scenes and fire animated icons **while recording**, and sees exactly
what is being recorded.

## 1. Always open the camera

`choose(mode)` currently opens the camera only when `wantCam` is true:

```js
const wantScreen = mode !== 'cam';
const wantCam = mode !== 'screen';
const user = await media.getUserMedia({ video: wantCam, audio: true });
```

Change it so the camera video is always requested, and a camera failure is **non-fatal** when a
screen stream is available (fall back to screen-only scene, show a one-line notice, keep going):

```js
const user = await media.getUserMedia({ video: true, audio: true });
```

Requesting camera on a `screen`-only start costs one permission prompt. That is the price of
switching scenes mid-take, and it is the whole point of this increment.

If `getUserMedia` rejects and there is no screen stream, keep the current error path
(`showNotice(explain(err), true)`). If it rejects and there *is* a screen stream, continue with
`session.hasCam = false`, show a non-error notice, and disable the cam-dependent scene buttons.

## 2. Scene state instead of `useBubble`

Replace `session.useBubble` with `session.scene`, one of `'screen' | 'both' | 'cam' | 'title'`.

- Starting placement from the chosen mode: `screen` → `'screen'`, `both` → `'both'`, `cam` → `'cam'`.
- `drawFrame()` becomes:

```js
function drawFrame() {
  ctx.fillStyle = session.bg;                                  // background colour, see §3
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (session.scene === 'screen' || session.scene === 'both') coverFit($('mainVideo'));
  if (session.scene === 'both') drawCamera($('camVideo'));
  if (session.scene === 'cam') coverFit($('camVideo'));
  if (session.scene === 'title') drawTitle();
  drawIcons();
  drawClock();                                                 // see §4 (keeps the track alive)
}
```

`coverFit(video)` is a new ~6-line helper: source-crop to the canvas aspect ratio and draw it
full-frame so it covers, never stretches (the existing `drawCamera()` already computes a `side`
crop — reuse that idea).

`drawTitle()` fills the frame with `session.bg`, then draws `session.titleText` (default
"Clip", editable before recording) centred at ~7% of canvas height, white, bold.

**Canvas dimensions stay fixed for the life of the take** (a `captureStream` track cannot be
resized without tearing). In `start()`, elect the **screen** video's aspect when a screen stream
exists — never the camera's — so a 720p webcam plus a 4K monitor does not produce a 720p canvas.

## 3. Background colour

`session.bg` defaults to `#0b0b0c`. Add a colour swatch row (6 presets + `<input type="color">`)
visible in the setup view and during recording. Changing it while recording takes effect on the
next frame — no restart. This is the "change the screen background" ask: the canvas fills with
`session.bg` before the content is drawn, so letterboxed screens and title cards pick it up.

## 4. Animated icons, live

`session.icons = []` of `{ kind, at }` where `kind` is `'subscribe' | 'like' | 'bell' | 'arrow'`
and `at = elapsed()` — **`elapsed()`, never `performance.now()`**: pause freezes `elapsed()`, and an
icon clocked on wall time reappears mid-pause already finished.

`drawIcons()` computes `p = (elapsed() - icon.at) / 900` (ms), returns early when `p > 1`, and
draws a vector shape with a scale-and-fade entrance plus a gentle bob. Four hardcoded shapes drawn
with `arc`/`fillText`/`beginPath` — no images, no library, no per-icon settings.

- Trigger: a row of four buttons in `#bar` plus keys `S` / `L` / `B` / `A` while recording.
- Sizes derive from `canvas.width` (e.g. radius = `canvas.width * 0.035`), not CSS pixels — the
  same icon must look the same on a 4K screen share and a 720p webcam.
- Keep icons inside a 5% inset (YouTube's progress bar and Shorts UI cover the bottom edge).
- Draw them **last**, above every scene.
- Label the row "Icons — live only (cannot be undone; they are in the take)". An icon fired at the
  wrong moment is unrepeatable; say so rather than letting the user discover it.

## 5. Preview must be the canvas

Today `.stage` renders `#mainVideo` with `object-fit: contain` and a DOM `#bubble`. With four
scenes that is a lie. Change the stage so the **canvas element is visible** (appended into
`#stage`, `object-fit: contain`, `max-width: 100%`), and `#mainVideo` / `#camVideo` become hidden
`<video>` elements used only as draw sources. Keep `#bubble` as the drag handle (pointer events
still set `bubblePos`), but hide its video child since the bubble is now canvas-drawn.

Add a scene row (Screen / Screen + Cam / Cam / Title) that is visible in setup **and** during
recording, with the active scene marked (`aria-pressed="true"`). Switching during recording must
not touch `MediaRecorder`.

`drawClock()` draws the elapsed timer (mm:ss) into the top-right corner of the canvas, `canvas.width
* 0.018` px, 70% white, with a 3% inset. A frozen frame with no motion can leave
`canvas.captureStream(30)` emitting nothing while audio keeps going; a moving clock guarantees the
video track never stalls. It doubles as the timestamp viewers see.

## 6. Stop-sharing must not kill the take

Currently:

```js
(screen ?? user).getVideoTracks()[0].onended = () => (session.recorder ? stop() : cancel());
```

Change it: when the **screen** track ends and the camera is alive, set `session.scene = 'cam'`,
show a notice ("Screen sharing stopped — switched to camera"), and keep recording. Only fall back
to `stop()`/`cancel()` when the camera track also ends. A podcaster who stops sharing to hide a
password manager must not lose a 35-minute take.

## 7. Camera frame (lightweight "background")

Reframe, per the critique: an uploaded PNG or brand colour drawn as a rounded panel with the camera
inset inside the existing 180 px footprint. No segmentation, no blur (blur blurs the face, not the
room). `drawCamera()` gains an optional `session.camFrame = { color }` that fills a rounded rect
behind the circle with `roundRect` then clips the camera to the circle as today. One swatch row
(Transparent / 3 colours) in setup. Keep it to ~20 lines; no upload in this increment.

## Constraints

- No new server routes, no database column, no npm dependency.
- All of the above lives in `public/index.html` (plus a few CSS rules at the end of
  `public/app.css`). Touch nothing else.
- Recording must still work exactly as before when the user never leaves the initial scene.
- Keep access keys (drag bubble with arrows), `aria-pressed` on scene/icon buttons, and visible
  focus rings.

## VERIFY BEFORE YOU FINISH

Run these and paste the real output. Do not report success without them.

1. `node --check server.js` → no output.
2. Extract the inline module from `public/index.html` and check it:
   `python3 - <<'PY'` … pull everything between `<script type="module">` and `</script>` into
   `/tmp/rec.mjs`, then `node --check /tmp/rec.mjs` → no output.
3. `grep -n "useBubble" public/index.html` → **no matches** (the old flag is gone).
4. `grep -n "getUserMedia({ video: true" public/index.html` → matches (camera always requested).
5. `grep -n "elapsed() - icon.at\\|elapsed() - icon" public/index.html` → matches, and
   `grep -n "drawIcons" public/index.html` shows it called from `drawFrame`.
6. Start the service: `systemctl --user restart clip.service` then
   `curl -s -o /dev/null -w '%{http_code}' localhost:3001/` → `200`.
7. Screenshot the recorder so the layout is visible and read the PNG back:
   `CHROME=$(ls ~/tools/chrome-libs/*/chrome 2>/dev/null | head -1); "$CHROME" --headless \
     --disable-gpu --screenshot=/tmp/recorder.png --window-size=1280,860 \
     --virtual-time-budget=4000 http://localhost:3001/`
   Confirm with an image read that the page shows: source buttons, the new scene row, the icon row,
   the background swatches and no obviously broken layout. If Chrome is not available at that path,
   say so instead of skipping silently.
8. State plainly in your report what could NOT be tested headlessly: `getDisplayMedia` /
   `getUserMedia` need a real browser and a user gesture, so the live capture path is unverified
   until the user records a clip.

## EXECUTION DIRECTIVE

Order: `public/index.html` (state + choose + drawFrame + helpers) → `public/app.css` additions
(rows, canvas stage, swatches) → re-run the checks. Do not rewrite `server.js`, `edit.html`,
`watch.html`, `library.html`, or the render path. Do not touch `data/`.

Report at the end: the diff summary (what changed, line counts), and the output of every VERIFY
step. If a check fails, fix it and re-run until it passes.
