# Changelog

All notable changes to `@vornrun/connector-discord`.

## 0.1.0

First release.

Trigger a workflow from new Discord messages, server members and threads, and
let a workflow step send a message, reply in a thread, add a reaction, pin a
message, or read the channels of a server, one channel and one member.

- **Triggers:** `messageInChannel`, `memberJoined`, `threadCreated`.
- **Actions:** `sendMessage`, `createThread`, `addReaction`, `pinMessage`,
  `listChannels`, `getChannel`, `getGuildMember`.
- **Signing in:** a bot token from the Developer Portal's Bot tab, sent as
  `Authorization: Bot <token>`. There is no Discord CLI to borrow a login
  from. The README names the two privileged intents (Message Content for
  message text, Server Members for the member trigger) and the server
  permissions the bot needs, with the invite URL's permission sum.

Every action is hand-written against one small client rather than declared as
an SDK `request`: the three things every call shares, stripping a pasted
`Bot ` prefix from the token, the per-bucket rate-limit bookkeeping and
Discord's `<status> <code>: <message>` error shape with the first nested
`_errors` message of an invalid form body, live in the client and cannot be
said in a header template or a `postReceive`. The client sends the documented
`DiscordBot (url, version)` User-Agent, remembers `X-RateLimit-Remaining` and
`X-RateLimit-Reset-After` per `X-RateLimit-Bucket` and sleeps out an exhausted
bucket before calling it again, waits `Retry-After` on a `429` (never under a
second, twice, then throws with the bucket and scope), retries a `5xx` once,
and caps every wait at 60 seconds.

The three triggers are declarative fetches on the SDK's timestamp strategy.
Messages page with `after` from a snowflake built from the watermark, so the
first poll looks back an hour rather than replaying the channel, and drop
bots, the bot itself and system messages unless the connection includes them.
Members watermark on `joined_at`, not user id, because the member list is
sorted by account age rather than join order. Threads watermark on
`create_timestamp`, not id, because a thread started from a message shares
that message's id.

`createThread` posts into the thread a message already has when Discord
answers `160004`, and reports `created: false`. `sendMessage` replies with
`fail_if_not_exists: false`, so a deleted target posts a plain message.

Ships as a pack with a conformance receipt covering the mock run and the
dedupe replay of every trigger. No runtime dependencies: `fetch`,
`URLSearchParams`, `encodeURIComponent` and `BigInt` cover the client, the
emoji path segment and snowflake arithmetic.
