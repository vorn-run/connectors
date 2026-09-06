# Changelog

All notable changes to `@vornrun/connector-trello`.

## 0.1.0

First release.

Trigger a workflow from cards created, moved, commented on or due soon on a
Trello board, and let a workflow step create, update, move, comment on, label,
archive, read and search cards, and list the member's boards, a board's lists
and a list's cards.

- **Triggers:** `cardCreated`, `cardMoved`, `commentAdded`, `cardDueSoon`.
- **Actions:** `createCard`, `updateCard`, `moveCard`, `addComment`,
  `addLabel`, `archiveCard`, `getCard`, `listBoards`, `listLists`,
  `listCards`, `searchCards`.
- **Signing in:** a Power-Up API key from trello.com/power-ups/admin and the
  member token its authorization page grants for read and write, both sent as
  query parameters on every call. There is no Trello CLI to borrow a login
  from. Preflight reads `/members/me` once to prove the pair.

The three action triggers are declarative polls on the SDK's timestamp
strategy over `GET /boards/{id}/actions` with `since` as the watermark,
walking `before` up to five pages of 1000 and delivering oldest first; the
action id is the dedupe key. `cardMoved` reads `listBefore` and `listAfter`
and falls back to `old.idList` and `list`, and can be limited to one
destination list. `cardDueSoon` re-reads the board's open cards every poll and
keys on the card id and due date, so a card fires once per due date and again
when the date moves.

`updateCard`, `moveCard`, `archiveCard`, `getCard`, `listBoards`, `listLists`
and `listCards` are declared requests reshaped with `postReceive`, all
idempotent so the SDK's own retry may repeat them. `createCard`, `addComment`,
`addLabel` and `searchCards` go through one small client: the first two are
not idempotent and would otherwise never be retried on a `429`, `addLabel`
treats the `400` for a label already on the card as success, and search reads
either of the answer shapes the reference and the API disagree on. The client
retries a `429` once after `Retry-After`, else the exhausted
`x-rate-limit-*` window, else 10 seconds, and never quotes the URL in an
error because it carries the key and token.

Ships as a pack with a conformance receipt covering the dedupe replay of every
trigger and the mock run of every action. No runtime dependencies: `fetch`,
`URL` and `setTimeout` cover the client, the query-string writes, the action
paging and the retry wait.
