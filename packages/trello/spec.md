id: trello

# Trello connector

Trello's REST API at `https://api.trello.com/1` (the Swagger file behind the
reference lists that as its only server). Reads are `GET` with a query string;
writes are `POST` and `PUT` whose parameters are also query parameters (the
reference lists every write parameter as `in: query`), so the connector sends
every argument in the URL and no body. Answers are JSON objects or arrays.
Ids are `TrelloID`s, 24 hexadecimal characters (`^[0-9a-fA-F]{24}$`); cards
also answer to their `shortLink`. Dates go in and out as ISO 8601 strings
("The API expects a ISO 8601 date format"). An error answer is plain text or
a small object; the connector throws `<http status>: <body text>` on a
non-2xx answer. The authorization guide names two: a revoked or wrong token
answers `401` with the text `invalid token`, and a rate-limit hit answers
`429` "along with a message corresponding to which limit was exceeded".

Package: `@vornrun/connector-trello` in `packages/trello`, shaped exactly like
the existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category
`Productivity` (the one Notion and Airtable use), `packs: true`.

## Auth

Rung: **key**. There is no CLI most developers already sign in to for Trello;
the connection takes two values, both secret, both sent as query parameters
on every request. The reference's security schemes are exactly these two:
`APIKey` (`in: query`, `name: key`) and `APIToken` (`in: query`,
`name: token`).

| Config field | Env name | Secret | Query parameter | Where it comes from |
| --- | --- | --- | --- | --- |
| `apiKey` | `TRELLO_API_KEY` | yes | `key` | The Power-Up API key: create a Power-Up at https://trello.com/power-ups/admin, open it, choose the **API Key** tab and **Generate a new API Key** |
| `token` | `TRELLO_TOKEN` | yes | `token` | The member token the key's authorization page grants |

How a person gets both, per the introduction and authorization guides:

1. Sign in to Trello and open https://trello.com/power-ups/admin. Create a
   Power-Up (the form asks only for a name, workspace and contact email),
   open it, pick the **API Key** tab and press **Generate a new API Key**.
   That is `TRELLO_API_KEY`. The guide says keys "may be public"; this
   connector still marks it secret because it is paired with the token.
2. On the same tab, the word **Token** is a link to
   `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<apiKey>`.
   The `/1/authorize` parameters, quoted from the guide: `key` is "used to
   generate the user's token"; `scope` is a comma-separated set of `read`,
   `write`, `account` (`account` adds "reading of member email" and is not
   needed here); `expiration` is one of `1hour`, `1day`, `30days`, `never`,
   "when the token should expire"; `response_type=token` shows the token
   in the browser without a redirect; `name` is the label the member sees
   on the consent screen. Approve, copy the token shown: that is
   `TRELLO_TOKEN`. "Tokens for users should always be securely stored as
   they grant access to the entire user's account!"
3. Revoking: the member removes the application under their account
   settings, after which the API answers `401` `invalid token`.

The guide also accepts an `Authorization: OAuth oauth_consumer_key="<key>",
oauth_token="<token>"` header; the connector uses the query parameters,
which the introduction's own examples use, and never logs a URL.

Preflight is `GET /members/me?fields=id,username,fullName`, the cheapest
read that proves both values at once; `me` "references the authenticated
user based on the token".

## Rate limits and retries

Quoted from the rate-limits guide: "300 requests per 10 seconds" per API
key and "100 requests per 10 second interval" per token; `/1/members/` has
a special budget of "100 requests per 900 seconds". Exceeding one answers
`429` with a message naming the limit (`API_KEY_LIMIT_EXCEEDED` or
`API_TOKEN_LIMIT_EXCEEDED`). Every answer carries:

| Header | Meaning |
| --- | --- |
| `x-rate-limit-api-key-interval-ms`, `x-rate-limit-api-key-max`, `x-rate-limit-api-key-remaining` | the key window (10000 ms), its budget (300) and what is left |
| `x-rate-limit-api-token-interval-ms`, `x-rate-limit-api-token-max`, `x-rate-limit-api-token-remaining` | the same for the token (10000 ms, 100) |

The guide does not promise a `Retry-After` header. The connector's policy,
per the brief:

- On `429`: wait `Retry-After` seconds when the header is present, else the
  larger `x-rate-limit-*-interval-ms` whose `remaining` is `0`, else 10
  seconds, and retry **once**. A second `429` is thrown as-is.
- On `401` `invalid token` and `400` (bad or unknown id: the API answers a
  plain-text body such as `invalid id`), throw immediately; a person must
  act.
- No other status is retried. The poll stays well under the token budget:
  one board poll is one request.

The preflight's `/1/members/me` call is inside the 100-per-900-seconds
member budget, so the connector calls it only at connect time, never per
poll.

## Pagination

Actions: "The API limits Action queries to 1000 at a time. To retrieve the
full list of actions when there are more then 1000, multiple requests must
be made using the `since` and `before` parameters." `GET /boards/{id}/actions`
takes `filter` ("A comma-separated list of action types"), `since` and
`before` ("A date string in the form of YYYY-MM-DDThh:mm:ssZ or a mongo
object ID. Only objects created since/before this date will be returned"),
`limit` ("between 0 and 1000", default 50), `page` (default 0),
`idModels`, `format` (`list` or `count`), `member` and `memberCreator`
(both default true) with their `_fields`. Actions come newest first. Each
poll asks for `limit=1000` with `since=<cursor>`; when a page is full it
asks again with `before=<oldest date on the page>` and the same `since`, at
most 5 pages, then reverses so the workflow sees the oldest first.

Cards on a board and cards in a list are single unpaged arrays; the
reference gives them no `limit` or `page`. Search takes `cards_limit`
(default 10, maximum 1000) and `cards_page` (default 0, maximum 100).

## Triggers

All poll. Every trigger takes `boardId` (string, required): the 24-character
id, or the short link from the board URL, which the API accepts in place of
the id. Items carry the action `date` (or the card's `dateLastActivity`) in
`updatedAt` and the raw object in `data`. Card URLs are the card's `shortUrl`
(`https://trello.com/c/<shortLink>`) when the object carries one, else
`https://trello.com/c/<data.card.shortLink>` from the action.

Action items share one shape. An action, from the reference's schema and
example: `id`, `idMemberCreator`, `type`, `date` (ISO 8601), `data`
(`text`, `card { id, name, idShort, shortLink }`, `board { id, name,
shortLink }`, `list { id, name }`), `memberCreator` (`id`, `fullName`,
`username`, `initials`, `avatarUrl`), `display`, `limits`. The connector
asks for `memberCreator=true&member=false&fields=id,type,date,data` plus
`memberCreator_fields=fullName,username` to keep pages small.

### `cardCreated` — a card was created on the board

- **Poll:** `GET /boards/{boardId}/actions?filter=createCard&limit=1000&since=<cursor>`.
- **Cursor:** the newest action `date` seen; the `since` parameter takes it
  verbatim. Trello's `since` is inclusive at the boundary, so the newest
  action comes back once more and dedupe absorbs it. With no cursor the
  first poll starts 24 hours back.
- **Dedupe key:** the action `id`.
- **Sample item:**

```json
{
  "externalId": "5abbe4b7ddc1b351ef961414",
  "title": "Card created: Bowie",
  "url": "https://trello.com/c/3CsPkqOF",
  "updatedAt": "2020-03-09T19:41:51.396Z",
  "data": {
    "id": "5abbe4b7ddc1b351ef961414",
    "idMemberCreator": "5abbe4b7ddc1b351ef961414",
    "type": "createCard",
    "date": "2020-03-09T19:41:51.396Z",
    "data": {
      "card": { "id": "5abbe4b7ddc1b351ef961414", "name": "Bowie", "idShort": 7, "shortLink": "3CsPkqOF" },
      "list": { "id": "5abbe4b7ddc1b351ef961414", "name": "Amazing" },
      "board": { "id": "5abbe4b7ddc1b351ef961414", "name": "Mullets", "shortLink": "3CsPkqOF" }
    },
    "memberCreator": { "id": "5abbe4b7ddc1b351ef961414", "fullName": "Bob Loblaw", "username": "bobloblaw" }
  }
}
```

### `cardMoved` — a card moved to another list

- **Poll:** `GET /boards/{boardId}/actions?filter=updateCard:idList&limit=1000&since=<cursor>`.
  The colon sub-filter is documented by the cards reference, whose
  `GET /cards/{id}/actions` defaults `filter` to `commentCard,
  updateCard:idList`, and by the nested-resources guide's list of
  `updateCard` sub-filters (`updateCard:idList`, `updateCard:closed`,
  `updateCard:desc`, `updateCard:name`).
- **Cursor and dedupe:** as `cardCreated`.
- **Item:** the card, and the list before and after. The reference's Action
  schema documents only `data.card`, `data.board`, `data.list` and
  `data.text`; a list move carries the origin and destination as
  `data.listBefore` and `data.listAfter` (`{ id, name }`) and the previous
  id under `data.old.idList`. The connector reads `listBefore` and
  `listAfter` and falls back to `data.old.idList` and `data.list` when
  either is missing, so an unexpected shape degrades to a partial item
  rather than a failure. The live check prints one real `updateCard:idList`
  action so the shape is confirmed before release.
- **Optional config:** `toListId` (string): emit only moves whose
  `listAfter.id` matches.
- **Sample item:**

```json
{
  "externalId": "5abbe4b7ddc1b351ef961415",
  "title": "Card moved: Bowie (Amazing → Done)",
  "url": "https://trello.com/c/3CsPkqOF",
  "updatedAt": "2020-03-09T19:45:00.000Z",
  "data": {
    "id": "5abbe4b7ddc1b351ef961415",
    "type": "updateCard",
    "date": "2020-03-09T19:45:00.000Z",
    "card": { "id": "5abbe4b7ddc1b351ef961414", "name": "Bowie", "idShort": 7, "shortLink": "3CsPkqOF" },
    "listBefore": { "id": "5abbe4b7ddc1b351ef961414", "name": "Amazing" },
    "listAfter": { "id": "5abbe4b7ddc1b351ef961416", "name": "Done" },
    "board": { "id": "5abbe4b7ddc1b351ef961414", "name": "Mullets", "shortLink": "3CsPkqOF" },
    "memberCreator": { "id": "5abbe4b7ddc1b351ef961414", "fullName": "Bob Loblaw", "username": "bobloblaw" }
  }
}
```

### `commentAdded` — a comment was added to a card

- **Poll:** `GET /boards/{boardId}/actions?filter=commentCard&limit=1000&since=<cursor>`.
- **Cursor and dedupe:** as `cardCreated`.
- **Sample item** (the reference's own `commentCard` example):

```json
{
  "externalId": "5abbe4b7ddc1b351ef961414",
  "title": "Bob Loblaw commented on Bowie: Can never go wrong with bowie",
  "url": "https://trello.com/c/3CsPkqOF",
  "updatedAt": "2020-03-09T19:41:51.396Z",
  "data": {
    "id": "5abbe4b7ddc1b351ef961414",
    "idMemberCreator": "5abbe4b7ddc1b351ef961414",
    "type": "commentCard",
    "date": "2020-03-09T19:41:51.396Z",
    "data": {
      "text": "Can never go wrong with bowie",
      "card": { "id": "5abbe4b7ddc1b351ef961414", "name": "Bowie", "idShort": 7, "shortLink": "3CsPkqOF" },
      "board": { "id": "5abbe4b7ddc1b351ef961414", "name": "Mullets", "shortLink": "3CsPkqOF" },
      "list": { "id": "5abbe4b7ddc1b351ef961414", "name": "Amazing" }
    },
    "memberCreator": { "id": "5abbe4b7ddc1b351ef961414", "fullName": "Bob Loblaw (Trello)", "username": "bobloblaw" }
  }
}
```

### `cardDueSoon` — a card's due date falls inside the window

- **Poll:** `GET /boards/{boardId}/cards?fields=id,name,due,dueComplete,idList,idBoard,shortUrl,url,dateLastActivity,idMembers,labels`
  (the reference gives this route no query parameters beyond `id`; the
  `fields` filter is the standard card `fields` parameter and the plain
  route returns open cards). Keep cards where `due` is not null,
  `dueComplete` is false, and `due` is between now and now plus
  `withinHours`.
- **Config:** `withinHours` (number, optional, default 24).
- **Cursor:** none; the window moves with the clock, so every poll
  re-evaluates the board and dedupe does the filtering.
- **Dedupe key:** `${card.id}:${card.due}`, so a card fires once per due
  date and fires again if the due date is changed. The item carries no
  `updatedAt` (the SDK then remembers the key for as long as the card stays
  in the window), so `updatedAt` is the poll time.
- **Sample item** (from the reference's card example):

```json
{
  "externalId": "5abbe4b7ddc1b351ef961414:2019-09-18T12:00:00.000Z",
  "title": "Due 2019-09-18T12:00:00.000Z: 👋 What? Why? How?",
  "url": "https://trello.com/c/H0TZyzbK",
  "updatedAt": "2019-09-16T16:19:17.156Z",
  "data": {
    "id": "5abbe4b7ddc1b351ef961414",
    "name": "👋 What? Why? How?",
    "due": "2019-09-18T12:00:00.000Z",
    "dueComplete": false,
    "closed": false,
    "idBoard": "5abbe4b7ddc1b351ef961414",
    "idList": "5abbe4b7ddc1b351ef961414",
    "idMembers": ["5abbe4b7ddc1b351ef961414"],
    "labels": [{ "id": "5abbe4b7ddc1b351ef961414", "idBoard": "5abbe4b7ddc1b351ef961414", "name": "Overdue", "color": "yellow" }],
    "dateLastActivity": "2019-09-16T16:19:17.156Z",
    "shortUrl": "https://trello.com/c/H0TZyzbK",
    "url": "https://trello.com/c/H0TZyzbK/4-%F0%9F%91%8B-what-why-how"
  }
}
```

## Actions

Every action sends `key` and `token`, throws on a non-2xx answer and retries
as described. List-valued inputs (`labelIds`, `memberIds`, `boardIds`) are
strings the action splits on commas, because the API wants them
"comma-separated". A `Card` in an output is the reference's Card object:
`id`, `name`, `desc`, `closed`, `due`, `start`, `dueComplete`,
`dateLastActivity`, `idBoard`, `idList`, `idLabels`, `idMembers`,
`idShort`, `labels`, `pos`, `shortLink`, `shortUrl`, `url`, `badges`,
`cover`.

### `createCard` — create a card (`POST /cards`), not idempotent

| Input | Type | Required | Description (from the reference) |
| --- | --- | --- | --- |
| `listId` | string | yes | `idList`: "The ID of the list the card should be created in" |
| `name` | string | yes | `name`: "The name for the card" (the API allows it empty; the connector requires it) |
| `description` | string | no | `desc`: "The description for the card" |
| `due` | string | no | `due`: "A due date for the card", ISO 8601 |
| `labelIds` | string | no | `idLabels`: "Comma-separated list of label IDs to add to the card" |
| `memberIds` | string | no | `idMembers`: "Comma-separated list of member IDs to add to the card" |
| `position` | string | no | `pos`: "`top`, `bottom`, or a positive float" |

Output: the created `Card`. No live sample: it creates data.

### `updateCard` — update a card (`PUT /cards/{id}`)

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cardId` | string | yes | Card id or short link |
| `name` | string | no | "The new name for the card" |
| `description` | string | no | `desc`: "The new description for the card" |
| `due` | string | no | "When the card is due, or `null`"; the string `null` clears it |
| `dueComplete` | boolean | no | "Whether the status of the card is complete" |
| `closed` | boolean | no | "Whether the card should be archived (closed: true)" |

Only the inputs given are sent. Output: the updated `Card`. Idempotent in
effect (a repeat sets the same values) but it changes data, so no live
sample.

### `moveCard` — move a card to a list (`PUT /cards/{id}`)

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cardId` | string | yes | Card id or short link |
| `listId` | string | yes | `idList`: "The ID of the list the card should be in" |
| `position` | string | no | `pos`: "`top`, `bottom`, or a positive float" |
| `boardId` | string | no | `idBoard`: "The ID of the board the card should be on", for a move across boards |

Output: the updated `Card`. Same idempotency note as `updateCard`; no live
sample.

### `addComment` — comment on a card (`POST /cards/{id}/actions/comments`), not idempotent

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cardId` | string | yes | Card id or short link |
| `text` | string | yes | `text`: "The comment" |

Output: the `commentCard` Action (`id`, `type`, `date`, `data.text`,
`data.card`, `memberCreator`). No live sample.

### `addLabel` — add a label to a card (`POST /cards/{id}/idLabels`)

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cardId` | string | yes | Card id or short link |
| `labelId` | string | yes | `value`: "The ID of the label to add" |

Output: `{ labelIds: string[] }`, the card's label ids as the API returns
them. A repeat answers `400` because the label is already on the card; the
connector treats that specific answer as success so the action is
idempotent in effect. Changes data, so no live sample.

### `archiveCard` — archive a card (`PUT /cards/{id}?closed=true`), idempotent

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cardId` | string | yes | Card id or short link |

Output: the updated `Card` with `closed: true`. Idempotent: a second call
leaves the card archived. The live sample is set only when
`TRELLO_ARCHIVE_CARD_ID` names a throwaway card, so the card `getCard` reads
is never archived; the mock check uses the placeholder
`{ "cardId": "5abbe4b7ddc1b351ef961414" }`.

### `getCard` — get a card (`GET /cards/{id}`), idempotent

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cardId` | string | yes | Card id or short link |

Sends `fields=all&list=true&board=true&board_fields=name,shortUrl` so the
output is the `Card` plus `list { id, name }` and `board { id, name,
shortUrl }`. Live sample: `{ "cardId": "<TRELLO_CARD_ID>" }`; mock sample:
`{ "cardId": "5abbe4b7ddc1b351ef961414" }`.

### `listBoards` — boards of the member (`GET /members/me/boards`), idempotent

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `filter` | string | no | "`all` or a comma-separated list of: `closed`, `members`, `open`, `organization`, `public`, `starred`", default `open` |

Sends `fields=id,name,desc,closed,idOrganization,url,shortUrl,dateLastActivity`.
Output: `{ items: Board[] }` (a bare array answer is stored by the SDK under
`items`). Sample: no arguments. This route is under
`/1/members/`, whose budget is 100 requests per 900 seconds.

### `listLists` — lists on a board (`GET /boards/{id}/lists`), idempotent

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `boardId` | string | yes | Board id or short link |
| `filter` | string | no | "Filter to apply to Lists": `all`, `closed`, `none`, `open`; default `open` |

Sends `fields=id,name,closed,idBoard,pos`. Output: `{ items: List[] }`
where a List is `id`, `name`, `closed`, `idBoard`, `pos`, `subscribed`,
`softLimit`. Sample: `{ "boardId": "<TRELLO_BOARD_ID>" }`, mock
`{ "boardId": "5abbe4b7ddc1b351ef961414" }`.

### `listCards` — cards in a list (`GET /lists/{id}/cards`), idempotent

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `listId` | string | yes | "The ID of the list" |

Output: `{ items: Card[] }`. Sample: `{ "listId": "<TRELLO_LIST_ID>" }`,
mock `{ "listId": "5abbe4b7ddc1b351ef961414" }`.

### `searchCards` — search cards (`GET /search`), idempotent

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | "The search query with a length of 1 to 16384 characters" |
| `boardIds` | string | no | `idBoards`: "`mine` or a comma-separated list of Board IDs" |
| `limit` | number | no | `cards_limit`: "The maximum number of cards to return. Maximum: 1000", default 10 |

Sends `modelTypes=cards&card_list=true&card_board=true&card_fields=id,name,desc,closed,due,dueComplete,idBoard,idList,labels,shortUrl,url,dateLastActivity`.
Search also offers `partial` ("look for content that starts with any of
the words in your query"), which the action exposes as `partial` (boolean,
optional). The reference types the answer as an array of mixed models; in
practice it is an object keyed by model type, so the connector reads
`cards` from an object answer and filters `idList`-bearing entries from an
array answer. Output: `{ cards: Card[] }`. Sample: `{ "query": "test" }`.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/trello/dist/index.js --mock --receipt packages/trello/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls: the client takes an injected `fetch`, and the retry tests use
fake timers.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `TRELLO_API_KEY` or
`TRELLO_TOKEN` is unset. With both it calls `GET /members/me`,
`GET /members/me/boards?filter=open`, `GET /search?query=test&modelTypes=cards`,
then, when the optional ids are set, `GET /boards/$TRELLO_BOARD_ID/lists`,
`GET /boards/$TRELLO_BOARD_ID/actions?filter=updateCard:idList&limit=1`
(printing the action so the `listBefore`/`listAfter` shape is confirmed),
`GET /lists/$TRELLO_LIST_ID/cards` and `GET /cards/$TRELLO_CARD_ID`, then
`vorn-connector check --live`.

| Env | Required | Used by |
| --- | --- | --- |
| `TRELLO_API_KEY` | yes | every call, as `key` |
| `TRELLO_TOKEN` | yes | every call, as `token` |
| `TRELLO_BOARD_ID` | no | `listLists`, the actions probe; skipped when unset |
| `TRELLO_LIST_ID` | no | `listCards`; skipped when unset |
| `TRELLO_CARD_ID` | no | `getCard`; skipped when unset |
| `TRELLO_ARCHIVE_CARD_ID` | no | the live sample of `archiveCard`; a throwaway card, because it will be archived |

Nothing is created, moved, commented or archived unless
`TRELLO_ARCHIVE_CARD_ID` is set: the live check touches only idempotent reads. No key or token exists on this machine.

## Dependencies

None at runtime. `fetch`, `URL`, `URLSearchParams` and `setTimeout` cover
the client, the query-string writes, action paging and the retry wait.
Trello publishes no first-party JavaScript SDK for the REST API, and the
community wrappers are larger than the client this connector needs, so
nothing is inlined.

## Icon

Trello's mark is a rounded square tile holding two vertical bars side by
side, like two list columns on a board: the left bar reaches lower than the
right one. It is drawn in one colour on a blue background in the product,
and in a single colour on nothing for a monochrome mark. A single-colour
SVG carries it in a 24-unit viewBox as one path with `fill-rule: evenodd`:
the outer shape is a rounded square from (2,2) to (22,22) with corner
radius 3; cut out of it are two rounded rectangles with corner radius 1,
the left from (5.5,5.5) to (10.5,18.5) and the right from (13.5,5.5) to
(18.5,13). Fill only, one path.

## Docs

The only source. The reference pages render from the Swagger file at
https://dac-static.atlassian.com/cloud/trello/swagger.v3.json, which is
where the hidden parameter defaults and limits above were read.

- REST API introduction: https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/
- Authorization: https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/
- Rate limits: https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits/
- Action types: https://developer.atlassian.com/cloud/trello/guides/rest-api/action-types/
- Nested resources (linked from the introduction; the `updateCard:` sub-filters): https://developer.atlassian.com/cloud/trello/guides/rest-api/nested-resources/
- Actions: https://developer.atlassian.com/cloud/trello/rest/api-group-actions/
- Boards: https://developer.atlassian.com/cloud/trello/rest/api-group-boards/
- Cards: https://developer.atlassian.com/cloud/trello/rest/api-group-cards/
- Lists: https://developer.atlassian.com/cloud/trello/rest/api-group-lists/
- Members: https://developer.atlassian.com/cloud/trello/rest/api-group-members/
- Search: https://developer.atlassian.com/cloud/trello/rest/api-group-search/
- Power-Up admin (API key and token): https://trello.com/power-ups/admin
