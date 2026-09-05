#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

# With no key in the environment, borrow the test key a `stripe login` profile holds, as the connector does.
if [ -z "${STRIPE_API_KEY:-}" ] && command -v stripe >/dev/null 2>&1; then
  STRIPE_API_KEY="$(stripe config --list 2>/dev/null | sed -n 's/^ *test_mode_api_key = "\(.*\)"$/\1/p' | head -n 1)"
  export STRIPE_API_KEY
fi

if [ -z "${STRIPE_API_KEY:-}" ]; then
  echo "STRIPE_API_KEY is not set and no stripe CLI profile holds a test key; skipping live checks"
  exit 0
fi

case "$STRIPE_API_KEY" in
  sk_live_*|rk_live_*)
    echo "STRIPE_API_KEY is a live key; the live checks only run against a sandbox"
    exit 1
    ;;
esac

API=https://api.stripe.com/v1
VERSION=2026-08-26.dahlia

# A failure carries an error object, so success is read from the JSON, not the exit code.
call() {
  local path=$1
  shift
  local body
  body=$(curl -sS -G -H "Authorization: Bearer $STRIPE_API_KEY" -H "Stripe-Version: $VERSION" "$API/$path" "$@")
  if ! printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);if(r.error){console.error(`${r.error.type}/${r.error.code??""}: ${r.error.message}`);process.exit(1)}})'; then
    echo "GET /$path failed"
    exit 1
  fi
  echo "GET /$path ok"
}

call balance
call customers --data-urlencode limit=5
call charges --data-urlencode limit=5

if [ -n "${STRIPE_CUSTOMER_ID:-}" ]; then
  call "customers/$STRIPE_CUSTOMER_ID"
else
  echo "STRIPE_CUSTOMER_ID is not set; skipping GET /customers/:id"
fi

if [ -f packages/stripe/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  node "$CLI" check packages/stripe/dist/index.js --live
else
  echo "packages/stripe/dist/index.js is not built; skipping vorn-connector check --live"
fi
