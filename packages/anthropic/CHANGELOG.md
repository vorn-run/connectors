# Changelog

All notable changes to `@vornrun/connector-anthropic`.

## 0.1.0

First release.

Trigger a workflow when an Anthropic message batch finishes processing or a
new model becomes available, and let a workflow step create a message, count
tokens, list or read models, and create, read, collect or cancel a message
batch.

- **Triggers:** `batchEnded`, `newModel`.
- **Actions:** `createMessage`, `countTokens`, `listModels`, `getModel`,
  `createMessageBatch`, `getMessageBatch`, `getBatchResults`,
  `cancelMessageBatch`.
- **Signing in:** an API key from console.anthropic.com/settings/keys, sent as
  `x-api-key` with `anthropic-version: 2023-06-01`. There is no CLI to borrow
  a login from.

Every action and both polls go through one small client rather than declared
SDK requests, because the documented rate-limit behaviour needs more than a
declared request can express: a `429` is retried once after `retry-after` and
reported at once when the header is missing, since that is the spend cap; a
`529` or `5xx` is retried once; and a reply that says no requests remain makes
the next call wait for `anthropic-ratelimit-requests-reset`. Every failure is
reported as `<error.type>: <error.message>` with the status and request id,
and every message, model and batch read returns the reply as `raw` beside the
named fields. Batch results are the JSONL stream parsed into an array.

Both triggers poll on the SDK's timestamp dedupe strategy, walking `after_id`
pages newest first. Ended batches are stamped with `ended_at` and
the walk stops 24 hours before the cursor, the batch lifetime, so a batch
created before one poll and ended after it still fires once. New models are
stamped with `created_at`; the first poll looks 30 days back and an epoch
release date never fires.

Ships as a pack with a conformance receipt covering the dedupe replay of both
triggers and the mock run of every action. No runtime dependencies: `fetch`
and `JSON` cover the client, the pager is a loop on `after_id`, and JSONL is
a split on newlines.
