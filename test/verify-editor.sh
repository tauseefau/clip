#!/usr/bin/env bash
# End-to-end check of the render API. Runs on a throwaway copy so ./data is never touched.
# Usage: test/verify-editor.sh [port]   (default 3112)
set -euo pipefail

PORT=${1:-3112}
BASE=localhost:$PORT
WORK=$(mktemp -d)
cp -r "$(dirname "$0")/../server.js" "$(dirname "$0")/../package.json" "$(dirname "$0")/../public" "$(dirname "$0")/../fonts" "$WORK/"
SERVER=
stop() { [ -z "$SERVER" ] || { kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null || true; SERVER=; }; }
trap 'stop; rm -rf "$WORK"' EXIT

start() {
  (cd "$WORK" && exec env PORT="$PORT" "$@" node --no-warnings server.js >/dev/null) & SERVER=$!
  for _ in $(seq 50); do curl -sf -o /dev/null "$BASE/library" && return; sleep 0.1; done
  echo 'server did not start'; exit 1
}
upload() { curl -sf -X POST --data-binary @"$1" -H 'X-Title: test' "$BASE/api/recordings" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }
. "$(dirname "$0")/render.sh"
expect() { [ "$2" = "$3" ] && echo "ok   $1 ($3)" || { echo "FAIL $1: wanted $2, got $3"; exit 1; }; }
status() { render "$1" "$2" | tail -1; }
newid() { sed -n 's/.*"id":"\([^"]*\)".*/\1/p' <<<"$1"; }
pixel() { # prints the RGB of the top-left pixel of a frame 1s in
  ffmpeg -v error -y -ss 1 -i "$1" -frames:v 1 "$WORK/frame.png"
  python3 -c 'import sys; from PIL import Image; print("#%02x%02x%02x" % Image.open(sys.argv[1]).convert("RGB").getpixel((0,0)))' "$WORK/frame.png"
}
near() { # asserts hex colours $2 and $3 are within 6/255 per channel: VP9 is lossy
  python3 -c 'import sys
a, b = [[int(c[i:i+2], 16) for i in (1, 3, 5)] for c in sys.argv[2:]]
ok = all(abs(x - y) <= 6 for x, y in zip(a, b))
print(("ok  " if ok else "FAIL"), sys.argv[1], sys.argv[2], "vs", sys.argv[3]); sys.exit(not ok)' "$@"
}

echo '== 1 node --check'
node --check server.js && echo ok

echo '== 2 start, upload 6s clip'
start
ffmpeg -v error -y -f lavfi -i testsrc=size=1280x720:rate=30:duration=6 -f lavfi -i sine=frequency=440:duration=6 \
  -c:v libvpx-vp9 -b:v 500k -c:a libopus "$WORK/t.webm"
ID=$(upload "$WORK/t.webm"); echo "uploaded $ID"

echo '== 3 render'
BODY='{"trim":{"start":1,"end":4},"background":"#1b1b3a","overlays":[
  {"text":"Hello world","x":0.5,"y":0.15,"size":64,"color":"#ffffff","bold":true,"font":"sans"},
  {"text":"clip.demo","x":0.5,"y":0.9,"size":32,"color":"#ffcc00","bold":false,"font":"serif"}]}'
OUT=$(render "$ID" "$BODY"); echo "$OUT"
expect 'render status' 201 "$(tail -1 <<<"$OUT")"
NEW=$(newid "$OUT")
FILE=$WORK/data/media/$NEW.webm

echo '== 4 ffprobe'
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of compact "$FILE"
curl -s "$BASE/api/recordings/$NEW" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("row:", r["title"], r["duration_ms"], r["size"])'

echo '== 5 top-left pixel, as specified (16:9 source: nothing to letterbox)'
echo "pixel: $(pixel "$FILE")"

echo '== 5b top-left pixel, 4:3 source (pillarboxed, so the pad colour must show)'
ffmpeg -v error -y -f lavfi -i testsrc=size=640x480:rate=30:duration=3 -c:v libvpx-vp9 -b:v 500k "$WORK/silent.webm"
SILENT=$(upload "$WORK/silent.webm")
OUT=$(render "$SILENT" '{"trim":{"start":0,"end":2},"background":"#1b1b3a","overlays":[]}')
expect 'silent 4:3 render' 201 "$(tail -1 <<<"$OUT")"
near 'pad colour' "$(pixel "$WORK/data/media/$(newid "$OUT").webm")" '#1b1b3a'

echo '== 6 edit page'
expect 'GET /edit/:id' 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/edit/$NEW")"

echo '== 7 bad input'
OK='"x":0.5,"y":0.5,"size":32,"color":"#ffffff","font":"sans"'
MANY=$(python3 -c 'import sys,json; print(json.dumps({"trim":{"start":0,"end":1},"background":"#000000","overlays":[{"text":"a","x":.5,"y":.5,"size":32,"color":"#ffffff","font":"sans"}]*21}))')
render "$ID" '{"trim":{"start":4,"end":1},"background":"#000000","overlays":[]}'; echo
render "$ID" "$MANY"; echo
expect 'end < start' 400 "$(status "$ID" '{"trim":{"start":4,"end":1},"background":"#000000","overlays":[]}')"
expect '21 overlays' 400 "$(status "$ID" "$MANY")"
expect 'over 3600s' 400 "$(status "$ID" '{"trim":{"start":0,"end":3601},"background":"#000000","overlays":[]}')"
expect 'bad background' 400 "$(status "$ID" '{"trim":{"start":0,"end":1},"background":"red:x","overlays":[]}')"
expect 'filter injection via x' 400 "$(status "$ID" "{\"trim\":{\"start\":0,\"end\":1},\"background\":\"#000000\",\"overlays\":[{\"text\":\"a\",\"x\":\"0,evil\",\"y\":0.5,\"size\":32,\"color\":\"#ffffff\",\"font\":\"sans\"}]}")"
expect 'bad font' 400 "$(status "$ID" "{\"trim\":{\"start\":0,\"end\":1},\"background\":\"#000000\",\"overlays\":[{\"text\":\"a\",$OK,\"font\":\"comic\"}]}")"
expect 'size too big' 400 "$(status "$ID" "{\"trim\":{\"start\":0,\"end\":1},\"background\":\"#000000\",\"overlays\":[{\"text\":\"a\",$OK,\"size\":201}]}")"
expect 'null overlay' 400 "$(status "$ID" '{"trim":{"start":0,"end":1},"background":"#000000","overlays":[null]}')"
expect 'unknown recording' 404 "$(status 00000000-0000-0000-0000-000000000000 '{}')"

echo '== extras'
expect 'text with % and quotes' 201 "$(status "$ID" "{\"trim\":{\"start\":0,\"end\":1},\"background\":\"#000000\",\"overlays\":[{\"text\":\"100% %{pts} it's: a\\\\b\",$OK}]}")"
expect 'trim past end' 400 "$(status "$ID" '{"trim":{"start":100,"end":101},"background":"#000000","overlays":[]}')"
OUT=$(render "$ID" '{"trim":{"start":5,"end":50},"background":"#000000","overlays":[]}')
expect 'end past source' 201 "$(tail -1 <<<"$OUT")"
curl -s "$BASE/api/recordings/$(newid "$OUT")" | python3 -c 'import json,sys; d=json.load(sys.stdin)["duration_ms"]; print("ok   stored duration is the real one:", d) if 900<d<1100 else sys.exit(f"FAIL duration {d}")'
expect 'tmp files cleaned' 0 "$(ls "$WORK/data/tmp" | wc -l)"
expect 'no .part left' 0 "$(ls "$WORK/data/media" | grep -c '\.part$' || true)"

echo '== ffmpeg failure path'
stop
start FFMPEG=/bin/false
BEFORE=$(ls "$WORK/data/media" | wc -l)
render "$ID" "$BODY"; echo
expect 'failed render' 500 "$(status "$ID" "$BODY")"
expect 'no files added' "$BEFORE" "$(ls "$WORK/data/media" | wc -l)"
expect 'tmp files cleaned' 0 "$(ls "$WORK/data/tmp" | wc -l)"

echo '== 8 kill server'
stop
curl -s -o /dev/null --max-time 2 "$BASE/library" && { echo 'FAIL server still up'; exit 1; } || echo 'ok   stopped'
echo ALL_PASSED
