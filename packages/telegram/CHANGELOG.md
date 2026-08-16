# Changelog

All notable changes to `@vornrun/connector-telegram`.

## 0.1.0

First release.

Trigger a workflow when a Telegram message arrives, and let a workflow step
send, reply or edit.

- **Trigger:** `messageReceived`.
- **Actions:** `sendMessage`, `replyToMessage`, `editMessageText`.
- **Signing in:** paste a bot token from @BotFather. There is no Telegram CLI to
  sign in with, and Telegram's OAuth grants only outbound messaging, never
  reads.

Unlike every other connector here, reading Telegram is acking it: `getUpdates`
confirms every update below the offset it is given, and a confirmed update
cannot be fetched again. So this is the first trigger written against the SDK's
hand-written `poll` arm rather than the declarative `fetch`/`dedupe` one — the
cursor *is* the ack, and the connector has to own its exact value. It never
reports `hasMore`, so a backlog waits for the next scheduled poll instead of
being confirmed inside one, and a negative offset — the one call Telegram
documents as destructive — can never reach the wire.

Consequences worth knowing before you connect it: one bot token can only be read
by one connection, there is no backfill, editing a message starts a second run
rather than revising the first, and `vorn-connector check --live` consumes real
messages. The README says all of this louder.

Built against Telegram's own Bot API reference at 10.2, hand-rolled at zero
dependencies. There is no vendor SDK to prefer — Telegram maintains none — and
the three community frameworks are bot runtimes we would install to use about
5% of.
