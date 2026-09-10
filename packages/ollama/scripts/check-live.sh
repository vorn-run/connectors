#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

HOST="${OLLAMA_HOST:-http://localhost:11434}"
HOST="${HOST%/}"
HOST="${HOST%/api}"
case "$HOST" in http://*|https://*) ;; *) HOST="http://$HOST" ;; esac
API="$HOST/api"
MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
HEADERS=$(mktemp)
trap 'rm -f "$HEADERS" /tmp/ollama-embed-error' EXIT
if [ -n "${OLLAMA_API_KEY:-}" ]; then
  printf 'header = "Authorization: Bearer %s"\n' "$OLLAMA_API_KEY" > "$HEADERS"
fi

if ! version=$(curl -sS -m 5 -K "$HEADERS" "$API/version" 2>/dev/null); then
  echo "no Ollama server answered GET $API/version; skipping live checks"
  exit 0
fi
echo "GET /version ok: $version"

# A failure carries an error string, so success is read from the JSON, not the exit code.
call() {
  local method=$1 path=$2 data=${3:-}
  local body
  if [ -n "$data" ]; then
    body=$(curl -sS -m 120 -X "$method" -K "$HEADERS" -H "content-type: application/json" "$API/$path" -d "$data")
  else
    body=$(curl -sS -m 30 -X "$method" -K "$HEADERS" "$API/$path")
  fi
  if ! printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let r;try{r=JSON.parse(d||"{}")}catch{return}if(r&&typeof r.error==="string"){console.error(r.error);process.exit(1)}})'; then
    return 1
  fi
  echo "$method /$path ok"
}

call GET tags || { echo "GET /tags failed"; exit 1; }
call POST show "{\"model\":\"$MODEL\"}" || { echo "POST /show failed"; exit 1; }
call GET ps || { echo "GET /ps failed"; exit 1; }

EMBED_MODEL="${OLLAMA_EMBED_MODEL:-$MODEL}"
if ! call POST embed "{\"model\":\"$EMBED_MODEL\",\"input\":\"hello\"}" 2>/tmp/ollama-embed-error; then
  if grep -q "does not support embeddings" /tmp/ollama-embed-error; then
    echo "POST /embed skipped: the runner for $EMBED_MODEL does not serve embeddings; set OLLAMA_EMBED_MODEL to one that does"
  else
    cat /tmp/ollama-embed-error
    echo "POST /embed failed"
    exit 1
  fi
fi

if [ -f packages/ollama/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  OLLAMA_HOST="$HOST" node "$CLI" check ./packages/ollama/dist/index.js --live
else
  echo "packages/ollama/dist/index.js is not built; skipping vorn-connector check --live"
fi
