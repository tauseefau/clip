#!/usr/bin/env bash
# End-to-end check of cuts, silence detection and the waveform. Runs on a throwaway copy so ./data is never touched.
# Usage: test/verify-cuts.sh [port]   (default 3131)
set -euo pipefail

PORT=${1:-3131}
BASE=localhost:$PORT
WORK=$(mktemp -d)
cp -r "$(dirname "$0")/../server.js" "$(dirname "$0")/../package.json" "$(dirname "$0")/../public" "$(dirname "$0")/../fonts" "$WORK/"
SERVER=
stop() { [ -z "$SERVER" ] || { kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null || true; SERVER=; }; }
trap 'stop; rm -rf "$WORK"' EXIT

(cd "$WORK" && exec env PORT="$PORT" node --no-warnings server.js >/dev/null) & SERVER=$!
for _ in $(seq 50); do curl -sf -o /dev/null "$BASE/library" && break; sleep 0.1; done

upload() { curl -s -w '\n%{http_code}' -X POST --data-binary @"$1" -H 'X-Title: test' "$BASE/api/recordings"; }
. "$(dirname "$0")/render.sh"
expect() { [ "$2" = "$3" ] && echo "ok   $1 ($3)" || { echo "FAIL $1: wanted $2, got $3"; exit 1; }; }
newid() { sed -n 's/.*"id":"\([^"]*\)".*/\1/p' <<<"$1"; }
near() { python3 -c 'import sys; v, want, tol = map(float, sys.argv[2:]); ok = abs(v - want) <= tol
print(("ok  " if ok else "FAIL"), sys.argv[1], v, "want", want, "±", tol); sys.exit(not ok)' "$@"; }
trim='"trim":{"start":0,"end":20}'

echo '== 2 upload 20s test take'
ffmpeg -v error -y -f lavfi -i "testsrc=size=640x360:rate=30:duration=20" -f lavfi -i "sine=frequency=440:duration=20" \
  -c:v libvpx-vp9 -b:v 400k -c:a libopus "$WORK/t20.webm"
out=$(upload "$WORK/t20.webm"); expect 'upload' 201 "$(tail -1 <<<"$out")"; ID=$(newid "$out"); echo "id $ID"

echo '== 3 silence route'
body=$(curl -s "$BASE/api/recordings/$ID/silence"); echo "tone:    $body"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert {"cuts","removed","total"} <= r.keys(); c=r["cuts"]; assert len(c)==1 and c[0][0]==0 and c[0][1]>=20, r' "$body" && echo 'ok   tone has no silence'
ffmpeg -v error -y -f lavfi -i "testsrc=size=640x360:rate=30:duration=10" \
  -f lavfi -i "aevalsrc='if(between(t,2,8),0,0.5*sin(2*PI*440*t))':s=48000:d=10" \
  -c:v libvpx-vp9 -b:v 400k -c:a libopus "$WORK/gap.webm"
GAP=$(newid "$(upload "$WORK/gap.webm")")
body=$(curl -s "$BASE/api/recordings/$GAP/silence"); echo "gap:     $body"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); c=r["cuts"]; assert len(c)==2, c
assert abs(c[0][1]-2.15)<0.15 and abs(c[1][0]-7.85)<0.15, c; print("ok   one removed range near 2-8s, removed", r["removed"])' "$body"
body=$(curl -s "$BASE/api/recordings/$GAP/silence?start=1&end=9"); echo "trimmed: $body"
python3 -c 'import json,sys; c=json.loads(sys.argv[1])["cuts"]; assert c[0][0]==0 and abs(c[0][1]-1.15)<0.15 and abs(c[1][1]-8)<1e-6, c; print("ok   trim offset applied")' "$body"

echo '== 4 render cuts [[0,4],[8,12],[16,20]]'
out=$(render "$ID" "{$trim,\"cuts\":[[0,4],[8,12],[16,20]]}"); expect 'render' 201 "$(tail -1 <<<"$out")"
CUT=$(newid "$out")
near 'duration' "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/data/media/$CUT.webm")" 12 0.15
packets=$(ffprobe -v error -select_streams a -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$WORK/data/media/$CUT.webm")
near 'audio packets (20 ms opus, 600 = 12s)' "$packets" 600 10
near 'stored durationMs' "$(curl -s "$BASE/api/recordings/$CUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["duration_ms"])')" 12000 150

echo '== 5 caption bound uses kept length'
expect 'caption 5-7' 201 "$(render "$ID" "{$trim,\"cuts\":[[0,4],[8,12],[16,20]],\"captions\":[{\"start\":5,\"end\":7,\"text\":\"hi\"}]}" | tail -1)"
expect 'caption 11-13' 400 "$(render "$ID" "{$trim,\"cuts\":[[0,4],[8,12],[16,20]],\"captions\":[{\"start\":11,\"end\":13,\"text\":\"hi\"}]}" | tail -1)"

echo '== 6 bad cuts'
for bad in '[[4,0]]' '[[0,4],[2,8]]' '[[0,0.05]]' '[]' '"x"' '[[0,25]]'; do
  out=$(render "$ID" "{$trim,\"cuts\":$bad}"); expect "cuts $bad -> $(head -1 <<<"$out")" 400 "$(tail -1 <<<"$out")"
done
expect 'no cuts still renders' 201 "$(render "$ID" "{\"trim\":{\"start\":0,\"end\":2}}" | tail -1)"

echo '== 7 waveform'
curl -s "$BASE/api/recordings/$ID" | python3 -c 'import json,sys,base64; w=json.load(sys.stdin)["waveform"]; p="data:image/png;base64,"
assert w.startswith(p), w[:40]; b=base64.b64decode(w[len(p):]); print("first bytes", b[:4].hex(" ").upper()); assert b[:4]==b"\x89PNG"; print("ok   waveform is PNG,", len(b), "bytes")'

echo '== 8 editor module'
python3 - "$WORK/public/edit.html" "$WORK/edit.mjs" <<'EOF'
import re, sys
html = open(sys.argv[1]).read()
open(sys.argv[2], 'w').write(re.search(r'<script type="module">(.*?)</script>', html, re.S).group(1))
EOF
node --check "$WORK/edit.mjs" && echo 'ok   module parses'
expect 'GET /edit/:id' 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/edit/$ID")"
