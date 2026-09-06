# @vornrun/connector-trello

Trigger Vorn workflows from cards created, moved, commented on or due soon on
a Trello board, and create, update, move, comment on, label, archive, read and
search cards from a workflow step. Talks to the REST API at
`https://api.trello.com/1`.

## Signing in

There is no Trello CLI to borrow a login from. The connection takes two values,
both sent as query parameters on every call:

1. **API key.** Sign in to Trello and open https://trello.com/power-ups/admin.
   Create a Power-Up (the form asks only for a name, workspace and contact
   email), open it, pick the **API Key** tab and press **Generate a new API
   Key**. Paste that into the **API key** field (`TRELLO_API_KEY`).
2. **Token.** On the same tab the word **Token** links to
   `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<apiKey>`.
   Approve read and write access and copy the token shown. Paste it into the
   **Token** field (`TRELLO_TOKEN`). The `account` scope is not needed; it
   only adds reading of the member's email.

The token acts as your Trello account, so it is stored as a secret. Revoke it
from your account settings under *Applications*; the API then answers
`401 invalid token`. The API key is marked secret too, because a key is only
useful with the token it authorized.

At connect time the connector reads `GET /members/me` once to prove both
values, and says who you are signed in as.

## Settings

| Setting | Environment | Required | What it does |
| --- | --- | --- | --- |
| API key | `TRELLO_API_KEY` | yes | Sent as `key` on every call |
| Token | `TRELLO_TOKEN` | yes | Sent as `token` on every call |
| Board | `TRELLO_BOARD_ID` | yes | The board the triggers watch, by id or by the short link from `trello.com/b/<shortLink>/…` |
| Destination list | `TRELLO_TO_LIST_ID` | no | For `cardMoved`: only fire when a card lands in this list |
| Due within hours | `TRELLO_WITHIN_HOURS` | no | For `cardDueSoon`: how far ahead a due date must fall; 24 by default |

The board setting is read by the triggers only. Every action takes its own
ids, so one connection can reach any board the token can see. `listBoards`
returns the ids of every board, `listLists` the ids of a board's lists.

## Rate limits

Trello allows 300 requests per 10 seconds per API key and 100 per 10 seconds
per token, with a separate budget of 100 requests per 900 seconds for the
`/members/` routes. Exceeding one answers `429` with a message naming the
limit. Every answer carries `x-rate-limit-api-key-*` and
`x-rate-limit-api-token-*` headers with the window, budget and what is left.

The triggers and the hand-written actions (`createCard`, `addComment`,
`addLabel`, `searchCards`) go through one small client. On a `429` it waits
`Retry-After` when the header is present, otherwise the interval of whichever
window reports no remaining budget, otherwise 10 seconds, and sends once more;
a second `429` is reported as `429: <message>`. A `401 invalid token` or a
`400` (a bad or unknown id answers a plain-text body such as `invalid id`) is
thrown at once as `<status>: <body>`; a person has to act. The URL is never
quoted in an error, because it carries the key and token.

The declared actions (`updateCard`, `moveCard`, `archiveCard`, `getCard`,
`listBoards`, `listLists`, `listCards`) are sent by the SDK, whose own retry
honours `Retry-After` on a `429` and backs off on a `5xx`; all of them are
idempotent reads or `PUT`s, so a retry lands the same card. A poll is one
request per page and never touches `/members/`.

## Triggers

All four poll the board from the settings. The action triggers ask
`GET /boards/{id}/actions` with a `filter`, `limit=1000`,
`since=<watermark>`, `memberCreator=true&member=false`,
`fields=id,type,date,data` and `memberCreator_fields=fullName,username`.
Actions come back newest first; when a page is full the poll asks again with
`before=<oldest date on the page>`, at most five pages, then reverses so the
workflow sees the oldest first. The watermark is the newest action `date`
delivered; `since` is inclusive at the boundary, so the newest action comes
back once more and dedupe on the action id absorbs it. The first poll starts
24 hours back. Items carry the action `date` as `updatedAt` and the card's
`shortUrl`, or `https://trello.com/c/<shortLink>`, as `url`.

### `cardCreated` — a card was created

`filter=createCard`. `data` is the raw action: `id`, `type`, `date`,
`data.card { id, name, idShort, shortLink }`, `data.list`, `data.board` and
`memberCreator { id, fullName, username }`. Title: `Card created: <name>`.

### `cardMoved` — a card moved to another list

`filter=updateCard:idList`, the sub-filter the cards reference and the
nested-resources guide document. `data` carries `id`, `type`, `date`, `card`,
`listBefore { id, name }`, `listAfter { id, name }`, `board` and
`memberCreator`. The reference's Action schema documents only `data.card`,
`data.board`, `data.list` and `data.text`; a list move carries the origin and
destination as `data.listBefore` and `data.listAfter`, and the connector falls
back to `data.old.idList` and `data.list` when either is missing, so an
unexpected shape degrades to a partial item rather than a failure. Set
**Destination list** to fire only on arrivals in that list. Title:
`Card moved: <name> (<before> → <after>)`.

### `commentAdded` — a comment was added

`filter=commentCard`. `data` is the raw action with `data.text`; the item's
`description` is the comment. Title:
`<member> commented on <card>: <text>`.

### `cardDueSoon` — a card's due date falls inside the window

Reads `GET /boards/{id}/cards` with
`fields=id,name,due,dueComplete,closed,idList,idBoard,shortUrl,url,dateLastActivity,idMembers,labels`
(the plain route returns the open cards) and keeps the cards whose `due` is
set, whose `dueComplete` is false and whose `due` falls between now and now
plus **Due within hours**. There is no cursor: the window moves with the
clock, so every poll re-reads the board. The dedupe key is
`<card id>:<due>`, so a card fires once per due date and fires again if the
due date is changed. Items carry no upstream time; `updatedAt` is the poll
time. `data` is the card. Title: `Due <due>: <name>`.

## Actions

Every action sends `key` and `token` and throws `<status>: <body>` on a
failed answer. List-valued inputs (`labelIds`, `memberIds`, `boardIds`) are
comma-separated strings; whitespace around the commas is removed. Every
write sends its parameters in the query string, as the reference lists them.
A `Card` output is the reference's Card object: `id`, `name`, `desc`,
`closed`, `due`, `start`, `dueComplete`, `dateLastActivity`, `idBoard`,
`idList`, `idLabels`, `idMembers`, `idShort`, `labels`, `pos`, `shortLink`,
`shortUrl`, `url`, `badges`, `cover`. A card id can be the 24-character id or
the short link from the card URL.

| Action | Idempotent | What it does |
| --- | --- | --- |
| `createCard` | no | `POST /cards` with `idList`, `name`, optional `desc`, `due` (ISO 8601), `idLabels`, `idMembers`, `pos` (`top`, `bottom` or a positive number). Returns the `Card`. |
| `updateCard` | yes | `PUT /cards/{id}` with whichever of `name`, `desc`, `due` (the word `null` clears it), `dueComplete`, `closed` were given. Returns the `Card`. |
| `moveCard` | yes | `PUT /cards/{id}` with `idList`, optional `pos` and `idBoard` for a move across boards. Returns the `Card`. |
| `addComment` | no | `POST /cards/{id}/actions/comments` with `text`. Returns the `commentCard` action: `id`, `type`, `date`, `data`, `memberCreator`. |
| `addLabel` | yes | `POST /cards/{id}/idLabels` with `value`. Returns `labelIds` as the API answers and `alreadyPresent`; a `400` saying the label is already on the card counts as success. |
| `archiveCard` | yes | `PUT /cards/{id}?closed=true`. Returns the `Card` with `closed: true`. |
| `getCard` | yes | `GET /cards/{id}?fields=all&list=true&board=true&board_fields=name,shortUrl`. Returns the `Card` plus `list { id, name }` and `board { id, name, shortUrl }`. |
| `listBoards` | yes | `GET /members/me/boards` with optional `filter` (default `open`). Returns `items`: `id`, `name`, `desc`, `closed`, `idOrganization`, `url`, `shortUrl`, `dateLastActivity`. Counts against the `/members/` budget. |
| `listLists` | yes | `GET /boards/{id}/lists` with optional `filter` (`all`, `closed`, `none`, `open`; default `open`). Returns `items`: `id`, `name`, `closed`, `idBoard`, `pos`. |
| `listCards` | yes | `GET /lists/{id}/cards`, one unpaged array. Returns `items` of `Card`s. |
| `searchCards` | yes | `GET /search` with `query`, `modelTypes=cards`, optional `idBoards` (`mine` or ids), `cards_limit` (1 to 1000, default 10) and `partial`. Returns `cards` with their list and board, and `count`. |

The three list actions answer with a bare array, which the SDK stores under
`items`. Search is typed by the reference as a mixed list but answers an
object keyed by model type; the connector reads `cards` from an object and
the card-shaped entries from a list.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/trello/dist/index.js --mock --receipt packages/trello/verified.json
```

`packages/trello/scripts/check.sh` runs exactly this, calling the CLI by its
real path because a linked `node_modules` defeats its entry-point guard. Tests
make no network calls: the client takes an injected `fetch`, and the retry
tests use an injected sleep or fake timers.

`packages/trello/scripts/check-live.sh` exits 0 with a note when
`TRELLO_API_KEY` or `TRELLO_TOKEN` is unset. With both it reads
`/members/me`, the member's open boards and a card search, then the lists,
the newest `updateCard:idList` action (printed so the `listBefore` and
`listAfter` shape can be confirmed), the cards of a list and one card when the
optional ids below are set, and finally `vorn-connector check --live` against
the built package. The same variables fill the live samples of `getCard`,
`listLists` and `listCards`.

| Env | Required | Used by |
| --- | --- | --- |
| `TRELLO_API_KEY` | yes | every call, as `key` |
| `TRELLO_TOKEN` | yes | every call, as `token` |
| `TRELLO_BOARD_ID` | no | `listLists` and the actions probe; skipped when unset |
| `TRELLO_LIST_ID` | no | `listCards`; skipped when unset |
| `TRELLO_CARD_ID` | no | `getCard`; skipped when unset |
| `TRELLO_ARCHIVE_CARD_ID` | no | the live sample of `archiveCard`; name a throwaway card, because it will be archived |

Nothing is created, moved, commented or archived unless
`TRELLO_ARCHIVE_CARD_ID` is set.

## Built from

The REST API reference and guides were the only source. The reference pages
render from the Swagger file at
https://dac-static.atlassian.com/cloud/trello/swagger.v3.json.

- REST API introduction: https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/
- Authorization: https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/
- Rate limits: https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits/
- Action types: https://developer.atlassian.com/cloud/trello/guides/rest-api/action-types/
- Nested resources (the `updateCard:` sub-filters): https://developer.atlassian.com/cloud/trello/guides/rest-api/nested-resources/
- Actions: https://developer.atlassian.com/cloud/trello/rest/api-group-actions/
- Boards: https://developer.atlassian.com/cloud/trello/rest/api-group-boards/
- Cards: https://developer.atlassian.com/cloud/trello/rest/api-group-cards/
- Lists: https://developer.atlassian.com/cloud/trello/rest/api-group-lists/
- Members: https://developer.atlassian.com/cloud/trello/rest/api-group-members/
- Search: https://developer.atlassian.com/cloud/trello/rest/api-group-search/
- Power-Up admin (API key and token): https://trello.com/power-ups/admin
