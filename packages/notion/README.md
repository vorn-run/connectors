# @vornrun/connector-notion

Trigger Vorn workflows from the pages in a Notion database, and create or update
pages from a workflow step.

## Install

Nothing to install by hand. In Vorn, create an **MCP** connection with:

| Field   | Value                                 |
| ------- | ------------------------------------- |
| Command | `npx`                                 |
| Args    | `["-y", "@vornrun/connector-notion"]` |

## Authentication

**There is no Notion CLI.** No first-party tool mints API credentials, so unlike
`@vornrun/connector-kusto` — where `az login` is the whole story — a secret has
to be pasted.

1. Create an integration at
   [notion.so/profile/integrations](https://www.notion.so/profile/integrations).
   Give it **read content**, **update content** and **insert content**
   capabilities. "Update content" on its own cannot create pages, and widening
   capabilities later forces every OAuth user to re-authenticate — so choose the
   full set now.
2. Copy the token into `NOTION_TOKEN`.
3. **Share the database with the integration.** Open it in Notion, ••• →
   **Add connections**, and pick the integration.

Step 3 is not optional and is the single most common setup failure. A perfectly
valid token returns **404 on everything** until a human shares each page or
database with the connection — that is the expected first-run state, not a wrong
id. The connector says so in the error rather than leaving you to guess.

A workspace-owner-created *internal integration token* and a *personal API key*
have the same wire format, so either works here. Creating an internal
integration requires being a workspace owner; a personal API key does not.

OAuth is not implemented. It needs a registered public integration with a hosted
redirect URI, and Notion documents neither a token lifetime nor refresh-rotation
semantics — see `design.md` §2 and §5.

## Configuration

| Variable                 | Required | Default | Meaning                                                                    |
| ------------------------ | -------- | ------- | -------------------------------------------------------------------------- |
| `NOTION_TOKEN`           | yes      |         | Integration token or personal API key                                      |
| `NOTION_DATABASE_ID`     | yes      |         | The database URL, or the 32-character id in it                             |
| `NOTION_DATA_SOURCE_ID`  | no       |         | Only when the database has more than one data source                       |
| `NOTION_FILTER`          | no       |         | A JSON filter in Notion's own syntax, ANDed with the poll watermark        |
| `NOTION_STATUS_PROPERTY` | no       |         | Property carrying status. Blank uses the first `status`, then first `select` |
| `NOTION_LIMIT`           | no       | `100`   | Maximum pages per poll. 100 is Notion's documented maximum                 |

### Databases and data sources

Since API version `2025-09-03` a Notion database is a *container*, and the
queryable schema lives on its **data sources**. A database id is rejected by the
data-source endpoints and vice versa. The id you can copy out of a browser is the
database's, so that is what this connector asks for, and it resolves the data
source itself.

If the database has exactly one data source it is used silently. If it has
several, the connector fails with their ids and names listed and asks you to set
`NOTION_DATA_SOURCE_ID` — guessing would point every poll at the wrong table
while appearing to work.

Both id fields accept a pasted URL. The `?v=` view id in a database URL is
ignored.

## Trigger: `pageChanged`

Fires once per page in the data source that Vorn has not seen at this time.

Each poll asks Notion for everything with `last_edited_time` **on or after** the
watermark, sorted ascending, with an explicit `page_size`, following `has_more`
to the end. The watermark is inclusive because re-delivering an item is free —
Vorn's `timestamp` dedupe drops it — while missing one loses an event.

Each page becomes an item with:

| Field         | From                                                       |
| ------------- | ---------------------------------------------------------- |
| `externalId`  | the page id — stable across renames and moves              |
| `title`       | whichever property has type `title`                        |
| `status`      | the status/select property's option name                   |
| `updatedAt`   | `last_edited_time`                                         |
| `url`         | the browser URL                                            |
| `statusGroup` | the group behind that option: To-do / In progress / Complete |

Every database property is flattened and available to templates as
`{{trigger.item.properties.Owner}}` and so on.

### Status mapping

Notion has no fixed workflow states — a status property's options are whatever a
team invented. The seeded mapping covers the common names (`Not started`,
`In progress`, `Done`, `Cancelled`, …), and you can edit it on the connection.
When a team's vocabulary is not in that list, branch on `statusGroup` instead:
the three groups are the part of a Notion status property that cannot be renamed
away.

### What it cannot see

Polling a data source query only ever returns pages that currently match, so a
page that is **deleted, trashed, moved out of the database, or locked** produces
no event. Notion emits those as webhooks, which need a publicly reachable HTTPS
receiver — impossible for a connector launched by `npx` on a laptop. See
`design.md` §4.

A single query is capped at **10,000 results** server-side. When Notion reports
`query_result_limit_reached` the connector warns on the poll and the `findPages`
action returns `truncated: true`, rather than quietly handing back a short list.

## Actions

| Action       | Idempotent | Notes                                                     |
| ------------ | ---------- | --------------------------------------------------------- |
| `createPage` | **no**     | Notion has no idempotency key; two calls make two pages    |
| `updatePage` | yes        | Setting the same values twice lands in the same state      |
| `findPages`  | yes        | A read                                                     |

**`createPage`** takes `title`, an optional `markdown` body (paragraphs and `#`
headings) and optional `properties` as a JSON object in the API's own shape. The
body is capped at 100 blocks, which is Notion's own limit for one create call —
a longer body is **refused**, not truncated. Returns `id` and `url`.

**`updatePage`** takes a page URL or id plus `title`, `properties`, or both. An
empty patch throws rather than reporting a successful no-op. Property names are
checked against the data source schema first, so a typo names itself instead of
becoming a generic Notion 400. Rollup properties are refused — the API cannot
write them. `erase_content` is deliberately not exposed: it destroys a page's
blocks with no undo.

**`findPages`** takes an optional JSON `filter` and `limit`, and returns `count`,
`pages` and `truncated`.

## Troubleshooting

**404 on everything** — the database has not been shared with the integration.
Open it in Notion, ••• → Add connections.

**403** — a capabilities problem, not a sharing one. The integration needs read,
update and insert content.

**`Database … has N data sources`** — set `NOTION_DATA_SOURCE_ID` to one of the
ids in the message.

**429** — the rate limit is per *workspace* and shared with every other
integration installed there, so this can be someone else's traffic. The vendor
client has no retry policy of its own, so `src/client.ts` supplies one: 429, 503
and 529 are retried up to three times, honouring `Retry-After` when Notion sends
one and otherwise backing off exponentially **with full jitter** — an unjittered
fleet would re-collide on the shared budget every attempt. 400, 401, 403 and 404
are never retried; the second answer would be the same as the first.

## Built from

- Notion API reference and guides, `https://developers.notion.com` — authorization,
  capabilities, data sources, `POST /v1/data_sources/{id}/query`, `POST /v1/pages`,
  `PATCH /v1/pages/{id}`, request limits, and the `2025-09-03` upgrade guide.
- `makenotion/notion-sdk-js` v5.24.0, read directly — `Client.ts`,
  `api-endpoints/data-sources.ts`, `helpers.ts`.
- `research.md` at the repo root, and `design.md` in this package, which record
  where the vendor documentation contradicts itself and how each conflict was
  resolved.

The API version is pinned to `2025-09-03` in one constant in `src/client.ts`, sent
explicitly rather than inherited from the installed SDK's default, so the version
this package was tested against is the version it sends.
