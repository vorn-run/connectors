id: rss

# RSS connector

Web feeds, not one vendor: RSS 2.0, RSS 1.0 (RDF), Atom 1.0 and JSON Feed
1.1 documents at any `http` or `https` URL. One trigger fires on new items
across the connection's feeds; three idempotent actions read one feed, read
many feeds with a keyword filter, and find the feeds a web page declares.
Every format comes out as one item shape.

Package: `@vornrun/connector-rss` in `packages/rss`, shaped like the existing
packages: scoped name, tsup (`noExternal` only if a dependency is ever added;
none is), `vitest.config.ts` re-exporting `vitest.shared.ts`, `CHANGELOG.md`,
`README.md` with the links from the Docs section, `verified.json` from
`vorn-connector check --mock`, category `Social` as the substack package (the
other content-feed connector) uses, `packs: true`, keywords `rss`, `atom`,
`json feed`, `feeds`, `news`, `blogs`, `syndication`. The User-Agent version is
read from `../package.json` bundled at build time, as substack does.

## Auth

Rung: **`none`**. Feeds are public and take no credentials; no CLI or key
exists to borrow. Declare `auth: { rung: 'none' }`. No field is secret, and no
key matches the SDK's credential-name pattern (`secret|token|password|
api[-_]?key|credential`), so the `secrets` check passes.

| Config field | Env name | Required | Default | What it is |
| --- | --- | --- | --- | --- |
| `feeds` | `RSS_FEEDS` | no | none | Feed URLs, one per line or comma separated. The trigger polls them; `readFeeds` uses them when its `urls` is empty. The trigger throws `Add feed URLs to the connection's feeds` when this is empty. |
| `lookbackHours` | `RSS_LOOKBACK_HOURS` | no | `24` | How far back the first poll of a feed reaches. A whole number from 1 to 8760; anything else is an error naming the field. |
| `userAgent` | `RSS_USER_AGENT` | no | `vorn-connector-rss/<version> (+https://vorn.run)` | Sent as `User-Agent`; some hosts refuse requests without one. |

## Fetching

Every request, trigger or action, goes through one `fetchFeed(url)`:

- **URL:** trimmed; a value with no scheme gets `https://` prefixed (so
  `example.com/feed.xml` works, and the mock run's placeholder `check` reaches
  the stub as `https://check/`); any scheme other than `http:` or `https:` is
  refused before a request is made: `<url>: refused, only http and https feeds
  are read`. Private and loopback hosts are allowed: the connector runs on the
  user's machine and intranet feeds are a real use.
- **Request:** `GET` with `Accept: application/rss+xml, application/atom+xml,
  application/feed+json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5`,
  `User-Agent` from config, `redirect: 'follow'`, and the context's `fetch`
  (the SDK's resilient fetch, which retries 408, 425, 429 and 5xx).
- **Limits:** a 20 second `AbortSignal.timeout` covering headers and body;
  the body read from the stream and abandoned past 5 MB (5 × 1024 × 1024
  bytes), or refused up front when `Content-Length` says more; at most 6
  feeds in flight at once (a small pool, no dependency).
- **Charset:** the body is read as bytes and decoded with `TextDecoder` using
  the `charset` of `Content-Type`, else the XML declaration's `encoding`, else
  UTF-8; a leading BOM is dropped.
- **Failures** carry the URL and a reason and never discard other feeds'
  items: `HTTP <status>`, `timed out after 20 s`, `larger than 5 MB`,
  `not a feed (the body starts with "<html"); try find feeds`, `unparseable:
  <what>`, or the network error's message. `readFeed` throws it, `readFeeds`
  lists it in `feedsFailed`, the trigger writes it to stderr as
  `rss: <url>: <reason>` and throws only when every feed failed.

Observed on 2026-09-12: the sample RSS 2.0 file answers `304` to both
`If-None-Match` and `If-Modified-Since`; GitHub sends a weak ETag
(`W/"…"`) and Hugging Face a weak ETag with no `Last-Modified`; Google News
sends neither, so each poll of it downloads the whole feed (about 97 KB).
Sizes: Node releases Atom 752 KB, arXiv cs.AI 591 KB, all far under the cap.

## Parsing

No XML library: a small tokenizer grown from `packages/substack/src/feed.ts`
(which already handles CDATA and entities) builds a light element tree of
name, attributes, text and children. It has no code that could fetch or
expand anything, which is the whole of "never resolve a DOCTYPE".

- **Before parsing:** drop the XML declaration, comments, processing
  instructions and the `<!DOCTYPE …>` including any internal subset
  `[ … ]`. Entities declared there are never expanded: `&name;` for a name not
  in the fixed table stays as written.
- **Entities:** the five XML ones, decimal and hex numeric references (valid
  code points only), and a fixed table of common HTML names (`nbsp`, `rsquo`,
  `lsquo`, `rdquo`, `ldquo`, `hellip`, `mdash`, `ndash`, `copy`, `reg`,
  `trade`, `laquo`, `raquo`, `bull`, `middot`, and the Latin-1 letters).
- **CDATA** is kept as written. When CDATA text holds escaped markup
  (`&lt;` and no `<`) it is decoded once more: rssboard.org's own feed wraps
  entity-escaped HTML in CDATA.
- **Tolerance:** an unclosed element ends at its parent's end tag; a stray
  `&` is text; attribute values may use either quote. A body whose root
  cannot be found is `unparseable: no root element`.
- **Namespaces:** prefixes resolved from `xmlns:*` declarations to URIs, and
  elements matched by URI and local name, so `<atom:feed>` and `<feed>` are
  the same; an undeclared prefix falls back to its conventional URI. Known
  URIs: RSS 1.0 `http://purl.org/rss/1.0/`, RDF
  `http://www.w3.org/1999/02/22-rdf-syntax-ns#`, content
  `http://purl.org/rss/1.0/modules/content/`, Dublin Core
  `http://purl.org/dc/elements/1.1/`, Atom `http://www.w3.org/2005/Atom`,
  Media RSS `http://search.yahoo.com/mrss/`. Elements in any other
  namespace (`arxiv:announce_type`) are ignored.
- **Format:** a body starting with `{` is JSON Feed (version
  `https://jsonfeed.org/version/1.1` or `…/version/1`; jsonfeed.org's own
  feed is still version 1, served as `application/json`). A JSON object with
  no `version` and no `items` still reads as a JSON Feed with no items, so the
  mock's `{}` reply does not throw. Otherwise XML by root: `rss` → `rss2`
  (0.9x included), RDF `RDF` → `rss1`, Atom `feed` → `atom`, `html` → not a
  feed, anything else → `unparseable: root <x> is not rss, RDF or feed`.
- **Relative links** resolve against the nearest `xml:base` (RFC 4287 §2:
  "establishing the base URI … for resolving any relative references found
  within the effective scope of the xml:base attribute"), else the feed's
  final URL after redirects.

### One item shape

| Field | RSS 2.0 | RSS 1.0 | Atom | JSON Feed |
| --- | --- | --- | --- | --- |
| `id` | `guid` | `rdf:about` | `id` | `id` (a number coerced to text) |
| `title` | `title` | `title` | `title` (html/xhtml types as text) | `title` |
| `url` | `link`, else `guid` when `isPermaLink` is not `false` and it is http(s), else `atom:link rel=alternate` | `link` | `link rel=alternate` (no `rel` counts as alternate), `type="text/html"` first | `url`, else `external_url` |
| `author` | `author` (the name in parentheses of `lawyer@boyer.net (Lawyer Boyer)`, else the address), else `dc:creator` | `dc:creator` | entry `author/name`, else the feed's | `authors[].name`, else 1.0's `author.name` |
| `publishedAt` | `pubDate`, else `dc:date` | `dc:date` | `published`, else `updated` | `date_published` |
| `updatedAt` | `atom:updated` if present | empty | `updated` | `date_modified` |
| `summary` | `description`, else `media:description` | `description` | `summary`, else `content` | `summary`, else `content_text`, else `content_html` |
| `html` | `content:encoded`, else `description` | `content:encoded`, else `description` | `content` (html as is, xhtml's inner markup, text escaped), else `summary` | `content_html`, else `content_text` escaped |
| `categories` | `category`, `dc:subject` | `dc:subject` | `category/@term` | `tags` |

- `id` falls back to `url`, then to `sha256:` plus the first 16 hex characters
  of SHA-256 over `title + "\n" + publishedAt` (`node:crypto`).
- `title` falls back to `media:title`; `summary` is plain text (the substack
  `plainText`, one line per block) cut to 2000 characters, the last being `…`
  when cut; titles and authors are entity-decoded with tags stripped.
- `publishedAt` and `updatedAt` are ISO 8601 in UTC with milliseconds
  (`new Date(ms).toISOString()`), or `""` when missing or unparseable.
- `feedTitle` and `feedUrl` are the feed's title and the URL as configured
  (not the redirect target, so a host moving its feed does not refire items).
- Categories are trimmed and de-duplicated, order kept.

### Dates

One parser, no `Date.parse` guessing:

- **RFC 822 §5** `[ day "," ] date time`: optional day name, 1–2 digit day,
  English month, year of 2 or 4 digits (RSS 2.0: "with the exception that the
  year may be expressed with two characters or four characters"; 00–49 →
  20xx, 50–99 → 19xx), `hh:mm` with optional `:ss`, and zone `UT`, `GMT`,
  `EST`/`EDT`, `CST`/`CDT`, `MST`/`MDT`, `PST`/`PDT`, a military letter
  (`Z` is UT, `A`…`M` minus 1…12 hours skipping `J`, `N`…`Y` plus 1…12, as
  §5.2 defines), or `+hhmm`/`-hhmm`. A missing or unknown zone name is read
  as UTC. The sample feed's `Fri, 21 Jul 2023 09:04 EDT` (no seconds, a zone
  name) becomes `2023-07-21T13:04:00.000Z`.
- **RFC 3339 §5.6** `full-date "T" full-time` with optional `time-secfrac`,
  `Z` or `±hh:mm`, lowercase `t`/`z` accepted ("may alternatively be lower
  case"); also the W3CDTF forms `dc:date` uses, including no seconds
  (`2000-01-01T12:00+00:00`, the Dublin Core module's own example), a space
  for `T`, and a bare `YYYY-MM-DD` read as midnight UTC.

## Triggers

### `newItem` — an item appears in any of the connection's feeds

Hand-written `poll()`, not declarative `fetch()`: the cursor has to carry,
per feed, the newest date seen plus the ETag and Last-Modified to send back,
and a declarative fetch only sees one `since`. One global watermark would
also drop a slow feed's items older than a fast feed's newest.

- **Poll:** every URL in `feeds` (de-duplicated), 6 at a time, each sent with
  `If-None-Match: <etag>` and `If-Modified-Since: <last-modified>` when the
  cursor holds them, values sent back verbatim (weak ETags included; RFC 9110
  §13.1.2: "A recipient MUST use the weak comparison function when comparing
  entity tags for If-None-Match"). Sending both is safe: §13.1.3 "A recipient
  MUST ignore If-Modified-Since if the request contains an If-None-Match
  header field". A `304` means nothing new and costs no parsing (§15.4.5:
  "there is no need for the server to transfer a representation").
- **Dedupe key:** `externalId = "<feedUrl> <id>"`. A space cannot appear
  unencoded in a URL, so the pair splits back unambiguously.
- **Cursor:** JSON, `{"v":1,"feeds":{"<feedUrl>":{"t":"<newest publishedAt,
  else updatedAt>","etag":"…","lm":"…","seen":["<12 hex>", …]}}}`.
  `seen` holds the first 12 hex characters of SHA-256 of each item id sitting
  at `t` plus every dateless id still present in the feed, capped at 1000
  per feed. That cap is needed: arXiv cs.AI served 273 items all stamped
  `Sat, 12 Sep 2026 00:00:00 -0400`, and Google News guids run to 149
  characters. Feeds no longer configured are dropped from the cursor; a
  failed feed keeps its previous state. `nextCursor` is returned on every
  poll, empty or not.
- **Which items fire:** for a feed with no state, the dated items at or after
  `since` when the host gives one, else `now − lookbackHours`; dateless items
  are only remembered, so a new connection does not fire hundreds of runs.
  For a feed with state: a dated item fires when its date is after `t`, or
  equal to `t` with an id not in `seen`; a dateless item fires once, when its
  id is not in `seen`. An item dated before `t` never fires (a backdated post
  is missed; the README says so). Items return oldest first; `hasMore` is
  false; the host's `limit` is not applied, since each feed is one page.
- **Item mapping:** `title` (else `url`, else `Untitled item`), `url`,
  `description = summary`, `assignee = author`, `labels = categories`,
  `updatedAt = publishedAt || updatedAt` (omitted when both are empty), and
  `data` = the whole item shape.
- **Sample item**, from the RSS Advisory Board's feed
  (`http://feeds.rssboard.org/rssboard`, the one its home page advertises),
  summary trimmed here:

```json
{
  "externalId": "http://feeds.rssboard.org/rssboard tag:rssboard.org,2006:weblog.221",
  "title": "How to Read an RSS Feed with Java Using XOM",
  "url": "https://www.rssboard.org/news/221/read-rss-feed-java-using-xom",
  "description": "There are a lot of libraries for processing XML data with Java that can be used to read RSS feeds. One of the best is the open source library XOM created by the computer book author Elliotte Rusty Harold.\nAs he wrote one of his 20 books about Java and XML, …",
  "assignee": "Rogers Cadenhead",
  "labels": ["announcements,"],
  "updatedAt": "2023-08-02T03:25:57.000Z",
  "data": {
    "id": "tag:rssboard.org,2006:weblog.221",
    "title": "How to Read an RSS Feed with Java Using XOM",
    "url": "https://www.rssboard.org/news/221/read-rss-feed-java-using-xom",
    "author": "Rogers Cadenhead",
    "publishedAt": "2023-08-02T03:25:57.000Z",
    "updatedAt": "",
    "summary": "There are a lot of libraries for processing XML data with Java that can be used to read RSS feeds. …",
    "html": "<figure class=\"text-center\"><img src=\"https://www.rssboard.org/images/xml-in-a-nutshell-3rd-edition-cover-elliotte-rusty-harold-w-scott-means.jpg\" …/></figure><p>There are a lot of libraries …</p>",
    "categories": ["announcements,"],
    "feedTitle": "RSS Advisory Board",
    "feedUrl": "http://feeds.rssboard.org/rssboard"
  }
}
```

The raw item: `pubDate` `Tue, 01 Aug 2023 23:25:57 -0400`, `dc:creator`
`Rogers Cadenhead`, `guid isPermaLink="false"`, the title in CDATA and the
description as entity-escaped HTML inside CDATA; the trailing comma in the
category is the feed's own.

**Receipt consequence:** `vorn-connector check --mock` cannot replay the
`sample` of a `poll()` trigger, reports `sample-unusable`, and so leaves
`dedupe` out of `verified.json`, exactly as the github package's receipt
does. The sample is still declared. Dedupe is proven two other ways: unit
tests drive `poll()` twice through the harness with the first `nextCursor`
(first poll delivers, second delivers nothing, a 304 delivers nothing and
keeps the cursor, a new item delivers once, a dateless item delivers once),
and `check-live.sh` runs `check --live`, which polls the real feeds and fails
on `redelivers-items`.

## Actions

All three are hand-written `run()` over `fetchFeed`, and all are idempotent:
they only read. Output fields that are arrays or objects are declared
without a `type`, since output types are only `string`, `number` or
`boolean`. Each must survive the mock run's placeholders (`check` for text,
`1` for numbers, config as `mock-<key>` or its default) against a `{}`
reply; the rules above (`check` → `https://check/`, `{}` → an empty JSON
Feed) make them resolve, and a test asserts it.

### `readFeed` — read a feed

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | The feed's address; `https://` is assumed when there is no scheme |
| `limit` | number | no | Newest items to return, a whole number from 1 to 100; default 20 |
| `sinceHours` | number | no | Only items published within this many hours; dateless items are left out when set |

Items are sorted newest first, dateless last, then cut to `limit`. Outputs:
`feed` (`{ title, url, siteUrl, format }`: `url` after redirects; `siteUrl`
from the channel `link`, the feed's Atom `link rel=alternate`, or JSON Feed
`home_page_url`; `format` one of `rss2`, `rss1`, `atom`, `json`), `items`
(item shapes), `count` (number). A failure throws `<url>: <reason>`.

Live sample: `{ "url": "https://www.rssboard.org/files/sample-rss-2.xml" }`
(`NASA Space Station News`, site `http://www.nasa.gov/`, 5 items).

### `readFeeds` — read feeds

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `urls` | string | no | Feed addresses, one per line or comma separated; empty means the connection's feeds |
| `sinceHours` | number | no | Only items published within this many hours; dateless items are left out when set |
| `perFeed` | number | no | Newest items kept from each feed, 1 to 100; default 20 |
| `keywords` | string | no | Comma separated; an item passes when any one matches its title or summary as a whole word or phrase, ignoring case; empty keeps everything |
| `minFeedsOk` | number | no | The action fails when fewer feeds than this answer; default 1 |

No `urls` and no connection feeds is an error saying to give one. Order:
fetch all (6 at a time), then per feed `sinceHours`, then `keywords`
(each escaped and matched with `(?<![\p{L}\p{N}])<kw>(?![\p{L}\p{N}])`, flags
`iu`), then the newest `perFeed`; then de-duplicate by `url` across feeds,
keeping the newest copy (items with no url by `feedUrl` + `id`), and sort
newest first, dateless last. When `feedsOk < minFeedsOk` it throws
`<n> of <m> feeds answered, fewer than minFeedsOk <k>: <url>: <reason>; …`
naming every failed URL. Outputs: `items`, `count` (number), `feedsOk`
(number), `feedsFailed` (`[{ url, error }]`).

Live sample: `{ "urls": "https://www.rssboard.org/files/sample-rss-2.xml\nhttps://github.com/nodejs/node/releases.atom" }`.

### `findFeeds` — find the feeds a page declares

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | A web page, or a feed |

Fetch with `Accept: text/html, application/xhtml+xml` ahead of the feed
types. When the body parses as a feed (a JSON body needs a `version` or an
`items` array here), return that URL alone with its title and format.
Otherwise read every `<link>` in the document whose `rel` tokens include
`alternate` (compared ignoring case, although autodiscovery says it "must be
lowercase") and whose `type` is `application/rss+xml` (RSS 1.0 and 2.0 per
autodiscovery), `application/atom+xml` (RFC 4287 §2) or
`application/feed+json`; `application/json` links count only when no
`application/feed+json` link exists (JSON Feed: "apps must prefer
application/feed+json, but should fall back to accepting application/json").
`href` resolves against `<base href>`, else the page URL (autodiscovery:
"clients should treat the web page's URL as the base"); attribute entities
are decoded; duplicates are dropped, document order kept. Outputs: `feeds`
(`[{ url, title, type, format }]`, `format` guessed from `type`), `count`
(number), `isFeed` (boolean). A page with none returns an empty list.

Live sample: `{ "url": "https://www.rssboard.org/" }` → one feed,
`http://feeds.rssboard.org/rssboard`, `RSS Advisory Board`,
`application/rss+xml` (returned as declared, `http` included).

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check ./packages/rss/dist/index.js --mock --receipt packages/rss/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard, with a `./`
entry path. Expected receipt: every check the substack package has except
`dedupe` (see the trigger's receipt consequence).

Tests make no network calls: `fetchFeed` and the actions take an injected
`fetch`, the trigger a fixed `now`. Recorded fixtures, one per format, trimmed
copies of what the URLs served on 2026-09-12 unless noted:

- `rss2.xml`: the rssboard.org sample file plus one item carrying
  `content:encoded` in CDATA, `dc:creator`, `media:title`, a channel
  `atom:link rel="self"`, a relative `link`, and the double-escaped CDATA
  description from rssboard.org's own feed.
- `rss1.rdf`: the RSS 1.0 specification's own example document, with
  `dc:date` in W3CDTF without seconds and one `content:encoded`.
- `atom.xml`: two Node release entries, plus one hand-made entry with
  `xml:base`, a relative `link rel="alternate"`, a `rel="self"` link and a
  link with no `rel`, `type="xhtml"` content and both `published` and
  `updated`.
- `feed.json`: jsonfeed.org's feed (version 1, singular `author`) plus a
  version 1.1 item with `authors`, `tags` and `date_modified`.
- `malformed.xml`: an RSS 2.0 feed cut off mid-item with an unclosed
  `<title>` and a stray `&`: the complete items parse, and a body with no
  root fails with `unparseable`.
- `doctype.xml`: an RSS 2.0 feed whose DOCTYPE declares an external entity
  (`SYSTEM "file:///etc/passwd"`) and a nested expanding entity, both used in
  an item: the items parse, `&xxe;` stays as written, and the injected fetch
  fails the test if anything but the feed URL is requested.
- `page.html`: a page with `<base href>`, relative RSS and Atom
  autodiscovery links, a `feed+json` link, an `application/json` link, and a
  `rel="stylesheet"` link that must be ignored.

## Live checks

No credentials exist or are needed, so `scripts/check-live.sh` always runs
for real, and exits 0 with a note only when the machine is offline (neither
`www.rssboard.org` nor `github.com` answers). It reads, with the connector's
`Accept` and a User-Agent, each of:

- https://www.rssboard.org/files/sample-rss-2.xml (RSS 2.0)
- https://github.com/nodejs/node/releases.atom (Atom)
- https://export.arxiv.org/rss/cs.AI
- https://huggingface.co/blog/feed.xml
- https://news.google.com/rss/search?q=site:anthropic.com&hl=en-US&gl=US&ceid=US:en

and fails on any status other than 200, a missing `rss`, `feed` or `rdf:RDF`
root, or no items. It then sends the sample file's ETag back and expects a
304 (a different answer is a note, not a failure), runs the find-feeds
probe on https://www.rssboard.org/, and, when `packages/rss/dist/index.js`
is built, runs `vorn-connector check --live` with `RSS_FEEDS` set to the
five feeds, which polls the trigger twice for real and calls the three
actions with their samples. Run on 2026-09-12 it passed: 5, 10, 273, 861 and
100 items, a 304, and one autodiscovery link.

| Env | Required | Used by |
| --- | --- | --- |
| `RSS_FEEDS` | no | the trigger during `check --live`; default the five feeds above |
| `RSS_LOOKBACK_HOURS` | no | the first live poll; default `168` there, so a quiet week still yields items |
| `RSS_USER_AGENT` | no | every live request; default `vorn-connector-rss/live-check (+https://vorn.run)` |

## Dependencies

None, at runtime or build time. The substack parser covers CDATA and
entities already; `node:crypto` gives the id hashes, `TextDecoder` the
charsets, `AbortSignal.timeout` the timeouts. A general XML parser would add
DOCTYPE and entity handling to configure off and strict error modes to work
around for tolerance, where a tokenizer with no DOCTYPE code cannot resolve
anything by construction. The registry is unreachable from this machine
anyway, and CI resolves the lockfile.

## Icon

The standard feed mark: a solid dot in the lower-left corner and two thick
concentric quarter-circle bands rising from the left edge and landing on the
bottom edge, all centred on the lower-left corner, like waves broadcasting
up and to the right. A single-colour SVG carries it in a 24-unit viewBox as
three filled paths, no strokes, the glyph spanning (3, 3) to (21, 21) with
the arcs centred at (3, 21):

- the dot, a circle of radius 2.5 at (5.5, 18.5), touching the left and
  bottom edges: `M5.5 16a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z`;
- the inner band, radius 8 to 11: `M3 13a8 8 0 0 1 8 8h3A11 11 0 0 0 3 10z`;
- the outer band, radius 15 to 18: `M3 6a15 15 0 0 1 15 15h3A18 18 0 0 0 3 3z`.

Rendered at 512 px on 2026-09-12, it reads as the feed mark.

## Docs

The only source:

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
