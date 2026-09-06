#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is not set; skipping live checks"
  exit 0
fi

API=https://api.anthropic.com/v1

# A failure carries a top-level error object, so success is read from the JSON, not the exit code.
call() {
  local method=$1 path=$2 data=${3:-}
  local body
  if [ -n "$data" ]; then
    body=$(curl -sS -X "$method" -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" "$API/$path" -d "$data")
  else
    body=$(curl -sS -X "$method" -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" "$API/$path")
  fi
  if ! printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let r;try{r=JSON.parse(d.split("\n")[0]||"{}")}catch{return}if(r&&r.type==="error"){console.error(`${r.error.type}: ${r.error.message}`);process.exit(1)}})'; then
    echo "$method /$path failed"
    exit 1
  fi
  echo "$method /$path ok"
}

call GET models
call GET models/claude-sonnet-5
call POST messages/count_tokens '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hello"}]}'
call GET "messages/batches?limit=5"

if [ -n "${ANTHROPIC_BATCH_ID:-}" ]; then
  call GET "messages/batches/$ANTHROPIC_BATCH_ID"
  call GET "messages/batches/$ANTHROPIC_BATCH_ID/results"
else
  echo "ANTHROPIC_BATCH_ID is not set; skipping the batch reads"
fi

if [ -f packages/anthropic/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  node "$CLI" check packages/anthropic/dist/index.js --live
else
  echo "packages/anthropic/dist/index.js is not built; skipping vorn-connector check --live"
fi
