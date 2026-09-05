# @vornrun/connector-discord

Trigger Vorn workflows from new Discord messages, server members and threads,
and send a message, reply in a thread, react, pin, or read channels and
members from a workflow step. Talks to the HTTP API at
`https://discord.com/api/v10` with a bot token.

## Signing in

There is no Discord CLI to borrow a login from: the connection takes a bot
token.

1. Open https://discord.com/developers/applications and pick or create an
   application.
2. On the **Bot** tab press **Reset Token** and copy the token it shows once.
3. Paste it into the **Bot token** field (`DISCORD_BOT_TOKEN`). A pasted
   `Bot ` prefix is stripped; the connector sends it as
   `Authorization: Bot <token>`.

A missing or wrong token answers `401`; a token whose bot cannot see the
channel answers `403`. An OAuth2 `Bearer` token is a user token and is not
this connection.

### Privileged intents

Two gateway intents also gate HTTP responses. Both are switches under
**Privileged Gateway Intents** on the same Bot page, and an app with fewer
than 10,000 servers can turn them on without approval.

| Intent | Unlocks |
| --- | --- |
| **Message Content** | The text of messages. Without it the message trigger delivers every message with empty `content`, `embeds` and `attachments`. |
| **Server Members** | The member trigger. Listing guild members answers `403` until it is on; reading one member with `getGuildMember` needs no intent. |

### Server permissions

Invite the bot with **OAuth2 → URL Generator**, scope `bot`, or paste this
shape with your application id:

```
https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=2252109051415616
```

`2252109051415616` is the sum of the permissions below, all of which the
connector uses. Manage Messages is what older guides name for pinning; the
current docs ask for Pin Messages instead, so it is not in the sum.

| Permission | Needed by |
| --- | --- |
| View Channels | every read |
| Read Message History | `messageInChannel`, `addReaction` |
| Send Messages | `sendMessage` |
| Send Messages in Threads | `sendMessage` into a thread, `createThread` |
| Create Public Threads | `createThread` |
| Embed Links | `sendMessage` with embeds |
| Add Reactions | `addReaction` |
| Pin Messages | `pinMessage` |

## Settings

| Setting | Environment | Required | Default |
| --- | --- | --- | --- |
| Bot token | `DISCORD_BOT_TOKEN` | yes | |
| Channel | `DISCORD_CHANNEL_ID` | by the message trigger | |
| Server | `DISCORD_GUILD_ID` | by the member and thread triggers | |
| Include bot messages | `DISCORD_INCLUDE_BOTS` | no | `false` |
| Include system messages | `DISCORD_INCLUDE_SYSTEM` | no | `false` |
| First poll look-back (minutes) | `DISCORD_LOOKBACK_MINUTES` | no | `60` |
| Pages per poll | `DISCORD_MAX_PAGES` | no | `5` |

Ids are snowflakes: decimal strings too large for a JavaScript number. Turn
on **Developer Mode** under Discord's advanced settings, then right-click a
channel, server or user and **Copy ID**. A thread is a channel, so a thread
id goes wherever a channel id does.

## Triggers

All three poll, and each is a declarative fetch on the SDK's timestamp
dedupe, so an item is delivered once. Every poll emits oldest first.

**`messageInChannel` — a message is posted in a channel.** Reads
`GET /channels/{channel}/messages?after=<snowflake>&limit=100`, up to
**Pages per poll** pages, walking `after` from the newest id of a full page.
The first poll starts at a snowflake built from now minus the look-back, so
an old channel is not replayed. Messages of type `0` (default) and `19`
(reply) whose author is not a bot are delivered; **Include bot messages**
keeps bots, including this one, and **Include system messages** keeps joins,
pins, boosts and thread notices. The bot's own messages are dropped unless
bots are included, so a workflow that posts into the channel it watches does
not loop. Replies inside a thread do not appear in the parent channel: point
a second connection at the thread id.

The item's `url` is `https://discord.com/channels/<guild>/<channel>/<id>`.
A message fetched over HTTP carries no guild id, so the connector reads the
channel once per process; a DM links through `@me`.

`data` holds the message as returned: `id`, `channel_id`, `guild_id`, `type`,
`content`, `timestamp`, `edited_timestamp`, `author` (`id`, `username`,
`global_name`, `bot`), `attachments`, `embeds`, `mention_everyone`, `pinned`,
`message_reference`, `thread`.

**`memberJoined` — a member joins the server.** Reads
`GET /guilds/{guild}/members?limit=1000`, paging with `after` set to the
highest user id of a full page. The list is sorted by user id, which is
account age rather than join order, so the watermark is `joined_at`: each
poll walks the list from the start and delivers members who joined after the
last watermark. A guild larger than **Pages per poll** × 1000 is truncated
with a warning. Needs the Server Members intent.

`data` holds `user` (`id`, `username`, `global_name`, `bot`), `nick`, `roles`,
`joined_at`, `premium_since`, `pending`, `guild_id`.

**`threadCreated` — a thread is created.** Reads
`GET /guilds/{guild}/threads/active`, one response for the whole guild, and
keeps threads whose parent is the configured **Channel**, or every channel
when it is blank. The watermark is `thread_metadata.create_timestamp`, not
the id: a thread started from a message shares that message's id, so an id
cursor would miss a thread on last month's message. Threads from before
2022-01-09 have no `create_timestamp` and fall back to the id's time.
Archived threads are not polled.

`data` holds `id`, `type`, `guild_id`, `parent_id`, `owner_id`, `name`,
`message_count`, `member_count`, `thread_metadata`.

## Actions

| Action | Idempotent | Inputs | Outputs |
| --- | --- | --- | --- |
| `sendMessage` | no | `channel`, `content`, `embeds` (JSON array), `replyTo` | `id`, `channelId`, `content`, `timestamp`, `url` |
| `createThread` | no | `channel`, `message`, `name`, `content`, `autoArchiveDuration` | `threadId`, `threadName`, `created`, `messageId`, `url` |
| `addReaction` | no | `channel`, `message`, `emoji` | `ok` |
| `pinMessage` | yes | `channel`, `message` | `ok` |
| `listChannels` | yes | `guild`, `type` | `channels` |
| `getChannel` | yes | `channel` | `id`, `name`, `type`, `guildId`, `parentId`, `topic`, `nsfw`, `lastMessageId`, `rateLimitPerUser`, `threadMetadata`, `messageCount`, `memberCount` |
| `getGuildMember` | yes | `guild`, `user` | `userId`, `username`, `globalName`, `nick`, `roles`, `joinedAt`, `premiumSince`, `pending`, `communicationDisabledUntil`, `isBot` |

`sendMessage` posts `content` (up to 2000 characters) and up to 10 `embeds`,
and refuses an empty message before calling. `replyTo` becomes a
`message_reference` with `fail_if_not_exists: false`, so a deleted target
posts a plain message rather than failing. The thread id works as `channel`.

`createThread` starts a thread from `message` and posts `content` into it.
A thread shares its source message's id, and Discord answers `160004` when
one already exists: the connector then posts into that thread and reports
`created: false`. Works on text and announcement channels, not on forum or
media channels.

`addReaction` takes a Unicode emoji as itself or a custom one as `name:id`;
a pasted `<:name:id>` is reduced to that. `pinMessage` uses
`PUT /channels/{channel}/messages/pins/{message}`; pinning a pinned message
is a `204`, and a channel holds at most 250 pins.

`listChannels` sorts by `position` and does not include threads. `type`
keeps one channel type: `0` text, `2` voice, `4` category, `5` announcement,
`13` stage, `15` forum, `16` media.

## Rate limits

Every response carries `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`
and `X-RateLimit-Bucket`. The client remembers them per bucket and sleeps out
an exhausted bucket before the next call on it, so a `429` rarely happens.
When one does, it waits `Retry-After` (the header, then the body's
`retry_after`), never less than a second, and retries twice; the third `429`
throws with the bucket and scope in the message. A `5xx` is retried once
after a second. Nothing else is retried, since `401`, `403` and `429` count
against Discord's invalid-request limit of 10,000 per 10 minutes. Every wait
is capped at 60 seconds and logged to stderr.

A failure reads `<status> <code>: <message>`, for example
`404 10003: Unknown Channel` or `403 50013: Missing Permissions`; an invalid
form body appends the first field error in parentheses.

## Checks

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/discord/dist/index.js --mock --receipt packages/discord/verified.json
```

`scripts/check.sh` in this package runs exactly this from the repository
root. `scripts/check-live.sh` exits 0 with a note when `DISCORD_BOT_TOKEN`
is unset; with it set it calls `GET /users/@me`, the read-only samples of
`listChannels`, `getChannel` and `getGuildMember` when `DISCORD_GUILD_ID`,
`DISCORD_CHANNEL_ID` and `DISCORD_USER_ID` name real ids, and then
`vorn-connector check --live`. Nothing is sent, reacted, pinned or threaded.
Tests make no network calls: the client takes an injected `fetch` and sleep.

## Built from

- [API reference](https://discord.com/developers/docs/reference): base URL, versioning, the `Bot` header, User-Agent, snowflakes, error shape
- [Rate limits](https://discord.com/developers/docs/topics/rate-limits)
- [Opcodes, HTTP status codes and JSON error codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes)
- [Permissions](https://discord.com/developers/docs/topics/permissions): bit flags and the invite URL
- [Gateway intents](https://discord.com/developers/docs/events/gateway#gateway-intents): privileged intents, Message Content, Server Members
- [Channel resource](https://discord.com/developers/docs/resources/channel): Get Channel, channel types, Start Thread from Message, thread metadata
- [Message resource](https://discord.com/developers/docs/resources/message): Get Channel Messages, Create Message, Create Reaction, Pin Message, message types, embeds
- [Guild resource](https://discord.com/developers/docs/resources/guild): List Guild Members, Get Guild Member, Get Guild Channels, List Active Guild Threads
- [User resource](https://discord.com/developers/docs/resources/user): Get Current User
- [Developer Portal](https://discord.com/developers/applications): applications, Bot tab, Reset Token, Privileged Gateway Intents, URL Generator
