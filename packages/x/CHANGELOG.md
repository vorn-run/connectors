# Changelog

All notable changes to `@vornrun/connector-x`.

## 0.1.0

First release.

Trigger a workflow from new mentions of the connected account or from posts
matching a recent-search query, and let a workflow step create, reply to,
delete, read and search posts or look up the connected account and a user by
username.

- **Triggers:** `newMention`, `newSearchResult`.
- **Actions:** `createPost`, `replyToPost`, `deletePost`, `getMe`, `getPost`,
  `getUserByUsername`, `searchRecentPosts`.
- **Signing in:** the four OAuth 1.0a credentials of an X developer app with
  Read and Write permission, from the app's Keys and tokens tab. Every request
  is signed in the package with `node:crypto` (HMAC-SHA1, the
  `Authorization: OAuth …` header); no OAuth dependency. All four fields are
  stored encrypted, because the SDK refuses a credential field left in the
  clear.

Every call goes through one small client rather than a declared SDK request,
because a per-request OAuth 1.0a signature cannot be written as a static
header template. The client waits out a `429` until `x-rate-limit-reset`
(capped at 60 seconds, past which the reset instant is reported) and sends
once more, retries a `500`, `502`, `503` or `504` once after a second, and
reports a failure as `<status> <title>: <detail> [<problem>]`, appending a
`403`'s `reason` when present. A `402`, `client-forbidden` or `usage-capped`
answer says plainly that the plan or credits do not cover the endpoint and is
never retried.

Both triggers are declarative polls on the SDK's `lastItem` strategy with
`since_id`; the connected account's id is fetched once per process. Post text
is counted in code points and refused over 280 characters before sending.
The README records which reads needed a paid tier and what each call costs.

Ships as a pack with a conformance receipt covering the dedupe replay of both
triggers and the mock run of every action. No runtime dependencies.
