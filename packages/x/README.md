# @vornrun/connector-x

Trigger Vorn workflows from new mentions of the connected account or from
posts matching a search on X (formerly Twitter), and create, reply to, delete,
read and search posts from a workflow step. Talks to API v2 at
`https://api.x.com/2`.

## Signing in

Paste the four OAuth 1.0a user-context credentials of an X developer app.
There is no X CLI to borrow a login from. Create the app in the
[Developer Console](https://developer.x.com/en/portal/dashboard) under
Projects & Apps, open the app's **Keys and tokens** tab, and copy the API Key
and Secret (the consumer key pair) and the Access Token and Secret generated
for your own account. Each value is shown once at creation; regenerate it from
the same tab.

Two things about the app's permissions:

- Set **User authentication settings** to **Read and Write** before
  `createPost`, `replyToPost` or `deletePost` will work. Read alone "cannot
  post, like, or modify anything".
- Generate (or regenerate) the access token **after** setting Read and Write.
  Changing permissions "requires users to re-authorize your app to get new
  tokens with the updated scope": an access token generated before the change
  stays read-only, and the API answers `403` to every write.

Every request is signed in the package with `node:crypto`: an
`Authorization: OAuth …` header carrying `oauth_consumer_key`, `oauth_nonce`,
`oauth_signature` (HMAC-SHA1, base64), `oauth_signature_method`,
`oauth_timestamp`, `oauth_token` and `oauth_version`, built as the signing
guide describes. A `401` means one of the four values or the signature is
wrong; the error says so and names the Keys and tokens tab.

All four fields are stored encrypted. The consumer key and access token are
not secrets in X's own terms, but Vorn stores every field that names a
credential encrypted, and the SDK refuses to leave one in the clear.

## Settings

| Setting | Environment | Required | What it does |
| --- | --- | --- | --- |
| API key | `X_API_KEY` | yes | The app's API Key (OAuth 1.0a consumer key) |
| API key secret | `X_API_SECRET` | yes | The app's API Key Secret; half of the signing key |
| Access token | `X_ACCESS_TOKEN` | yes | The access token generated for your own account |
| Access token secret | `X_ACCESS_TOKEN_SECRET` | yes | Shown with the access token; the other half of the signing key |
| Search query | `X_SEARCH_QUERY` | for `newSearchResult` | A recent-search query, 1 to 512 characters, such as `from:xdevelopers -is:retweet` |

## Access, pricing and tiers

Access to the X API is metered per endpoint, and the connector cannot make a
call the app's plan or credit balance does not cover. The pages the connector
was built from describe pay-per-usage pricing: credits bought in the Developer
Console, deducted per resource read and per write request, deduplicated within
a UTC day, with a cap of 3 million post reads per billing cycle. Those pages
no longer name the Free, Basic and Pro tiers; what the older tiers allowed is
recorded here because the API still refuses in the same shapes:

- The **Free** tier allowed writes (create and delete a post) and
  `GET /2/users/me`, with a small monthly post budget and very few reads.
- The **mentions timeline** and **recent search** were the reads that needed
  **Basic or above**. If your app is on a legacy tier, `newMention`,
  `newSearchResult` and `searchRecentPosts` are the ones that will refuse.
- **Quote posts** need an Enterprise plan: the create page says quoting is
  "not available on self-serve tiers".

What each call costs and how often it may be made, per user, from the
rate-limit and pricing pages:

| Call | Used by | Rate limit | Billing |
| --- | --- | --- | --- |
| `GET /2/users/me` | `getMe`, `newMention` once per process | 75 / 15 min | 1 user read ($0.010) |
| `GET /2/users/:id/mentions` | `newMention` | 300 / 15 min | per post returned: Owned Read ($0.001) when the account owns the app, $0.005 otherwise |
| `GET /2/tweets/search/recent` | `newSearchResult`, `searchRecentPosts` | 300 / 15 min | $0.005 per post returned |
| `GET /2/tweets/:id` | `getPost` | 900 / 15 min | 1 post read plus 1 user read |
| `GET /2/users/by/username/:username` | `getUserByUsername` | 900 / 15 min | 1 user read |
| `POST /2/tweets` | `createPost`, `replyToPost` | 100 / 15 min, 10,000 / 24 h app-wide | $0.015 per request |
| `DELETE /2/tweets/:id` | `deletePost` | 50 / 15 min | $0.010 per request |

When the plan or the balance is what refuses, the connector says so plainly.
A `402`, a `403` whose problem type is `client-forbidden` ("App not enrolled
or lacks required access") and a `429` whose type is `usage-capped` ("Usage
cap exceeded") are thrown as `<status> <title>: <detail> [<problem>]`
followed by "The app's plan or credits do not cover this endpoint." None of
the three is retried: a budget does not come back in a second.

## Rate limits

Every answer carries `x-rate-limit-limit`, `x-rate-limit-remaining` and
`x-rate-limit-reset` (Unix seconds). On a `429` the connector reads
`x-rate-limit-reset`, waits until that instant and sends once more; a second
`429` is reported. The wait is capped at 60 seconds: a window that resets
later than that is reported at once with the reset instant in the message,
so a fresh 15-minute window cannot hold a workflow step or a poll open. A
`500`, `502`, `503` or `504` is retried once after one second. Any other
failure is reported as X describes it: `<status> <title>: <detail>` for a v2
problem, with the last segment of the problem `type` in brackets, or
`<status>: <message> (code <n>)` for the legacy `errors` list; a `403` that
carries a `reason` field has it appended.

## Triggers

Both are declarative polls on the SDK's `lastItem` strategy: X returns the
feed newest first, and the post id is the only dependable order. Each poll
sends `since_id` = the newest id already delivered and `max_results` = the
poll's limit clamped to the endpoint's window (5 to 100 for mentions, 10 to
100 for search). The connector does not follow `next_token`, so a burst above
100 new posts between two polls loses the oldest.

Every item has the post id as `externalId`, `@username: ` plus the first 80
characters of the text as `title`, `created_at` as `updatedAt`,
`https://x.com/{username}/status/{id}` as `url`, and in `data` the post joined
with its author: `id`, `text`, `createdAt`, `conversationId`,
`inReplyToUserId`, `author` (`id`, `username`, `name`) and `url`. When the
author is missing from `includes` (a partial answer) the username is empty and
the URL takes the `https://x.com/i/status/{id}` form, which X resolves.

### `newMention` — a post mentions the connected account

`GET /2/users/{id}/mentions` with
`tweet.fields=created_at,author_id,conversation_id,in_reply_to_user_id`,
`expansions=author_id` and `user.fields=username,name`. The account id comes
from `GET /2/users/me`, fetched once per connection and cached for the life of
the process (the SDK keeps nothing but the cursor between polls, so "once per
connection" means once per process). Seeds the workflow `X: new mentions`,
every 5 minutes.

### `newSearchResult` — a post matches a search

`GET /2/tweets/search/recent?query=…&sort_order=recency` with the same
fields, using the **Search query** setting. Only posts from the last 7 days
are searchable, and `start_time` is never sent because at most one of it and
`since_id` may be. Seeds the workflow `X: search results`, every 5 minutes.

## Actions

`createPost` and `replyToPost` count the text in code points and refuse
anything empty or over 280 characters before sending, with `Post text is N
characters; the limit is 280 for non-Premium accounts`. The pages read do not
publish the weighted counting rule, so this is a plain count; a text the API
weighs longer still answers `403`, reported like any other error.

| Action | Idempotent | What it does |
| --- | --- | --- |
| `createPost` | no | `POST /2/tweets` with `text`, optional `inReplyToPostId` (sent as `reply.in_reply_to_tweet_id`) and `quotePostId` (`quote_tweet_id`, Enterprise only). Returns `id`, `url` (`https://x.com/i/status/{id}`), `text`. |
| `replyToPost` | no | `POST /2/tweets` with `text` and `reply.in_reply_to_tweet_id` = `postId`. Returns `id`, `url`, `text`. |
| `deletePost` | no | `DELETE /2/tweets/{postId}`; only the connected account's own posts. Returns `deleted`. |
| `getMe` | yes | `GET /2/users/me?user.fields=id,username,name`. Returns `id`, `username`, `name`, `url`. The live check. |
| `getPost` | yes | `GET /2/tweets/{postId}` with `created_at,author_id,conversation_id,public_metrics` and the author expansion. Returns `id`, `text`, `createdAt`, `authorId`, `authorUsername`, `conversationId`, `url`, `metrics`, `raw`. |
| `getUserByUsername` | yes | `GET /2/users/by/username/{username}` (a leading `@` is stripped). Returns `id`, `username`, `name`, `description`, `createdAt`, `followers`, `following`, `posts`, `url`, `raw`. |
| `searchRecentPosts` | yes | `GET /2/tweets/search/recent` with `query`, `maxResults` (10 to 100, default 10; a smaller value is raised to 10, a larger one refused) and `sinceId`. Returns `posts` (the trigger's `data` shape), `count`, `newestId`, `nextToken`. |

## Checks

```sh
packages/x/scripts/check.sh        # typecheck, tests, build, conformance receipt
packages/x/scripts/check-live.sh   # needs the four X_* credentials; exits 0 with a note without them
```

Tests make no network calls: the client takes an injected `fetch`, clock and
sleep. The signer is pinned to the signing guide's worked example with
stand-in credentials of the same shape. The live check calls the idempotent
actions on their samples (`getMe`, `getPost` on id `20`,
`getUserByUsername` on `x`, `searchRecentPosts` on
`from:xdevelopers -is:retweet`); those are billed reads and need credits on
the app. Nothing is created or deleted.

## Built from

- [X API introduction](https://docs.x.com/x-api/introduction)
- [About the X API](https://docs.x.com/x-api/getting-started/about-x-api)
  and [pricing](https://docs.x.com/x-api/getting-started/pricing)
- [Authentication overview](https://docs.x.com/resources/fundamentals/authentication),
  [API key and secret](https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/api-key-and-secret)
  and [developer apps](https://docs.x.com/resources/fundamentals/developer-apps)
- OAuth 1.0a: [creating a signature](https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature),
  [authorizing a request](https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/authorizing-a-request)
  and [percent encoding](https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/percent-encoding-parameters)
- [Fields](https://docs.x.com/x-api/fundamentals/fields)
- Posts: [create](https://docs.x.com/x-api/posts/creation-of-a-post),
  [delete](https://docs.x.com/x-api/posts/post-delete-by-post-id),
  [lookup by id](https://docs.x.com/x-api/posts/post-lookup-by-post-id),
  [mentions timeline](https://docs.x.com/x-api/posts/user-mention-timeline-by-user-id)
  and [recent search](https://docs.x.com/x-api/posts/recent-search)
- Users: [me](https://docs.x.com/x-api/users/user-lookup-me)
  and [by username](https://docs.x.com/x-api/users/user-lookup-by-username)
- [Rate limits overview](https://docs.x.com/resources/fundamentals/rate-limits)
  and [v2 rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [Response codes and errors](https://docs.x.com/x-api/fundamentals/response-codes-and-errors)
