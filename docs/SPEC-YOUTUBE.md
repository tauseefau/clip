# Build task: make Clip usable for a YouTube channel

Read DESIGN.md, SPEC-EDITOR.md and the current code first. Extend, do not rewrite. Zero npm
dependencies stays (`node:http`, `node:sqlite`, `node:fs`, `node:child_process`).

Five features, all baked in at render time by ffmpeg. Everything else stays as it is.

## 1. Watermark (channel logo)

- `POST /api/brand/watermark` — raw PNG body (≤ 5 MB, must start with the PNG magic bytes).
  Save to `data/brand/watermark.png`. Return `{ok:true}`.
- `GET /api/brand/watermark` — serve it (`image/png`), 404 if none.
- `DELETE /api/brand/watermark` — remove it.
- Render options: `watermark: {corner: "tl"|"tr"|"bl"|"br", size: 0.05-0.30, opacity: 0.1-1, margin: 0-0.1}`
  where `size` is a fraction of output width and `margin` a fraction of output width.
  Omit or `null` = no watermark. If a watermark is requested but no file exists → 400.

## 2. Aspect presets (Shorts / long-form / square)

- Render option `aspect: "16:9" | "9:16" | "1:1"`, default `"16:9"`.
- Output sizes: 1920x1080, 1080x1920, 1080x1080. Scale to fit, pad with the background colour.
- The editor must show the preview at the chosen aspect (CSS `aspect-ratio`), and overlay
  positions stay fractional so they survive the change.

## 3. Captions (CapCut's signature feature)

- Render option `captions: [{start, end, text}]` — seconds relative to the **trimmed** clip.
- Max 100 captions, `0 <= start < end <= trimmed length`, text 1–200 chars.
- Burned in with `drawtext` + `enable='between(t,start,end)'`, centred horizontally, 8% from
  the bottom, white with a black box, font size scaled to output height (≈ 4.5% of height).
- Editor: a "Captions" section with rows of [start] [end] [text] and an "Add caption" button.
  A "Use current time" button per row fills start/end from the video's currentTime.

## 4. Music bed

- `POST /api/brand/music` — raw audio body (≤ 20 MB, mp3/m4a/wav/ogg by magic bytes or
  extension header), saved as `data/brand/music/<uuid>.<ext>`, returns `{id, name}`.
- `GET /api/brand/music` — list `[{id, name, size}]`; `GET /api/brand/music/:id` — the file.
- `DELETE /api/brand/music/:id`.
- Render option `music: {id, volume: 0-1}` — looped/trimmed to the clip length, mixed under
  the original audio with `amix` (original stays at full level). Missing id → 400.

## 5. Speed

- Render option `speed: 0.5-2.0`, default 1. `setpts=PTS/speed` for video and `atempo` for
  audio (chain two `atempo` filters if you ever need >2, but the range is capped at 2).
- Trim start/end are in **source** seconds; the output duration is `(end-start)/speed`.
  Store that as the recording's duration.

## Editor UI

Add a right-hand panel (or stacked sections under the existing controls) with: Format
(3 aspect buttons), Watermark (upload, corner 2x2 picker, size slider, opacity slider,
remove), Captions (rows), Music (upload, select, volume slider, remove), Speed (slider
0.5–2.0 with readout). Keep the existing trim/background/text sections working.

The preview must reflect aspect + background + text overlays + captions (as a static
approximation) + watermark position. It does not need to play music.

## Validation

Every new field is validated server-side with a 400 and a clear message. Reject unknown
`aspect`, out-of-range numbers, non-array captions, captions past the trimmed length, and a
watermark/music reference that does not exist. Never interpolate user text into a filter
string — keep using `textfile=` for captions and overlays.

## VERIFY BEFORE YOU FINISH

Run all of these and paste the real output:

1. `node --check server.js`
2. Start on `PORT=3113`. Create a 6s 1280x720 test clip and upload it.
3. Upload a 200x80 PNG watermark (generate one with ffmpeg `color` + `drawtext`, or python).
4. Upload a 6s sine-wave mp3 as music.
5. Render with: `aspect:"9:16"`, `background:"#101020"`, `speed:1.5`, `trim {0,6}`,
   `watermark {corner:"br", size:0.2, opacity:0.8, margin:0.03}`,
   `captions [{start:0.5,end:2.5,text:"First caption"}]`, `music {id, volume:0.3}`.
   Expect 201.
6. `ffprobe` the result: 1080x1920, duration ≈ 4.0s (6/1.5), has an audio stream.
7. Extract a frame at 1s and assert with python: the bottom-right region contains non-background
   pixels (watermark present) and the top area is the background colour (letterbox).
8. Assert the caption is visible: compare a frame at 1s against a frame at 3.5s (after the
   caption ends) — they must differ in the lower-middle band.
9. Bad input: `aspect:"4:3"` → 400; `speed:3` → 400; caption ending past the clip → 400;
   watermark requested with no file uploaded → 400.
10. Kill the server.

## EXECUTION DIRECTIVE

Order: server.js (routes + validation + ffmpeg) → public/edit.html → app.css → README.
Check `node --check` after server.js. Keep the existing render path working for edits that
use none of the new options.
