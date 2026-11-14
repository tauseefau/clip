# Sourced by the verify scripts. POST a render, wait for its background job, and print "<job json>\n<code>":
# 201 when it finished, 500 when it failed, or the POST's own response when it was refused (e.g. 400).
render() {
  local out job s
  out=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -d "$2" "$BASE/api/recordings/$1/render")
  [ "$(tail -1 <<<"$out")" = 202 ] || { echo "$out"; return; }
  job=$(sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p' <<<"$out")
  while s=$(curl -s "$BASE/api/renders/$job"); grep -q '"state":"\(queued\|running\)"' <<<"$s"; do sleep 0.2; done
  grep -q '"state":"done"' <<<"$s" && printf '%s\n201\n' "$s" || printf '%s\n500\n' "$s"
}
