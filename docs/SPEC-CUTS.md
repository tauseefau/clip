# Build task: cut the take (increment B)

Read CRITIQUE-FEATURES.md sections 4, 5, 6 and 7 first — they contain measured findings from this
machine (ffmpeg 8.0.1) that decide the implementation. Extend the existing code. Zero npm
dependencies stays. The render path already works: do not restructure it beyond what `cuts` needs.

Goal: a podcaster can delete dead air and mistakes inside a take, see a waveform to find them, and
undo.

## 1. Cuts (the substrate)

`validateEdit()` gains `cuts`: an array of `[start, end]` pairs in **trimmed-source seconds**
(0 = `trim.start`), ascending, non-overlapping, each at least 0.1 s, total kept ≤ 3600 s.
Missing `cuts` means `[[0, end - start]]` — one path, no branch.

```js
const cuts = normaliseCuts(payload.cuts, end - start);   // [[0,4],[8,12],[16,20]]
const kept = cuts.reduce((n, [a, b]) => n + (b - a), 0);
const outputSeconds = kept / speed;
```

Reject with 400 and a clear message on: non-array, more than 200 cuts, descending or overlapping
ranges, a range shorter than 0.1 s, a range outside `0..end-start`, or zero total kept length.

Every place that used `end - start` as the clip length must use `kept`:

- `outputSeconds` (drives `atempo`, the music `atrim=duration`, and `-shortest`);
- `durationMs` stored on the row;
- the caption bound in `validateEdit` (`to > kept + 1e-6` → 400);
- the render's progress/log text.

**Caption time base changes meaning with cuts**: caption `start`/`end` are now seconds into the
*edited* clip, not the trimmed source. Relabel the editor's Captions section to say so, and document
it in README.

### Filter graph

`select`/`aselect` **silently fails on Opus** (measured: picture cut, audio 20 s of a 12 s edit).
Build per-segment `trim`/`atrim` + `concat` instead, assembled with `cuts.map` exactly like
`overlays.map`:

```js
const seg = cuts.map(([a, b], i) => `[0:v]trim=${a}:${b},setpts=PTS-STARTPTS[v${i}]`);
const cat = `${cuts.map((_, i) => `[v${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0[vcat]`;
// audio per segment: [0:a]atrim=a:b, asetpts=PTS-STARTPTS, 30 ms afade in, 30 ms afade out
// then concat=n=N:v=0:a=1, then the existing atempo=speed
```

Splice that in where the current graph starts at `scale`, keep `-ss <start> -to <end>` on the input
(so cut times stay 0-based and the head of a long file is not decoded), then run the existing
`scale`/`pad`/`drawtext`/`setpts` chain on `[vcat]`.

Use short 30 ms `afade` in/out per audio segment — without it every cut clicks.

## 2. Silence removal as a cut generator

Add `runStderr(command, args)` beside `run()` (keep `run()` and its callers untouched — it pipes
stderr to `'ignore'`, and `silencedetect` writes its findings to **stderr at info level, exiting
0**, so building on `run()` reports "no silence" on a half-silent take).

New route:

```
GET /api/recordings/:id/silence   →   { cuts: [[a,b],…], removed: 124.6, total: 2140.2 }
```

Two passes in the handler:

1. `ffmpeg -i <file> -af volumedetect -f null -` → parse `max_volume`.
2. `ffmpeg -i <file> -af silencedetect=noise=<peak-20>dB:d=0.7 -f null -`, threshold clamped to
   `[-45, -20]` dB — an absolute threshold is meaningless across microphones.

Then in code: parse `silence_start` / `silence_end`, merge gaps under 400 ms, pad each silence by
150 ms on both sides, invert to keep-ranges, subtract `trim.start` and clamp to
`0..(end - start)`.

Handle unmatched pairs at both ends: a `silence_start` at 0 with no preceding end, and a
`silence_start` before EOF with no `silence_end` (clamp the latter to the probed duration).

Return the keep-ranges; the editor **pre-fills its cut list** with them. No second render path, no
preview player, no new state, no job queue.

## 3. Waveform

One image, cached in a module `Map` keyed by recording id, shipped as a data URL inside the
existing `GET /api/recordings/:id` response as `waveform` (null if generation failed). Skip the
route entirely if the file has no audio stream (`probeUpload` already records that).

```
ffmpeg -i <src> -filter_complex "showwavespic=s=1600x120:colors=#6b6b74" \
  -frames:v 1 -c:v png -f image2 -update 1 <path>
```

`-c:v png -update 1` is mandatory: `-f image2` on a `.part` name exits 0 and writes a **JPEG**,
which would then be served as `image/png`. Verify the first bytes are the PNG magic, not JPEG.

## 4. Editor UI

- **Timeline strip** under the preview: the waveform as a background image stretched to the strip
  width, a playhead line at the preview's current time, removed ranges painted over it with a CSS
  gradient, and the trim bounds dimmed outside. Clicking the strip seeks the preview.
- **Cut list**: rows of `mm:ss.s → mm:ss.s` with a remove button; "Split at playhead" splits the
  range containing the playhead at the current time (snap to the quietest sample within ±300 ms if
  a waveform peak array is available — otherwise leave the raw time and say so in the code);
  "Remove selected range" deletes one range; "Remove silence" calls the route and replaces the list.
  Show `kept` length live ("12:04 of 40:12 kept"). Cap the list at 200 ranges in the UI.
- Persist `cuts` in the draft (`formState()`), and pass it in the render POST body. Clear the draft
  only on a successful render, as today.
- **Undo/redo**: `formState()` is already a complete snapshot. Add `resetForm()` (empty `overlays`
  and `#captionRows`) then `applyDraft(snapshot)` plus explicit `start`/`end` assignment, since
  `applyDraft()` is append-only and skips trim. Push a snapshot on the existing
  input/change/click/pointerup/keyup listeners, gated to one push per 400 ms (a slider drag fires
  ~200 events) and skipped when identical to the top of the stack. Redo is a second array cleared on
  any new push. `Ctrl/Cmd+Z` undo, `Shift+Ctrl/Cmd+Z` redo, `I`/`O` set in/out to the playhead,
  `Space` toggles play (preventDefault on the body handler — buttons activate on Space otherwise).
- Keyboard handler already ignores input fields; keep that.

## Constraints

- No new dependency, no new table, no new column: `recordings.edit` (JSON) already stores the whole
  validated edit including `cuts`.
- Do not change the API shape of existing fields; `cuts` is additive and defaults to one range.
- Watch the `[${watermark ? 2 : 1}:a:0]` index in the audio graph if you add any `-i` — one new
  input silently makes the music bed the wrong stream.
- Keep the 3600 s cap and every existing validation message.

## VERIFY BEFORE YOU FINISH

Run these and paste the real output. Every one of them must pass; a "looks fine" is not a result.

1. `node --check server.js` → no output.
2. Start on `PORT=3131`. Build a test take with known silences:
   `ffmpeg -y -f lavfi -i "testsrc=size=640x360:rate=30:duration=20" -f lavfi -i "sine=frequency=440:duration=20" -c:v libvpx-vp9 -b:v 400k -c:a libopus /tmp/t20.webm`
   then upload it → 201, note the id.
3. `GET /api/recordings/<id>/silence` → JSON with `cuts`, `removed`, `total`. (This clip is not
   silent, so also test a real silent stretch: generate `aevalsrc` with 2 s tone, 6 s silence,
   2 s tone and confirm the route returns one removed range near 2–8 s.)
4. Render with `cuts: [[0,4],[8,12],[16,20]]`, no other options → 201. `ffprobe` the new file:
   duration ≈ 12.0 s (±0.15), and count audio packets with
   `ffprobe -v error -select_streams a -count_packets -show_entries stream=nb_read_packets -of csv=p=0`
   — it must be ≈ 12 s worth, **not 20 s**. This is the `aselect`-no-op trap; if packets match the
   source length, the cut did not reach the audio.
5. Render the same clip with a caption at `start: 5, end: 7` → 201 (proves the caption bound uses
   `kept`, not `end-start`); with `start: 11, end: 13` → 400.
6. Bad cuts: `[[4,0]]` → 400; `[[0,4],[2,8]]` (overlap) → 400; `[[0,0.05]]` → 400.
7. `GET /api/recordings/<id>` → response has `waveform` starting `data:image/png;base64,` and the
   decoded bytes start `89 50 4E 47`. If they start `FF D8`, the `-c:v png` flag is missing.
8. Extract the editor's inline module and `node --check` it (Python heredoc, same as increment A).
9. `curl -s -o /dev/null -w '%{http_code}' localhost:3131/edit/<id>` → 200, and restart the live
   service afterwards: `systemctl --user restart clip.service` → `curl` localhost:3001 → 200.
10. Report which parts could not be exercised headlessly (the editor's pointer/undo behaviour) so
    the user knows what to check by hand.

## EXECUTION DIRECTIVE

Order: `server.js` (validate cuts → filter graph → silence route → waveform) → `public/edit.html`
(timeline + cut list + undo) → `public/app.css` additions → README note on caption time base.
`node --check server.js` after the server edit. Keep every existing endpoint working; if a VERIFY
step fails, fix and re-run it before reporting.
