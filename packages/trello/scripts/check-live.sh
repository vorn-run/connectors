#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${TRELLO_API_KEY:-}" ] || [ -z "${TRELLO_TOKEN:-}" ]; then
  echo "TRELLO_API_KEY or TRELLO_TOKEN is not set; skipping live checks (create both at https://trello.com/power-ups/admin)"
  exit 0
fi

API=https://api.trello.com/1

# A failure is a non-2xx status with a plain-text body, so the status is read alongside the body.
call() {
  local path=$1
  shift
  local out status body
  out=$(curl -sS -G -w '\n%{http_code}' "$API/$path" --data-urlencode "key=$TRELLO_API_KEY" --data-urlencode "token=$TRELLO_TOKEN" "$@")
  status=${out##*$'\n'}
  body=${out%$'\n'*}
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "GET /$path failed: $status $body"
    exit 1
  fi
  echo "GET /$path ok"
  printf '%s' "$body"
}

call members/me --data-urlencode fields=id,username,fullName >/dev/null
call members/me/boards --data-urlencode filter=open --data-urlencode fields=id,name,shortUrl >/dev/null
call search --data-urlencode query=test --data-urlencode modelTypes=cards --data-urlencode cards_limit=5 >/dev/null

if [ -n "${TRELLO_BOARD_ID:-}" ]; then
  call "boards/$TRELLO_BOARD_ID/lists" --data-urlencode fields=id,name,closed >/dev/null
  echo "Newest updateCard:idList action, to confirm the listBefore/listAfter shape:"
  call "boards/$TRELLO_BOARD_ID/actions" --data-urlencode filter=updateCard:idList --data-urlencode limit=1 --data-urlencode fields=id,type,date,data
  echo
else
  echo "TRELLO_BOARD_ID is not set; skipping GET /boards/:id/lists and the actions probe"
fi

if [ -n "${TRELLO_LIST_ID:-}" ]; then
  call "lists/$TRELLO_LIST_ID/cards" >/dev/null
else
  echo "TRELLO_LIST_ID is not set; skipping GET /lists/:id/cards"
fi

if [ -n "${TRELLO_CARD_ID:-}" ]; then
  call "cards/$TRELLO_CARD_ID" --data-urlencode fields=id,name,idList,due,dueComplete,shortUrl >/dev/null
else
  echo "TRELLO_CARD_ID is not set; skipping GET /cards/:id"
fi

if [ -f packages/trello/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  node "$CLI" check packages/trello/dist/index.js --live
else
  echo "packages/trello/dist/index.js is not built; skipping vorn-connector check --live"
fi
