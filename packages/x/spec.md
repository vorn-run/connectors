id: x

# X connector

X (formerly Twitter), API v2 at `https://api.x.com/2`. Every request is HTTPS,
JSON in (`Content-Type: application/json`) and JSON out. A successful answer
wraps its payload in `data` (an object for a single post or user, an array
for a timeline or search page); related objects requested through
`expansions` arrive beside it in `includes` (`includes.users` for authors),
and list answers carry `meta` with `result_count`, `newest_id`, `oldest_id`
and `next_token`. A 200 can also carry a partial `errors` array next to
`data`, and the error page says to check for it.

Ids are numeric strings up to 19 digits (`^[0-9]{1,19}$`); usernames match
`^[A-Za-z0-9_]{1,15}$`. `created_at` is an ISO 8601 instant
(`2024-01-15T12:00:00.000Z`). A post lookup returns only `id`, `text` and
`edit_history_tweet_ids` unless `tweet.fields` asks for more; the fields
page names the parameter `tweet.fields` while the endpoint schemas name the
same query parameter `post.fields`, and the connector sends `tweet.fields`,
the name the fields guide and the spec use.

**Pricing and access.** The published docs describe pay-per-usage pricing:
credits bought in the Developer Console, deducted per resource read (posts
$0.005, users $0.010) and per write request (post create $0.015, deletes
and other interactions $0.010), deduplicated within a UTC day, with a cap of
3 million post reads per billing cycle. Mentions are "Owned Reads" at $0.001
per resource when the id is the authenticated app owner's own. The pages read
no longer name Free, Basic or Pro tiers, so the README says access is metered
and per-endpoint, quotes the table below for every trigger and read action,
and explains that quote posts need an Enterprise plan ("not available on
self-serve tiers", from the create page). When the API refuses for access or
budget reasons the connector reports the answer plainly: a 402, a 403 whose
`type` ends in `client-forbidden` ("App not enrolled or lacks required
access"), or a 429 whose `type` ends in `usage-capped` ("Usage cap
exceeded") is thrown as `<status> <title>: <detail>` with a sentence saying
the app's plan or credits do not cover the endpoint. The README's tier
section is required by the spec and says exactly this.

Package: `@vornrun/connector-x` in `packages/x`, shaped like the existing
packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from **Docs**,
`verified.json` from `vorn-connector check --mock`, and a `"vorn"` block in
`package.json` with category `Social` (a new category: none of AI,
Communication, Data & observability, Development, Finance, Productivity
fits a social network), keywords (`x`, `twitter`, `posts`, `tweets`,
`mentions`, `social`), and one sentence on how it signs in.

## Auth

Rung: **key**. There is no CLI most developers already sign in to for X, so
the connection takes the four OAuth 1.0a user-context credentials of a
developer app. `auth: { rung: 'key', keys: ['apiKey', 'apiSecret',
'accessToken', 'accessTokenSecret'] }`; `apiSecret` and `accessTokenSecret`
are `secret: true`.

| Config field | Env name | Secret | Where it comes from |
| --- | --- | --- | --- |
| `apiKey` | `X_API_KEY` | no | The app's API Key (consumer key): Developer Console → Apps → the app → Keys and tokens |
| `apiSecret` | `X_API_SECRET` | yes | The app's API Key Secret (consumer secret), same tab |
| `accessToken` | `X_ACCESS_TOKEN` | no | The Access Token generated for your own account, same tab |
| `accessTokenSecret` | `X_ACCESS_TOKEN_SECRET` | yes | The Access Token Secret shown with it |

The console is https://developer.x.com/en/portal/dashboard (the docs now
also call it https://console.x.com). Credentials are shown once at creation;
regenerate them from the Keys and tokens tab. The app's OAuth 1.0a
permission must be **Read and Write** for `createPost`, `replyToPost` and
`deletePost` (Read alone "cannot post, like, or modify anything"), and the
apps page says "changing permissions requires users to re-authorize your
app to get new tokens with the updated scope": an access token generated
before the permission change stays read-only, so regenerate the token after
setting Read and Write. The README says both.

**Signing.** Every request carries `Authorization: OAuth ...` built in the
package with `node:crypto`, no OAuth dependency, following the two signing
pages:

1. Percent-encode with the RFC 3986 rule: leave `A–Z a–z 0–9 - . _ ~`, encode
   every other byte of the UTF-8 form as `%XX` uppercase. Node's
   `encodeURIComponent` plus escaping `! ' ( ) *` does exactly this. The
   doc's own examples pin it: `Ladies + Gentlemen` → `Ladies%20%2B%20Gentlemen`,
   `An encoded string!` → `An%20encoded%20string%21`, `Dogs, Cats & Mice` →
   `Dogs%2C%20Cats%20%26%20Mice`, `☃` → `%E2%98%83`.
2. Collect the query-string parameters and, only for an
   `application/x-www-form-urlencoded` body, the body parameters, plus
   `oauth_consumer_key`, `oauth_nonce`, `oauth_signature_method=HMAC-SHA1`,
   `oauth_timestamp` (Unix seconds), `oauth_token`, `oauth_version=1.0`.
   A JSON body is not a parameter and is not signed; the v2 writes here
   send JSON, so their parameter set is the six `oauth_*` values only.
3. Encode each key and value, sort by encoded key, join as `k=v` with `&`
   (the parameter string). X does not accept duplicate keys.
4. Signature base string = `METHOD & encode(base URL without query) &
   encode(parameter string)`: exactly two `&`, and every `%` of the
   parameter string becomes `%25`.
5. Signing key = `encode(consumer secret) & encode(token secret)`.
6. `oauth_signature` = base64 of HMAC-SHA1(signing key, base string).
7. Header: `OAuth ` then the seven `oauth_*` pairs as `key="encoded
   value"` joined by `, ` (the signature's `/` and `=` become `%2F` and
   `%3D`). Nonce: 32 random bytes, base64, non-word characters stripped.

The signing page's worked example (a POST to
`https://api.x.com/1.1/statuses/update.json?include_entities=true` with a
form body `status=Hello Ladies + Gentlemen, a signed OAuth request!`, nonce
`kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg`, timestamp `1318622958`)
was reproduced during research with the algorithm above: it yields the
page's signature `Ls93hJiZbQ3akF3HF3x1Bz8/zU4=` byte for byte. The
authorizing page shows a different signature for the same request; that
value predates the domain change and neither `api.x.com` nor
`api.twitter.com` reproduces it, so the signing page is the one that counts.

The example's consumer key, token and both secrets must not be copied into
the repository, so the test pins the same example with four stand-ins of the
same shape, whose expected answers were computed with the verified signer:

| Stand-in | Value |
| --- | --- |
| consumer key | `consumer-key` |
| token | `123-token` |
| consumer secret | `consumer-secret` |
| token secret | `token-secret` |

Expected base string:

```
POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dconsumer-key%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D123-token%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521
```

Expected signature: `ZaqfaIjE/MHLy6NXQlBB5Kk/bD8=`, and its header form
`oauth_signature="ZaqfaIjE%2FMHLy6NXQlBB5Kk%2FbD8%3D"`. The test also
checks the four percent-encoding examples, that the header starts with
`OAuth oauth_consumer_key="consumer-key", oauth_nonce=`, and that a GET with
`tweet.fields=created_at,author_id` in the query signs those two as
parameters while a JSON POST signs none.

**Errors.** A non-2xx answer is JSON of one of two shapes: the v2 problem
`{ title, detail, type, status?, ...}` (`type` is a URI such as
`https://api.x.com/2/problems/invalid-request`, `resource-not-found`,
`not-authorized-for-resource`, `client-forbidden`, `usage-capped`,
`rate-limit-exceeded`, or `about:blank`), or the legacy `{ errors: [{ code,
message }] }` that the rate-limit page still shows for a 429 (`code: 88,
message: "Rate limit exceeded"`). The connector throws `<status> <title>:
<detail>` for the first and `<status>: <message> (code <code>)` for the
second, appends the last path segment of `type` when present, and for a 403
appends `reason: <reason>` when the body carries a `reason` field (the spec
asks for it; the pages read do not document such a field, so it is read
optionally and never required). 401 says the four credentials or the
signature are wrong and names the Keys and tokens tab. Problem `detail`
strings the error page shows: `The 'query' parameter is required.` (400),
`Could not find tweet with id: [456].` (404, `resource_type: "tweet"`,
`resource_id`).

**Rate limits.** Every answer carries `x-rate-limit-limit`,
`x-rate-limit-remaining` and `x-rate-limit-reset` (Unix seconds). Per-user
limits apply to OAuth 1.0a requests; the v2 rate-limit page's rows for the
endpoints used:

| Endpoint | Per user | Notes |
| --- | --- | --- |
| `GET /2/users/me` | 75 / 15 min | |
| `GET /2/users/by/username/:username` | 900 / 15 min | |
| `GET /2/tweets/:id` | 900 / 15 min | |
| `GET /2/users/:id/mentions` | 300 / 15 min | |
| `GET /2/tweets/search/recent` | 300 / 15 min | 10 default, 100 max results; 512-character query on this row, 4096 in the schema |
| `POST /2/tweets` | 100 / 15 min | app-wide 10,000 / 24 h |
| `DELETE /2/tweets/:id` | 50 / 15 min | |

On 429 the client reads `x-rate-limit-reset`, waits until it (bounded by a
60-second ceiling, so a fresh 15-minute window cannot hold a step or poll
open; past the ceiling it throws the rate-limit error with the reset
instant in the message) and retries once. On 500, 502, 503 or 504 it waits
one second and retries once. Neither retry applies to `usage-capped`,
which is a budget, not a window. Tests drive both paths through the
injected `fetch` and a fake clock or sleep.

## Triggers

Both are declarative `dedupe: 'lastItem'` triggers: the feed is newest-first
and the id is the only dependable order (`since_id` is an id, and the SDK's
`lastItemId` is exactly what `since_id` wants). `fetch` sends `since_id =
lastItemId` when present and `max_results = min(limit, 100)` (mentions
accept 5–100, search 10–100, so the floor is 5 and 10 respectively), and
returns the page as delivered; the SDK stops at the last delivered id and
keeps the newest as the next cursor. The connector does not follow
`next_token`: a page of 100 per poll is the ceiling, and the SDK's
`hasMore` is not available to a declarative trigger, so the description
says a burst above 100 mentions between polls loses the oldest.

Every item: `externalId` = the post id, `title` = the first 80 characters
of `text` prefixed by `@username: `, `updatedAt` = `created_at`, `url` =
`https://x.com/{username}/status/{id}`, and `data` = the post joined with
its author from `includes.users` (`author_id` matched on `id`), which the
request asks for with
`tweet.fields=created_at,author_id,conversation_id,in_reply_to_user_id&expansions=author_id&user.fields=username,name`.
When the author is missing from `includes` (a partial error) the username
is `""` and the URL uses `https://x.com/i/status/{id}`, which X resolves
without a username.

Sample item, shared by both triggers:

```json
{
  "externalId": "1346889436626259968",
  "title": "@xdevelopers: Hello world!",
  "updatedAt": "2024-01-15T12:00:00.000Z",
  "url": "https://x.com/xdevelopers/status/1346889436626259968",
  "data": {
    "id": "1346889436626259968",
    "text": "Hello world!",
    "createdAt": "2024-01-15T12:00:00.000Z",
    "conversationId": "1346889436626259968",
    "inReplyToUserId": null,
    "author": { "id": "2244994945", "username": "xdevelopers", "name": "X Developers" },
    "url": "https://x.com/xdevelopers/status/1346889436626259968"
  }
}
```

### `newMention` — a post mentions the connected account

- **Poll:** `GET /2/users/{id}/mentions` with the fields above, `since_id`
  when a cursor exists, `max_results`. `id` is the connected account's id
  from `GET /2/users/me?user.fields=id,username,name`, fetched once per
  connection and cached in the client for the process's life (the SDK
  gives no persistent store beyond the cursor, so "once per connection"
  is once per process; the README says so). `since_id` must be less than
  `until_id` when both are sent; only `since_id` is.
- **Dedupe key:** the post id. **Cursor:** the newest id delivered
  (`meta.newest_id` equals the first item's id).
- **Access:** 300 requests per 15 minutes per user; billed as an Owned Read
  ($0.001 per post) when the account owns the app, $0.005 per post
  otherwise, plus one user read for `/users/me` per process.
- **Default workflow:** `X: new mentions`, every 5 minutes.

### `newSearchResult` — a post matches a search

- **Config:** `query` (env `X_SEARCH_QUERY`, required by this trigger only):
  a recent-search query, 1–512 characters, such as `from:xdevelopers
  -is:retweet`. Only posts from the last 7 days are searchable.
- **Poll:** `GET /2/tweets/search/recent?query=…&sort_order=recency` with the
  fields above, `since_id` when a cursor exists (at most one of `since_id`
  and `start_time`; the connector never sends `start_time`), `max_results`.
- **Dedupe key:** the post id. **Cursor:** the newest id delivered.
- **Access:** 300 requests per 15 minutes per user; $0.005 per post
  returned, and the spec notes this endpoint was the one that used to need
  a paid tier: on `client-forbidden` or `usage-capped` the error says the
  app's plan or credits do not cover recent search.
- **Default workflow:** `X: search results`, every 5 minutes.

## Actions

Inputs arrive as strings; `maxResults` is parsed as an integer and refused
outside its range. Every action must survive the mock's `{}` reply and
placeholder arguments, so outputs fall back to `""`, `null` or `[]` and no
nested field is read without a guard. Outputs are declared with
descriptions; every input carries a description (the `manifest` check needs
it).

**Text length.** `createPost` and `replyToPost` count `Array.from(text).length`
(code points) and refuse anything over 280 before sending, with `Post text is
N characters; the limit is 280 for non-Premium accounts`. The pages read do
not publish the weighted counting rule, so this is the plain count; the API
still answers 403 for a text it weighs longer, and that answer is reported
as any other error. Empty text is refused too (the schema says text is
required unless media is sent, and the connector sends no media).

### `createPost` — create a post

- **Inputs:** `text` (string, required: the post, up to 280 characters),
  `inReplyToPostId` (string, optional: id of the post to reply to, sent as
  `reply: { in_reply_to_tweet_id }`), `quotePostId` (string, optional: id of
  the post to quote, sent as `quote_tweet_id`; the docs say quoting needs an
  Enterprise plan and the description says so).
- **Call:** `POST /2/tweets` with `{ text, reply?, quote_tweet_id? }`;
  answers 201 `{ data: { id, text, edit_history_post_ids } }`.
- **Outputs:** `id` (the new post id), `url`
  (`https://x.com/i/status/{id}`: the answer carries no username, and X
  redirects that form), `text`.
- **Idempotent:** no.

### `replyToPost` — reply to a post

- **Inputs:** `postId` (string, required: the post being replied to),
  `text` (string, required, up to 280 characters).
- **Call:** `POST /2/tweets` with `{ text, reply: { in_reply_to_tweet_id:
  postId } }`.
- **Outputs:** `id`, `url`, `text`, as above.
- **Idempotent:** no.

### `deletePost` — delete a post

- **Inputs:** `postId` (string, required).
- **Call:** `DELETE /2/tweets/{id}`; answers 200 `{ data: { deleted: true } }`.
  Only the connected account's own posts can be deleted; a 403 is reported
  with its `detail`.
- **Outputs:** `deleted` (boolean, `false` on a missing field).
- **Idempotent:** no.

### `getMe` — get the connected account

- **Inputs:** none.
- **Call:** `GET /2/users/me?user.fields=id,username,name`; answers
  `{ data: { id, name, username } }`.
- **Outputs:** `id`, `username`, `name`, `url` (`https://x.com/{username}`).
- **Idempotent:** yes. **Sample:** `{}`. This is the live check: 75 requests
  per 15 minutes per user, one user read.

### `getPost` — get a post

- **Inputs:** `postId` (string, required).
- **Call:** `GET /2/tweets/{id}?tweet.fields=created_at,author_id,conversation_id,public_metrics&expansions=author_id&user.fields=username,name`.
- **Outputs:** `id`, `text`, `createdAt`, `authorId`, `authorUsername`,
  `conversationId`, `url`, `metrics` (json: `public_metrics`, whose schema
  requires `like_count`, `reply_count`, `repost_count`, `quote_count`,
  `bookmark_count`, `impression_count`), `raw` (json: the answer).
- **Idempotent:** yes. **Sample:** `{ "postId": "20" }`. 900 per 15
  minutes per user, one post read plus one user read.

### `getUserByUsername` — get a user by username

- **Inputs:** `username` (string, required: the handle without `@`, 1–15
  characters of letters, digits and underscore; a leading `@` is stripped).
- **Call:** `GET /2/users/by/username/{username}?user.fields=id,username,name,description,public_metrics,created_at`.
- **Outputs:** `id`, `username`, `name`, `description`, `createdAt`,
  `followers` (`public_metrics.followers_count`), `following`
  (`following_count`), `posts` (`tweet_count`), `url`, `raw` (json).
- **Idempotent:** yes. **Sample:** `{ "username": "x" }`. 900 per 15
  minutes per user, one user read.

### `searchRecentPosts` — search posts from the last 7 days

- **Inputs:** `query` (string, required, 1–512 characters), `maxResults`
  (number, optional, 10–100, default 10), `sinceId` (string, optional: only
  posts with a greater id).
- **Call:** `GET /2/tweets/search/recent` with the trigger's fields,
  `sort_order=recency`, `max_results`, `since_id`.
- **Outputs:** `posts` (json: array of the trigger's `data` shape), `count`
  (`meta.result_count`, `0` when absent), `newestId` (`meta.newest_id`,
  `""`), `nextToken` (`meta.next_token`, `""`).
- **Idempotent:** yes. **Sample:** `{ "query": "from:xdevelopers -is:retweet",
  "maxResults": "10" }`. 300 per 15 minutes per user, $0.005 per post; the
  README names this as the read that used to require a paid tier, and the
  access errors above say so.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/x/dist/index.js --mock --receipt packages/x/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls: the client takes an injected `fetch` and an injected clock
and sleep. They cover the signer against the stand-in vector above, the
header layout, the query-versus-JSON parameter rule, the 280-character
refusal, the error shapes (problem, legacy `errors`, 403 with and without
`reason`, `client-forbidden`, `usage-capped`), the 429 wait-and-retry with
the reset header, the single 5xx retry, and both triggers' `since_id` and
item mapping including a missing author.

What the receipt says: `manifest`, `auth`, `secrets`, `actions`, `mock`,
`dedupe`, `no-lifecycle-scripts`, `keywords`, `no-runtime-deps`, `launch`.
Under `--mock` every action gets `mock-` placeholders for the four
credentials and a `{}` reply, so each output falls back as described and
no warning spoils the receipt.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `X_ACCESS_TOKEN` is unset.
No key exists on this machine, so that is the path it takes here.

| Env | Required | Used by |
| --- | --- | --- |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | yes | every call |
| `X_SEARCH_QUERY` | no | `newSearchResult`; the script sets `from:xdevelopers -is:retweet` when unset |

With all four set the script builds the package and runs `vorn-connector
check --live`, which calls the idempotent actions on their samples:
`getMe`, `getPost` on id 20, `getUserByUsername` on `x`, and
`searchRecentPosts`. Those are billed reads (a handful of posts and users)
and need credits on the app; nothing is created or deleted, because the
write actions are not idempotent and the SDK never calls them live. A
sandbox is any X developer app with Read and Write permission, an access
token generated after that setting, and a small credit balance.

## Dependencies

None at runtime. `node:crypto` (`createHmac`, `randomBytes`) signs;
`fetch` and `URLSearchParams` carry the requests; the OAuth 1.0a header is
under a hundred lines, so no OAuth package is inlined.
`@vornrun/connector-sdk` at the range the other packages use.

## Icon

X's mark is a black letter X drawn as two crossing diagonals of unequal
weight: the diagonal from top-left to bottom-right is a heavy bar, and the
one from top-right to bottom-left is thin and is cut where the heavy bar
crosses it. A single-colour SVG in a `0 0 24 24` box, `fill="currentColor"`,
`fill-rule="evenodd"`, one path built from three polygons:

1. The heavy bar: the parallelogram (0, 1.2), (7.6, 1.2), (24, 22.8),
   (16.6, 22.8).
2. Its inner slit, which makes the heavy bar read as an outline: the
   parallelogram (4.3, 3.4), (6.6, 3.4), (19.7, 20.6), (17.4, 20.6), drawn
   inside the first so evenodd leaves it open.
3. The thin bar in two pieces, each stopping at the heavy bar's edge: the
   upper-right piece (18.9, 1.2), (22.7, 1.2), (14.9, 10.3), (12.8, 7.5),
   and the lower-left piece (11.2, 16.5), (9.2, 13.7), (0.5, 22.8), (4.3,
   22.8).

The develop step tunes the slit and the two cut points so the thin bar's
ends align with the heavy bar's edges at 24 pixels.

## Docs

The only source. The spec's error page URL answers 404 and redirects to a
page that also answers 404; the response-codes page it lists under related
topics is the one read.

- X API introduction: https://docs.x.com/x-api/introduction
- About the X API (versions, pricing summary): https://docs.x.com/x-api/getting-started/about-x-api
- Pricing and credits: https://docs.x.com/x-api/getting-started/pricing
- Authentication overview: https://docs.x.com/resources/fundamentals/authentication
- API key and secret: https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/api-key-and-secret
- Developer apps and permissions: https://docs.x.com/resources/fundamentals/developer-apps
- OAuth 1.0a, creating a signature: https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature
- OAuth 1.0a, authorizing a request: https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/authorizing-a-request
- OAuth 1.0a, percent encoding: https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/percent-encoding-parameters
- Fields: https://docs.x.com/x-api/fundamentals/fields
- Create a post: https://docs.x.com/x-api/posts/creation-of-a-post
- Delete a post: https://docs.x.com/x-api/posts/post-delete-by-post-id
- Post lookup by id: https://docs.x.com/x-api/posts/post-lookup-by-post-id
- Users me: https://docs.x.com/x-api/users/user-lookup-me
- User by username: https://docs.x.com/x-api/users/user-lookup-by-username
- Mentions timeline: https://docs.x.com/x-api/posts/user-mention-timeline-by-user-id
- Recent search: https://docs.x.com/x-api/posts/recent-search
- Rate limits overview: https://docs.x.com/resources/fundamentals/rate-limits
- X API v2 rate limits (per-endpoint tables): https://docs.x.com/x-api/fundamentals/rate-limits
- Response codes and errors: https://docs.x.com/x-api/fundamentals/response-codes-and-errors
