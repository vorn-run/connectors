#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${HUBSPOT_ACCESS_TOKEN:-}" ]; then
  echo "HUBSPOT_ACCESS_TOKEN is not set; skipping live checks"
  exit 0
fi

API=https://api.hubapi.com

# A failure carries status "error", so success is read from the JSON, not the exit code.
check() {
  local label=$1
  local body=$2
  if ! printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);if(r.status==="error"){console.error(`${r.category??""}: ${r.message} (${r.correlationId??""})`);process.exit(1)}})'; then
    echo "$label failed"
    exit 1
  fi
  echo "$label ok"
}

get() {
  local path=$1
  shift
  check "GET /$path" "$(curl -sS -G -H "Authorization: Bearer $HUBSPOT_ACCESS_TOKEN" "$API/$path" "$@")"
}

post() {
  local path=$1
  local json=$2
  check "POST /$path" "$(curl -sS -X POST -H "Authorization: Bearer $HUBSPOT_ACCESS_TOKEN" -H "Content-Type: application/json" -d "$json" "$API/$path")"
}

get crm/v3/owners --data-urlencode limit=5
get crm/v3/pipelines/deals
post crm/v3/objects/contacts/search '{"query":"test","limit":5}'

if [ -n "${HUBSPOT_CONTACT_ID:-}" ]; then
  get "crm/v3/objects/contacts/$HUBSPOT_CONTACT_ID"
else
  echo "HUBSPOT_CONTACT_ID is not set; skipping GET /crm/v3/objects/contacts/:id"
fi

if [ -f packages/hubspot/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  node "$CLI" check packages/hubspot/dist/index.js --live
else
  echo "packages/hubspot/dist/index.js is not built; skipping vorn-connector check --live"
fi
