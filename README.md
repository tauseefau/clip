# Clip

A self-hosted, single-user async video tool: record your screen and camera in the browser, get a
link, share it, comment on it. See `DESIGN.md` for the product definition.

## Install

**Docker (any OS, including Windows):**

```sh
git clone https://github.com/tauseefau/clip.git && cd clip
CLIP_TOKEN=$(openssl rand -hex 16) docker compose up -d
docker compose logs | grep listening        # then open http://localhost:3001/?token=<your token>
```

The token is asked for once per browser. Recordings are kept in `./data`.

**Without Docker (Linux, macOS, or Windows through WSL):** install Node.js 24 or newer and
ffmpeg (`sudo apt install ffmpeg` or `brew install ffmpeg`), then:

```sh
git clone https://github.com/tauseefau/clip.git && cd clip
./install.sh           # checks Node and ffmpeg, creates ./data
npm start              # http://localhost:3000
PORT=8080 npm start    # choose another port
```

There are no npm packages to install. Fonts for captions and text ship in `fonts/` (DejaVu,
under its own free licence in `fonts/LICENSE-DejaVu.txt`). Native Windows is untested: use
Docker or WSL. Record in desktop Chrome, Edge or Firefox (see *Browser caveat* below).

Optional: AI dubbing needs a VoiceStudio server (`VOICE_STUDIO_URL`, `VOICE_STUDIO_KEY`).
Everything else works without it.

## Drawing and zooming while you record

The **Draw** row under the preview (and these keys) mark up the take live. Everything is baked into
the recording, and you draw on Clip's preview, not on the app you are sharing.

| Key | Tool |
|-----|------|
| H / R / P | Highlight box, arrow, freehand pen: drag on the preview |
| T / N | Text, or a boxed comment: click where it goes and type. Enter adds a line, Esc finishes |
| Z | Zoom 2x to the mouse; the view follows the mouse, the wheel changes the level (1.25x to 5x) |
| O | Spotlight: drag over an area; everything else dims |
| M | Step: each click drops the next numbered marker (1, 2, 3…) |
| Ctrl+Z / C | Undo the last mark / clear all |
| Esc | Leave the tool, then the zoom |

Marks zoom with the picture, and the view holds still while a tool is active so you can draw on a
zoomed area. The colour swatches set the ink for the next arrow, pen stroke, text or comment.
Tick **Fade marks after 5 s** to have marks clear themselves. Marks are hidden on the Title scene.

**Sound and devices.** To record what the shared tab or computer is playing, tick the browser's
"share audio" box in the screen picker; it is mixed with the microphone. The **Devices** row picks
the microphone and camera (remembered for next time) and works mid-take. Start runs a 3-2-1
countdown unless you untick **Countdown**.

`test/verify-annotate.mjs` checks the drawing tools in headless Chromium (needs `playwright-core`).

## Editing

The Edit button on a watch page opens `/edit/:id`: trim, background colour, and draggable text
overlays, plus Format, Watermark, Captions, Music and Speed. Render bakes all of it into a new
`<title> (edited)` recording; the original stays.

- **Format** is 1920x1080, 1080x1920 or 1080x1080. The API default is 16:9, so renders are 1920x1080.
- **Text overlay sizes** are pixels on a 1280-wide frame and scale to the output, so a layout keeps
  its proportions across formats.
- **Cuts** are the ranges of the trimmed clip you keep: split at the playhead, then remove the piece
  you don't want. "Remove silence" fills the list from the audio (threshold 20 dB under the file's
  peak, pauses of 0.7 s or more, 150 ms of air left beside every word); review it before rendering.
  The API takes `cuts` as `[[start, end], …]` in seconds from the trim start; leaving it out keeps
  the whole trim. Undo/redo is Ctrl+Z / Shift+Ctrl+Z; I and O set the trim to the playhead.
- **Caption times** are seconds into the *edited* clip, after trim and cuts and before any speed
  change. Removing a stretch shifts every later caption's time down by its length; a caption on a
  word stays on that word at 1.5×. A row's "Use current time" fills start, then end.
- **Text timing**: a text overlay's **Show** from/to fields limit it to part of the clip; blank keeps it
  up throughout. Times are seconds into the edited clip, like captions.
- **Zoom** punches in on a point for a stretch of the clip, easing in and out over 0.4 s. Add one at
  the playhead, then click the video to set the point. It zooms the picture only (text and captions
  stay put), and with Crop to fill it decides which part of the picture a Short keeps. A render with
  zooms is resampled to a steady 30 fps. API: `zooms: [{start, end, level, x, y}]`, x/y 0..1.
- **Caption style** is one choice per render: black box, outline or yellow highlight; small, medium
  or large; bottom, middle or top. API: `captionStyle: {look, size, position}`.
- **Loudness** is measured first and then corrected (two passes, with a light compressor), which
  lands speech within about 1 LU of -14 LUFS.
- **Watermark and music** are stored in `data/brand/` and shared by every recording. An uploaded
  watermark goes on every render until you remove it. Music is mixed under the original audio,
  which stays at full level, and is not previewed.

- **Rendering needs** `ffmpeg` 6.1+ with libvpx-vp9, libopus and drawtext, plus `ffprobe` and the DejaVu
  fonts in `/usr/share/fonts/truetype/dejavu` (`fonts-dejavu-core` on Debian/Ubuntu).
- **Background only shows in letterbox bars.** A 16:9 recording fills the frame, so there are none.

## Publishing to YouTube

Clip does not call the YouTube API (no OAuth client is bundled). Instead, the watch page's
**Upload package** button downloads a zip containing:

- the rendered video (MP4 when a cached transcode exists, otherwise WebM, which YouTube accepts),
- `thumbnail.jpg` at 1280×720,

The watch page's **Thumbnail headline** box draws big outlined text on the Thumbnail and Shorts
thumbnail downloads (`?text=` on the API). The package's own thumbnail stays a plain frame.

- `description.txt` with chapter timestamps derived from the captions,
- `captions.srt` when the clip has captions.

For Shorts, render at 9:16 and use the **Shorts thumbnail** button (1080×1920). Then upload the
contents of the zip through YouTube Studio. The **Metadata** button downloads just the
description text if you want to paste chapters by hand.
- **Rendering holds the request open** and is slow for long clips; keep the tab open until it lands
  on the new watch page.

## Dubbing

The editor's **Dub** section re-voices a clip in another language (es, hi, ur, ar, fr, de, pt, it)
or the same one, through a local [VoiceStudio](http://localhost:3000) (OmniVoice): upload →
transcribe → translate (Argos, local; packs install on demand) → generate speech → mix into a new
`<title> — ES dub` recording. The original is untouched.

```sh
VOICE_STUDIO_URL=http://localhost:3000   # default
VOICE_STUDIO_KEY=<bearer token>          # required; without it /api/dub/* answers 503
```

Supply the key through the environment (e.g. a systemd `EnvironmentFile` outside the repo); never
commit it.

- **Cost:** on a 4 GB GTX 1650 Ti, generation takes roughly a minute of GPU time per minute of
  audio (≈45 s for a 7 s clip, mostly fixed overhead). Clips are limited to 60 minutes.
- **Jobs are in memory.** They survive a closed tab (the editor resumes polling on reload) but not a
  Clip restart: a restart forgets every running and finished job, and a dub in flight is lost.
- API: `POST /api/recordings/:id/dub {targetLang, sourceLang="en"}` → `202 {jobId}`;
  `GET /api/dubs/:jobId` → `{state, step, error?, recordingId?, url?}`;
  `GET /api/dub/languages` → the eight targets with `installed` per Argos pack.

## Agents

`bin/clip` (CLI) and `bin/clip-mcp` (MCP server) are plain clients of the HTTP API above, with no
dependencies. Both read `CLIP_URL` (default `http://localhost:3001`) and `CLIP_TOKEN` (sent as
`x-clip-token` when set).

```sh
bin/clip ls                                   # id, duration, date, comments, title
bin/clip upload take.webm --title "Demo"      # probes duration with ffprobe
bin/clip render <id> --trim 0-30 --cuts "0-4,8-12" --aspect 9:16 \
  --text "Hello|0.5|0.85|64|#fff|bold"        # prints the new id and watch URL
bin/clip silence <id>                         # proposed keep-ranges for --cuts
bin/clip dub <id> --into es --wait            # step lines on stderr, watch URL on stdout
bin/clip get <id> --json                      # --json on any command prints raw API JSON
```

Errors go to stderr with exit 1; bad flags exit 2. `render` holds until ffmpeg finishes, and
dubbing costs about a minute of GPU time per minute of audio.

**Claude Code:** `claude mcp add -s user clip -- /path/to/clip/bin/clip-mcp`; add
`-e CLIP_URL=http://host:port` to point somewhere other than port 3001.

**Hermes:** add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  clip:
    command: /path/to/clip/bin/clip-mcp
    env:
      CLIP_URL: http://localhost:3001
```

Tools: `list_recordings`, `get_recording`, `upload_recording`, `render_recording`, `detect_silence`,
`dub_recording`, `add_comment`, `delete_recording`, `save_to_drive` (the server has no Drive route
yet, so it returns an error). `test/verify-agent.sh` checks both clients against a running server.

## Browser caveat

Recording needs `getDisplayMedia`, `getUserMedia` and `MediaRecorder` with WebM output.

- **Use desktop Chrome, Edge or Firefox to record.** Safari's `MediaRecorder` does not produce WebM,
  and mobile browsers have no `getDisplayMedia`, so both show an error instead of recording.
- **Browsers only allow capture on `https://` or `localhost`.** The server speaks plain HTTP, so
  opening it at `http://<lan-ip>:3000` lets people watch and comment but not record. Put it behind
  a TLS proxy to record from another machine.
- **Seeking needs a metadata scan.** `MediaRecorder` writes no duration into WebM, so the watch page
  briefly seeks to the end on load to find it.

## Security

By default the server listens on `127.0.0.1` only, so nothing else on the network can reach it.
To share it (`HOST=0.0.0.0`, which the Docker setup uses), Clip refuses to start without
`CLIP_TOKEN`; every visitor then needs `?token=<it>` once. Anyone with the token can view, upload,
rename and delete recordings, so treat it like a password and put a TLS proxy in front before
exposing it to the internet.
