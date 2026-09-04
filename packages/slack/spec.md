id: slack

# Slack connector

Slack's Web API at `https://slack.com/api/<method>`. Every response carries
`ok`; when `ok` is `false` the `error` field holds a code such as
`channel_not_found`, `missing_scope` or `ratelimited`, and the connector
surfaces that code verbatim. Read methods take their arguments as a GET query
string; write methods take a POST body, `application/json` preferred.

## Auth

Rung: **key**. There is no CLI developers already sign in to for the Web API.

| Config field | Env name | Where it comes from |
| --- | --- | --- |
| `botToken` | `SLACK_BOT_TOKEN` | Create an app at https://api.slack.com/apps, add the bot scopes below under **OAuth & Permissions**, install it to the workspace, copy the **Bot User OAuth Token** (starts with `xoxb-`) |

Sent as `Authorization: Bearer <token>`. Slack refuses tokens in the query
string, so the token never appears in a URL.

Bot scopes, per method:

| Scope | Needed by |
| --- | --- |
| `channels:read` | `conversations.list`, `conversations.info`, `conversations.members` (public channels) |
| `groups:read` | the same three, for private channels |
| `channels:history` | `conversations.history`, `conversations.replies` (public channels) |
| `groups:history` | the same two, for private channels |
| `chat:write` | `chat.postMessage` |
| `reactions:write` | `reactions.add` |
| `users:read` | `users.info` |
| `users:read.email` | `users.lookupByEmail`, and the `email` field of `users.info` |

The bot must be a member of a channel before it can read its history or post
to it; otherwise Slack answers `not_in_channel`.

`auth.test` needs no scope and confirms the token: it returns `team`, `team_id`,
`user_id` and `bot_id`. Failures come back as `invalid_auth`, `not_authed`,
`token_revoked` or `account_inactive`.

## Rate limits

Tiers are per method, per workspace. Exceeding one answers HTTP 429 with a
`Retry-After` header in seconds; the connector should wait that long and retry
once.

| Method | Tier |
| --- | --- |
| `conversations.history` | 3 (50+/min) |
| `conversations.replies` | 3 (50+/min) |
| `conversations.list` | 2 (20+/min) |
| `conversations.info` | 3 (50+/min) |
| `conversations.members` | 4 (100+/min) |
| `chat.postMessage` | special: 1 message per second per channel |
| `reactions.add` | 3 (50+/min) |
| `users.info` | 4 (100+/min) |
| `users.lookupByEmail` | 3 (50+/min) |

Apps created after 29 May 2025 that are distributed commercially but not
Marketplace-approved get `conversations.history` and `conversations.replies`
at 1 request per minute with `limit` capped at 15. A workspace's own internal
app is not affected, but poll cadence should default to minutes, not seconds,
and the history triggers should never need more than one page per poll.

## Pagination

Cursor-based. A page carries `response_metadata.next_cursor`; pass it back as
`cursor` for the next page. An empty, null or missing `next_cursor` is the end,
and a page may be shorter than `limit` even when more exists. Sensible `limit`
is 100 to 200; the max is 1000 (999 on `conversations.history`).

## Triggers

All three poll. Each poll walks pages until `next_cursor` is empty or the
configured `limit` is reached.

### `messageInChannel` — new messages in a channel

- **Poll:** `GET conversations.history?channel=<id>&oldest=<cursor>&limit=<n>`.
  Messages come back newest first; the connector reverses them so the workflow
  sees them in order.
- **Cursor:** the largest `ts` seen, passed as `oldest` on the next poll.
  `ts` is a string like `1512085950.000216`; compare it numerically. `oldest`
  is exclusive by default, so the message at the cursor is not returned again.
- **Dedupe key:** the message `ts`, unique per channel.
- **Filtering:** messages whose `subtype` is set (e.g. `bot_message`,
  `channel_join`, `channel_leave`, `channel_topic`, `channel_purpose`,
  `message_changed`, `message_deleted`, `thread_broadcast`) or that carry a
  `bot_id` are skipped by default. Config `includeBots` (boolean, default
  `false`) includes them. Thread replies do not appear in `conversations.history`
  unless they were broadcast.
- **Config:** `channel` (required, a channel id such as `C0123456789`),
  `includeBots` (optional), `limit` (optional, default 100).
- **Sample item:**

```json
{
  "type": "message",
  "user": "U123ABC456",
  "text": "Deploy finished for build 418",
  "ts": "1512085950.000216",
  "team": "T012AB3CD"
}
```

### `replyInThread` — new replies in a thread

- **Poll:** `GET conversations.replies?channel=<id>&ts=<thread_ts>&oldest=<cursor>&limit=<n>`.
  The parent message is always in the response, even with no replies, and is
  dropped because its `ts` equals `thread_ts`.
- **Cursor:** the largest reply `ts` seen, passed as `oldest`.
- **Dedupe key:** the reply `ts`.
- **Config:** `channel` (required), `threadTs` (required, the parent's `ts`),
  `limit` (optional, default 100).
- **Sample item:**

```json
{
  "type": "message",
  "user": "U061F7AUR",
  "text": "Looks good, shipping it",
  "ts": "1512104434.000490",
  "thread_ts": "1512085950.000216",
  "parent_user_id": "U123ABC456"
}
```

### `memberJoinedChannel` — new members in a channel

- **Poll:** `GET conversations.members?channel=<id>&limit=200`, walking every
  page. The response is a flat list of user ids with no timestamps, so the
  cursor is the set of ids already seen and a poll emits ids not in it.
- **Cursor:** none from Slack; the SDK's dedupe store carries the seen ids.
- **Dedupe key:** the user id (`U…` or `W…`).
- **Config:** `channel` (required).
- **Sample item:**

```json
{ "user": "U023BECGF", "channel": "C0123456789" }
```

## Actions

Every action sends the bot token as a Bearer header and throws the `error`
code when `ok` is `false`.

### `postMessage` — post a message

`POST chat.postMessage`, JSON body. Not idempotent: two calls post twice.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | Channel id, or a name the bot can resolve |
| `text` | string | yes | Message text; with `blocks` it is the notification fallback |
| `threadTs` | string | no | Parent `ts` to reply under |
| `blocks` | string | no | Block Kit layout as a JSON array string, parsed before sending |

Outputs: `ts` (the new message's timestamp), `channel` (the id it landed in).

### `replyInThread` — reply in a thread

`POST chat.postMessage` with `thread_ts`. Not idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | Channel id |
| `threadTs` | string | yes | The parent message's `ts` |
| `text` | string | yes | Reply text |

Outputs: `ts`, `channel`.

### `addReaction` — add a reaction

`POST reactions.add` with `channel`, `timestamp`, `name`. Not idempotent:
a second call answers `already_reacted`, which the connector surfaces.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | Channel id |
| `ts` | string | yes | The message's `ts` |
| `emoji` | string | yes | Emoji name without colons, e.g. `thumbsup` |

Outputs: `ok` (`true`).

### `listChannels` — list channels

`GET conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=<n>`.
Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | no | Channels per page, default 100, max 1000 |
| `cursor` | string | no | `next_cursor` from an earlier call |

Outputs: `channels` (array of `{ id, name, isPrivate, isArchived, topic, purpose, numMembers }`), `nextCursor`.

Live sample: `{ "limit": 20 }`.

### `getChannel` — get a channel

`GET conversations.info?channel=<id>&include_num_members=true`. Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | Channel id |

Outputs: `id`, `name`, `isPrivate`, `isArchived`, `topic`, `purpose`, `numMembers`, `created`.

Live sample: `{ "channel": "$SLACK_CHANNEL_ID" }`, a channel id placeholder the
live check fills from the environment.

### `findUserByEmail` — find a user by email

`GET users.lookupByEmail?email=<email>`. Idempotent. An unknown or deactivated
address answers `users_not_found`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string | yes | The address registered on the workspace |

Outputs: `id`, `name`, `realName`, `displayName`, `email`, `tz`, `isBot`, `deleted`.

Live sample: `{ "email": "$SLACK_USER_EMAIL" }`.

### `getUser` — get a user

`GET users.info?user=<id>`. Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `user` | string | yes | User id such as `U123ABC456` |

Outputs: `id`, `name`, `realName`, `displayName`, `email`, `tz`, `isBot`, `deleted`.

Live sample: `{ "user": "$SLACK_USER_ID" }`.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/slack/dist/index.js --mock --receipt packages/slack/verified.json
```

`scripts/check.sh` runs exactly this. Tests make no network calls.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `SLACK_BOT_TOKEN` is unset.
With it set, the script calls `auth.test`, then the idempotent actions'
samples against the real API, then `vorn-connector check --live`.

| Env | Required | Used by |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | every call |
| `SLACK_CHANNEL_ID` | no | `getChannel`; skipped when unset |
| `SLACK_USER_EMAIL` | no | `findUserByEmail`; skipped when unset |
| `SLACK_USER_ID` | no | `getUser`; skipped when unset |

Nothing is posted and no reaction is added: the live check touches only
idempotent, read-only methods.

## Docs

The only source. `api.slack.com` links redirect to `docs.slack.dev`.

- Method reference: https://api.slack.com/methods
- Web API basics and Bearer header: https://docs.slack.dev/apis/web-api/
- Token types: https://api.slack.com/concepts/token-types
- Rate limits: https://api.slack.com/apis/rate-limits
- Pagination: https://api.slack.com/apis/pagination
- Message subtypes: https://docs.slack.dev/reference/events/message
- `auth.test`: https://api.slack.com/methods/auth.test
- `conversations.history`: https://api.slack.com/methods/conversations.history
- `conversations.replies`: https://api.slack.com/methods/conversations.replies
- `conversations.list`: https://api.slack.com/methods/conversations.list
- `conversations.info`: https://api.slack.com/methods/conversations.info
- `conversations.members`: https://api.slack.com/methods/conversations.members
- `chat.postMessage`: https://api.slack.com/methods/chat.postMessage
- `reactions.add`: https://api.slack.com/methods/reactions.add
- `users.info`: https://api.slack.com/methods/users.info
- `users.lookupByEmail`: https://api.slack.com/methods/users.lookupByEmail
