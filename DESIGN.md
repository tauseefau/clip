# Clip — a Loom-like async video tool (rough design)

Recon source: REA against the live Loom marketing site (CDP, headless Chrome 152).
Evidence: `ev_9b5733e8…` (screenshot), `ev_65ed0228…` (DOM + accessibility tree, 1636 nodes),
`ev_7c78e7bc…` (JS route inventory — marketing routes only; the app bundle is behind login).

## What Loom actually is (observed, not assumed)

Loom's own page taxonomy, read from the accessibility tree:

- **Record** — screen, webcam, meeting, mobile; Chrome extension + desktop + mobile apps.
- **Edit** — trim, cut, stitch, "edit like a pro".
- **Share** — link, embed anywhere, video library, video hosting.
- **Engage** — comments, reactions, viewer insights ("engage and connect with video").
- **Secure** — access control, "keep your content safe".
- **AI** — auto titles/summaries/chapters ("Loom AI").

The recorder UI itself is a Chrome extension, not a web page — the marketing site only
exposes a decorative recorder animation with three controls: **pause**, **cancel**, and a
timer. That is the whole visible recorder contract: *one floating bar, timer, pause, stop.*

## Product definition (MVP)

A single-user, self-hosted async video tool: record screen + camera in the browser, get a
link, share it, comment on it. No accounts, no teams, no AI.

**The one demo path that proves it:** open `/` → press Record → pick a screen → talk for
10s → pause → resume → stop → land on the watch page → copy link → open it in a second tab
→ leave a comment → see it persisted after reload.

## Architecture

```
browser (getDisplayMedia + getUserMedia + MediaRecorder)
   │  webm blob, one POST
   ▼
node:http server (zero deps)  ──►  data/clip.db (node:sqlite)
   │                                  recordings(id, title, created_at, duration_ms, size, mime)
   │                                  comments(id, recording_id, author, body, created_at)
   └──►  data/media/<id>.webm  (served with Range support so seeking works)
```

Boundary decisions:

- **No transcoding.** MediaRecorder emits WebM/VP8+Opus; every modern browser plays it.
  ffmpeg is only used for the duration probe, and even that is optional (client sends it).
- **No multipart.** The blob is the raw request body; metadata rides in headers. Removes a
  parser dependency and a whole class of bugs.
- **No framework.** Three static pages + one server file. A build step would cost more than
  it saves at this size.
- **Range requests are mandatory**, not a nicety: without them the `<video>` element cannot
  seek and the watch page feels broken.

## Information architecture

| Route | Purpose |
|---|---|
| `/` | Recorder: source picker, camera bubble, mic level, timer, pause/resume/stop |
| `/library` | Grid of recordings: thumbnail, title, duration, date, comment count |
| `/watch/:id` | Player, title, copy-link, download, comments thread |

## Design decisions as numbers

- Recorder bar: 56px tall, bottom-centre, 12px radius, `#111` at 92% opacity, white text.
- Camera bubble: 180px circle, bottom-right, 16px inset, draggable, 2px white ring.
- Timer: 15px tabular-nums, `mm:ss`, red dot pulsing at 1.2s when recording.
- Library grid: `repeat(auto-fill, minmax(280px, 1fr))`, 16:9 thumbnails, 16px gap.
- Watch page: max-width 960px, video 16:9, comments 14px/1.5, 8px vertical rhythm.
- Palette: `#0b0b0c` bg, `#f5f5f7` text, `#2f6bff` accent (Loom's blue, sampled from the
  hero CTA), `#1c1c1f` surfaces.

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/recordings` | raw webm | `{id, url}` |
| GET | `/api/recordings` | — | `[{id,title,duration_ms,created_at,size,comments}]` |
| GET | `/api/recordings/:id` | — | recording + comments |
| PATCH | `/api/recordings/:id` | `{title}` | updated |
| DELETE | `/api/recordings/:id` | — | `{ok}` |
| POST | `/api/recordings/:id/comments` | `{author, body}` | comment |
| GET | `/media/:id.webm` | — | video, Range-capable |

## Deliberately out of scope

Auth, teams, transcoding, thumbnails via ffmpeg, AI transcript, embeds, analytics,
mobile apps, desktop app, meeting recording. Each is a later phase; none is needed to
prove the loop.
