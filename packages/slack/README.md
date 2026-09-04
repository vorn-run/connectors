# @vornrun/connector-slack

Trigger Vorn workflows from Slack messages, thread replies and channel members,
and post a message, reply in a thread or add a reaction from a workflow step.

## Signing in

There is no Slack CLI to borrow a login from, so this connector asks for a bot
token:

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps).
2. Under **OAuth & Permissions**, add the bot scopes below.
3. Install the app to the workspace and copy the **Bot User OAuth Token**. It
   starts with `xoxb-`.

Paste it into the connection. Vorn stores it encrypted and never prints it. It
travels as `Authorization: Bearer <token>`; Slack refuses tokens in the query
string, so it never appears in a URL.

| Scope | Needed by |
| --- | --- |
| `channels:read` | `listChannels`, `getChannel`, the member trigger (public channels) |
| `groups:read` | the same, for private channels |
| `channels:history` | the message and reply triggers (public channels) |
| `groups:history` | the same, for private channels |
| `chat:write` | `postMessage`, `replyInThread` |
| `reactions:write` | `addReaction` |
| `users:read` | `getUser` |
| `users:read.email` | `findUserByEmail`, and the `email` field of `getUser` |

The bot must be a member of a channel before it can read its history or post to
it; otherwise Slack answers `not_in_channel`. Invite it with `/invite @app`.

## Settings

| Field | Env | Required | What it does |
| --- | --- | --- | --- |
| `botToken` | `SLACK_BOT_TOKEN` | yes | The bot token above |
| `channel` | `SLACK_CHANNEL` | for triggers | Channel id such as `C0123456789`, not a name |
| `threadTs` | `SLACK_THREAD_TS` | for the reply trigger | The parent message's `ts` |
| `includeBots` | `SLACK_INCLUDE_BOTS` | no | `true` delivers bot and system messages too. Default `false` |
| `limit` | `SLACK_LIMIT` | no | Messages read per request, 1 to 999. Default 100 |

## Triggers

All three poll. The seeded workflows run every few minutes rather than every
few seconds, because Slack rate-limits per method and some apps get the history
methods at one request a minute.

**A message is posted in a channel** reads `conversations.history` and delivers
messages oldest first. The newest delivered `ts` is the cursor and goes back as
`oldest`, which is exclusive, so nothing is delivered twice. A poll follows
`next_cursor` until it holds `limit` messages worth delivering or Slack has no
more, ten pages at most, so the first poll reads the newest messages rather
than the channel's whole history. Messages with a `subtype` (`channel_join`,
`channel_topic`, `message_changed`, …) or a `bot_id` are skipped unless
`includeBots` is `true`, and skipped messages do not count towards `limit`, so
a run of bot posts cannot hide the person after it. Thread replies only appear
here when they were also broadcast to the channel.

**A reply is posted in a thread** reads `conversations.replies` for the
configured `threadTs`. The parent rides along in every page and is dropped.
Replies are delivered whoever wrote them, including replies this connector
posts, so a workflow that answers the thread it watches should check `botId`
before answering again.

**A member joins a channel** reads every page of `conversations.members`. Slack
gives no join time, so the cursor is the set of ids already seen and a poll
delivers the ones not in it. Someone who leaves and rejoins is not delivered
again. The SDK remembers up to 500 ids, so in a larger channel the oldest
members can be delivered again and are left to Vorn's inbox to de-duplicate.

Each message item carries `channel`, `ts`, `text`, `user`, `botId`, `subtype`,
`threadTs`, `parentUserId` and `team` as `{{trigger.item.<key>}}`; its `title`
is the first line of the text.

## Actions

| Action | Idempotent | Notes |
| --- | --- | --- |
| `postMessage` | no | `chat.postMessage`; optional `threadTs` and Block Kit `blocks` as a JSON array |
| `replyInThread` | no | `chat.postMessage` with `thread_ts` |
| `addReaction` | no | `reactions.add`; a second call answers `already_reacted` |
| `listChannels` | yes | `conversations.list`, public and private, unarchived; returns `channels` and `nextCursor` |
| `getChannel` | yes | `conversations.info` with the member count |
| `findUserByEmail` | yes | `users.lookupByEmail`; unknown addresses answer `users_not_found` |
| `getUser` | yes | `users.info` |

Every Slack reply carries `ok`. When it is `false` the action fails with the
`error` code verbatim: `channel_not_found`, `missing_scope`, `invalid_blocks`,
and so on.

The actions are hand-written rather than declared as requests on purpose:
Slack answers HTTP 200 on failure, and a declared request would hand
`{ ok: false, error }` to the step as a success.

A 429 carries `Retry-After` in seconds. The SDK waits that long and retries the
idempotent actions and every trigger poll; the three writes are not retried,
because a repeated post is a second message.

## Checks

```sh
packages/slack/scripts/check.sh        # typecheck, test, build, vorn-connector check --mock
packages/slack/scripts/check-live.sh   # exits 0 with a note unless SLACK_BOT_TOKEN is set
```

The live check calls `auth.test` and the idempotent actions only. It posts
nothing and adds no reaction. `SLACK_CHANNEL_ID`, `SLACK_USER_EMAIL` and
`SLACK_USER_ID` name what `getChannel`, `findUserByEmail` and `getUser` are
called with, and each is skipped when unset.

## Built from

- [Web API method reference](https://api.slack.com/methods)
- [Web API basics and the Bearer header](https://docs.slack.dev/apis/web-api/)
- [Token types](https://api.slack.com/concepts/token-types)
- [Rate limits](https://api.slack.com/apis/rate-limits)
- [Pagination](https://api.slack.com/apis/pagination)
- [Message subtypes](https://docs.slack.dev/reference/events/message)
- [`auth.test`](https://api.slack.com/methods/auth.test)
- [`conversations.history`](https://api.slack.com/methods/conversations.history)
- [`conversations.replies`](https://api.slack.com/methods/conversations.replies)
- [`conversations.list`](https://api.slack.com/methods/conversations.list)
- [`conversations.info`](https://api.slack.com/methods/conversations.info)
- [`conversations.members`](https://api.slack.com/methods/conversations.members)
- [`chat.postMessage`](https://api.slack.com/methods/chat.postMessage)
- [`reactions.add`](https://api.slack.com/methods/reactions.add)
- [`users.info`](https://api.slack.com/methods/users.info)
- [`users.lookupByEmail`](https://api.slack.com/methods/users.lookupByEmail)

`api.slack.com` links redirect to `docs.slack.dev`.
