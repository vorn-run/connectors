# Notion connector — design

Design only. No connector code yet. Everything factual here traces to `research.md`
at the repo root, which is sourced from `developers.notion.com` and `makenotion/notion-sdk-js`
v5.24.0 read directly. Where research left a question open, it is called out below as
an open question rather than papered over.

House style read from `packages/linear` and `packages/ado`: `client.ts` holds the
transport and every non-obvious decision as a comment; `connector.ts` holds the
manifest and maps upstream shapes to `ConnectorItem`; both take an injectable
`fetch`/connect so tests never reach the network; `index.ts` wires version and
`serveIfEntryPoint`.

---

## 1. API surface, and whether to use the vendor SDK

**Surface: the Notion REST API, `https://api.notion.com/v1/`, pinned to
`Notion-Version: 2025-09-03`.**

Pinned explicitly, never inherited. Research conflict #1: the docs advertise
`2026-03-11` as newest, while SDK v5.24.0 still defaults to `2025-09-03`
(`Client.ts:261`). Both are true. `2025-09-03` is the data-source model, is what the
SDK defaults to, and Notion states no plans to retire old versions. Pinning it in one
constant in `client.ts` means the version we were tested against is the version we
send, and a bump is one line with a test.

**Vendor SDK: yes — `@notionhq/client` (makenotion/notion-sdk-js).**

Use it. This is not the Linear situation. The rule in `README.md` is prefer a
maintained vendor client, and `packages/linear/src/client.ts` records why it takes the
exception: `@linear/sdk` is a generated client over the entire GraphQL schema,
megabytes of types for seven operations, downloaded by `npx` on every launch. Notion's
SDK is a hand-written thin REST wrapper — no codegen bloat — and it carries three
things we would otherwise have to re-derive and keep re-deriving:

1. the `Notion-Version` header plumbing and per-endpoint request/response types
   for the post-`2025-09-03` data-source model;
2. `isFullPage` / partial-object type guards, which matter because `POST /v1/pages`
   can legitimately return `{object, id}` only (research §1.3) and a connector that
   assumed the full shape crashes on the partial one;
3. `verifyWebhookSignature` / `signWebhookPayload`, constant-time, raw-body-correct
   — relevant if we ever take the webhook path (§5).

`packages/ado` already sets the precedent for depending on the vendor client
(`azure-devops-node-api`, ~5MB, cached once per version by `npx`) for exactly this
reason. So: **`@notionhq/client` as a dependency, no hand-rolled transport, and no
justification comment needed in the module** — the module comment instead records the
version pin and the reason the pin is explicit.

What the SDK does *not* do, and therefore stays in our `client.ts`, mirroring the
"what the SDK does not do is batch" note in `packages/ado/src/client.ts`:

- **Retry policy.** Research §3: retry 429 / 529 / 503 honouring `Retry-After`
  (integer seconds), else exponential backoff **with jitter**; never retry
  400 / 401 / 403 / 404. The per-workspace limit is shared across every integration in
  that workspace, so a client-side 3 rps limiter is provably insufficient — reactive
  `Retry-After` handling is the mechanism, a limiter is at best a courtesy.
- **Paging.** Loop on `has_more`, never on `results.length`, and always send an
  explicit `page_size` — research conflict #3 has the docs contradicting themselves on
  one page (100 vs 10) about the default, so we do not rely on one.
- **The 10,000-result ceiling.** `request_status.incomplete_reason =
  "query_result_limit_reached"` must surface as a visible warning on the poll, not be
  swallowed. Silently truncating a trigger is the failure mode that looks like data
  loss months later.
- **database → data source resolution** (§3, config).
- **Error translation**, in the spirit of ADO's `explain()`: a 404 on everything is
  the *expected first-run state* for Notion, and it means "nobody has shared a page
  with this connection", not "your id is wrong". See §2.

---

## 2. How it signs in

Ranked as the workflow asks. The headline finding, from research §2:

> **There is no Notion CLI.** No first-party CLI mints API credentials; nothing in the
> SDK repo or the authorization docs references one. Every path terminates in a browser
> OAuth round-trip or a human copying a secret out of the Notion web UI.

So the `packages/ado` story — "if `az login` works in your terminal, the connector
works, there is no token to paste" — **is not available for Notion.** This should be
stated plainly in the package README rather than left for a user to discover.

### Rank 1 — interactive credential with a cached token: OAuth 2.0 public integration

The best available option, and the primary path.

- No admin: *"each prospective user needs to individually follow the auth flow"*.
- No pasted secret for the end user. Vorn holds `CLIENT_ID` / `CLIENT_SECRET`;
  the user sees a browser consent screen and a page picker.
- Revocable, and the token response hands back `workspace_id` / `workspace_name` /
  `bot_id`, which we surface so a user can tell which workspace a connection points at.
- Token exchange `POST /v1/oauth/token`, HTTP Basic with base64 `CLIENT_ID:CLIENT_SECRET`,
  `Notion-Version` required on this call too.

Two things this costs us, both of which are design work, not code:

- **`redirect_uri` is conditionally required** (research §2 B). Send it when it was in
  the authorization URL or when the integration lists several; it is *rejected* when
  only one URI is configured and it was not in the authorization URL. Getting this
  wrong returns `invalid_request`. One code path, one test each way.
- **Refresh semantics are unconfirmed** (research §4.1, §4.2). Notion documents no
  `expires_in`, and `refresh_token` is explicitly "string or null". We do not know
  whether access tokens expire, nor whether an old refresh token is invalidated
  immediately. **Build defensively:** persist `access_token` and `refresh_token`
  atomically together, treat a 401 on a previously-working token as "try refresh, then
  re-auth", and serialise refresh per connection so two concurrent polls cannot race
  and log the user out. This is the single largest unknown in the connector and should
  be resolved against a live workspace before OAuth ships.

Caching: Vorn stores the token pair on the connection (`secret: true`), so the browser
round-trip happens once per workspace, not once per launch. That is the "cached token"
half of this rank.

### Rank 2 — pasted key: personal access token (PAT)

The escape hatch, and the thing that will actually ship first.

- Acts as the user who created it, with that user's permissions in the chosen
  workspace. Broadest access of the three.
- **No workspace-owner ceremony** beyond being the user — this is why PAT ranks above
  the internal integration token, despite both being pasted secrets.
- Reason the paste is unavoidable: there is no CLI, and OAuth requires Vorn to register
  and operate a public integration with a hosted redirect URI. Until that exists — and
  for self-hosted Vorn where it may never exist — a pasted bearer token is the only
  thing that reaches the API. Recorded here so it is a decision, not a default.

Config field: `token`, `env: NOTION_TOKEN`, `secret: true`, `required: true` — same
shape as Linear's `apiKey`.

### Rank 3 — last resort, **requires a workspace admin**: internal integration token

⚠️ **Labelled as admin-gated.** Research §2 A: *"You are required to be a workspace
owner to create a connection."* Same wire format as the PAT (a static bearer token),
so the connector code does not branch — but the *instructions* differ, and a user who
is not an owner will hit a wall in the Notion UI before they ever reach Vorn. Offer it
only in the setup text, as "if your workspace requires it".

Also assume some enterprise workspaces gate public-integration installs (research §4.9
— implied by the capabilities page, not confirmed). Make that failure legible.

### The thing that is not auth, and will generate most of the support load

**Auth succeeding and data being visible are two separate events.** For every path
above, the connection sees *nothing* until a human opens each page or database in
Notion and does ••• → `Add connections`. A perfectly valid token returning 404 on
everything is the expected first-run state. Research calls this the #1 support burden
and I agree.

Design consequences, all deliberate:

- The `explain()`-equivalent in `client.ts` translates a 404 on the configured data
  source into: *"Notion returned 404. The token is valid but the database has not been
  shared with this connection — open it in Notion, ••• → Add connections, and pick this
  integration."* This is the ADO sign-in-page lesson applied: the raw error sends people
  to look at the wrong thing.
- A 403 translates to a **capabilities** problem, not a sharing one. Notion uses
  capabilities, not OAuth scopes; "read content" / "update content" / "insert content"
  are separate, and *update content cannot create pages*. So the capability set must be
  chosen before shipping: **read content + update content + insert content, users
  without email addresses.** Widening it later *forces every installed OAuth user to
  re-authenticate* (research §2, capabilities) — that is a one-way door.

### `package.json` → `"vorn"."auth"`

> "Paste a Notion integration token, then share the pages you want it to see with the
> connection in Notion. There is no Notion CLI to sign in with."

Honest, and it front-loads the sharing step.

---

## 3. The manifest

### Config fields

| key | env | secret | required | notes |
| --- | --- | --- | --- | --- |
| `token` | `NOTION_TOKEN` | yes | yes | Integration token or PAT. OAuth swaps this for a stored pair later without changing the field. |
| `databaseId` | `NOTION_DATABASE_ID` | | yes | The database URL or id people paste from the browser. |
| `dataSourceId` | `NOTION_DATA_SOURCE_ID` | | | **Only needed when the database has more than one data source.** Blank resolves it automatically. |
| `filter` | `NOTION_FILTER` | | | Optional JSON filter, in Notion's own filter syntax, ANDed with the watermark. |
| `statusProperty` | `NOTION_STATUS_PROPERTY` | | | Name of the property carrying status. Defaults to the first `status` then first `select` property in the schema. |
| `limit` | `NOTION_LIMIT` | | | Max per poll, default 100 — the documented maximum `page_size`. |

**Why `databaseId` and `dataSourceId` are two fields.** Research §1.6: since
`2025-09-03` a database is a *container* and the schema/query surface lives on data
sources; `GET /v1/databases/:id` returns a `data_sources[]` array, and *"you can't use
a database ID with the retrieve data source API, or vice-versa"*. A one-field
"database ID" picker is now wrong. But making everyone paste a data source id is also
wrong — the id you can get from a browser URL is the database's. So: take the database
id, resolve it, and if there is exactly one data source use it silently; if there are
several, fail with an error that **lists the ids and names** and tells the user to set
`dataSourceId`. Resolution is cached per connection like ADO caches its `WitApi`
connection, because it is a network round trip that does not change between polls.

Both fields accept a pasted URL as well as a bare id, the way ADO's
`organizationName()` accepts `https://dev.azure.com/contoso` — that is what people
actually have in their clipboard. Notion URLs carry a 32-char unhyphenated id, so
normalising to canonical UUID form belongs in `client.ts` with a test.

### Trigger — one

```
type:        pageChanged
label:       A page is created or changed
description: Fires once per page in the database that Vorn has not seen at this time.
dedupe:      timestamp
```

**Mechanism: poll `POST /v1/data_sources/{id}/query`** — POST, not PATCH; research
conflict #2 resolves against the upgrade guide's table in favour of the reference page
and `data-sources.ts:601` (`method: "post"`).

**Dedupe strategy: `timestamp`.** Every Notion page carries `last_edited_time`, and the
query endpoint can both filter and sort on it. Each poll sends:

- `filter`: a `timestampFilter` `{ timestamp: "last_edited_time", last_edited_time: { on_or_after: since } }`,
  ANDed with the user's optional `filter` — and the SDK's `since` is a *hint*, so
  `on_or_after` (inclusive) rather than `after`. Returning something already delivered
  is free; missing something is not. Same reasoning as Linear's `updatedAt: { gte: since }`.
- `sorts`: `[{ timestamp: "last_edited_time", direction: "ascending" }]`.
- `page_size`: explicit, never defaulted (conflict #3).
- Paging: loop on `has_more` / `next_cursor` up to `limit`.

`externalId` is the page id (a UUID — stable across renames and moves, unlike the
title or the URL slug). `updatedAt` is `last_edited_time`. That satisfies the SDK's
requirement that `updatedAt` be monotonic per item and ISO-8601-comparable.

**Why not webhooks, given Notion has real ones.** Research §1.1 is decisive against
them *for this SDK*:

- The Vorn SDK's contract is `fetch(context) → items` on a timer. A push trigger would
  need the `poll()` escape hatch plus a receiving server.
- The endpoint *"must be a secure (SSL) and publicly available endpoint. Endpoints in
  localhost are not reachable."* A connector launched by `npx` on someone's laptop has
  no such endpoint.
- Setup is UI-only and involves a human copying a `verification_token` out of a JSON
  body into the Notion web UI — and *"you can only change the webhook URL before
  verification"*, so a laptop's tunnel URL is a one-shot.
- The payload is a pointer, not the object: every event needs a follow-up read anyway.
- Events are *aggregated* — `page.content_updated` *"may take a minute or two"* — so
  push is not even a large latency win over a 5-minute poll.

Polling costs us sub-minute latency and misses **deletes** (§4). That is the right
trade here and is revisited in §5.

### `statusMapping`

Notion has no fixed workflow states. A `status` property has user-defined options
grouped into exactly three groups — To-do, In progress, Complete — and the group is
the stable thing, the way Linear maps on state *type* rather than name because a team
can rename "In Progress" to anything. But the query response gives us the option's
`name` (and its group), not a canonical enum, so the mapping has to be over the names
teams actually use, case-insensitively, with a fallback to the group.

```
{ upstream: 'Not started',  suggestedLocal: 'todo' }
{ upstream: 'To-do',        suggestedLocal: 'todo' }
{ upstream: 'Backlog',      suggestedLocal: 'todo' }
{ upstream: 'In progress',  suggestedLocal: 'in_progress' }
{ upstream: 'In review',    suggestedLocal: 'in_progress' }
{ upstream: 'Doing',        suggestedLocal: 'in_progress' }
{ upstream: 'Done',         suggestedLocal: 'done' }
{ upstream: 'Complete',     suggestedLocal: 'done' }
{ upstream: 'Shipped',      suggestedLocal: 'done' }
{ upstream: 'Cancelled',    suggestedLocal: 'cancelled' }
{ upstream: 'Archived',     suggestedLocal: 'cancelled' }
```

Without these every page imports as `todo`, including work closed a year ago — the
exact failure Linear's comment names. Because the list cannot be exhaustive over
user-defined options, `item.data.statusGroup` also carries the raw group name so a
workflow can branch on it when a team's vocabulary is not above.

### `defaultWorkflow`

```
{ name: 'Notion: database pages', defaultCronFromMinutes: 5 }
```

Five minutes matches Linear and sits comfortably inside Notion's aggregation window
(`page.content_updated` may take *"a minute or two"* to even exist), so a tighter
interval would burn the shared per-workspace rate budget for events that are not there
yet.

### Actions — three

| type | label | idempotent | why |
| --- | --- | --- | --- |
| `createPage` | Create a page | **no** | `POST /v1/pages`. Two calls make two pages. Notion offers no client-supplied idempotency key, so a retrying agent has no other way to know. Declared false exactly as `createWorkItem` and `createIssue` are. |
| `updatePage` | Update a page | **yes** | `PATCH /v1/pages/{id}`. Setting the same properties to the same values lands the page in the same state, so a retry is safe. Same reasoning as ADO's `updateWorkItem`. |
| `findPages` | Find pages | **yes** | `POST /v1/data_sources/{id}/query`. A read; repeating it changes nothing. |

Constraints to encode, from research §1.3–1.5:

- **`createPage`**: parent is `{ data_source_id }`, not `database_id` — post-2025-09-03
  model. `children` is capped at `maxItems: 100` and the whole payload at 1000 blocks /
  500KB, so a long body must be created with ≤100 blocks and the rest appended; for the
  first version, accept a `markdown` string (mutually exclusive with children) and
  **refuse oversized input with a clear error** rather than silently truncating it.
  Do **not** pass `allow_async` — a `202` async-task response would require a polling
  loop honouring `poll_after_seconds`, and a synchronous action is the simpler contract.
  Handle the `partialPageObjectResponse` shape (`{object, id}` only) on the way out.
- **`updatePage`**: property edits only work when the parent is a data source (except a
  page `title`), and the submitted properties *must match the parent's schema* — so
  validate against the fetched schema and name the offending property rather than
  forwarding a raw 400. Rollup properties cannot be updated. **`erase_content` is not
  exposed**: it wipes block children irreversibly and there is no undo through the API.
  An empty patch throws rather than reporting success, per ADO's `updateWorkItem`.
- **`findPages`**: explicit `page_size`, loop on `has_more`, and surface
  `query_result_limit_reached` in the output rather than returning a quietly short list.

Outputs follow house style — the **browser** URL (`page.url`), not the API resource,
so `{{steps.createPage.url}}` is a link somebody can follow.

---

## 4. What this connector cannot do, and what that would cost

**Sub-minute latency, and deletes/moves/comments as triggers.**
Polling a data source query only ever sees pages that currently match. A page deleted,
trashed, moved out of the database, locked, or commented on produces no row and
therefore no event. Notion *does* emit `page.deleted`, `page.moved`, `page.locked`,
`comment.created` as webhooks. Cost: a hosted, publicly-reachable HTTPS receiver in
Vorn — not in the connector — plus the SDK's `poll()` escape hatch, plus a one-time
manual verification handshake per subscription (copy `verification_token` out of a JSON
body into the Notion UI, unchangeable URL after verification), plus HMAC-SHA256
verification over the **raw** body. Call it a Vorn-platform feature, one to two weeks,
and it changes the connector's shape from `fetch` to `poll`. Not a code change we can
make inside this package alone.

**OAuth on day one.** Costs a registered public integration, a hosted redirect URI, the
conditional-`redirect_uri` branch, and — the real cost — resolving the two unknowns in
research §4.1/§4.2 (token lifetime, refresh rotation semantics) against a live
workspace, because guessing wrong there logs users out intermittently in a way that is
very hard to debug. Days, and it is gated on Vorn having a hosted callback at all.

**Seeing anything nobody shared with it.** Structural, not fixable in code. Every auth
path is partial-by-design: internal tokens see only pages explicitly shared via
••• → Add connections, and the OAuth page picker *"only displays pages or databases to
which a user has full access"*. Cost: zero engineering, unbounded human effort — it is
per-page, per-workspace, forever. Which is why the sharing step is in the setup text
and in the 404 error message rather than in a footnote.

**More than 10,000 results from one query.** Hard server-side ceiling
(`query_result_limit_reached`). We surface it as a warning; we cannot page past it.
Cost: nothing to build, but a user with a very large database must narrow their filter.
Mitigated in practice by the watermark — after the first poll, only what changed comes
back.

**Guaranteeing rate-limit headroom.** The per-workspace limit is *shared across all
that workspace's connections and scaled to the plan*, and Notion publishes no plan → rps
table (research §4.5). We can be perfectly behaved and still get 429'd by somebody
else's integration. Cost: unfixable. Mitigation is the reactive `Retry-After` path and
not hard-coding any number, since Notion warns limits will change.

**Blocks, files, users, and comments as first-class objects.** v1 treats a page as its
properties. Reading page *content* means walking the block tree
(`GET /v1/blocks/{id}/children`, recursively, paged) and writing it means chunked
appends under the 100-block cap. Cost: a few days per direction, mostly in the block-model
mapping — worth doing only once a workflow actually needs page bodies rather than fields.

**Rollup properties, and moving a page's parent.** Both refused by the API itself
(§1.4). No cost estimate; there is nothing to buy.

---

## 5. Open questions to close before code

1. **OAuth token lifetime and refresh rotation** (research §4.1, §4.2) — blocks Rank-1
   auth. Needs a live workspace.
2. **`2026-03-11` vs `2025-09-03`** — we pin `2025-09-03`; confirm Notion's recommendation
   for new integrations before the pin ossifies.
3. **Default `page_size`** — we sidestep it by always sending one explicitly, so this is
   informational only.
4. **Whether enterprise workspaces can block a public-integration install** (§4.9) —
   affects how we word the OAuth failure path, not what we build.
5. Nothing in research was executed against the live API. First code task should be a
   `--live` `checkConnector` run against a real workspace, before the manifest is frozen.
