#!/usr/bin/env bash
# End-to-end check of docs/SPEC-YOUTUBE.md. Runs on a throwaway copy so ./data is never touched.
# Usage: test/verify-youtube.sh [port]   (default 3113)
set -euo pipefail

PORT=${1:-3113}
BASE=localhost:$PORT
WORK=$(mktemp -d)
cp -r "$(dirname "$0")/../server.js" "$(dirname "$0")/../package.json" "$(dirname "$0")/../public" "$(dirname "$0")/../fonts" "$WORK/"
SERVER=
stop() { [ -z "$SERVER" ] || { kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null || true; SERVER=; }; }
trap 'stop; rm -rf "$WORK"' EXIT

jsonfield() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
upload() { curl -sf -X POST --data-binary @"$1" -H 'X-Title: test' "$BASE/api/recordings" | jsonfield id; }
. "$(dirname "$0")/render.sh"
status() { render "$1" "$2" | tail -1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { [ "$2" = "$3" ] && echo "ok   $1 ($3)" || { echo "FAIL $1: wanted $2, got $3"; exit 1; }; }
newid() { sed -n 's/.*"id":"\([^"]*\)".*/\1/p' <<<"$1"; }
frame() { ffmpeg -v error -y -ss "$2" -i "$1" -frames:v 1 "$3"; }
media() { echo "$WORK/data/media/$1.webm"; }
meandb() { ffmpeg -hide_banner -i "$1" -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \(.*\) dB/\1/p'; }

echo '== 1 node --check'
node --check server.js && echo ok

echo '== 2 start on 3113, upload a 6s 1280x720 clip'
(cd "$WORK" && exec env PORT="$PORT" node --no-warnings server.js >/dev/null) & SERVER=$!
for _ in $(seq 50); do curl -sf -o /dev/null "$BASE/library" && break; sleep 0.1; done
ffmpeg -v error -y -f lavfi -i testsrc=size=1280x720:rate=30:duration=6 -f lavfi -i sine=frequency=440:duration=6 \
  -c:v libvpx-vp9 -b:v 500k -c:a libopus "$WORK/t.webm"
ID=$(upload "$WORK/t.webm"); echo "uploaded $ID"

echo '== 9d watermark requested before any upload (spec order needs this first)'
WM='{"corner":"br","size":0.2,"opacity":0.8,"margin":0.03}'
TRIM='"trim":{"start":0,"end":6},"background":"#101020"'
render "$ID" "{$TRIM,\"watermark\":$WM}"; echo
expect 'watermark with no file' 400 "$(status "$ID" "{$TRIM,\"watermark\":$WM}")"
expect 'GET watermark before upload' 404 "$(code "$BASE/api/brand/watermark")"

echo '== 3 upload a 200x80 PNG watermark'
ffmpeg -v error -y -f lavfi -i color=c=orange:size=200x80 -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text=LOGO:fontsize=48:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2" \
  -frames:v 1 "$WORK/logo.png"
curl -s -X POST --data-binary @"$WORK/logo.png" "$BASE/api/brand/watermark"; echo
expect 'watermark file saved' 200 "$(code "$BASE/api/brand/watermark")"
echo 'not a png' > "$WORK/fake.png"
expect 'non-PNG watermark' 400 "$(code -X POST --data-binary @"$WORK/fake.png" "$BASE/api/brand/watermark")"
head -c $((5*1024*1024+1)) /dev/zero > "$WORK/big.bin"
expect 'watermark over 5 MB' 413 "$(code -X POST --data-binary @"$WORK/big.bin" "$BASE/api/brand/watermark")"

echo '== 4 upload a 6s sine-wave mp3'
ffmpeg -v error -y -f lavfi -i sine=frequency=880:duration=6 "$WORK/bed.mp3"
OUT=$(curl -s -X POST --data-binary @"$WORK/bed.mp3" -H 'X-Filename: bed%20track.mp3' "$BASE/api/brand/music"); echo "$OUT"
MUSIC=$(jsonfield id <<<"$OUT")
curl -s "$BASE/api/brand/music"; echo
expect 'GET music file' 200 "$(code "$BASE/api/brand/music/$MUSIC")"
expect 'unknown audio type' 400 "$(code -X POST --data-binary @"$WORK/fake.png" -H 'X-Filename: a.txt' "$BASE/api/brand/music")"
expect 'extension header accepted' 201 "$(code -X POST --data-binary @"$WORK/fake.png" -H 'X-Filename: a.WAV' "$BASE/api/brand/music")"

echo '== 5 full render'
CAP='{"start":0.5,"end":2.5,"text":"First caption"}'
BODY="{\"aspect\":\"9:16\",\"speed\":1.5,$TRIM,\"watermark\":$WM,\"captions\":[$CAP],\"music\":{\"id\":\"$MUSIC\",\"volume\":0.3}}"
echo "$BODY"
OUT=$(render "$ID" "$BODY"); echo "$OUT"
expect 'render status' 201 "$(tail -1 <<<"$OUT")"
NEW=$(newid "$OUT")
FILE=$(media "$NEW")

echo '== 6 ffprobe'
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,width,height -of compact "$FILE"
curl -s "$BASE/api/recordings/$NEW" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("row:", r["title"], r["duration_ms"]); assert 3900 < r["duration_ms"] < 4100'
python3 - "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE")" \
  "$(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 "$FILE")" \
  "$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$FILE")" <<'PY'
import sys
duration, size, audio = sys.argv[1:]
assert size == '1080,1920', size
assert abs(float(duration) - 4) < 0.15, duration
assert audio == 'audio', audio
print('ok   1080x1920, duration', duration, 'audio stream present')
PY

echo '== 7+8 frames: watermark, letterbox, caption'
frame "$FILE" 1 "$WORK/at1.png"
frame "$FILE" 3.5 "$WORK/at3.5.png"
frame "$FILE" 2 "$WORK/at2.png"
python3 - "$WORK" <<'PY'
import sys
from PIL import Image, ImageChops
work = sys.argv[1]
a = Image.open(f'{work}/at1.png').convert('RGB')
later = Image.open(f'{work}/at3.5.png').convert('RGB')
two = Image.open(f'{work}/at2.png').convert('RGB')
W, H = a.size
bg = (0x10, 0x10, 0x20)
near = lambda p, q, d=10: all(abs(x - y) <= d for x, y in zip(p, q))
diff = lambda box, im: sum(1 for p in im.crop(box).getdata() if not near(p, bg))

top = (0, 0, W, 300)
assert diff(top, a) == 0, 'top is not the background colour'
print('ok   top 300px all background; sample', a.getpixel((540, 100)))

corner = (W - 300, H - 150, W, H)
logo = diff(corner, a)
assert logo > 3000, logo
print('ok   bottom-right non-background pixels:', logo)
# size 0.2 of 1080 is 216 wide; margin 0.03 is 32px on both axes.
box = ImageChops.difference(a, Image.new('RGB', a.size, bg)).point(lambda v: 255 if v > 40 else 0).crop(corner).getbbox()
print('     logo bbox in frame:', (box[0] + W - 300, box[1] + H - 150, box[2] + W - 300, box[3] + H - 150))
assert abs(box[2] + W - 300 - (W - 32)) <= 2 and abs(box[3] + H - 150 - (H - 32)) <= 2, box

band = (150, 1600, 930, 1800)
during, after = diff(band, a), diff(band, later)
changed = sum(1 for p in ImageChops.difference(a.crop(band), later.crop(band)).getdata() if max(p) > 40)
assert during > 2000 and after == 0 and changed > 2000, (during, after, changed)
print(f'ok   caption band at 1s: {during} non-bg px, at 3.5s: {after}, changed: {changed}')

# Caption ends 2.5s into the trimmed clip, which is 1.67s of output at 1.5x. Read as output time it would still show at 2s.
assert diff(band, two) == 0, 'caption is on output time, not trimmed time'
print('ok   caption gone at output 2.0s: times are on the trimmed clip')
PY

echo '== 9 bad input'
for pair in \
  'aspect 4:3|{"aspect":"4:3",'"$TRIM"'}' \
  'aspect constructor|{"aspect":"constructor",'"$TRIM"'}' \
  'speed 3|{"speed":3,'"$TRIM"'}' \
  'speed string|{"speed":"1.5",'"$TRIM"'}' \
  'caption past clip|{"captions":[{"start":1,"end":7,"text":"x"}],'"$TRIM"'}' \
  'captions not array|{"captions":"x",'"$TRIM"'}' \
  'caption end<=start|{"captions":[{"start":2,"end":2,"text":"x"}],'"$TRIM"'}' \
  'caption empty text|{"captions":[{"start":0,"end":1,"text":" "}],'"$TRIM"'}' \
  'watermark bad corner|{"watermark":{"corner":"mm","size":0.2,"opacity":0.8,"margin":0.03},'"$TRIM"'}' \
  'watermark size range|{"watermark":{"corner":"br","size":0.5,"opacity":0.8,"margin":0.03},'"$TRIM"'}' \
  'watermark margin injection|{"watermark":{"corner":"br","size":0.2,"opacity":0.8,"margin":"0;evil"},'"$TRIM"'}' \
  'missing music id|{"music":{"id":"00000000-0000-0000-0000-000000000000","volume":0.3},'"$TRIM"'}' \
  'music id object|{"music":{"id":{},"volume":0.3},'"$TRIM"'}' \
  'music volume range|{"music":{"id":"'"$MUSIC"'","volume":2},'"$TRIM"'}'; do
  expect "${pair%%|*}" 400 "$(status "$ID" "${pair#*|}")"
done
MANY=$(python3 -c 'import json; print(json.dumps({"trim":{"start":0,"end":6},"background":"#000000","captions":[{"start":0,"end":1,"text":"a"}]*101}))')
expect '101 captions' 400 "$(status "$ID" "$MANY")"
render "$ID" "{\"aspect\":\"4:3\",$TRIM}"; echo
render "$ID" "{\"speed\":3,$TRIM}"; echo
render "$ID" "{\"captions\":[{\"start\":1,\"end\":7,\"text\":\"x\"}],$TRIM}"; echo

echo '== extras'
OUT=$(render "$ID" '{"trim":{"start":1,"end":2},"background":"#000000","overlays":[]}')
expect 'no new options still renders' 201 "$(tail -1 <<<"$OUT")"
expect 'default output is 1920x1080' '1920,1080' "$(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 "$(media "$(newid "$OUT")")")"
expect 'float-noise caption end' 201 "$(status "$ID" '{"trim":{"start":1.1,"end":3.3},"background":"#000000","captions":[{"start":0,"end":2.2,"text":"100% it'"'"'s: a\\b"}]}')"
OUT=$(render "$ID" '{"aspect":"1:1","trim":{"start":0,"end":1},"background":"#000000","captions":[{"start":0,"end":1,"text":"'"$(python3 -c 'print("word " * 39 + "word")')"'"}]}')
expect 'long caption, square' 201 "$(tail -1 <<<"$OUT")"
frame "$(media "$(newid "$OUT")")" 0.5 "$WORK/long.png"
python3 - "$WORK/long.png" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('L')
W, H = im.size
assert im.size == (1080, 1080), im.size
edge = [im.getpixel((x, y)) for x in (2, W - 3) for y in range(H)]
print('ok   wrapped caption stays off the frame edges' if max(edge) < 40 else sys.exit('FAIL caption hits the edge'))
PY

ffmpeg -v error -y -f lavfi -i testsrc=size=640x480:rate=30:duration=3 -c:v libvpx-vp9 -b:v 500k "$WORK/silent.webm"
SILENT=$(upload "$WORK/silent.webm")
OUT=$(render "$SILENT" "{\"speed\":2,\"trim\":{\"start\":0,\"end\":2},\"background\":\"#000000\"}")
expect 'silent source with speed' 201 "$(tail -1 <<<"$OUT")"
OUT=$(render "$SILENT" "{\"trim\":{\"start\":0,\"end\":2},\"background\":\"#000000\",\"music\":{\"id\":\"$MUSIC\",\"volume\":0.5}}")
expect 'silent source with music' 201 "$(tail -1 <<<"$OUT")"
expect 'silent source gains audio' audio "$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$(media "$(newid "$OUT")")")"
OUT=$(render "$ID" "{\"trim\":{\"start\":5,\"end\":50},\"background\":\"#000000\",\"music\":{\"id\":\"$MUSIC\",\"volume\":0.3}}")
expect 'end past source with music' 201 "$(tail -1 <<<"$OUT")"
curl -s "$BASE/api/recordings/$(newid "$OUT")" | python3 -c 'import json,sys; d=json.load(sys.stdin)["duration_ms"]; print("ok   music does not outlast the picture:", d) if 900<d<1200 else sys.exit(f"FAIL duration {d}")'
expect 'trim past end with music' 400 "$(status "$ID" "{\"trim\":{\"start\":100,\"end\":101},\"background\":\"#000000\",\"music\":{\"id\":\"$MUSIC\",\"volume\":0.3}}")"

# Original stays at full level: the same render with a near-silent bed must match one with no bed.
PLAIN=$(newid "$(render "$ID" '{"trim":{"start":0,"end":6},"background":"#000000"}')")
QUIET=$(newid "$(render "$ID" "{\"trim\":{\"start\":0,\"end\":6},\"background\":\"#000000\",\"music\":{\"id\":\"$MUSIC\",\"volume\":0}}")")
A=$(meandb "$(media "$PLAIN")"); B=$(meandb "$(media "$QUIET")")
python3 -c 'import sys; a,b=map(float,sys.argv[1:]); assert abs(a-b)<1,(a,b); print("ok   original level kept:",a,"dB vs",b,"dB with bed at volume 0")' "$A" "$B"

expect 'delete music' 200 "$(code -X DELETE "$BASE/api/brand/music/$MUSIC")"
expect 'music gone' 404 "$(code "$BASE/api/brand/music/$MUSIC")"
expect 'music file gone' 0 "$(ls "$WORK/data/brand/music" | grep -c "$MUSIC" || true)"
expect 'deleted music in render' 400 "$(status "$ID" "{$TRIM,\"music\":{\"id\":\"$MUSIC\",\"volume\":0.3}}")"
expect 'delete watermark' 200 "$(code -X DELETE "$BASE/api/brand/watermark")"
expect 'watermark gone' 404 "$(code "$BASE/api/brand/watermark")"
expect 'tmp files cleaned' 0 "$(ls "$WORK/data/tmp" | wc -l)"
expect 'no .part left' 0 "$(ls "$WORK/data/media" | grep -c '\.part$' || true)"

echo '== 10 kill server'
stop
curl -s -o /dev/null --max-time 2 "$BASE/library" && { echo 'FAIL server still up'; exit 1; } || echo 'ok   stopped'
echo ALL_PASSED
