#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

UA="${RSS_USER_AGENT:-vorn-connector-rss/live-check (+https://vorn.run)}"
ACCEPT='application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5'
FEEDS=(
  https://www.rssboard.org/files/sample-rss-2.xml
  https://github.com/nodejs/node/releases.atom
  https://export.arxiv.org/rss/cs.AI
  https://huggingface.co/blog/feed.xml
  'https://news.google.com/rss/search?q=site:anthropic.com&hl=en-US&gl=US&ceid=US:en'
)
PAGE=https://www.rssboard.org/
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

if ! curl -sS -m 10 -o /dev/null "$PAGE" 2>/dev/null && ! curl -sS -m 10 -o /dev/null https://github.com/ 2>/dev/null; then
  echo "offline: neither www.rssboard.org nor github.com answered; skipping live checks"
  exit 0
fi

failed=0
for url in "${FEEDS[@]}"; do
  if ! code=$(curl -sSL -m 20 --max-filesize 5242880 -A "$UA" -H "Accept: $ACCEPT" -o "$BODY" -w '%{http_code}' "$url"); then
    echo "FAIL $url: the request failed"; failed=1; continue
  fi
  if [ "$code" != 200 ]; then
    echo "FAIL $url: HTTP $code"; failed=1; continue
  fi
  root=$(head -c 4096 "$BODY" | grep -o -m1 -E '<(rss|feed|rdf:RDF)[ >]' || true)
  if [ -z "$root" ]; then
    echo "FAIL $url: no rss, feed or rdf:RDF root element"; failed=1; continue
  fi
  items=$(grep -o -E '<(item|entry)[ >]' "$BODY" | wc -l | tr -d ' ')
  if [ "$items" -eq 0 ]; then
    echo "FAIL $url: no items"; failed=1; continue
  fi
  echo "ok   $url: ${root%?}> with $items items, $(wc -c < "$BODY" | tr -d ' ') bytes"
done

sample=${FEEDS[0]}
etag=$(curl -sS -m 20 -A "$UA" -D - -o /dev/null "$sample" | tr -d '\r' | awk 'tolower($1) == "etag:" { sub(/^[^:]*: */, ""); print }')
if [ -n "$etag" ]; then
  code=$(curl -sS -m 20 -A "$UA" -H "If-None-Match: $etag" -o /dev/null -w '%{http_code}' "$sample")
  if [ "$code" = 304 ]; then
    echo "ok   $sample: 304 Not Modified on If-None-Match"
  else
    echo "note $sample: If-None-Match answered $code, so every poll of it downloads the whole feed"
  fi
fi

if curl -sSL -m 20 -A "$UA" -o "$BODY" "$PAGE"; then
  links=$(grep -i -o -E '<link[^>]*>' "$BODY" | grep -i 'rel="alternate"' | grep -i -E 'type="application/(rss\+xml|atom\+xml|feed\+json)"' || true)
  if [ -n "$links" ]; then
    echo "ok   $PAGE: find feeds sees $(printf '%s\n' "$links" | wc -l | tr -d ' ') autodiscovery link(s)"
    printf '%s\n' "$links" | grep -o -i -E 'href="[^"]*"' | sed 's/^/       /'
  else
    echo "FAIL $PAGE: no link rel=\"alternate\" for RSS, Atom or JSON Feed"; failed=1
  fi
else
  echo "FAIL $PAGE: the request failed"; failed=1
fi

if [ -f packages/rss/dist/index.js ]; then
  CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
  RSS_FEEDS="${RSS_FEEDS:-$(printf '%s\n' "${FEEDS[@]}")}" RSS_LOOKBACK_HOURS="${RSS_LOOKBACK_HOURS:-168}" \
    node "$CLI" check ./packages/rss/dist/index.js --live || failed=1
else
  echo "packages/rss/dist/index.js is not built; skipping vorn-connector check --live"
fi

exit "$failed"
