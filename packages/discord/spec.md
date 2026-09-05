id: discord

# Discord connector

Discord's HTTP API at `https://discord.com/api/v10`. The reference says the
base URL is `https://discord.com/api` and the version goes in the path,
`https://discord.com/api/v{version_number}`; 10 is current, and a request
without a version falls back to an old default, so every request names `v10`.
Bodies are JSON both ways. An error is `{ code, message, errors }`: `code` is a
Discord JSON error code (`10003` Unknown channel, `50013` "You lack
permissions to perform that action", `50001` Missing access), `message` is
prose, and `errors` nests `_errors` arrays per field for a `50035` "Invalid
form body". The connector throws `<http status> <code>: <message>` and, for
`50035`, appends the first nested `_errors` message. Successful writes that
have nothing to say answer `204` with an empty body (reactions, pins).

Ids are snowflakes: 64-bit integers serialised as decimal strings. "Bits 63–22
(42 bits) contain milliseconds since Discord Epoch (1420070400000)", so
`(snowflake >> 22) + 1420070400000` is the creation time, and a snowflake made
from a timestamp `((ms - 1420070400000) << 22)` is a valid `after` bound for
any id-ordered list. Compare ids with `BigInt`, never as numbers or strings:
they exceed 2^53 and differ in length. Timestamps are ISO8601 strings.

"Clients using the HTTP API must provide a valid User Agent" of the form
`User-Agent: DiscordBot ($url, $versionNumber)`; the connector sends
`DiscordBot (https://github.com/vorn-run/connectors, <package version>)`.

Package: `@vornrun/connector-discord` in `packages/discord`, shaped like the
existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category
`Communication` (as `slack` and `telegram`), `packs: true`.

## Auth

Rung: **key**. There is no CLI developers already sign in to for the Discord
API; the connection takes a bot token.

| Config field | Env name | Where it comes from |
| --- | --- | --- |
| `botToken` (secret) | `DISCORD_BOT_TOKEN` | https://discord.com/developers/applications: pick or create an application, open the **Bot** tab, press **Reset Token** and copy the token it shows once |

Sent as `Authorization: Bot <token>`, exactly as the reference's example
`Authorization: Bot <token>`.
A `Bearer` token is an OAuth2 user token and is not this connection; the
connector strips a pasted `Bot ` prefix and otherwise lets the API judge the
value. A missing or wrong token answers `401` ("The `Authorization` header
was missing or invalid"), a token that lacks access answers `403`.

Preflight is `GET /users/@me`, which "returns the user object of the
requester's account": `id`, `username`, `global_name`, `bot: true`. The `id`
is cached for the process and is how the message trigger knows its own
messages.

**Privileged intents.** Intents are a gateway concept, but two of them gate
HTTP responses as well and are toggled on the **Bot** page of the portal
"under the 'Privileged Gateway Intents' section":

| Intent | Bit | Why the connector needs it |
| --- | --- | --- |
| **Message Content** (`MESSAGE_CONTENT`, `1 << 15`) | privileged | "An app will receive empty values in the `content`, `embeds`, `attachments`, and `components` fields while `poll` will be omitted if they have not configured (or been approved for) the `MESSAGE_CONTENT` privileged intent." Without it the message trigger delivers messages with empty text. |
| **Server Members** (`GUILD_MEMBERS`, `1 << 1`) | privileged | "This endpoint requires the `GUILD_MEMBERS` Privileged Intent" is stated on List Guild Members, so the member trigger fails with `403` until it is on. |

"Apps with fewer than 10,000 users can access privileged intents by enabling
them"; larger, verified apps need approval during verification. The README
tells the reader to switch both on and says which trigger each one unlocks.

**Server permissions.** The bot joins a server through an OAuth2 URL with
`scope=bot&permissions=<decimal>` where the number is the bitwise OR of the
flags it needs. The portal builds this URL under **OAuth2 → URL Generator**.
From the permissions table:

| Permission | Bit | Needed by |
| --- | --- | --- |
| View Channels (`VIEW_CHANNEL`) | `1 << 10` | every read; Get Channel Messages "requires the current user to have the `VIEW_CHANNEL` permission" |
| Read Message History (`READ_MESSAGE_HISTORY`) | `1 << 16` | message trigger ("If the current user is missing the `READ_MESSAGE_HISTORY` permission in the channel, then no messages will be returned", not an error) and Create Reaction |
| Send Messages (`SEND_MESSAGES`) | `1 << 11` | `sendMessage` |
| Send Messages in Threads (`SEND_MESSAGES_IN_THREADS`) | `1 << 38` | `sendMessage` into a thread, `createThread`'s first post |
| Create Public Threads (`CREATE_PUBLIC_THREADS`) | `1 << 35` | `createThread` |
| Add Reactions (`ADD_REACTIONS`) | `1 << 6` | `addReaction` |
| Pin Messages (`PIN_MESSAGES`) | `1 << 51` | `pinMessage`: "Pin a message in a channel. Requires the `PIN_MESSAGES` permission." |
| Manage Messages (`MANAGE_MESSAGES`) | `1 << 13` | not required by the current docs for pinning; the older pin route asked for it. The README lists Pin Messages and notes that Manage Messages is what older guides name |
| Embed Links (`EMBED_LINKS`) | `1 << 14` | `sendMessage` with `embeds`, so the embeds render |

The sum for the invite URL, all of the above except Manage Messages:
`1<<6 | 1<<10 | 1<<11 | 1<<14 | 1<<16 | 1<<35 | 1<<38 | 1<<51` =
`2252109051415616`. The README prints that number next to the URL shape.

## Rate limits

From the rate limits topic. Every response carries:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | "The number of requests that can be made" |
| `X-RateLimit-Remaining` | "The number of remaining requests that can be made" |
| `X-RateLimit-Reset` | "Epoch time (seconds since 00:00:00 UTC on January 1, 1970) at which the rate limit resets" |
| `X-RateLimit-Reset-After` | "Total time (in seconds) of when the current rate limit bucket will reset" |
| `X-RateLimit-Bucket` | "A unique string denoting the rate limit being encountered" |
| `X-RateLimit-Global` | "Returned only on HTTP 429 responses if the rate limit encountered is the global rate limit" |
| `X-RateLimit-Scope` | 429 only: `user`, `global` or `shared` |

A `429` carries a `Retry-After` header in seconds and a body
`{ message, retry_after (float seconds), global (boolean), code? }`.
"All bots can make up to 50 requests per second" globally, and buckets are
per route, with `channel_id`, `guild_id` and `webhook_id` counted separately.
There is also an invalid request limit, "10,000 per 10 minutes", counting
`401`, `403` and `429` answers, so a connector must never spin on a bad token
or a missing permission.

The connector's client keeps, per `X-RateLimit-Bucket` (falling back to
method+path with ids stripped), the `Remaining` and `Reset-After` it last saw.
When `Remaining` is `0` it sleeps `Reset-After` before the next request on
that bucket. On `429` it waits `Retry-After` (header first, body
`retry_after` second), never less than one second, and retries twice; a third
`429` throws with the bucket and scope in the message. A `5xx` and a `502`
("Wait a bit and retry") get one retry after one second. Nothing else is
retried. Every wait is capped at 60 seconds and logged with `warn`. Sleeping
is injectable so tests never wait.

Send `X-Audit-Log-Reason` nowhere; it is optional and the actions do not take a
reason.

## Pagination

Message lists take `before`, `after` or `around` (mutually exclusive) plus
`limit` 1–100, default 50, and come back "from newest to oldest". Member
lists take `limit` 1–1000, default 1, and `after` "the highest user id in the
previous page", sorted by user id. Active-thread lists are one response for
the whole guild, "ordered by their `id` in descending order", not paged.

## Triggers

All three poll. Each poll walks at most `maxPages` pages (config, default 5)
and emits oldest first.

### `messageInChannel` — new messages in a channel

- **Poll:** `GET /channels/{channel}/messages?after=<cursor>&limit=100`,
  reversed so the oldest comes first, then a second page with `after` set to
  the newest id of the first while the page was full.
- **Cursor:** the largest message `id` seen, compared as `BigInt`. `after`
  is exclusive, so the message at the cursor is not returned again. On the
  first poll with no cursor the connector builds a snowflake from `now -
  lookbackMinutes` (config, default 60) so an old channel is not replayed.
- **Dedupe key:** the message `id`; `updatedAt` is `timestamp`. The SDK's
  `timestamp` dedupe would also do, but ids are what the API pages on.
- **Filtering:** by default keep only `type` `0` (`DEFAULT`) and `19`
  (`REPLY`) whose `author.bot` is not `true`. Everything else in the message
  types table is a system or app message: `7` `USER_JOIN`, `6`
  `CHANNEL_PINNED_MESSAGE`, `18` `THREAD_CREATED`, `21`
  `THREAD_STARTER_MESSAGE`, `20` `CHAT_INPUT_COMMAND`, `8`–`11` boosts and so
  on. Config `includeBots` (boolean, default `false`) keeps messages whose
  `author.bot` is true, which includes the connector's own; `includeSystem`
  (boolean, default `false`) keeps the other types. The trigger also drops
  messages whose `author.id` equals the preflight's own id unless
  `includeBots` is on, so a workflow that sends into the channel it watches
  does not loop.
- **Thread replies** do not appear in the parent channel's messages; point a
  second trigger at the thread id, since a thread is a channel.
- **Config:** `channel` (required, the channel or thread id),
  `includeBots`, `includeSystem`, `lookbackMinutes`, `maxPages`.
- **Sample item** (`data` is the message as returned, trimmed to the fields
  the connector keeps):

```json
{
  "externalId": "1412345678901234567",
  "title": "wumpus: Deploy finished for build 418",
  "url": "https://discord.com/channels/197038439483310086/41771983423143937/1412345678901234567",
  "updatedAt": "2026-09-04T18:41:02.123000+00:00",
  "data": {
    "id": "1412345678901234567",
    "channel_id": "41771983423143937",
    "guild_id": "197038439483310086",
    "type": 0,
    "content": "Deploy finished for build 418",
    "timestamp": "2026-09-04T18:41:02.123000+00:00",
    "edited_timestamp": null,
    "author": { "id": "80351110224678912", "username": "wumpus", "global_name": "Wumpus", "bot": false },
    "attachments": [],
    "embeds": [],
    "mention_everyone": false,
    "pinned": false,
    "message_reference": null,
    "thread": null
  }
}
```

The message URL is `https://discord.com/channels/<guild_id>/<channel_id>/<id>`.
`guild_id` is not on a message fetched over HTTP, so the connector reads the
channel once with `GET /channels/{id}` at trigger start and remembers its
`guild_id` (a DM has none: the URL then uses `@me`).

### `memberJoined` — new members in a guild

- **Poll:** `GET /guilds/{guild}/members?limit=1000&after=<page cursor>`,
  paging with `after` set to the last `user.id` of the page while the page
  was full. Needs the Server Members intent; a `403` here is reported as
  "enable Server Members under Privileged Gateway Intents".
- **Cursor:** the largest `joined_at` seen, not a user id. User ids are
  snowflakes of account creation, and "sorted by user id" is age of account,
  not join order: a five-year-old account that joins today has an id far
  below yesterday's newcomer, so `after=<last user id>` across polls would
  never see it. `after` is therefore only the page cursor inside one poll;
  across polls the connector walks the list from the start and emits members
  whose `joined_at` is later than the cursor. First poll: `joined_at` within
  `lookbackMinutes` (default 60). A guild with more than `maxPages × 1000`
  members is truncated with a `warn`.
- **Dedupe key:** `user.id`; `updatedAt` is `joined_at`.
- **Config:** `guild` (required), `lookbackMinutes`, `maxPages`.
- **Sample item:**

```json
{
  "externalId": "80351110224678912",
  "title": "wumpus joined",
  "url": "https://discord.com/users/80351110224678912",
  "updatedAt": "2026-09-04T18:30:00.000000+00:00",
  "data": {
    "user": { "id": "80351110224678912", "username": "wumpus", "global_name": "Wumpus", "bot": false },
    "nick": null,
    "roles": [],
    "joined_at": "2026-09-04T18:30:00.000000+00:00",
    "premium_since": null,
    "pending": false,
    "guild_id": "197038439483310086"
  }
}
```

### `threadCreated` — new threads in a channel

- **Poll:** `GET /guilds/{guild}/threads/active`, which "returns all active
  threads in the guild, including public and private threads", ordered by id
  descending, in one response. There is no per-channel active list in v10,
  so the trigger takes the guild and filters `parent_id === channel` when
  `channel` is set; blank watches every channel the bot can see. Archived
  threads are not new and are not polled.
- **Cursor:** the largest `thread_metadata.create_timestamp` seen. Not the
  thread id: a thread started from a message has "the same id as the source
  message", so a thread on last month's message carries last month's
  snowflake and would fall below an id cursor. `create_timestamp` is null
  for threads created before 2022-01-09; those fall back to the id's
  snowflake time.
- **Dedupe key:** the thread `id`; `updatedAt` is `create_timestamp`.
- **Config:** `guild` (required), `channel` (optional parent id),
  `lookbackMinutes`.
- **Sample item:**

```json
{
  "externalId": "1412345678901234567",
  "title": "Thread: Build 418 rollout",
  "url": "https://discord.com/channels/197038439483310086/1412345678901234567",
  "updatedAt": "2026-09-04T18:45:10.000000+00:00",
  "data": {
    "id": "1412345678901234567",
    "type": 11,
    "guild_id": "197038439483310086",
    "parent_id": "41771983423143937",
    "owner_id": "80351110224678912",
    "name": "Build 418 rollout",
    "message_count": 1,
    "member_count": 2,
    "thread_metadata": { "archived": false, "auto_archive_duration": 1440, "archive_timestamp": "2026-09-04T18:45:10.000000+00:00", "locked": false, "create_timestamp": "2026-09-04T18:45:10.000000+00:00" }
  }
}
```

## Actions

Every action sends the `Bot` header and the User-Agent, goes through the
rate-limit client, and throws on a non-2xx answer.

### `sendMessage` — send a message

`POST /channels/{channel}/messages`, JSON. Not idempotent: two calls send
twice. `content` is at most 2000 characters; `embeds` is "up to 10 embeds"
whose "combined character sum across all embeds cannot exceed 6000"; sending
neither answers `50006` "Cannot send an empty message". A reply is
`message_reference: { message_id, fail_if_not_exists: false }` so a deleted
target sends "as a normal (non-reply) message" instead of failing. In a
thread the same endpoint works with the thread id as `channel`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | Channel or thread id |
| `content` | string | no | Text, up to 2000 characters; required unless `embeds` is given |
| `embeds` | string | no | A JSON array of embed objects (`title`, `description`, `url`, `color`, `fields`, `footer`, `image`, `thumbnail`, `author`, `timestamp`), parsed before sending |
| `replyTo` | string | no | Message id to reply to |

Outputs: `id`, `channelId`, `content`, `timestamp`, `url`.

### `createThread` — reply in a thread, creating it from a message if needed

`POST /channels/{channel}/messages/{message}/threads` with `{ name,
auto_archive_duration }`, then `POST /channels/{thread}/messages` with the
content. "The id of the created thread will be the same as the id of the
source message, and as such a message can only have a single thread created
from it": when the first call answers `160004` "A thread has already been
created for this message" the connector skips creation and posts into the
thread whose id is the message id, which is what "reply in a thread or
create one" means. Works on `GUILD_TEXT` (makes a `PUBLIC_THREAD`) and
`GUILD_ANNOUNCEMENT` (`ANNOUNCEMENT_THREAD`); "does not work on a
`GUILD_FORUM` or a `GUILD_MEDIA` channel". Not idempotent: the content is
posted on every call.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | The parent channel id |
| `message` | string | yes | The message to thread from |
| `name` | string | yes | Thread name, 1–100 characters; ignored when the thread exists |
| `content` | string | yes | The reply to post in the thread, up to 2000 characters |
| `autoArchiveDuration` | number | no | 60, 1440, 4320 or 10080 minutes; default 1440 |

Outputs: `threadId`, `threadName`, `created` (boolean, whether this call
made the thread), `messageId`, `url`.

### `addReaction` — add a reaction

`PUT /channels/{channel}/messages/{message}/reactions/{emoji}/@me`, answers
`204`. Not idempotent in intent (the spec says so); Discord answers `204`
again for a repeat, so a retry is harmless. The emoji is URL-encoded: a
Unicode emoji as itself (`%F0%9F%91%8D`), a custom one as `name:id`. Needs
Read Message History and Add Reactions.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | Channel or thread id |
| `message` | string | yes | Message id |
| `emoji` | string | yes | A Unicode emoji such as `👍`, or `name:id` for a custom one |

Outputs: `ok` (`true`).

### `pinMessage` — pin a message

`PUT /channels/{channel}/messages/pins/{message}`, answers `204`. The older
`PUT /channels/{channel}/pins/{message}` is marked deprecated in the current
docs and is not used. Idempotent: pinning a pinned message is a `204`. Needs
Pin Messages; `30003` "Maximum number of pins reached for the channel (250)"
is surfaced as is.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | Channel or thread id |
| `message` | string | yes | Message id |

Outputs: `ok` (`true`).

No live sample: the live check does not pin anything.

### `listChannels` — list the channels of a guild

`GET /guilds/{guild}/channels`, which "does not include threads" and returns
every channel object; from 16 November 2026 it omits channels the bot cannot
view. Idempotent. Type numbers from the channel types table: `0` text, `2`
voice, `4` category, `5` announcement, `13` stage, `15` forum, `16` media.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `guild` | string | yes | Guild (server) id |
| `type` | number | no | Keep only this channel type, e.g. `0` for text |

Outputs: `channels` (array of `{ id, name, type, parentId, position, topic,
nsfw }`), sorted by `position`.

Live sample: `{ "guild": "$DISCORD_GUILD_ID" }`, a placeholder the live check
fills from the environment.

### `getChannel` — get a channel

`GET /channels/{channel}`: "Get a channel by ID. Returns a channel object."
Idempotent. `10003` Unknown channel for a wrong id, `50001` Missing access for
one the bot cannot see.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | yes | Channel or thread id |

Outputs: `id`, `name`, `type`, `guildId`, `parentId`, `topic`, `nsfw`,
`lastMessageId`, `rateLimitPerUser`, `threadMetadata` (or null),
`messageCount`, `memberCount`.

Live sample: `{ "channel": "$DISCORD_CHANNEL_ID" }`.

### `getGuildMember` — get a guild member

`GET /guilds/{guild}/members/{user}`: "Returns a guild member object for the
specified user." Idempotent, and needs no privileged intent (only the list
does). `10007` Unknown member when the user is not in the guild.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `guild` | string | yes | Guild id |
| `user` | string | yes | User id |

Outputs: `userId`, `username`, `globalName`, `nick`, `roles`, `joinedAt`,
`premiumSince`, `pending`, `communicationDisabledUntil`, `isBot`.

Live sample: `{ "guild": "$DISCORD_GUILD_ID", "user": "$DISCORD_USER_ID" }`;
`DISCORD_USER_ID` defaults to the preflight's own id, since the bot is a
member of every guild it can read.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/discord/dist/index.js --mock --receipt packages/discord/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls: the client takes an injected `fetch` and sleep, and the
rate-limit tests feed it canned `429` and header sequences.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `DISCORD_BOT_TOKEN` is
unset; no token exists on this machine. With it set, the script calls
`GET /users/@me`, then the idempotent read actions' samples against the real
API, then `vorn-connector check --live`.

| Env | Required | Used by |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | every call |
| `DISCORD_GUILD_ID` | no | `listChannels`, `getGuildMember`; skipped when unset |
| `DISCORD_CHANNEL_ID` | no | `getChannel`; skipped when unset |
| `DISCORD_USER_ID` | no | `getGuildMember`; defaults to the bot's own id |

Nothing is sent, reacted, pinned or threaded: the live check touches only
idempotent, read-only endpoints, which also keeps it clear of the invalid
request limit.

## Dependencies

None at runtime. `fetch`, `URLSearchParams`, `encodeURIComponent` and `BigInt`
cover the client, the emoji path segment and snowflake arithmetic. `discord.js`
and `@discordjs/rest` are gateway-shaped SDKs many times the size of this
connector and are not inlined.

## Icon

Discord's mark is "Clyde": a rounded, controller-shaped face in white on
blurple (`#5865F2`), with two vertical oval eyes as cut-outs and a wide, flat
brow. A single-colour SVG carries the face alone: in a 24-unit viewBox, one
path with `fill-rule: evenodd`. The outer silhouette spans roughly x 1.5 to
22.5 and y 2.8 to 20.6: a flat top edge with two small notches at the temples
(x ≈ 5.5 and 18.5, y ≈ 4.5) where the ears sit, sides that flare outward
slightly toward the bottom, a lower edge that curves up into two short
rounded feet at the corners (x ≈ 4 and 20, y ≈ 20) with a shallow dip
between them, and a chin at y ≈ 17.5. The two eyes are ellipses about 2.4
wide and 2.9 tall, centred near (8.6, 12.3) and (15.4, 12.3), drawn as inner
subpaths so the evenodd rule punches them through. Fill only, no strokes.

## Docs

The only source. `discord.com/developers/docs/...` links `301` to
`docs.discord.com/developers/...`; fetch the target directly.

- Reference (base URL, versioning, `Bot` header, User-Agent, snowflakes, error shape): https://discord.com/developers/docs/reference
- Rate limits: https://discord.com/developers/docs/topics/rate-limits
- Opcodes, HTTP status codes and JSON error codes: https://discord.com/developers/docs/topics/opcodes-and-status-codes
- Permissions (bit flags, invite URL): https://discord.com/developers/docs/topics/permissions
- Gateway intents (privileged intents, Message Content, Server Members): https://discord.com/developers/docs/events/gateway#gateway-intents
- Channel resource (Get Channel, channel types, Start Thread from Message, thread metadata): https://discord.com/developers/docs/resources/channel
- Message resource (Get Channel Messages, Create Message, Create Reaction, Pin Message, message types, embeds): https://discord.com/developers/docs/resources/message
- Guild resource (List Guild Members, Get Guild Member, Get Guild Channels, List Active Guild Threads): https://discord.com/developers/docs/resources/guild
- User resource (Get Current User): https://discord.com/developers/docs/resources/user
- Developer Portal (applications, Bot tab, Reset Token, Privileged Gateway Intents, URL Generator): https://discord.com/developers/applications
