# Build task: add a Canva-style editor to Clip

Read DESIGN.md and the existing code first. This is an addition, not a rewrite. Keep the
zero-dependency rule (`node:http`, `node:sqlite`, `node:fs`, `node:child_process` only).

## What to add

A post-recording editor at `/edit/:id` with the four Canva-ish controls that matter for a
screen recording, and a server-side render that bakes them in.

### Editor UI (`public/edit.html`, new)

- `<video>` preview of `/media/:id.webm`, 16:9, max-width 960px.
- **Trim**: two range inputs (start / end, seconds, step 0.1) with a live readout. Preview
  seeks to `start` when start changes.
- **Background**: colour swatches (6 presets + `<input type=color>`) that fill the letterbox
  area around the video. Preview shows it as the page area behind the video.
- **Text overlays**: "Add text" button appends an overlay. Each overlay is a draggable div
  positioned over the video (percentage coordinates), with controls for: text, font size
  (16–96), colour, bold toggle, font family (Sans / Sans Bold / Serif). Click to select,
  Delete/Backspace or a ✕ button removes it. Dragging must work with pointer events and stay
  inside the video bounds.
- **Render** button → POSTs the edit, shows a spinner, then navigates to the new `/watch/:id`.
- A "Cancel" link back to `/watch/:id`.

### Server

- `POST /api/recordings/:id/render` — JSON body:
  ```json
  {"trim":{"start":0.0,"end":6.0},"background":"#0b0b0c",
   "overlays":[{"text":"Hello","x":0.5,"y":0.8,"size":48,"color":"#ffffff","bold":true,"font":"sans"}]}
  ```
  `x`/`y` are 0–1 fractions of the frame (centre of the text box).
- Validate: `end > start`, `end - start <= 600`, at most 20 overlays, text ≤ 200 chars,
  size 8–200, colour matches `^#[0-9a-fA-F]{6}$`, font in `sans|sans-bold|serif`.
  Reject with 400 and a message.
- Render with ffmpeg to a **new** recording: new uuid, file `data/media/<newid>.webm`,
  title `<original title> (edited)`, duration = trimmed length, insert row, return
  `201 {id, url}`.
- ffmpeg command shape (adapt as needed, but keep these properties):
  - `-ss <start> -to <end>` before `-i` for a fast trim.
  - `scale=1280:720:force_original_aspect_ratio=decrease`, then
    `pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=<background>`.
  - one `drawtext` per overlay: `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`
    (or `DejaVuSans-Bold.ttf` / `DejaVuSerif.ttf`), `textfile=<temp file>` (never inline the
    text — escaping), `fontsize`, `fontcolor`, `x=(w-text_w)*<x>`, `y=(h-text_h)*<y>`,
    `box=1:boxcolor=black@0.35:boxborderw=12`.
  - output `-c:v libvpx-vp9 -crf 32 -b:v 0 -c:a libopus` to the new `.webm`.
  - Write overlay text to temp files under `data/tmp/`, delete them after the run.
  - On ffmpeg failure: delete the partial file, return 500 `{error:"Render failed"}`.
- Add an **Edit** button on the watch page linking to `/edit/:id`.
- Route `GET /edit/:id` serves `public/edit.html`.

## Style

Match the existing dark UI in `public/app.css`. Reuse its classes where they fit; add new
ones at the end of the file. No new dependencies, no inline `<style>` blocks.

## VERIFY BEFORE YOU FINISH

Run these, fix failures, and paste the real output:

1. `node --check server.js`
2. Start on `PORT=3112`. Upload a 6s test clip:
   `ffmpeg -y -f lavfi -i testsrc=size=1280x720:rate=30:duration=6 -f lavfi -i sine=frequency=440:duration=6 -c:v libvpx-vp9 -b:v 500k -c:a libopus /tmp/t.webm`
   then POST it to `/api/recordings`.
3. POST a render with `trim {start:1,end:4}`, background `#1b1b3a`, and two overlays
   ("Hello world" at 0.5/0.15 size 64 bold, "clip.demo" at 0.5/0.9 size 32).
   Expect `201` and a new id.
4. `ffprobe` the new file: duration ≈ 3.0s, 1280x720, vp9+opus.
5. Extract a frame at 1s (`ffmpeg -ss 1 -i <file> -frames:v 1 /tmp/frame.png`) and confirm
   with `python3 -c` that the top-left pixel is the background colour (not black) — i.e. the
   pad colour was applied.
6. `curl -s -o /dev/null -w '%{http_code}' localhost:3112/edit/<id>` → 200.
7. Bad input: `end < start` → 400; 21 overlays → 400.
8. Kill the server.

## EXECUTION DIRECTIVE

Order: server.js changes → public/edit.html → app.css additions → watch.html Edit button →
README note. Check `node --check` after server.js. Do not rewrite existing working code.
