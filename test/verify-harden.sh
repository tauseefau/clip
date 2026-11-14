#!/usr/bin/env bash
# End-to-end check of docs/SPEC-HARDEN.md steps 1-10. Runs on a throwaway copy so ./data is never touched.
# Usage: test/verify-harden.sh [port]   (default 3122)
set -euo pipefail

PORT=${1:-3122}
BASE=localhost:$PORT
BG=ff00ff
WORK=$(mktemp -d)
cp -r "$(dirname "$0")/../server.js" "$(dirname "$0")/../package.json" "$(dirname "$0")/../public" "$(dirname "$0")/../fonts" "$WORK/"
SERVER=
stop() { [ -z "$SERVER" ] || { kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null || true; SERVER=; }; }
trap 'stop; rm -rf "$WORK"' EXIT

jsonfield() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
expect() { [ "$2" = "$3" ] && echo "ok   $1 ($3)" || { echo "FAIL $1: wanted $2, got $3"; exit 1; }; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
. "$(dirname "$0")/render.sh"; render_id() { render "$@" | head -1 | jsonfield id; }
patch() { curl -s -o /dev/null -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d "$2" "$BASE/api/recordings/$1"; }
pixel() { ffmpeg -v error -y -ss 1 -i "$1" -frames:v 1 -vf "format=rgb24,crop=1:1:$2:$3" -f rawvideo -pix_fmt rgb24 - | od -An -tx1 | tr -d ' \n'; }
# Video encoding shifts colours slightly, so "equals the background" means within 40 per channel.
near_bg() {
  python3 -c 'import sys
a, b = bytes.fromhex(sys.argv[1]), bytes.fromhex(sys.argv[2])
print("yes" if all(abs(x - y) <= 40 for x, y in zip(a, b)) else "no")' "$1" "$BG"
}

echo '== 1 node --check'
node --check server.js && echo ok

echo "== 2 start on $PORT, upload real 6s clip and a PNG"
(cd "$WORK" && exec env -u HOST -u CLIP_TOKEN PORT="$PORT" node --no-warnings server.js >/dev/null) & SERVER=$!
for _ in $(seq 50); do curl -sf -o /dev/null "$BASE/library" && break; sleep 0.1; done
ffmpeg -v error -y -f lavfi -i testsrc=size=1280x720:rate=30:duration=6 -f lavfi -i sine=frequency=440:duration=6 \
  -c:v libvpx-vp9 -b:v 500k -c:a libopus "$WORK/t.webm"
ffmpeg -v error -y -f lavfi -i color=c=red:size=64x64 -frames:v 1 "$WORK/not-video.png"
CREATED=$(curl -s -w '\n%{http_code}' -X POST --data-binary @"$WORK/t.webm" -H 'X-Title: Harden test' "$BASE/api/recordings")
expect 'upload real clip' 201 "$(tail -1 <<<"$CREATED")"
ID=$(head -1 <<<"$CREATED" | jsonfield id)
expect 'probed duration_ms' 6 "$(curl -s "$BASE/api/recordings/$ID" | python3 -c 'import json,sys; print(round(json.load(sys.stdin)["duration_ms"]/1000))')"
expect 'upload PNG' 400 "$(code -X POST --data-binary @"$WORK/not-video.png" "$BASE/api/recordings")"

echo '== 3 two parallel MP4 downloads of an uncached id'
curl -s -o /tmp/a.mp4 -w '%{http_code}' "$BASE/media/$ID.mp4" >"$WORK/a.code" &
A=$!
curl -s -o /tmp/b.mp4 -w '%{http_code}' "$BASE/media/$ID.mp4" >"$WORK/b.code" &
B=$!
wait "$A" "$B"
expect 'first download' 200 "$(cat "$WORK/a.code")"
expect 'second download' 200 "$(cat "$WORK/b.code")"
sha256sum /tmp/a.mp4 /tmp/b.mp4
expect 'identical sha256' 1 "$(sha256sum /tmp/a.mp4 /tmp/b.mp4 | cut -d' ' -f1 | sort -u | wc -l)"
ERRORS=$(ffmpeg -v error -i /tmp/a.mp4 -f null - 2>&1)
expect 'ffmpeg decode output' '' "$ERRORS"
expect 'part files left' 0 "$(find "$WORK/data/media" -name '*.part' | wc -l)"

echo '== 4 fit:crop fills 9:16; fit:pad control shows the background'
TRIM='"trim":{"start":0,"end":3}'
CROP=$(render_id "$ID" "{$TRIM,\"background\":\"#$BG\",\"aspect\":\"9:16\",\"fit\":\"crop\"}")
PAD=$(render_id "$ID" "{$TRIM,\"background\":\"#$BG\",\"aspect\":\"9:16\",\"fit\":\"pad\"}")
for edge in 'top 0' 'bottom 1919'; do
  set -- $edge
  C=$(pixel "$WORK/data/media/$CROP.webm" 540 "$2")
  P=$(pixel "$WORK/data/media/$PAD.webm" 540 "$2")
  echo "$1-centre: crop=#$C pad=#$P background=#$BG"
  expect "crop $1 differs from background" no "$(near_bg "$C")"
  expect "pad $1 is background (control)" yes "$(near_bg "$P")"
done

echo '== 5 captions and SRT'
CAP=$(render_id "$ID" "{$TRIM,\"background\":\"#000000\",\"captions\":[{\"start\":0.5,\"end\":2.5,\"text\":\"First caption\"}]}")
curl -s -D "$WORK/h" -o "$WORK/c.srt" "$BASE/api/recordings/$CAP/captions.srt"
grep -iE '^(HTTP|content-type|content-disposition)' "$WORK/h"
cat "$WORK/c.srt"
expect 'SRT body' "$(printf '1\n00:00:00,500 --> 00:00:02,500\nFirst caption')" "$(cat "$WORK/c.srt")"
expect 'SRT on a captionless render' 404 "$(code "$BASE/api/recordings/$CROP/captions.srt")"
expect 'SRT on missing id' 404 "$(code "$BASE/api/recordings/nope/captions.srt")"
FAST=$(render_id "$ID" "{$TRIM,\"background\":\"#000000\",\"speed\":2,\"captions\":[{\"start\":1,\"end\":2,\"text\":\"Fast\"}]}")
expect 'SRT follows the output timeline at 2x' '00:00:00,500 --> 00:00:01,000' "$(curl -s "$BASE/api/recordings/$FAST/captions.srt" | sed -n 2p)"

echo '== 6 two renders of one source, plus a render of a render'
R1=$(render_id "$ID" "{$TRIM,\"aspect\":\"9:16\",\"speed\":1}")
R2=$(render_id "$ID" "{$TRIM,\"aspect\":\"1:1\",\"speed\":1.5}")
R3=$(render_id "$R1" '{"trim":{"start":0,"end":2},"aspect":"1:1","speed":2}')
T1=$(curl -s "$BASE/api/recordings/$R1"); T2=$(curl -s "$BASE/api/recordings/$R2"); T3=$(curl -s "$BASE/api/recordings/$R3")
for row in "$T1" "$T2" "$T3"; do jsonfield title <<<"$row"; done
expect 'title 1' 'Harden test — 9:16 1x' "$(jsonfield title <<<"$T1")"
expect 'title 2' 'Harden test — 1:1 1.5x' "$(jsonfield title <<<"$T2")"
expect 'title of a render' 'Harden test — 1:1 2x' "$(jsonfield title <<<"$T3")"
expect 'source_id' "$ID" "$(jsonfield source_id <<<"$T1")"
expect 'source_title' 'Harden test' "$(jsonfield source_title <<<"$T1")"
expect '"(edited)" occurrences' 0 "$(grep -c '(edited)' <<<"$T1$T2$T3" || true)"

echo '== 7 title cap'
expect 'PATCH 500 chars' 400 "$(patch "$ID" "{\"title\":\"$(printf 'x%.0s' $(seq 500))\"}")"
expect 'PATCH 200 chars' 200 "$(patch "$ID" "{\"title\":\"$(printf 'x%.0s' $(seq 200))\"}")"

echo '== 8 HOST=0.0.0.0 with no CLIP_TOKEN'
set +e
MESSAGE=$(cd "$WORK" && env -u CLIP_TOKEN HOST=0.0.0.0 PORT=$((PORT + 1)) timeout 5 node --no-warnings server.js 2>&1)
EXIT=$?
set -e
echo "$MESSAGE"
expect 'exit code' 1 "$EXIT"

echo '== 9 thumbnail, then a cached second call'
JPG=$WORK/data/media/$ID.jpg
curl -s -D "$WORK/h1" -o "$WORK/1.jpg" "$BASE/media/$ID.jpg"
grep -iE '^(HTTP|content-type)' "$WORK/h1"
FIRST=$(stat -c %y "$JPG")
expect 'first status' 200 "$(sed -n 's/^HTTP[^ ]* \([0-9]*\).*/\1/p' "$WORK/h1")"
expect 'first type' 'image/jpeg' "$(sed -n 's/^[Cc]ontent-[Tt]ype: \([^\r]*\).*/\1/p' "$WORK/h1")"
expect 'second status' 200 "$(curl -s -o "$WORK/2.jpg" -w '%{http_code}' "$BASE/media/$ID.jpg")"
expect 'cache file untouched' "$FIRST" "$(stat -c %y "$JPG")"
cmp "$WORK/1.jpg" "$WORK/2.jpg" && echo 'ok   second body identical'
file "$WORK/1.jpg" | cut -d: -f2-

echo '== 10 kill the server'
stop
expect 'server gone' 000 "$(code --max-time 2 "$BASE/library" || true)"
echo 'ALL PASSED'
