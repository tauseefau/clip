# Build task: dubbing through the local VoiceStudio API

Read REVIEW.md and the current code first. Extend, do not rewrite. Zero npm dependencies stays
(`node:http`, `node:sqlite`, `node:fs`, `node:child_process`). No new npm packages.

VoiceStudio (OmniVoice 0.5.7) is already running on this machine at `http://localhost:3000` with a
CUDA GTX 1650 Ti (4 GB VRAM), OmniVoice TTS (600+ languages) and faster-whisper ASR. Its dubbing
pipeline was exercised end to end by hand; the exact contract below is measured, not guessed.

Config (read at request time, never default in code to a secret):

```
VOICE_STUDIO_URL   default http://localhost:3000
VOICE_STUDIO_KEY   bearer token; if unset, /api/dub/* answers 503 "VoiceStudio is not configured"
```

## VoiceStudio contract (verified)

All calls: `Authorization: Bearer <VOICE_STUDIO_KEY>`.

1. `POST {VS}/dub/upload` — multipart (`-F video=@file -F input_type=video -F source_lang=en`).
   Returns **202** `{job_id, task_id, filename}`. Accepts the `.webm` directly.
2. `POST {VS}/dub/transcribe/{job_id}` — no body. **Synchronous**, returns
   `{job_id, segments:[{id,start,end,text,words[],speaker_id}], full_transcript, source_lang}`.
3. `POST {VS}/dub/translate` — JSON `{segments:[{id,start,end,text,speaker_id}], target_lang,
   source_lang, provider:"argos", job_id}`. Returns `{translated:[{id,text,plan}], target_lang}`.
   `provider:"argos"` is the **local, free** engine (the default `google` web endpoint returns
   "TooManyRequests" per segment, with HTTP 200 — check for per-segment `error`).
   Argos needs a language pack per pair; `POST {VS}/engines/translation/argos/packs/status`
   `{source_lang,target_langs:[…]}` → `{pairs:[{source_lang,target_lang,installed}]}`, and
   `…/packs/install` with the same body installs (≈4 s when cached). Install on demand before
   translating; treat a failure as a job error, not a silent pass.
4. `POST {VS}/dub/generate/{job_id}` — JSON `{segments, language, language_code, timing_strategy,
   overflow_budget_s}`. Returns `{task_id}` **immediately**; poll
   `GET {VS}/jobs/{task_id}` → `{status: running|done|failed, error}`.
   **`timing_strategy` must be `"smart_fit"` with `overflow_budget_s: 2.0`.** The default
   `"concise"` fails with `The speech does not fit its time slot` whenever the translation runs
   longer than the source — measured on a 7 s clip.
   Measured cost: ≈45 s of GPU for 7 s of speech.
5. `GET {VS}/dub/download-mp3/{job_id}` → `audio/mpeg`, the dubbed track at the source length
   (7.128 s for a 7.128 s clip). `GET {VS}/dub/download/{job_id}` → a full MP4 (not used).

## Server

New routes, all JSON:

- `POST /api/recordings/:id/dub` body `{targetLang, sourceLang = "en"}` →
  **202** `{jobId}`. Reject with 400 for an unknown language code, a clip longer than 60 minutes
  (message names the limit), or a missing recording (404).
- `GET /api/dubs/:jobId` → `{state, step, error?, recordingId?, url?}` where `state` is
  `queued|running|done|error` and `step` is `upload|transcribe|translate|generate|mux|done`.
- `GET /api/dub/languages` → `{languages:[{code,name,installed}]}` for the eight codes
  `es,hi,ur,ar,fr,de,pt,it` (names in the response; `installed` from the Argos pack status for the
  current source language). If VoiceStudio is unreachable, return the list with
  `installed:false` and a `warning` string — the UI must still render.

Jobs live in a module `Map` (single-user, in-memory; a restart loses them — say so in a comment
and in README). Run the pipeline as an async function that updates `{state, step}` as it goes:

1. **upload** — stream `data/media/<id>.webm` to `/dub/upload` as multipart. Build the multipart
   body yourself (boundary + CRLF, one file part) — no dependency.
2. **transcribe** — `POST /dub/transcribe/<job>`; keep `segments` and `source_lang`.
3. **translate** — skip when `targetLang === sourceLang` (same-language re-voice). Otherwise
   ensure the Argos pack, then translate. If any segment comes back with `error` or empty text,
   fail the job with that message.
4. **generate** — build segments `{id,start,end,text,speaker_id}` from the translated text using
   the source segment times, then `POST /dub/generate/<job>` with `language` (English name),
   `language_code`, `timing_strategy:"smart_fit"`, `overflow_budget_s:2`. Poll `/jobs/<task_id>`
   every 3 s for up to 45 minutes; on `failed` surface VoiceStudio's `error` verbatim.
5. **mux** — `GET /dub/download-mp3/<job>` to `data/tmp/<uuid>.mp3`, then
   `ffmpeg -i <source.webm> -i <dub.mp3> -map 0:v:0 -map 1:a:0 -c:v copy -c:a libopus` →
   `data/media/<newid>.webm`. Longest stream wins (`-shortest` is wrong when the dub is longer:
   use `-shortest` **after** `-map`, and check the duration is within ±2 s of the source; if not,
   fail the job rather than storing a truncated file).
6. Insert the row: title `<source title> — <CODE> dub` (truncated to 120 chars), duration from
   `ffprobe`, `source_id` = source id, `edit` JSON `{"dub":{"lang":"es","vsJob":"96a38563"}}`.
   Return `done` with `recordingId` and `url: "/watch/<newid>"`.

Timeouts on every fetch (`AbortSignal.timeout`): 120 s for upload/transcribe/translate, 300 s for
the mp3 download. A fetch that times out or returns non-2xx becomes a job `error` with the
response body's `detail`/`error` text — never a hang and never a silent success.

## Editor UI

A "Dub" section at the end of the control panel in `public/edit.html`:

- A language `<select>` filled from `GET /api/dub/languages` (show only `installed` ones, plus a
  "same language (re-voice)" option), a **Dub clip** button, and a status line.
- Poll `GET /api/dubs/<jobId>` every 2 s; show the step as text
  ("Transcribing…", "Translating…", "Generating Spanish speech… — about a minute per minute of
  audio on this GPU", "Mixing…").
- On `done`, show "Dubbed: watch it" linking to the returned URL.
- Persist `{jobId, recordingId}` in `localStorage` under `clip:dub:<id>` so a reload resumes
  polling instead of orphaning the job.
- One short note under the button: "Dubbing runs on this machine's VoiceStudio (4 GB GPU): about
  one minute of processing per minute of audio, and it keeps going if you close the tab."
- Keep it visually consistent with the existing sections; no new CSS framework, add rules at the
  end of `public/app.css`.

## Constraints

- Do not change any existing route, render option or validation. `cuts`, `render`, `silence`,
  `waveform` all keep working.
- Never log or return `VOICE_STUDIO_KEY`.
- Do not put the key in the repo. It will be supplied through a systemd `EnvironmentFile` outside
  the repo; the code only reads `process.env`.

## VERIFY BEFORE YOU FINISH

Run these and paste the real output. VoiceStudio is slow, so allow minutes.

1. `node --check server.js` → no output; editor module parses (`node --check /tmp/edit.mjs`).
2. Start on `PORT=3141` **with** `VOICE_STUDIO_URL=http://localhost:3000` and
   `VOICE_STUDIO_KEY=<read it from the running container: docker inspect voicestudio …Env>`.
   Never print the key in the transcript — export it in the shell and echo only its length.
3. Build a speech clip and upload it:
   `curl -s -X POST localhost:3000/v1/audio/speech -H "Authorization: Bearer $K" -H 'content-type: application/json' -d '{"model":"omnivoice","input":"Hello and welcome back to the show. Today we are talking about cutting dead air.","voice":"default"}' -o /tmp/tts.mp3`
   then `ffmpeg -f lavfi -i "color=c=0x203040:s=640x360:r=30" -i /tmp/tts.mp3 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac /tmp/speak.mp4`,
   `ffmpeg -i /tmp/speak.mp4 -c:v libvpx-vp9 -c:a libopus /tmp/speak.webm`, upload it to Clip.
4. `POST /api/recordings/<id>/dub {"targetLang":"es"}` → 202 with a `jobId`. Poll
   `GET /api/dubs/<jobId>` until `done` (or `error` with a real message). Report every observed
   `step` in order.
5. `ffprobe` the new recording: duration within ±2 s of the source, one video + one audio stream.
6. Prove the audio is actually Spanish: `curl -X POST localhost:3000/v1/audio/transcriptions -H
   "Authorization: Bearer $K" -F file=@<new recording's audio> -F model=whisper-1` — extract the
   audio first with ffmpeg. The transcript must be Spanish, not English.
7. Bad input: `targetLang:"xx"` → 400; unknown recording id → 404; a second Clip instance started
   with `VOICE_STUDIO_URL=http://127.0.0.1:9` → the job ends in `error` within ~30 s with a
   connection message (not a hang).
8. `GET /api/dub/languages` → eight entries, `installed` true for the pairs present.
9. Screenshot `/edit/<id>` and confirm the Dub section renders (language select + button).
10. Restart the live service on 3001 afterwards and confirm `curl localhost:3001/` → 200.

## EXECUTION DIRECTIVE

Order: `server.js` (config + multipart + pipeline + routes) → `public/edit.html` (section + polling)
→ `public/app.css` → README (env vars, in-memory jobs, GPU cost). `node --check` after server.js.
Do not restructure the existing render path; do not touch `data/clip.db` schema beyond what
`source_id` and `edit` already allow.
