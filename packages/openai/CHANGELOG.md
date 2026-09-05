# Changelog

All notable changes to `@vornrun/connector-openai`.

## 0.1.0

First release.

Trigger a workflow when an OpenAI batch or fine-tuning job reaches a terminal
status or a file is uploaded, and let a workflow step create a response, a
chat completion, embeddings, a moderation or a batch, or read the models, the
files and one batch.

- **Triggers:** `batchFinished`, `fileUploaded`, `fineTuningJobFinished`.
- **Actions:** `createResponse`, `createChatCompletion`, `createEmbeddings`,
  `moderateText`, `listModels`, `getModel`, `listFiles`, `getBatch`,
  `createBatch`.
- **Signing in:** an API key from https://platform.openai.com/api-keys, sent
  as `Authorization: Bearer <key>`, with optional `OpenAI-Organization` and
  `OpenAI-Project` headers. There is no OpenAI CLI to borrow a login from.

Every action is hand-written against one small client rather than declared as
an SDK `request`, because the things every call shares cannot be said in a
header template or a `postReceive`: the documented retry policy (a `429` with a
rate-limit code is retried once after `Retry-After`, else
`x-ratelimit-reset-requests`, else two seconds, with jitter; a `429` naming a
quota or spend limit is thrown at once; `500`, `502`, `503` and `504` are
retried once), the pre-emptive sleep when `x-ratelimit-remaining-requests`
reaches zero, the `<status> <code>: <message>` error shape read from the error
body with the `x-request-id`, inputs that are text or a JSON array, and the
Unix-second timestamps every output converts to ISO 8601.

The three triggers are declarative fetches on the SDK's timestamp strategy,
each walking `after` up to five pages of 100 and delivering oldest first.
Batches and fine-tuning jobs are keyed `<id>:<status>` and stamped with the
terminal timestamp, so each fires exactly once when it lands in one terminal
state; because both are created long before they finish, the poll pages back a
look-back before the watermark (48 hours for batches, a week for jobs). Files
watermark on `created_at`. The first poll looks a week back for batches, an
hour for files and a week for jobs rather than replaying the account.

`createResponse` sends `store: false` unless asked, so a step leaves nothing
behind, and gathers the `output_text` parts the HTTP body carries because the
SDK-only `output_text` field is not in it. `createChatCompletion` sends
`max_completion_tokens`, never the deprecated `max_tokens`.

Ships as a pack with a conformance receipt covering the mock run and the
dedupe replay of every trigger. No runtime dependencies: `fetch`, `URL` and
`setTimeout` cover the client, the pagination and the retry waits.
