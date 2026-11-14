# Continue: finish the hardening pass

A previous run was interrupted. Most of SPEC-HARDEN.md is already implemented in server.js and
public/. Read the current code first, then finish ONLY what is missing:

1. **SRT export** — `GET /api/recordings/:id/captions.srt`. Store the captions JSON on the
   recording row at render time (nullable `captions` TEXT column, added with a guarded
   `ALTER TABLE`). Emit standard SRT (`HH:MM:SS,mmm`). 404 when the recording has no captions.
   Add a "Download SRT" button on the watch page, shown only when captions exist.
2. **Title cap** — `cleanTitle` slices to 200 chars; PATCH rejects >200 with 400.
3. **Recorder quality** — confirm the quality select actually sets `videoBitsPerSecond` and
   downscales the canvas; fix it if it only renders the control.
4. **Library thumbnails** — confirm library.html uses `/media/:id.jpg` with the canvas fallback.
5. **Watch page lineage** — show "from <source title>" when `source_id` is set.

Then run the full verification from SPEC-HARDEN.md (steps 1-10) and paste the real output.
Do not re-implement anything that already works. `node --check server.js` after edits.
