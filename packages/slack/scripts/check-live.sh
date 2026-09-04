#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  echo "SLACK_BOT_TOKEN is not set; skipping live checks"
  exit 0
fi

API=https://slack.com/api

# Slack answers 200 on failure, so success is read from the ok field.
call() {
  local method=$1
  shift
  local body
  body=$(curl -sS -G -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$API/$method" "$@")
  if ! printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);if(!r.ok){console.error(r.error);process.exit(1)}})'; then
    echo "$method failed"
    exit 1
  fi
  echo "$method ok"
}

call auth.test
call conversations.list --data-urlencode types=public_channel,private_channel --data-urlencode limit=20

if [ -n "${SLACK_CHANNEL_ID:-}" ]; then
  call conversations.info --data-urlencode "channel=$SLACK_CHANNEL_ID" --data-urlencode include_num_members=true
else
  echo "SLACK_CHANNEL_ID is not set; skipping conversations.info"
fi

if [ -n "${SLACK_USER_EMAIL:-}" ]; then
  call users.lookupByEmail --data-urlencode "email=$SLACK_USER_EMAIL"
else
  echo "SLACK_USER_EMAIL is not set; skipping users.lookupByEmail"
fi

if [ -n "${SLACK_USER_ID:-}" ]; then
  call users.info --data-urlencode "user=$SLACK_USER_ID"
else
  echo "SLACK_USER_ID is not set; skipping users.info"
fi

if [ -f packages/slack/dist/index.js ]; then
  node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/slack/dist/index.js --live
else
  echo "packages/slack/dist/index.js is not built; skipping vorn-connector check --live"
fi
