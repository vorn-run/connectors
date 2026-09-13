# Changelog

All notable changes to `@vornrun/connector-rss`.

## 0.1.1

- Read a feed, Read feeds and Find feeds return their lists and objects through Vorn: rebuilt against `@vornrun/connector-sdk` 0.7.1-beta.2, whose outputs accept lists, objects and null.

## 0.1.0

First release.

Trigger a workflow when an item appears in any of a connection's web feeds,
and let a workflow step read one feed, read several at once with a keyword
filter, or find the feeds a web page declares. RSS 2.0, RSS 1.0 (RDF), Atom
1.0 and JSON Feed 1.1 all come out as one item shape.

- **Trigger:** `newItem`, polling every configured feed six at a time and
  sending each feed's ETag and Last-Modified back, so an unchanged feed
  answers 304 and costs nothing. The first poll of a feed fires only for
  items inside `lookbackHours` (default 24); an item with no date fires once.
- **Actions:** `readFeed`, `readFeeds`, `findFeeds`, all idempotent.
- **Signing in:** none. Feeds are public, so the connection takes only feed
  addresses, a look-back and a User-Agent.

Feeds are read over http and https only, within 20 seconds and 5 MB each. The
connector parses feeds itself, with no XML library: CDATA, namespaces,
`xml:base`, and RFC 822 and RFC 3339 dates are all read, and there is no code
that could resolve a DOCTYPE or an external entity. A feed that fails is
named with its reason and never costs the other feeds their items.

Ships as a pack with a conformance receipt covering the mock run of every
action. The receipt leaves out `dedupe`: the trigger keeps its own cursor per
feed, so the check cannot replay its sample. Its dedupe is proven by the unit
tests, which poll twice with the returned cursor, and by `check --live`. No
runtime dependencies.
