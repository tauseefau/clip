# Feature critique — ten proposals, graded against the code that exists

Read: `server.js` (686 L), `public/index.html` (360 L), `public/edit.html` (723 L), `public/app.css`,
`REVIEW.md`. Every claim below was checked in those files, and the ffmpeg claims were run on this
box against a real recording from `data/media/` and a synthetic fixture.

Environment correction first: **ffmpeg here is 8.0.1**, not 6.1. `libass`, `libx264`, `silencedetect`,
`showwavespic`, `select`/`aselect`, `concat`, `afade` are all present. No `whisper-cli` binary exists.

The single most useful thing I found is that the plan's stated mechanism for the top-ranked feature
(**"compiles down to keep-ranges the renderer can express with `select`/`aselect`"**) is
**false on this stack**, and it fails *silently*:

```
source: 20.008s, 1001 audio packets, beeps at 1.0 / 10.0 / 17.0
keep [0-4][8-12][16-20] via select+aselect
  video: 360 frames  ✅ correct (12s)
  audio: 1001 packets, duration 20.008  ❌ completely uncut
```

`aselect='between(t,0,4)'` — a single range, nothing clever — passes **all** frames. Video `select`
with the same expression cuts correctly. Result: a file whose picture is 12 s and whose sound is
20 s, which no ffprobe check in `renderRecording` would catch, because `probed > 0` is true.

The form that works, measured:

```
[0:v]trim=0:4,setpts=PTS-STARTPTS[v0] … [v0][v1][v2]concat=n=3:v=1:a=0
[0:a]atrim=0:4,asetpts=PTS-STARTPTS,afade=t=in:d=.03,afade=t=out:st=3.97:d=.03[a0] …
→ 12.001s, 360 v-frames, 600 a-packets, beeps at 1.0 / 6.0 / 9.0 ✅
```

Per-segment `trim`/`atrim` + `concat`. It is barely more code than `select`, it is correct, and the
`afade` pair falls out for free — which matters more than it sounds (a cut landing mid-word on a
hard waveform step is an audible click in Opus).

---

## 1. Scene switching during recording

**(a) What the proposal gets wrong.** It is described as a `drawFrame()` change, and that part is
right — but two things make it a capture change, and the plan doesn't say so.

First, `choose(mode)` only opens the camera when `wantCam` is true:

```js
const wantScreen = mode !== 'cam';
const wantCam    = mode !== 'screen';     // ← 'screen' mode never calls getUserMedia({video})
const user = await media.getUserMedia({ video: wantCam, audio: true });
```

So a take started as "Screen" has no camera stream at all and cannot switch to a bubble or full-cam
mid-take without a permission prompt over a live recording. Second, `start()` fixes the canvas from
whichever video got elected as `main`:

```js
canvas.height = Math.round(Math.min(height, main.videoHeight) / 2) * 2;
canvas.width  = Math.round(main.videoWidth * canvas.height / main.videoHeight / 2) * 2;
```

`main.srcObject = screen ?? user` — so a screen-first take is sized to the *screen's* aspect
(16:10 on a MacBook, 21:9 on an ultrawide). A cam-only scene then has to be letterboxed into a
weird frame for the rest of the take. The plan implies scenes change the canvas; **they must not.**
Canvas dimensions are immutable for the life of a `captureStream` track without tearing.

Third thing the plan misses: the *preview* is not the recording. `.stage` renders `#mainVideo` with
`object-fit: contain` and overlays `#bubble` as a DOM element. With one fixed layout that's a
harmless approximation. With four scenes the user is framing something they cannot see. The preview
has to become the canvas.

**(b) Simplest correct implementation.** Three small edits, no server change.

`choose()`: always request the camera, and make its failure non-fatal rather than killing the take —

```js
const screen = wantScreen ? await media.getDisplayMedia({ video: true }) : null;
const user = await media.getUserMedia({ video: true, audio: true });
```

`session.useBubble` becomes `session.scene` (`'screen' | 'both' | 'cam' | 'title'`). Canvas size is
still fixed in `start()`, but elect the **screen** when present (already true) and ignore
`videoHeight` of the camera — otherwise a 720p webcam plus a 4K monitor gives you a 720p canvas.

`drawFrame()` becomes a switch, and it must clear first — the canvas persists between frames, so a
'cam' or 'title' scene without a `fillRect` smears the previous frame's edges:

```js
function drawFrame() {
  ctx.fillStyle = session.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (session.scene !== 'cam') coverFit($('mainVideo'));      // screen, or title card backdrop
  if (session.scene === 'both') drawCamera($('camVideo'));
  if (session.scene === 'cam')  coverFit($('camVideo'));      // cover, not stretch
  if (session.scene === 'title') drawTitle();
  for (const icon of session.icons) drawIcon(icon);
}
```

`coverFit()` is ~6 lines (source-crop to canvas aspect, like the existing `drawCamera` already does
with `side`). `drawTitle()` is `fillText` on the scene background. Then swap the stage to show
`canvas` (`object-fit: contain`) and hide `#mainVideo`; keep `#bubble` only as the drag handle.

**(c) Traps.**
- **Dead screen = dead take.** `(screen ?? user).getVideoTracks()[0].onended = () => (session.recorder ? stop() : cancel())` — the browser's "Stop sharing" button ends the recording. With scenes available it should fall back to `session.scene = 'cam'` and keep rolling. A podcaster who stops sharing to hide a password manager should not lose 35 minutes.
- **A static title card can stall the track.** `canvas.captureStream(30)` captures on change; a frozen card with no motion can leave the video track emitting nothing while the worker keeps ticking, so the WebM's audio and video drift. Draw something that always changes (the elapsed timer in a corner) on every frame.
- **Keyboard shortcuts while sharing the screen.** If the podcaster shares the Clip tab itself, `1`–`4` typed into a scene switcher also lands in whatever they're showing. Not fatal, worth knowing.

**(d) Verdict: build now (A).** ~60 lines in one file, no server change, and it is the explicit ask.

---

## 2. Camera background replacement

**(a) What the proposal gets wrong.** "Solid colour, blur, uploaded image" implies the Zoom behaviour
— segment the person, replace what's behind them. Canvas cannot do that. There is no segmentation
in the browser without a model. What you *can* do cheaply is one of three different things, and only
one of them is worth shipping:

- solid colour behind the bubble: already free, the bubble is clipped to a circle and the screen shows through — there is no camera background to replace;
- `ctx.filter = 'blur(8px)'` on the camera draw: blurs the whole bubble, i.e. the person's face, not the room. It reads as a bug;
- chroma key in canvas: ~35 lines, per-pixel loop, works only on a green wall. A podcaster in a bedroom does not have one.

**(b) Simplest correct implementation.** Reframe it as **camera frame**, not background replacement:
an uploaded PNG or a brand colour drawn as a rounded-rect panel, with the camera inset and
cover-fitted inside it, inside the same 180 px footprint. That is ~20 lines in `drawCamera()` —
`roundRect` fill, then clip and `drawImage` inset — and it is what podcasters actually want, because
their problem is a messy room and an unbranded look, not an un-segmented silhouette.

If real segmentation is genuinely required, the only honest path is vendored MediaPipe Selfie
Segmentation (a ~6–10 MB wasm + JS bundle). That is not an npm dependency, so it doesn't break the
"zero deps" rule literally, but it costs ~5–8 ms/frame on the 30 fps tick and it's a supply-chain
and versioning commitment. Price it as its own decision, not a checkbox.

**(c) Traps.**
- **Blur bleeds past the clip.** `ctx.filter` applies to the drawn rect, not the clip path, so a blurred bubble smears a halo of room over the screen. Clip first, then filter, then reset `ctx.filter = 'none'` — an unreset filter silently blurs every later draw (including the icons).
- **The uploaded image must be same-origin-safe.** A `blob:` URL from `URL.createObjectURL` is fine; a remote URL taints the canvas and `captureStream` throws a `SecurityError` *at record time*, which surfaces as "recording failed" with no explanation.

**(d) Verdict: build later, as "camera frame" only.** Ship the panel; skip segmentation and skip
blur unless you vendor a model. It is decoration, not workflow.

---

## 3. Animated icon overlays

**(a) What the proposal gets wrong.** It's ranked 18 of 20 and it's still proposed for increment A,
which is defensible only because it's cheap — but "animated icons" as a feature implies a library, a
timeline, and per-icon options. None of that is needed. Four shapes, one key each, baked into the
canvas.

The real omission: **an icon triggered live is unrepeatable and uncorrectable.** If the podcaster
hits the bell at the wrong moment in minute 34 of 40, the only fix is a re-record. Say so in the UI,
or the feature will be blamed for something it cannot do.

**(b) Simplest correct implementation.** `session.icons = []` of `{kind, at}` where `at` is
`elapsed()`. `drawIcon()` computes `p = (elapsed() - icon.at) / 900` and returns early when `p > 1`.
~50 lines total for four hardcoded vector shapes (`arc` + `fillText`), drawn last in `drawFrame()`
so they sit above every scene. Trigger from `#bar` via four buttons plus `S`/`L`/`B`/`A`.

**(c) Traps.**
- **Use `elapsed()`, never `performance.now()`.** Pause sets `session.resumedAt = null` and freezes `elapsed()`; an animation clocked on wall time keeps running while paused and reappears already finished. This is a one-line mistake with a confusing symptom.
- **Size from `canvas.width`, not CSS pixels.** `start()` derives width from the source, so the same icon is 2.5× bigger on a 4K screen share than on a 720p webcam. Everything in `drawFrame` is in canvas pixels; the existing `BUBBLE = 180` constant is already wrong in that respect and gets away with it only because the default is 1080p.
- **Safe area.** Bottom-right icons land under YouTube's progress bar and Shorts' UI. Keep them inside a 5% inset.

**(d) Verdict: build now, but the smallest possible version.** Four shapes, one row of buttons, no
library, no per-icon settings. It's the cheapest thing in the list and it's what was asked for.

---

## 4. Split-and-delete cuts (keep-ranges)

**(a) What the proposal gets wrong.** Two things, one of them the finding at the top of this document.

First, `select`/`aselect` does not work for audio here. Second, the proposal treats cuts as an
*additive* option on the render path. It is not additive: it changes the length of the output, and
`renderRecording` uses that length in three places —

```js
const outputSeconds = (end - start) / speed;                 // → music bed atrim=duration
… atrim=duration=${outputSeconds} …                          // → bed length
const durationMs = Math.round(Math.min(probed, outputSeconds) * 1000);
```

and `validateEdit` validates every caption against `end - start`:

```js
if (to > end - start + 1e-6) fail(400, 'Caption ends past the trimmed clip');
```

With cuts, `end - start` is no longer the clip length, so every caption past the first cut is either
rejected or silently mistimed.

Third: the existing path already uses **input-level** `-ss start -to end`, which resets the filter
timeline to 0. Cut times must therefore live in the same coordinate system (0 = `trim.start`), or
you end up with two offsets fighting each other.

**(b) Simplest correct implementation.** One code path, no branch. `cuts` defaults to
`[[0, end - start]]`, so every render goes through the same graph:

```js
// validateEdit: ascending, non-overlapping, each >= 0.1s, sum <= MAX_RENDER_SECONDS
const cuts = normaliseCuts(payload.cuts, end - start);   // [[0,4],[8,12],[16,20]]
const kept = cuts.reduce((n, [a, b]) => n + (b - a), 0);
const outputSeconds = kept / speed;
```

Filter graph, built with `cuts.map` exactly like `overlays.map` already is:

```js
const seg = cuts.map(([a, b], i) => `[0:v]trim=${a}:${b},setpts=PTS-STARTPTS[v${i}]`);
const cat = `${cuts.map((_, i) => `[v${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0`;
// audio: atrim + 30ms afade in/out per segment, concat, then the existing atempo=speed
```

then splice `[...seg, cat, ...scalePad, ...drawtext, setpts=PTS/${speed}]` where the current code
has `filters` started by `scale`. Keep `-ss/-to` on the input: it preserves the 0-based timeline and
avoids decoding the head of a 40-minute file.

Measured result of exactly this shape: 12.001 s out of a 20 s source, 360 video frames, 600 audio
packets, cut points landing where the arithmetic says (1.0 / 6.0 / 9.0).

**(c) Traps.**
- **`aselect` silently no-ops on Opus.** Covered above. If a reviewer "simplifies" this back to `select`/`aselect` because it's one filter instead of 2·n, the file looks fine, plays fine, and the sound runs long.
- **Cut positions vs keyframes.** `-ss` before `-i` is accurate for the *window*, but a manual split lands wherever the podcaster clicked, which is mid-syllable. Snap manual splits to the quietest 100 ms within ±300 ms — one pass over the peaks you already computed for the waveform. Without that, "split and delete" produces the clicks that make the whole edit sound amateur.
- **Caption time base changes meaning.** With cuts, `t` in `captionFilter` is *edited* time, while the caption rows still say "seconds into the trimmed clip". Same words, different number. Either relabel the panel or the podcaster's captions drift by the total of everything they deleted before that point.

**(d) Verdict: build now (B), and it is the whole of B.** Everything else in increment B is a
generator for this list.

---

## 5. One-click silence removal

**(a) What the proposal gets wrong.** It's proposed as a preview-then-apply feature, as if detection
were the hard part. Detection is 8 lines; the hard part is that **`run()` cannot see the answer**:

```js
const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], ...options });
```

`silencedetect` writes its findings to **stderr at info level and exits 0** — verified:

```
ffmpeg -i src.webm -af silencedetect=noise=-30dB:d=0.5 -f null -  → exit 0, 8 lines on stderr
```

So a route built on the existing helper returns `''` and reports "no silence found" on a take that is
40% silence. That is the exact shape of bug that ships.

Second omission: a threshold in absolute dB is meaningless across microphones. A USB mic peaking at
−24 dBFS has every *word* below a −30 dB threshold. The number has to be relative to the file.

**(b) Simplest correct implementation.** Add a sibling that keeps stderr —
`runStderr(cmd, args)` returning `{code, stdout, stderr}` — rather than changing `run()`'s
signature and its twelve call sites. One route, no file written, no job queue:

```
GET /api/recordings/:id/silence   →  { cuts: [[a,b],…], removed: 124.6, total: 2140.2 }
```

Two ffmpeg passes in the handler: `volumedetect` for `max_volume` (fast), then
`silencedetect=noise=${peak - 20}dB:d=0.7` clamped to `[-45,-20]`. Parse `silence_start` /
`silence_end`, merge gaps under 400 ms, pad each end by 150 ms, invert to keep-ranges, subtract
`trim.start`, and hand the result to the editor as **pre-filled `cuts`**. The user reviews them in
the cut UI that already exists from #4. No second render path, no preview player, no new state.

**(c) Traps.**
- **Unmatched pairs.** A take that starts with the mic open before anyone speaks emits `silence_start: 0.0` with no preceding `silence_end`; a take that ends in silence emits `silence_start` with no `silence_end` before EOF. Handle both or you lose the leading 3 seconds of every recording — and `probeUpload` returns `format.duration` for these files, so there is a duration to clamp against, but not for raw MediaRecorder output where it's `0`.
- **Don't cut the breath.** A breath just above threshold leaves silence segments split around it; padding by 150 ms on each side fixes most of it. Removing *all* dead air makes a podcast sound like a machine — a 400 ms floor and a "keep it natural" toggle are not polish, they're the difference between usable and unwatchable.
- **Cost.** `silencedetect` decodes the whole audio track. `showwavespic` on 11 s took 0.12 s, so 40 minutes is a few seconds of CPU held inside the request. Fine — but don't call it on every slider move.

**(d) Verdict: build now, but strictly as a *generator* for #4's cut list.** It costs one route and
one helper, and without #4 it cannot exist.

---

## 6. Waveform under the editor preview

**(a) What the proposal gets wrong.** It treats the waveform as a visual nicety. Under a cut editor
it is the *input device* — it's how you find the sentence to kill. That distinction decides the
implementation: it must be accurate to the sample, one image, and it must sit behind the same
time axis as the cuts. A decorative squiggle that doesn't line up with the frame the playhead is on
is worse than nothing.

Also missing: the editor today has no timeline at all — `#start` and `#end` are two range inputs.
There is nowhere to put a waveform until the cut UI exists.

**(b) Simplest correct implementation.** Do not compute peaks in JS. `showwavespic` gives the whole
picture in one ffmpeg call:

```
ffmpeg -i src.webm -filter_complex "showwavespic=s=1600x120:colors=#8a8a8a" \
  -frames:v 1 -c:v png -f image2 -update 1 …
```

then a 1600×120 PNG is the background of the timeline strip, stretched to the clip's width. Cache it
in a module `Map` keyed by id (it's derived, disposable, and regenerating it on a 40-minute file is
sub-second), and ship it as a data URL inside the existing `GET /api/recordings/:id` response —
**zero new routes, zero cleanup entries, zero cache-invalidation logic**. Setting
`img.src = 'data:image/png;base64,…'` on a 30–60 KB payload is the cheapest thing that works.

**(c) Traps.**
- **`-f image2` on a `.part` filename silently writes a JPEG.** Verified: `-f image2 wave.png.part` exits 0 and `file` reports *JPEG*. If you route this through `buildOnce()` you will serve `Content-Type: image/png` over JPEG bytes and nobody will notice for weeks. You need `-c:v png -update 1`. (The existing `serveThumbnail` gets this right only because it names `-f mjpeg` explicitly.)
- **Timeline mismatch after trim/cuts.** The picture is of the *source*; the timeline is of the *edit*. Offset by `trim.start` and, once cuts exist, draw the removed regions over the image with CSS gradients — don't regenerate the waveform per edit.

**(d) Verdict: build now (B), but only as a backdrop to #4's timeline.** On its own it's 40 lines of
nothing.

---

## 7. Undo/redo + shortcuts

**(a) What the proposal gets wrong.** Nothing much — it's the cheapest feature on the list and the
plan is roughly right. But it assumes the form can be restored, and `applyDraft()` cannot:

```js
function applyDraft({ … overlays: savedOverlays, captions, … }) {
  for (const overlay of savedOverlays) draw(createOverlay(overlay));   // appends
  for (const { start, end, text } of captions) appendCaption(…)        // appends
```

It is append-only by design (it runs once, on load). Call it twice and you get two of everything.
It also deliberately skips `trim` ("wait for `setDuration`"), so undo would silently not restore the
trim.

**(b) Simplest correct implementation.** `formState()` is already a complete serializable snapshot of
everything the renderer sees — that's the entire undo system, already written, used for drafts.
You need a `resetForm()` that empties `overlays`/`#captionRows` (a loop over `overlays.splice` plus
`$('captionRows').replaceChildren()`), then `applyDraft(snapshot)` plus explicit `start`/`end`
assignment. Push on the existing capture:

```js
for (const type of ['input','change','click','pointerup','keyup']) document.addEventListener(type, scheduleDraft);
```

becomes `… document.addEventListener(type, commit)` where `commit` pushes
`JSON.stringify(formState())` only if it differs from the top of the stack **and** 400 ms have passed
since the last push. Redo is a second array, cleared on any new push. `onKeydown` already exists and
already ignores input fields — add `Ctrl/Cmd+Z`, `Shift+Ctrl/Cmd+Z`, `I`/`O`, `S`, `Space`.

**(c) Traps.**
- **Coalescing.** A slider drag fires ~200 `input` events; without the 400 ms gate, "undo" means "undo one pixel of size", and the podcaster presses it twelve times and gives up.
- **Space is taken.** `<button>` activates on Space; with `#render` focused, `Space` renders instead of toggling playback. `preventDefault()` on body-level space, not on the button.
- **Draft interaction.** `lastSaved` is compared against a new `JSON.stringify` — an undo-then-undo-back leaves the draft saying nothing changed. Harmless, but it will confuse whoever debugs it.

**(d) Verdict: build later (B), after cuts.** It's 60 lines and it makes the cut editor safe to use,
but it is worthless before there is something dangerous to undo.

---

## 8. H.264 MP4 at a chosen resolution

**(a) What the proposal gets wrong.** Two things, one of them a real bug.

First: **the cached transcode ignores resolution and is keyed only on the file path.**

```js
const out = join(MEDIA, `${id}.mp4`);
if (existsSync(out)) return Promise.resolve();      // second export returns the first one
await buildOnce(out, 'mp4', ['-i', src, '-c:v','libx264', …], 'Transcode failed');
```

Ask for 720p after a 1080p export and you get a 1080p file with no error. That is the whole feature,
and it doesn't work.

Second: MP4 is not needed for YouTube. YouTube ingests VP9/WebM happily. The real value is "send it
to my editor", podcast host uploads with size caps, and Descript/Premiere imports. That reframes the
feature from *publish* to *handoff*, and it means 720p matters more than 1080p.

Third, the honest cost: `-preset veryfast -crf 23` on 40 minutes of 1080p is minutes of CPU, and the
HTTP request is held open the whole time. `serveMp4`'s own comment says "move to a job queue past
~10 min clips" — a 40-minute episode is 4× past that line, so the shortcut has expired.

**(b) Simplest correct implementation.** `${id}-${height}.mp4`, `scale=-2:${height}`,
`-pix_fmt yuv420p`, and a `height` query param validated against `[720, 1080]`:

```js
const out = join(MEDIA, `${id}-${height}.mp4`);
await buildOnce(out, 'mp4', ['-i', src, '-vf', `scale=-2:${height}`,
  '-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p',
  '-c:a','aac','-b:a','128k','-movflags','+faststart'], 'Transcode failed');
```

Then add `-${height}` variants to the DELETE cleanup array next to `${id}.mp4`/`${id}.jpg`. Rename
the whole thing in the UI from "Export" to "Download MP4 ▾ (1080p / 720p)".

**(c) Traps.**
- **`-pix_fmt yuv420p` is not optional.** VP9 from a canvas can end up `yuv444p`/`gbrp`; H.264 in yuv444p is unplayable in Safari and QuickTime, and the file *looks* fine in Chrome. This is the classic "works for me".
- **Abandoned downloads keep burning CPU.** Nothing aborts the child when the socket closes (`buildOnce` is fire-and-forget), so closing the tab leaves ffmpeg running to completion for the full 40 minutes. Acceptable once; diagnose it as a mystery CPU spike.
- **Odd dimensions.** Canvas enforces even sizes, but `scale=-2` guards the case where an older recording came from elsewhere.

**(d) Verdict: build later (C), 15 lines, add only 720p + 1080p.** Don't build a resolution picker
with six options; two buttons.

---

## 9. Podcast preset (title bar + lower third + progress bar)

**(a) What the proposal gets wrong.** "Burned in by ffmpeg `drawbox`/`drawtext`" — `drawtext` is
right, and the existing `drawtext()`/`captionFilter()` machinery plus the `textfile=` +
`expansion=none` trick already handles quoting and em-dashes correctly. **`drawbox` is wrong for the
progress bar**, and wrong in the worst way: silently.

```
drawbox=x=0:y=ih-12:w='iw*t/12':h=12:color=#ff5c5c:t=fill
  t=1  → 1280 px wide
  t=3  → 1280 px wide
  t=6  → 1280 px wide
  t=11 → 1280 px wide        (expected 107 / 320 / 640 / 1173)
```

`drawbox`'s `w` does not re-evaluate per frame here. You get a full-width bar at every timestamp —
a progress bar that is always complete. And `crop=w='iw*t/12'` is worse: it hard-errors
("Error when evaluating the expression"), so the obvious second guess fails loudly and sends you back
to the one that fails quietly.

What *does* animate per frame is `overlay`:

```
overlay=x='-w+w*t/12':y=H-h   →  106 / 320 / 640 / 1174 px at t = 1 / 3 / 6 / 11  ✅
```

**(b) Simplest correct implementation.** Don't add a preset pipeline; add **one field** that expands
into existing machinery inside `validateEdit`:

```js
preset: 'none' | 'podcast'
```

On `'podcast'`, append two synthetic entries to `overlays` (title at `{x:0.04,y:0.04}`, lower third
at `{x:0.06,y:0.78}`) and push one flag the graph reads for the bar. Title text comes from the
recording's own title — no new form field, no new route.

The progress bar is one extra input: a 1 px-tall strip PNG generated once at boot (or a `color=`
lavfi source, which needs no file at all) plus

```
[bar]overlay=x='-w+w*t/${outputSeconds}':y=H-h-6[withbar]
```

Note `outputSeconds` must be interpolated as a literal, and it changes once cuts exist — that's the
coupling.

**(c) Traps.**
- **Input-index arithmetic.** `[1:v]` is the watermark and `[${watermark ? 2 : 1}:a:0]` is the music track. A new `-i` for the bar breaks both. Refactor to a counter (`let next = 1; inputs.push(...); const barIndex = next++`) *before* adding anything, or the music bed will silently become the progress bar's audio stream.
- **The lower third collides with burned captions.** `captionFilter()` hardcodes `y=h*0.92-text_h` (line 418); a lower third at 0.78 plus a title bar at 0.04 leaves a band in the middle. `captionFilter` needs a `y` parameter, and the preset has to pass it.
- **`enable` uses output time.** `setpts=PTS/${speed}` comes before the caption filters precisely so captions track their words at any speed; the bar must use the same convention (it does, if it's drawn after `setpts` and its denominator is already speed-adjusted).

**(d) Verdict: build later (C), and only as an expansion of `overlays`.** It's ~40 lines if it reuses
`drawtext`, and a whole subsystem if it doesn't.

---

## 10. Auto captions (explicitly deferred)

The plan defers it and that's correct, but "deferred" hides how much has to exist. Concretely:

- **Binary + model.** No `whisper-cli` on this box. `base.en` is ~150 MB, `small.en` ~466 MB, and the install step is a download in `install.sh` that can fail.
- **A job system, because the render path proves it's needed.** `renderRecording` holds the request open and its own comment admits the ceiling. A 40-minute transcription is 1–3 hours of CPU at `base.en` on a small box (`small.en` 2–3× that). That means: a `jobs` table, a loop, a progress route, client polling, resume-after-restart, and a way to kill a runaway. That is not an increment; it's the size of the rest of the app.
- **Storage.** The `captions` column already holds `[{start,end,text}]` and `toSrt()` already exports it, so *storage* is solved. Nothing else is.
- **The caption ceiling breaks first.** `validateEdit` rejects more than 100 captions, and `captionFilter` emits one `drawtext` per caption — a 40-minute episode is 400–600 cues, i.e. 500 `drawtext` filters in one `filter_complex`. Even if you raise the cap it will crawl. The fix is `subtitles=cues.srt` (libass is compiled in — verified), which also kills the hand-rolled `wrap()` and `captionChars` estimate. That change should happen **whenever captions are next touched**, before whisper, not during it.
- **Quality traps that decide whether it's usable.** Whisper hallucinates fluent text over silence (`no_speech_prob` filtering is mandatory, or the "remove dead air" cuts get captions about the thanks-for-watching outro that nobody said); it emits no speaker labels, so a two-person podcast gets one undifferentiated stream and every caption is attributed to whoever the viewer assumes; and word-level timings are only available with the `-ml 1`/token-timestamp path, so karaoke-style captions are a separate build.

**The strategic point:** YouTube already auto-captions podcasts for free, and reasonably well. The
podcaster's actual pain is *editing* an hour of speech, which is why Descript exists. If whisper is
ever built here, the highest-value version is **transcript-based cutting** — delete sentences in
text, get cuts in the keep-range list — not caption burning. That reuses #4 entirely and needs no
`drawtext` changes at all.

**(d) Verdict: cut, and don't re-add it as captions.** If it returns, it returns as a cutter.

---

## The two direct questions

**Which single change buys the most per line of code?** The keep-range cut list (#4). ~40 server
lines (validation + per-segment `trim`/`atrim` + `concat` + the `outputSeconds` fix) turns silence
removal, the waveform, chapters and transcript-editing from separate features into generators for
one data structure. Nothing else on the list is a substrate for three other features.

Runner-up, and it wins on raw diff size: always-open camera + scene switching in `drawFrame()` is
~60 lines in one file with no server change — but it's already increment A, and it makes recording
nicer rather than making the 40-minute episode survivable.

**Which is most likely to regress the working render path?** #4, clearly. It is the only one that
changes the *length* of the output, and length is read in three places (`outputSeconds` → music
`atrim=duration` → `-shortest` → `durationMs` clamp) plus the caption validation bound. It also
changes what `t` means inside `captionFilter`, so existing captions shift silently rather than
erroring.

Second place: #9, and for a specific reason — the `[${watermark ? 2 : 1}:a:0]` input-index ternary.
Adding a single `-i` for a progress-bar image turns the music bed into silence or worse, and nothing
in the code would say so.

Both are avoidable by one discipline: build the `cuts` default (`[[0, end-start]]`) so there is one
filter path, and replace the input-index ternary with a counter before adding any input.

---

## Schema fields

**Nothing needs a new database column.** `recordings.edit` (TEXT, added by the `PRAGMA table_info`
migration loop at server.js:83-86) already stores the whole validated payload as JSON, and
`recordings.captions` already stores the cue array. Both new features are payload, not schema. The
only schema that #10 would need is a `jobs` table — which is another reason it's a phase, not an
increment.

`validateEdit()` — the payload grows by two fields, with these rules:

| field | type | rule |
|---|---|---|
| `cuts` | `[[number, number], …]` | ascending, non-overlapping, `0 ≤ a < b ≤ end-start`, each segment ≥ 0.1 s, sum ≤ `MAX_RENDER_SECONDS` (3600). Absent ⇒ `[[0, end-start]]` |
| `preset` | `'none' \| 'podcast'` | default `'none'`; expands server-side into overlays + a progress-bar flag, never a new client field |

Derived, not stored: `kept = Σ(b-a)`, `outputSeconds = kept / speed`. These replace `end - start` in
exactly three places — the music `atrim=duration=`, the `-shortest` decision, and the `durationMs`
clamp — and in one validation bound (`captions[].end` may not exceed `kept`).

Outside the DB:

- `${id}-${height}.mp4` for exports, added to the DELETE cleanup array beside `${id}.mp4`/`${id}.jpg`.
- Waveform PNG held in a module `Map`, or inlined as a data URL on the existing
  `GET /api/recordings/:id` response. Not a file, not a route.
- Recorder scenes and icons are baked into the canvas. Store nothing; there is nothing to re-edit.

---

## What I did not check

Timing of a full 40-minute VP9 render or H.264 transcode on this box — the box has no 40-minute file,
and extrapolating from an 11-second one would be fiction. The CPU figures above are stated as
ranges, not measurements.

Risks the user must know: (1) `aselect` — if anyone implements cuts with it, the output has uncut
audio and correct video, and every existing check passes; (2) `drawbox` with a `t` expression —
silently a full-width bar; (3) `-f image2` onto a `.part` filename — silently a JPEG called a PNG.
