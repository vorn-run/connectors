#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${AIRTABLE_API_KEY:-}" ]; then
  echo "AIRTABLE_API_KEY is not set; skipping live checks"
  exit 0
fi

API=https://api.airtable.com/v0

# A failure carries an error field, so success is read from the JSON, not the exit code.
call() {
  local path=$1
  shift
  local body
  body=$(curl -sS -G -H "Authorization: Bearer $AIRTABLE_API_KEY" "$API/$path" "$@")
  if ! printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);if(r.error){const e=r.error;console.error(typeof e==="string"?e:`${e.type}: ${e.message}`);process.exit(1)}})'; then
    echo "GET /$path failed"
    exit 1
  fi
  echo "GET /$path ok"
}

call meta/bases

if [ -n "${AIRTABLE_BASE_ID:-}" ]; then
  call "meta/bases/$AIRTABLE_BASE_ID/tables"
else
  echo "AIRTABLE_BASE_ID is not set; skipping the base schema and record reads"
fi

if [ -n "${AIRTABLE_BASE_ID:-}" ] && [ -n "${AIRTABLE_TABLE:-}" ]; then
  call "$AIRTABLE_BASE_ID/$AIRTABLE_TABLE" --data-urlencode maxRecords=5
else
  echo "AIRTABLE_TABLE is not set; skipping the record list"
fi

if [ -n "${AIRTABLE_BASE_ID:-}" ] && [ -n "${AIRTABLE_TABLE:-}" ] && [ -n "${AIRTABLE_RECORD_ID:-}" ]; then
  call "$AIRTABLE_BASE_ID/$AIRTABLE_TABLE/$AIRTABLE_RECORD_ID"
else
  echo "AIRTABLE_RECORD_ID is not set; skipping the single record read"
fi

if [ -f packages/airtable/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  node "$CLI" check packages/airtable/dist/index.js --live
else
  echo "packages/airtable/dist/index.js is not built; skipping vorn-connector check --live"
fi
