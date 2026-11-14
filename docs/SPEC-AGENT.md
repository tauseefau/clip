# Build task: agent access — a `clip` CLI and a Clip MCP server

Read the code first (`server.js` HTTP surface below is the contract; `public/` is not in scope).
Zero npm dependencies stays. Node 26 ESM. These two files are **clients of the existing HTTP API** —
do not add server routes, do not import server internals.

## Files

1. `bin/clip` — executable ESM CLI (`#!/usr/bin/env node`), no deps.
2. `bin/clip-mcp` — executable ESM MCP server over stdio, no deps.
3. `README.md` — a short "Agents" section (CLI usage, MCP setup for Claude Code and Hermes).
4. `test/verify-agent.sh` — the checks from VERIFY, runnable.

Environment for both: `CLIP_URL` (default `http://localhost:3001`), `CLIP_TOKEN` (optional; sent as
`x-clip-token`).

## Existing HTTP API (verified, do not change)

```
GET    /api/recordings                     → [{id,title,created_at,duration_ms,size,mime,comments}]
POST   /api/recordings                     raw media body; headers x-title, x-duration-ms → 201 {id,url}
GET    /api/recordings/:id                 → recording + comments + source_title + waveform (data URL, large)
PATCH  /api/recordings/:id                 {title} → updated
DELETE /api/recordings/:id                 → {ok:true}
POST   /api/recordings/:id/render          {trim:{start,end}, cuts:[[a,b]], background, overlays[], captions[],
                                            aspect:"16:9|9:16|1:1", fit:"pad|crop", speed, normalize,
                                            watermark:{corner,size,opacity,margin}, music:{id,volume}} → 201 {id,url}
GET    /api/recordings/:id/silence?start=&end= → {cuts:[[a,b]], removed, total}
POST   /api/recordings/:id/dub             {targetLang, sourceLang} → 202 {jobId}
GET    /api/dubs/:jobId                    → {state, step, error?, recordingId?, url?}
GET    /api/dub/languages                  → {languages:[{code,name,installed}]}
POST   /api/recordings/:id/comments        {author, body} → 201 comment
GET    /api/recordings/:id/captions.srt    → SRT text (404 when no captions)
GET    /media/:id.webm|mp4|jpg             media (Range-capable webm)
GET    /watch/:id, /edit/:id, /library     pages
```

Render holds the request open until ffmpeg finishes; dubbing is asynchronous by design.

## 1. `bin/clip`

```
clip ls [--json]                       list recordings (id, title, duration, date, comments)
clip get <id>                          one recording as JSON, without the waveform blob
clip url <id>                          print the watch URL
clip upload <file> [--title "..."]     POST raw bytes (probe duration locally with ffprobe)
clip render <id> [flags]               → prints the new recording id and watch URL
    --trim 3.5-42 | --trim 3.5-        --cuts "0-4,8-12"   (seconds)
    --aspect 16:9|9:16|1:1   --fit pad|crop   --bg "#101020"   --speed 1.5
    --text "Hello|0.5|0.85|64|#fff|bold"   (repeatable: text|x|y|size|colour|weight)
    --captions-file captions.json     (array of {start,end,text})
    --no-normalize
clip dub <id> --into es [--wait]       start a dub; --wait polls until done/error, printing each step
clip dub-status <jobId>                one status line as JSON
clip silence <id> [--start s --end s]  print the proposed keep-ranges
clip comment <id> "text" [--author X]
clip rm <id>                           delete
clip languages                         dub target languages
```

Rules:
- `--json` on any command prints raw API JSON; otherwise a human table/one-liner.
- Non-2xx → print the server's `error` to stderr and exit 1. Never print a success message for a
  failed call.
- `clip upload` must probe the real duration with `ffprobe -show_entries format=duration` (fall back
  to 0) and send `x-duration-ms`.
- `clip render` builds the exact JSON body above: parse `--trim a-b`, `--cuts`, `--text`, and pass
  through `--aspect/--fit/--bg/--speed/--no-normalize`. Unknown flags → usage error, exit 2.
- `clip dub --wait` polls `GET /api/dubs/:id` every 3 s, writes a step line to stderr, and on `done`
  prints the new recording's watch URL to stdout. Timeout after 90 minutes → exit 1.

## 2. `bin/clip-mcp`

A stdio MCP server: **newline-delimited JSON-RPC 2.0** on stdin/stdout (no Content-Length frames).
Handle:

- `initialize` → `{protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{name:"clip",version:"0.1.0"}}`
- `notifications/initialized` (no reply), `ping` → `{}`
- `tools/list` → the tools below with JSON Schemas
- `tools/call` → `{content:[{type:"text",text:<json or message>}], isError?:true}`
- Unknown method → JSON-RPC error `-32601`. Unknown tool → `isError:true` with a clear message.
- Never write anything but JSON-RPC lines to stdout; logs go to stderr.

Tools (name → arguments):

| Tool | Arguments | Returns |
|---|---|---|
| `list_recordings` | `{}` | array of `{id,title,duration_s,created_at,comments}` |
| `get_recording` | `{id}` | recording without the waveform blob; includes `watch_url`, `edit` if set |
| `upload_recording` | `{path, title?}` | `{id, watch_url}` — reads a local file (video/webm/mp4) |
| `render_recording` | `{id, trim?, cuts?, aspect?, fit?, background?, overlays?, captions?, speed?, normalize?, watermark?, music?}` | `{id, watch_url}` — same schema the API validates |
| `detect_silence` | `{id, start?, end?}` | `{cuts, removed_s, total_s}` |
| `dub_recording` | `{id, target_lang, wait?}` | `{job_id, state, step, watch_url?}` — with `wait:true` polls up to 45 min |
| `add_comment` | `{id, body, author?}` | the comment |
| `delete_recording` | `{id}` | `{ok:true}` |
| `save_to_drive` | `{id, name?}` | `{file_id, web_view_link}` — only if the server route exists; otherwise `isError:true` with "Drive is not configured on this server" |

Every tool's description must say what it does in one sentence and note the two costs an agent cannot
see: `render_recording` blocks until ffmpeg finishes (it may take minutes), and `dub_recording` runs
on a 4 GB GPU at roughly one minute of processing per minute of audio.

Schemas: keep arguments flat and forgiving (`required` only where the API requires it). Return
`duration_s` rounded to 0.1, not milliseconds.

## VERIFY BEFORE YOU FINISH

Run these and paste the real output.

1. `node --check bin/clip && node --check bin/clip-mcp` → no output. `chmod +x` both.
2. `bin/clip ls` against the live service (`CLIP_URL=http://localhost:3001`) → at least one row,
   matching `curl -s localhost:3001/api/recordings | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'`.
3. `bin/clip url <id>` → a `http://localhost:3001/watch/<id>` line.
4. `bin/clip render <id> --trim 0-3 --aspect 9:16 --text "Agent test|0.5|0.8|64|#ffffff|bold"` →
   a new id; `ffprobe` that file → `1080x1920`. Delete the render afterwards.
5. `bin/clip silence <id>` → JSON with `cuts`.
6. `bin/clip render <id> --cuts "0-4,8-12"` on a ≥12 s clip → new id; ffprobe duration ≈ 8 s.
7. MCP handshake, exactly this shape (adjust only the path):
   `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_recordings","arguments":{}}}' | CLIP_URL=http://localhost:3001 timeout 20 bin/clip-mcp`
   → three JSON lines: an `initialize` result, a `tools/list` result with 9 tools, and a tool result
   whose `content[0].text` parses as JSON.
8. `bin/clip-mcp` with a deliberate bad call (`tools/call` for a missing tool) → `isError:true`.
9. `CLIP_URL=http://127.0.0.1:59999 bin/clip ls` → exit 1 with a connection error on stderr, no
   traceback.
10. `claude mcp add -s user clip -- /path/to/clip/bin/clip-mcp` then `claude mcp list` → the clip
    server reports connected. Do **not** edit `~/.claude.json` by hand.
11. `test/verify-agent.sh` runs 2–9 end to end and exits 0.

## EXECUTION DIRECTIVE

Order: `bin/clip-mcp` (JSON-RPC core first, then tools) → `bin/clip` → `test/verify-agent.sh` →
README. Keep each file under ~400 lines. Do not touch `server.js`, `public/`, or `data/`. If a check
fails, fix it and re-run before reporting; report the raw output of each numbered check.
