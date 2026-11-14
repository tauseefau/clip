# Clip — review for a YouTube podcaster (rich-content-developer view)

Reviewed 2026-11-08 against the running code (`server.js` 686 lines, `public/` 1,620 lines,
zero npm deps, ffmpeg bake at render time). Ranking by TypeSafe Jev, one typed score question
per candidate, `jev-latest`, 20 candidates / 7,571 input tokens.

## What the app can do today (verified in code, not from the README)

Capture
- Three capture modes chosen **once, before recording**: Screen / Screen+Cam / Cam only.
- 30 fps canvas composite: screen drawn full-frame, camera clipped to a 180px circle, draggable.
- Quality select (1080p / 720p / source), mic level meter, pause/resume, worker-driven ticker
  (survives tab switch), raw-WebM POST, retry + local save on upload failure.

Assemble (all baked by ffmpeg into a **new** recording, original preserved)
- Trim with mm:ss.s timecode entry, background colour, up to 20 draggable text overlays
  (3 fonts), 16:9 / 9:16 / 1:1 with pad-or-crop, PNG watermark (corner/size/opacity),
  burned-in captions (typed by hand), music bed with volume, speed 0.5–2×, loudnorm −14 LUFS,
  draft autosave to localStorage, source lineage, 3600s ceiling, SRT export.

Publish
- Watch page, comments, copy link, WebM download, cached MP4 transcode, server thumbnails.

## The gap, said plainly

This is a good **capture + polish** tool and a weak **assembly + publish** tool. A podcaster's
week is: record 40–60 min → remove dead air and mistakes → caption → cut 3 vertical clips →
thumbnail → chapters → upload. Clip covers the first step and the last 10% of the middle. The
hard part — deciding *what to remove* and *where the cuts are* — has no UI at all: one continuous
take, trim top and tail, and every caption typed by hand.

Three specific failures for the target user:

1. **Captions don't scale.** Burning captions is implemented well, but the editor asks you to
   type each line and set in/out by hand. For a 40-minute episode that is hours of work, which is
   why YouTube podcasters use auto-transcription. (No whisper binary on this box; that is a real
   dependency decision, not a code tweak.)
2. **No cutting inside the take.** Fumbles, "let me restart that", 8-second pauses: all still
   there unless the whole take is re-recorded. Trim only touches the ends.
3. **Recording is locked before it starts.** You pick Screen / Screen+Cam / Cam before pressing
   Record, and switching needs a full restart because the source is picked at `choose(mode)` and
   the canvas size is fixed at `start()`. Live scene switching — the ask — is a
   `drawFrame()` concern, not a capture concern: both streams are already open, only one is being
   drawn.

## Jev feature ranking (score 0–4, expected over level probabilities)

```
rank  expected  level             feature
1     3.040     high value        Cut editor: timeline with split markers, delete dead air
2     3.030     high value        Scene switching while recording (screen / screen+cam / cam)
3     3.030     high value        One-click silence removal
4     2.850     high value        Audio cleanup: noise removal + level matching
5     2.800     high value        Multi-camera: webcam + second angle, switch live
6     2.740     high value        Music auto-ducking under speech
7     2.630     high value        Camera background replacement (colour/image/blur)
8     2.590     high value        Export H.264 MP4 1080p (upload-ready)
9     2.460     useful            Auto speech-to-text captions
10    2.370     useful            Local Whisper + AI title/summary/chapters
11    2.350     useful            Teleprompter
12    2.320     useful            Waveform under preview
13    2.230     useful            Podcast preset templates (title bar, lower third, progress)
14    2.210     useful            Undo/redo + keyboard shortcuts
15    2.120     useful            Ken Burns on the screen layer
16    2.010     useful            Remote guest recording via link
17    1.980     useful            Thumbnail designer
18    1.930     useful            Animated subscribe/like/bell icons
19    1.930     useful            Progress bar / lower-third helpers
20    1.890     useful            Chapter markers → YouTube description
```

Read the numbers carefully: the spread is only 1.89–3.04, i.e. Jev considers nothing here a bad
idea, and the ordering within ±0.2 is noise, not a verdict. Two honest readings:

- **Nothing reached "make-or-break".** That is Jev saying Clip's value is not decided by any one
  of these; it is decided by whether the *assembly* story closes (cuts + captions + export).
- **The icons you asked for rank last (18).** Not because they are bad, but because a podcaster
  will tolerate a missing subscribe animation and will not tolerate losing 40 minutes to caption
  typing. They are also the cheapest thing on the list (canvas-drawn shapes, no ffmpeg work), so
  the right move is to build them anyway, last, as a toggle.

## Recommended scope (three increments, each independently shippable)

**A — live production in the recorder** (answers the explicit ask)
Scene switcher while recording (Screen / Screen+Cam / Cam / Title card), camera background
(preset colours + blur + uploaded image), and animated icon overlays (subscribe / like / bell /
arrow) triggered live, drawn on the same canvas that is already being captured. Everything is
`drawFrame()` work: no server route changes, no re-encode, and the recording is correct by
construction because the canvas is the recording.

**B — editing a real take** (the ranked top)
Split-and-delete on a timeline, silence detection with a one-click "remove dead air" preview,
waveform strip, undo/redo + shortcuts. All of it compiles down to a list of keep-ranges, which
the existing ffmpeg renderer can already express with `select`/`aselect` filters — so the render
path grows one option (`cuts: [[start,end],…]`) instead of a new pipeline.

**C — publish readiness**
H.264 MP4 export at chosen resolution (reuse the existing cached-transcode code), podcast preset
template (title bar + lower third + progress bar drawn by ffmpeg `drawbox`/`drawtext`), and
chapters. Auto-captions are deliberately **out** of this pass: they need whisper.cpp plus a model
(~1 GB) and a job queue (a 40-min transcript cannot run inside a held-open HTTP request), which
is a phase of its own, not an increment.

## Reviewer's verdict

Ship A and B. A closes the explicit ask and is genuinely low-risk; B is where the product earns
its keep. C's MP4 export is 30 lines because the transcode already exists. Skip remote guests —
that is a different product (a TURN/SFU stack), not a feature.
