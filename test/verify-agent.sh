#!/usr/bin/env bash
# End-to-end check of bin/clip and bin/clip-mcp against a running Clip (default http://localhost:3001).
# Creates a few recordings and deletes them again; existing recordings are only read.
# Usage: CLIP_URL=http://localhost:3001 test/verify-agent.sh
set -euo pipefail

export CLIP_URL=${CLIP_URL:-http://localhost:3001}
BIN=$(cd "$(dirname "$0")/../bin" && pwd)
WORK=$(mktemp -d)
CREATED=()
cleanup() { for id in "${CREATED[@]}"; do "$BIN/clip" rm "$id" >/dev/null 2>&1 || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

ok() { echo "ok   $*"; }
die() { echo "FAIL $*"; exit 1; }
media() { echo "$CLIP_URL/media/$1.webm${CLIP_TOKEN:+?token=$CLIP_TOKEN}"; }
probe() { ffprobe -v error "$@"; }
newid() { awk '{print $1}' <<<"$1"; }

echo '== 1 syntax'
node --check "$BIN/clip" && node --check "$BIN/clip-mcp" && ok 'node --check'

echo '== 2 ls matches the API'
"$BIN/clip" ls | tee "$WORK/ls"
rows=$(wc -l <"$WORK/ls")
api=$(curl -s ${CLIP_TOKEN:+-H "x-clip-token: $CLIP_TOKEN"} "$CLIP_URL/api/recordings" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[ "$rows" -ge 1 ] && [ "$rows" = "$api" ] && ok "ls rows $rows = api $api" || die "ls rows $rows, api $api"
ID=$(head -1 "$WORK/ls" | awk '{print $1}')

echo '== 3 url'
url=$("$BIN/clip" url "$ID"); echo "$url"
[ "$url" = "$CLIP_URL/watch/$ID" ] && ok url || die "url $url"

echo '== 4 render 9:16 with text'
out=$("$BIN/clip" render "$ID" --trim 0-3 --aspect 9:16 --text "Agent test|0.5|0.8|64|#ffffff|bold"); echo "$out"
R=$(newid "$out"); CREATED+=("$R")
size=$(probe -select_streams v -show_entries stream=width,height -of csv=s=x:p=0 "$(media "$R")")
[ "$size" = 1080x1920 ] && ok "render is $size" || die "render size $size"
"$BIN/clip" rm "$R"

echo '== 5 silence'
"$BIN/clip" silence "$ID" | tee "$WORK/sil"
python3 -c 'import json,sys; assert "cuts" in json.load(open(sys.argv[1]))' "$WORK/sil" && ok 'silence has cuts'

echo '== 6 cuts on a 14 s upload'
ffmpeg -v error -y -f lavfi -i "testsrc=size=640x360:rate=30:duration=14" -f lavfi -i "sine=frequency=440:duration=14" \
  -c:v libvpx-vp9 -b:v 400k -c:a libopus "$WORK/t14.webm"
out=$("$BIN/clip" upload "$WORK/t14.webm" --title 'agent verify 14s'); echo "$out"
U=$(newid "$out"); CREATED+=("$U")
out=$("$BIN/clip" render "$U" --cuts "0-4,8-12"); echo "$out"
C=$(newid "$out"); CREATED+=("$C")
dur=$(probe -show_entries format=duration -of csv=p=0 "$(media "$C")")
python3 -c 'import sys; d=float(sys.argv[1]); print("duration", d); assert abs(d-8) < 0.3' "$dur" && ok 'cut render ≈ 8 s'

echo '== 7 MCP handshake'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_recordings","arguments":{}}}' \
  | timeout 20 "$BIN/clip-mcp" >"$WORK/mcp"
cut -c1-200 "$WORK/mcp"
python3 - "$WORK/mcp" <<'EOF'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1])]
assert len(lines) == 3, len(lines)
by = {m["id"]: m for m in lines}
assert by[1]["result"]["serverInfo"]["name"] == "clip"
assert len(by[2]["result"]["tools"]) == 9, [t["name"] for t in by[2]["result"]["tools"]]
assert isinstance(json.loads(by[3]["result"]["content"][0]["text"]), list)
print("ok   3 lines, 9 tools, tool text is JSON")
EOF

echo '== 8 MCP bad tool and bad method'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}' '{"jsonrpc":"2.0","id":2,"method":"bogus"}' \
  | timeout 20 "$BIN/clip-mcp" | tee "$WORK/bad"
python3 - "$WORK/bad" <<'EOF'
import json, sys
by = {m["id"]: m for m in map(json.loads, open(sys.argv[1]))}
assert by[1]["result"]["isError"] is True
assert by[2]["error"]["code"] == -32601
print("ok   isError:true and -32601")
EOF

echo '== 9 unreachable server'
set +e; CLIP_URL=http://127.0.0.1:59999 "$BIN/clip" ls 2>"$WORK/err"; code=$?; set -e
cat "$WORK/err"
[ "$code" = 1 ] && grep -q 'cannot reach' "$WORK/err" && ! grep -q '    at ' "$WORK/err" && ok 'exit 1, no traceback' || die "exit $code"

echo 'ALL OK'
