#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

for name in JIRA_SITE_URL JIRA_EMAIL JIRA_API_TOKEN; do
  if [ -z "${!name:-}" ]; then
    echo "$name is not set; skipping live checks (create a token at https://id.atlassian.com/manage-profile/security/api-tokens)"
    exit 0
  fi
done

API="${JIRA_SITE_URL%/}/rest/api/3"

# A failure carries an error collection, so success is read from the JSON, not the exit code.
call() {
  local path=$1
  shift
  local body
  body=$(curl -sS -G -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "Accept: application/json" "$API/$path" "$@")
  if ! printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let r;try{r=JSON.parse(d)}catch{console.error("not JSON: "+d.slice(0,200));process.exit(1)}if(r.errorMessages||r.errors){console.error([...(r.errorMessages??[]),...Object.entries(r.errors??{}).map(([k,v])=>`${k}: ${v}`)].join("; "));process.exit(1)}})'; then
    echo "GET /$path failed"
    exit 1
  fi
  echo "GET /$path ok"
}

call myself
call project/search --data-urlencode maxResults=5
call search/jql --data-urlencode 'jql=created >= "1970-01-01" order by created DESC' --data-urlencode maxResults=5 --data-urlencode fields=summary,status,created,updated

if [ -n "${JIRA_ISSUE_KEY:-}" ]; then
  call "issue/$JIRA_ISSUE_KEY" --data-urlencode fields=summary,status
  call "issue/$JIRA_ISSUE_KEY/transitions"
else
  echo "JIRA_ISSUE_KEY is not set; skipping GET /issue/:key and its transitions"
fi

if [ -f packages/jira/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  node "$CLI" check packages/jira/dist/index.js --live
else
  echo "packages/jira/dist/index.js is not built; skipping vorn-connector check --live"
fi
