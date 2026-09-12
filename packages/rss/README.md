# @vornrun/connector-rss

Trigger Vorn workflows when an item appears in any of your web feeds, and
read one feed, read several at once with a keyword filter, or find the feeds
a web page declares from a workflow step. Reads RSS 2.0, RSS 1.0 (RDF), Atom
1.0 and JSON Feed 1.1 at any `http` or `https` address, and gives every one of
them the same item shape.

## Signing in

Nothing to sign in with: feeds are public and take no credentials, so the
connector declares `auth: { rung: 'none' }`.

## Settings

| Setting | Env | Required | What it is |
| --- | --- | --- | --- |
| `feeds` | `RSS_FEEDS` | no | Feed addresses, one per line or comma separated. The `newItem` trigger polls them, and `readFeeds` reads them when its `urls` is empty. A value with no scheme gets `https://` in front. |
| `lookbackHours` | `RSS_LOOKBACK_HOURS` | no | How far back the first poll of a feed reaches, a whole number of hours from 1 to 8760; `24` by default. |
| `userAgent` | `RSS_USER_AGENT` | no | Sent as `User-Agent` on every request, `vorn-connector-rss/<version> (+https://vorn.run)` by default; some hosts refuse requests without one. |

## Fetching

Every request is a `GET` with `Accept: application/rss+xml,
application/atom+xml, application/feed+json, application/xml;q=0.9,
text/xml;q=0.8, */*;q=0.5`, following redirects, through the SDK's fetch,
which retries 408, 425, 429 and 5xx. Each feed gets 20 seconds, covering
headers and body, and at most 5 MB. At most six feeds are in flight at once.
Any scheme other than `http` and `https` is refused before a request is made;
private and intranet hosts are allowed, since the connector runs on your
machine.

The body is decoded by its byte-order mark, else the `charset` of
`Content-Type`, else the XML declaration's `encoding`, else UTF-8. The
connector parses feeds itself, with no XML library. It skips a `<!DOCTYPE>`
unread, internal subset included, and expands only the XML entities, numeric
references and a fixed table of common HTML names. An entity a feed declares
for itself stays as written, so there is nothing to resolve and nothing to
fetch. The parser is tolerant: an unclosed element ends at its parent's end
tag, a stray `&` or `<` is text, and a feed cut off mid-item keeps its
complete items.

A feed that fails is reported with its address and one of these reasons:
`HTTP <status>`, `timed out after 20 s`, `larger than 5 MB`, `not a feed (the
body starts with "<html"); try find feeds`, `unparseable: <what>`, `refused,
only http and https feeds are read`, or the network error. It never costs the
other feeds their items.

## The item shape

| Field | RSS 2.0 | RSS 1.0 | Atom | JSON Feed |
| --- | --- | --- | --- | --- |
| `id` | `guid` | `rdf:about` | `id` | `id` |
| `title` | `title`, else `media:title` | `title` | `title` | `title` |
| `url` | `link`, else a permalink `guid`, else `atom:link rel="alternate"` | `link` | `link rel="alternate"` (no `rel` counts), `text/html` first | `url`, else `external_url` |
| `author` | `author` (the name of `jo@example.com (Jo)`), else `dc:creator` | `dc:creator` | entry `author/name`, else the feed's | `authors[].name`, else `author.name` |
| `publishedAt` | `pubDate`, else `dc:date` | `dc:date` | `published`, else `updated` | `date_published` |
| `updatedAt` | `atom:updated` | | `updated` | `date_modified` |
| `summary` | `description`, else `media:description` | `description`, else `dc:description` | `summary`, else `content` | `summary`, else `content_text`, else `content_html` |
| `html` | `content:encoded`, else `description` | `content:encoded`, else `description` | `content`, else `summary` | `content_html`, else `content_text` escaped |
| `categories` | `category`, `dc:subject` | `dc:subject` | `category/@term` | `tags` |

An item with no id takes its `url`, else `sha256:` and 16 hex characters of a
hash of its title and date. `summary` is plain text cut to 2000 characters,
`publishedAt` and `updatedAt` are ISO 8601 in UTC or empty, and every item
carries `feedTitle` and `feedUrl`, the address as configured. Relative links
resolve against the nearest `xml:base`, else the feed's address after
redirects. Dates are read in RFC 822 form, with or without seconds, a
two-digit year, and a zone name, military letter or offset, and in RFC 3339
form. A missing or unknown zone name reads as UTC.

## Triggers

### `newItem` — an item appears in any of the connection's feeds

Polls every address in `feeds`. Each feed sends back the `ETag` and
`Last-Modified` it last answered, as `If-None-Match` and `If-Modified-Since`,
so a feed that has not changed answers 304 and costs no download. The
cursor keeps, per feed, the newest date seen, those validators, and hashed
ids of the items on that date and of every dateless item, up to 1000.

- The first poll of a feed fires only for the dated items within
  `lookbackHours` (or from the host's `since` when it gives one), so a new
  connection does not fire hundreds of runs. Dateless items are only
  remembered.
- After that an item fires when it is newer than the newest date seen, or on
  that date with a new id, and an item with no date fires once, by its id.
- An item dated before the newest one seen never fires, so a post
  backdated after a newer one went out is missed.
- Items are keyed `<feedUrl> <id>` and come oldest first. A feed that fails
  is written to stderr as `rss: <url>: <reason>` and keeps its state; the
  poll throws only when every feed failed.

Each item carries `title` (else the address), `url`, `description` (the
summary), `assignee` (the author), `labels` (the categories) and `updatedAt`
(published, else updated), with `id`, `author`, `publishedAt`, `summary`,
`html`, `categories`, `feedTitle` and `feedUrl` for templates.

## Actions

| Action | Idempotent | What it does |
| --- | --- | --- |
| `readFeed` | yes | Reads `url`, keeps items within `sinceHours` when given (dateless ones are left out then), and returns the newest `limit` (1 to 100, default 20), dateless last. Returns `feed` (`{ title, url, siteUrl, format }`, `format` one of `rss2`, `rss1`, `atom`, `json`), `items` and `count`. A failure throws `<url>: <reason>`. |
| `readFeeds` | yes | Reads `urls` (one per line or comma separated; the connection's `feeds` when empty), six at a time. For each feed it keeps items within `sinceHours`, then those matching any of the comma-separated `keywords` as a whole word or phrase in the title or summary, ignoring case, then the newest `perFeed` (default 20). One copy per address is kept, the newest, and the result is sorted newest first. Returns `items`, `count`, `feedsOk` and `feedsFailed` (`[{ url, error }]`); fails naming every failed feed when fewer than `minFeedsOk` (default 1) answer. |
| `findFeeds` | yes | Fetches `url` asking for HTML first. When the body is itself a feed, returns that address alone. Otherwise returns every `<link rel="alternate">` whose type is `application/rss+xml`, `application/atom+xml` or `application/feed+json`, resolved against `<base href>` or the page. `application/json` counts only when no `application/feed+json` link exists. Returns `feeds` (`[{ url, title, type, format }]`), `count` and `isFeed`. |

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check ./packages/rss/dist/index.js --mock --receipt packages/rss/verified.json
```

`packages/rss/scripts/check.sh` runs exactly this. Tests make no network
calls: every request is answered from recorded fixtures in
`packages/rss/fixtures`, one per format plus a malformed feed, a feed whose
DOCTYPE declares external entities, and a page with autodiscovery links. The
receipt leaves out `dedupe`, because the check cannot replay the sample of a
trigger that keeps its own cursor. The trigger tests poll twice with the
returned cursor instead.

`packages/rss/scripts/check-live.sh` needs no credentials, so it always runs
for real, and exits 0 with a note only when the machine is offline. It reads
the RSS Advisory Board's sample RSS 2.0 file, the Node.js releases Atom feed,
arXiv cs.AI, the Hugging Face blog and a Google News search feed. It checks
that the sample file answers 304 to its own ETag and runs the find-feeds
probe on https://www.rssboard.org/. Then it runs `vorn-connector check
--live` against the built package with `RSS_FEEDS` set to those five feeds,
which polls the trigger twice and calls each action with its sample.

## Built from

These specifications were the only source.

- RSS 2.0 specification: https://www.rssboard.org/rss-specification
- RSS 1.0 specification: https://web.resource.org/rss/1.0/spec
- RSS 1.0 content module (`content:encoded`): https://web.resource.org/rss/1.0/modules/content/
- RSS 1.0 Dublin Core module (`dc:creator`, `dc:date`, `dc:subject`): https://web.resource.org/rss/1.0/modules/dc/
- Atom, RFC 4287: https://www.rfc-editor.org/rfc/rfc4287
- JSON Feed 1.1: https://www.jsonfeed.org/version/1.1/
- RSS autodiscovery: https://www.rssboard.org/rss-autodiscovery
- HTTP conditional requests, RFC 9110: https://www.rfc-editor.org/rfc/rfc9110#name-conditional-requests
- RFC 822 date and time: https://www.rfc-editor.org/rfc/rfc822#section-5
- RFC 3339 date and time: https://www.rfc-editor.org/rfc/rfc3339
