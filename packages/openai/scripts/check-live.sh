#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY is not set; skipping live checks (create one at https://platform.openai.com/api-keys)"
  exit 0
fi

API=https://api.openai.com/v1
HEADERS=(-H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json")
if [ -n "${OPENAI_ORGANIZATION:-}" ]; then HEADERS+=(-H "OpenAI-Organization: $OPENAI_ORGANIZATION"); fi
if [ -n "${OPENAI_PROJECT:-}" ]; then HEADERS+=(-H "OpenAI-Project: $OPENAI_PROJECT"); fi

# A failure carries an error object, so success is read from the JSON, not the exit code.
call() {
  local method=$1 path=$2 data=${3:-}
  local body
  if [ -n "$data" ]; then
    body=$(curl -sS -X "$method" "${HEADERS[@]}" "$API/$path" -d "$data")
  else
    body=$(curl -sS -X "$method" "${HEADERS[@]}" "$API/$path")
  fi
  if ! printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);if(r.error){console.error(`${r.error.type}/${r.error.code??""}: ${r.error.message}`);process.exit(1)}})'; then
    echo "$method /$path failed"
    exit 1
  fi
  echo "$method /$path ok"
}

call GET models
call GET models/gpt-4o-mini
call GET 'files?limit=5'
call POST moderations '{"input":"hello"}'
call POST embeddings '{"model":"text-embedding-3-small","input":"hello"}'

if [ -n "${OPENAI_BATCH_ID:-}" ]; then
  call GET "batches/$OPENAI_BATCH_ID"
else
  echo "OPENAI_BATCH_ID is not set; skipping GET /batches/:id"
fi

if [ -f packages/openai/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  node "$CLI" check packages/openai/dist/index.js --live
else
  echo "packages/openai/dist/index.js is not built; skipping vorn-connector check --live"
fi
