#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${X_ACCESS_TOKEN:-}" ]; then
  echo "X_ACCESS_TOKEN is not set; skipping live checks (set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET from the app's Keys and tokens tab to run them)"
  exit 0
fi

for v in X_API_KEY X_API_SECRET X_ACCESS_TOKEN_SECRET; do
  if [ -z "${!v:-}" ]; then
    echo "$v is not set; skipping live checks (all four OAuth 1.0a credentials are needed)"
    exit 0
  fi
done

export X_SEARCH_QUERY="${X_SEARCH_QUERY:-from:xdevelopers -is:retweet}"

yarn workspace @vornrun/connector-x build
# The CLI is called by its real path: behind a linked node_modules its entry-point guard otherwise does nothing.
CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
node "$CLI" check packages/x/dist/index.js --live
