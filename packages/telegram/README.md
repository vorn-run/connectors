# @vornrun/connector-telegram

Trigger Vorn workflows from Telegram messages, and send, reply to or edit
messages from a workflow step.

## Read this part first

Telegram is not like the other connectors here. Every other one re-asks its
source and lets Vorn work out what is new, so a poll that goes wrong costs
nothing. Telegram's `getUpdates` is different: **reading is acking.**

> "An update is considered confirmed as soon as getUpdates is called with an
> offset higher than its update_id."
> — [Bot API: getUpdates](https://core.telegram.org/bots/api#getupdates)

There is no endpoint that returns message history, and unconfirmed updates
"will not be kept longer than 24 hours". Three consequences you cannot design
away:

- **One token, one connection.** Two Vorn connections on the same bot token
  silently steal each other's messages, and Telegram reports no error. If you
  want two workflows watching Telegram, make two bots.
- **No backfill, ever.** The connection sees nothing sent before it was made.
- **A paused or slow poll loses messages**, not just time — which is why the
  seeded workflow polls every minute rather than the usual five.

This connector's job is to make sure Vorn has the messages *before* they are
confirmed. It does that by returning them with the offset that will confirm
them, and never confirming anything within a single poll. See "How the cursor
works" below.

## Signing in

Create a bot with [@BotFather](https://core.telegram.org/bots/features#botfather)
and paste the token it gives you. It is stored encrypted by Vorn, in the OS
keychain, and never printed.

There is no better option, and the two better-looking ones were checked:

- **No CLI to borrow a login from.** Nothing mints Bot API credentials the way
  `az login` serves `ado` and `kusto`.
- **Telegram's OAuth cannot read.** `oauth.telegram.org` exists, but its only
  messaging scope is outbound — it lets a bot message *you*. No scope grants
  reading a chat, so an OAuth flow would be ceremony returning a credential
  that cannot power the trigger.

Two things make this a milder secret than it looks: anyone with a Telegram
account can create a bot, so no admin has to be asked, and the token has no
scopes to choose wrong and no expiry to rotate.

The token travels in the **URL path**, not a header, which makes the request URL
itself a secret. `src/client.ts` builds that URL in one place and redacts the
token from every error message, including the ones Node writes about failed
sockets.

### If the bot sees nothing in a group

This is the setup failure this connector generates most, and it is not a bug.

> "By default, all bots added to groups run in Privacy Mode and only see
> relevant messages and commands … It can be disabled so that the bot receives
> all messages like an ordinary user (the bot will need to be **re-added to the
> group** for this change to take effect)."
> — [Bot features: privacy mode](https://core.telegram.org/bots/features#privacy-mode)

Turning privacy mode off in @BotFather and stopping there changes nothing. You
have to remove and re-add the bot afterwards. The connector checks `getMe` once
per process and warns if privacy mode is on — worded as a possibility rather
than a verdict, because the same paragraph exempts admins: a bot added as a
group admin receives everything while still reporting
`can_read_all_group_messages: false`.

Private chats are unaffected by any of this.

## Settings

| Field | Required | What it does |
| --- | --- | --- |
| `token` | yes | Bot token from @BotFather |
| `chatId` | no | Numeric chat id, or `@username` for a public channel. Blank watches every chat the bot is in. |
| `updateTypes` | no | Comma-separated: `message`, `edited_message`, `channel_post`, `edited_channel_post`. Defaults to `message,edited_message`. |
| `pollTimeout` | no | Seconds Telegram may hold the connection open. Default `10`; `0` is short polling, which Telegram documents as testing-only. |
| `limit` | no | 1–100 messages per poll. Default `100`, Telegram's documented maximum. |

`updateTypes` defaults to both halves of the pair because an update carries at
most one of them — asking for `message` alone would make the `edited` status
below unreachable. Anything outside the four listed types is refused when the
connection is saved rather than skipped at poll time: an update this connector
asked for but could not map would still be confirmed, and Telegram cannot give
it back.

## Trigger

**A message arrives.** Fires once for each new or edited message the bot can
see.

Each item's id is `chatId:messageId`, because the reference defines `message_id`
as "unique message identifier inside this chat" — every other connector here has
a globally unique id and this one cannot. Items carry no `url`: the Bot API
documents no permalink for a message, and the `t.me` forms that circulate are
not in the reference and do not resolve for private chats.

**An edit is a separate run, not a revision of the first.** Its id carries the
edit's timestamp — `chatId:messageId:e<edit_date>` — so editing a message starts
a new run rather than changing the task the original made. That is forced rather
than chosen: Vorn files an item under its id and discards one it has already
seen, with no path to apply an update, so an edit reusing the message's id would
never reach a workflow at all. Two edits inside the same second arrive as one,
because Telegram stamps `edit_date` in whole seconds.

| Message | Task status |
| --- | --- |
| `received` | `todo` |
| `edited` | `todo` |

That mapping is nearly empty on purpose. A Telegram message has no lifecycle —
there is no "done" — and both states exist only so imported items do not
silently inherit a default implying more than is known.

A workflow step can read `{{trigger.item.title}}` (the first line),
`.description` (the whole message), `.assignee` (the sender, absent on channel
posts), and from `data`: `.chatId`, `.chatTitle`, `.chatType`, `.messageId`,
`.fromUsername`, `.updateType`, `.sentAt`, `.editedAt`.

### How the cursor works

`getUpdates(offset: N)` confirms everything below `N` and returns from `N`, so
**the offset carried into the next poll is what confirms the last one**. Vorn
stores a poll's items and its cursor together, which means nothing is ever
confirmed that Vorn does not already hold. The connector keeps no state of its
own; it is an ordinary `npx -y` process like the rest of the repo.

Two rules fall out of that, and both are load-bearing:

- **The trigger never reports `hasMore`.** A backlog is drained by the *next*
  scheduled poll, not within one. A second call inside one poll would confirm
  the first page before the host had stored it. That costs latency; the
  alternative costs messages.
- **A negative offset never reaches the wire.** It is the one call this API
  documents as destructive ("All previous updates will be forgotten"), so an
  unreadable or out-of-range cursor is discarded and the poll resumes from the
  oldest unconfirmed update instead.

The offset is recalculated from each response, as the reference instructs, and
can only move forwards.

Messages the connection is not watching — another chat, `message_id: 0`, an
update with nothing mappable in it — are confirmed along with the rest. That is
deliberate: leaving them unconfirmed would re-read them on every poll for the
life of the connection.

A message and an edit of it can arrive in the same batch. They are two events
and arrive as two items, because the edit's id carries its `edit_date`. What is
still collapsed is a genuine repeat — the same update twice, or two edits
Telegram stamped in the same second — because Vorn rejects a page containing one
id twice, and a page that always fails is never confirmed.

## Actions

| Action | What it does |
| --- | --- |
| `sendMessage` | Post a message to a chat |
| `replyToMessage` | Post a message threaded under another |
| `editMessageText` | Replace the text of a message this bot sent |

`editMessageText` is idempotent — the same text twice leaves the message in the
same state, and an edit that changes nothing comes back as `changed: false`. The
other two are not: Telegram has no idempotency key, so two calls post two
messages.

Text over **4096 characters** is refused rather than truncated, matching the
limit `sendMessage` documents "after entities parsing". If a group has become a
supergroup, Telegram answers with `migrate_to_chat_id`; the send is retried
against the new id and the id actually used comes back in the step's output, so
the connection can be corrected.

There is deliberately **no `deleteMessage`**. Its time and admin conditions
cannot be stated honestly in one line of an action table, and an action that
destroys a message and sometimes silently cannot is worse than no action.

## Known limits

- **Cannot coexist with a webhook** on the same bot: `getUpdates` "will not work
  if an outgoing webhook is set up". A failed poll says so, along with the other
  two things it could be — the reference promises no status code that
  distinguishes them.
- **No delete history.** A deleted message produces no update at all, so a
  workflow can hold a task for a message that no longer exists.
- **`vorn-connector check --live` consumes real messages.** It polls twice and
  expects the second poll to redeliver nothing; against Telegram that second
  poll permanently confirms the first poll's messages. Point it at a throwaway
  bot, never a real one. Because the trigger is a hand-written poll, `check`
  without `--live` can only report `sample-unusable` — the correctness
  confidence here comes from the unit tests against a faked transport.

## Built from

Telegram's own [Bot API reference](https://core.telegram.org/bots/api), read on
2026-08-14 at Bot API 10.2. The specific pages this was written from:

- [Making requests](https://core.telegram.org/bots/api#making-requests) and
  [getting updates](https://core.telegram.org/bots/api#getting-updates) — the
  URL form, the response envelope, and the 24-hour retention
- [`getUpdates`](https://core.telegram.org/bots/api#getupdates) — offset
  semantics, the `limit` maximum, and the negative-offset warning
- [`Message`](https://core.telegram.org/bots/api#message) — per-chat
  `message_id`, `message_id: 0`, and the absent `from` on channel posts
- [`sendMessage`](https://core.telegram.org/bots/api#sendmessage) and
  [`editMessageText`](https://core.telegram.org/bots/api#editmessagetext) — the
  4096-character cap and the `Message | true` return
- [`ResponseParameters`](https://core.telegram.org/bots/api#responseparameters) —
  `retry_after` and `migrate_to_chat_id`
- [Bot features: privacy mode](https://core.telegram.org/bots/features#privacy-mode)
- [FAQ: limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)
  — the published pacing, used as documentation only

There is **no vendor SDK to prefer**, which is the repo's usual rule.
`core.telegram.org/bots/samples` lists only libraries "developed by the Telegram
community" and "not maintained by Telegram"; the only code Telegram publishes
itself is the server. The three real candidates were checked on 2026-08-14 —
`grammy` is healthy, `telegraf` is four Bot API majors behind, and
`node-telegram-bot-api` is mid-rewrite — and all three are bot runtimes we would
install to use about 5% of, while inheriting their release cadence for Bot API
currency. This connector needs four methods, each a JSON POST to a URL, so it
hand-rolls them at zero dependencies. The full argument is in the header of
`src/client.ts`.

Telegram publishes no machine-readable schema for the Bot API — the reference is
prose HTML, and the "Schema" in its navigation belongs to MTProto, a different
API — so the types here are hand-written for the fields actually consumed.

MTProto itself was considered and rejected: it authenticates as a *person*, not
a bot, which would put a user's own Telegram account at risk under Telegram's
automation rules. It is the only way to read history, and it is not worth it.
