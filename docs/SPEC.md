# Build task: "Clip" — a Loom-like async video tool

Read DESIGN.md in this directory first. It is the contract. Build exactly that, nothing more.

## Hard constraints

- Node.js 26, ESM (`"type": "module"`), **zero npm dependencies**. Use `node:http`, `node:fs`,
  `node:sqlite` (`import { DatabaseSync } from 'node:sqlite'`), `node:crypto`.
- No build step, no framework, no bundler. Plain HTML/CSS/JS served from `public/`.
- Port from `process.env.PORT || 3000`. Bind `0.0.0.0`.
- Data dir `./data` (create on boot): `data/clip.db`, `data/media/<id>.webm`.

## Files to create

1. `package.json` — name clip, type module, `"start": "node server.js"`.
2. `server.js` — the whole backend (~250 lines max).
3. `public/index.html` — recorder.
4. `public/library.html` — grid.
5. `public/watch.html` — player + comments.
6. `public/app.css` — shared styles (the numbers in DESIGN.md).
7. `README.md` — how to run, and the browser caveat below.

## Backend contract (exact)

- `POST /api/recordings` — body is the raw WebM bytes. Headers: `x-title` (string, may be
  empty), `x-duration-ms` (integer). Write to `data/media/<id>.webm`, insert row, return
  `201 {id, url}` where `url` is `/watch/<id>`.
- `GET /api/recordings` — newest first, each with `comments` count.
- `GET /api/recordings/:id` — recording + `comments` array.
- `PATCH /api/recordings/:id` — JSON `{title}`.
- `DELETE /api/recordings/:id` — delete row + file.
- `POST /api/recordings/:id/comments` — JSON `{author, body}`; reject empty body with 400.
- `GET /media/:id.webm` — **must support HTTP Range** (206 + `Content-Range`), `Accept-Ranges: bytes`,
  `Content-Type: video/webm`. 404 for unknown id.
- `GET /watch/:id` serves `public/watch.html`; `GET /library` serves `public/library.html`;
  `GET /` serves `public/index.html`; other `/public` assets served by extension.
- Reject uploads over 500 MB with 413. Sanitise ids to `[a-z0-9-]` before touching the filesystem.

## Recorder behaviour (public/index.html)

- Buttons: **Screen**, **Screen + Cam**, **Cam only**. Each calls `getDisplayMedia` and/or
  `getUserMedia({video,audio})` as appropriate; mic audio always requested.
- Compose the recording with a `<canvas>`: screen video drawn full-frame, camera drawn as a
  180px circle bottom-right (per DESIGN.md). `canvas.captureStream(30)` + the mic
  `MediaStreamTrack` → `MediaRecorder` (`video/webm;codecs=vp9,opus`, fall back to `vp8`).
- Floating bar: timer `mm:ss`, pause/resume, stop, cancel. Pause must pause the MediaRecorder
  and freeze the timer.
- On stop: POST the blob, then `location.href = '/watch/' + id`.
- Show a clear error if the user denies permission or the browser lacks `getDisplayMedia`.
- Camera bubble must be draggable with the mouse before recording starts.

## Library + watch

- Library: fetch `/api/recordings`, render cards. Thumbnail = a `<video preload="metadata">`
  seeked to 1s, drawn to a canvas once, used as the card image (no server thumbnails).
- Watch: `<video controls>` pointing at `/media/<id>.webm`, title (inline-editable via PATCH),
  copy-link button, download link, delete button, comments list + form (author defaults to
  "Guest", remembered in localStorage).

## Style

Dark UI per DESIGN.md numbers. No CSS framework. System font stack. Must look intentional,
not default-browser: rounded surfaces, subtle borders `#26262b`, hover states, focus rings.

## VERIFY BEFORE YOU FINISH

Run these and fix anything that fails. Do not report success without their output.

1. `node --check server.js` → no output.
2. `PORT=3111 node server.js &` then:
   - `curl -s -o /dev/null -w '%{http_code}' localhost:3111/` → `200`
   - `curl -s -o /dev/null -w '%{http_code}' localhost:3111/library` → `200`
   - `head -c 200000 /dev/urandom > /tmp/fake.webm; curl -s -X POST localhost:3111/api/recordings -H 'x-title: smoke test' -H 'x-duration-ms: 4200' --data-binary @/tmp/fake.webm` → JSON with an `id`
   - `curl -s localhost:3111/api/recordings` → array containing "smoke test"
   - `curl -s -D- -o /dev/null -H 'Range: bytes=0-99' localhost:3111/media/<id>.webm` → `206` and a `Content-Range` header
   - `curl -s -X POST localhost:3111/api/recordings/<id>/comments -H 'content-type: application/json' -d '{"author":"QA","body":"hello"}'` → comment JSON
   - `curl -s localhost:3111/api/recordings/<id>` → comments array length 1
   - `curl -s -X DELETE localhost:3111/api/recordings/<id>` → `{"ok":true}`
3. Kill the server. Report the exact command output for each step.

## EXECUTION DIRECTIVE

Write files in this order, one at a time, checking `node --check` after server.js:
package.json → server.js → public/app.css → public/index.html → public/library.html →
public/watch.html → README.md. Do not attempt one giant response.
