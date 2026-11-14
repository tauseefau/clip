# Build task: harden Clip for real weekly use

An external review ranked 16 problems. Fix the ones below, in this order. Keep zero npm
dependencies and the existing behaviour for everything not listed. Do not rewrite working code.

## 1. MP4 cache corruption (blocker)

`serveMp4` writes straight to the cache path with no lock. Two concurrent downloads of an
uncached clip spawn two ffmpeg processes on the same output and the corrupt file is served
forever.

Fix: transcode to `<id>.mp4.part`, then `rename` to `<id>.mp4` (atomic on the same fs). Keep a
per-id in-flight promise map so a second request awaits the first instead of spawning ffmpeg.
On failure delete the part file and return 500.

## 2. Uploads are not validated (blocker)

`createRecording` trusts the client. Fix: after writing the temp file, run `ffprobe` and require
at least one video stream; take the real duration from ffprobe (fall back to `x-duration-ms`
only if the probe has no duration). Reject non-video with 400 and delete the temp file. Cap
`x-duration-ms` at 4 hours.

## 3. Network exposure (blocker)

Bind `127.0.0.1` by default (`HOST` env to override). If `HOST` is not a loopback address,
require `CLIP_TOKEN` to be set or refuse to start with a clear message. When `CLIP_TOKEN` is
set, every request must carry it as `?token=`, an `x-clip-token` header, or the `clip_token`
cookie; the UI stores it in localStorage and appends it to fetches. Keep the existing
`Sec-Fetch-Site` check.

## 4. Editor work is lost on reload (blocker)

Persist the whole edit form (trim, background, overlays, captions, aspect, speed, watermark
settings, music id) to `localStorage` under `clip:draft:<id>` on every change (debounced 300ms),
restore it on load, and clear it after a successful render. Show a small "Draft restored" note
when a draft was applied.

## 5. 600-second ceiling (blocker)

Raise the server limit to 3600 seconds and remove the editor's 600s clamp. If the clip is longer
than 3600s, the editor must say so instead of silently truncating.

## 6. Trim needs timecode entry (blocker)

Add `mm:ss.s` text inputs next to both trim sliders, two-way bound (typing updates the slider and
the preview; dragging updates the text). Invalid input reverts to the previous value.

## 7. Shorts crop instead of letterbox (blocker)

Add render option `fit: "pad" | "crop"` (default `"pad"`). `crop` uses
`scale=<w>:<h>:force_original_aspect_ratio=increase` + `crop=<w>:<h>` so a 16:9 source fills a
9:16 frame. Expose it in the editor as a two-button toggle next to the aspect buttons, and make
the preview reflect it (`object-fit: cover` vs `contain`).

## 8. SRT export (blocker)

`GET /api/recordings/:id/captions.srt` — 404 if the recording has no stored captions. Store the
captions JSON on the recording row at render time (new nullable `captions` TEXT column, migrate
with `ALTER TABLE ... ADD COLUMN` guarded by a `PRAGMA table_info` check). Emit standard SRT with
`HH:MM:SS,mmm` timings. Add a "Download SRT" button on the watch page when captions exist.

## 9. Render lineage (nice-to-have)

Add nullable `source_id` and `edit` (JSON) columns to `recordings`. On render, store the source id
and the validated edit. Title becomes `<source title> — <aspect> <speed>x` (no repeated
"(edited)"), truncated to 120 chars. Show "from <source title>" on the watch page when
`source_id` is set.

## 10. Title cap (nice-to-have)

`cleanTitle` slices to 200 chars. PATCH rejects titles over 200 with 400.

## 11. Loudness normalisation (nice-to-have)

Add render option `normalize: true` (default true for new renders). Apply
`loudnorm=I=-14:TP=-1.5:LRA=11` to the final audio mix. Expose a checkbox "Normalise to -14 LUFS"
in the editor, default on.

## 12. Recorder quality controls (nice-to-have)

In the recorder, add a quality select (1080p / 720p / source) and set
`videoBitsPerSecond` (8 Mbps for 1080p, 4 Mbps for 720p, 6 Mbps for source). Downscale the
canvas to the chosen height, preserving aspect. Default 1080p.

## 13. Server-side thumbnails (nice-to-have)

`GET /media/:id.jpg` — generate once with ffmpeg (`-ss 1 -frames:v 1 -vf scale=640:-2`) into
`data/media/<id>.jpg`, cache, serve `image/jpeg`. Library uses it as the card image with the
existing client-side canvas as fallback on error.

## VERIFY BEFORE YOU FINISH

Run all of these and paste the real output:

1. `node --check server.js`
2. Start on `PORT=3122`. Upload a real 6s clip → 201. Upload a PNG as a recording → 400.
3. Two parallel `curl -o /tmp/a.mp4` and `/tmp/b.mp4` for the same uncached id → both 200,
   identical `sha256sum`, and `ffmpeg -v error -i /tmp/a.mp4 -f null -` prints nothing.
4. Render with `fit:"crop"`, `aspect:"9:16"` → frame at 1s has no background-coloured border
   (sample the top-centre and bottom-centre pixels; they must not equal the background colour).
5. Render with captions → `GET /api/recordings/<newid>/captions.srt` returns 200 and valid SRT
   (`1\n00:00:00,500 --> 00:00:02,500\nFirst caption`).
6. Render twice from the same source → titles differ by aspect/speed, `source_id` set, no
   "(edited) (edited)".
7. `PATCH` a 500-char title → 400. `PATCH` a 200-char title → 200.
8. `HOST=0.0.0.0 node server.js` with no `CLIP_TOKEN` → exits with a clear error.
9. `GET /media/<id>.jpg` → 200 `image/jpeg`, and a second call is served from cache.
10. Kill the server.

## EXECUTION DIRECTIVE

Order: server.js (schema migration, upload validation, mp4 lock, auth/host, render options,
srt, thumbnails) → edit.html (draft, timecode, fit toggle, normalize, quality) → index.html
(quality) → library.html (thumbnails) → watch.html (SRT button, lineage) → README.
`node --check` after server.js. Keep every existing endpoint working.
