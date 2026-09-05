#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "DISCORD_BOT_TOKEN is not set; skipping live checks (create one under Bot > Reset Token at https://discord.com/developers/applications)"
  exit 0
fi

API=https://discord.com/api/v10
UA="DiscordBot (https://github.com/vorn-run/connectors, check-live)"

# Discord answers errors as { code, message }, so success is read from the status line, not the exit code.
call() {
  local path=$1
  local out status
  out=$(curl -sS -w '\n%{http_code}' -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "User-Agent: $UA" "$API/$path")
  status=${out##*$'\n'}
  body=${out%$'\n'*}
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "GET /$path failed with $status: $body"
    exit 1
  fi
  echo "GET /$path ok"
}

call users/@me
SELF_ID=$(printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).id))')

if [ -n "${DISCORD_GUILD_ID:-}" ]; then
  call "guilds/$DISCORD_GUILD_ID/channels"
  call "guilds/$DISCORD_GUILD_ID/members/${DISCORD_USER_ID:-$SELF_ID}"
else
  echo "DISCORD_GUILD_ID is not set; skipping GET /guilds/:id/channels and /guilds/:id/members/:user"
fi

if [ -n "${DISCORD_CHANNEL_ID:-}" ]; then
  call "channels/$DISCORD_CHANNEL_ID"
else
  echo "DISCORD_CHANNEL_ID is not set; skipping GET /channels/:id"
fi

if [ -f packages/discord/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  node "$CLI" check packages/discord/dist/index.js --live
else
  echo "packages/discord/dist/index.js is not built; skipping vorn-connector check --live"
fi
