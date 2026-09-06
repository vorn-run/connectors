# @vornrun/connector-anthropic

Trigger Vorn workflows when an Anthropic message batch finishes processing or
a new model becomes available, and create messages, count tokens, list models
and run message batches from a workflow step. Talks to the Claude API at
`https://api.anthropic.com/v1`.

## Signing in

Paste an API key into the **API key** field. There is no CLI to borrow a login
from. Create one at https://console.anthropic.com/settings/keys (the console
also answers at https://platform.claude.com/settings/keys). Keys have no
scopes: choose the key's type and expiry when you create it. Use a
**single-workspace** key; a multi-workspace key also needs an
`anthropic-workspace-id` header, which this connector does not send.

The key is sent as `x-api-key` together with `anthropic-version: 2023-06-01`
on every call. A malformed, revoked or expired key answers
`401 authentication_error`; a key without access to a resource answers
`403 permission_error`. The connector surfaces every API error as
`<error.type>: <error.message>` with the HTTP status and the `request-id`,
such as `not_found_error: The requested resource could not be found. (HTTP 404,
request req_…)`. Keep the key out of shared configuration: it bills against
your organization.

## Settings

| Setting | Environment | Required | What it does |
| --- | --- | --- | --- |
| API key | `ANTHROPIC_API_KEY` | yes | Sent as `x-api-key` on every call |

## Rate limits

Limits are per organization and per model, in requests, input tokens and
output tokens per minute; batches have their own request limit shared across
models. Beyond a limit the API answers `429 rate_limit_error` with a
`retry-after` header. The connector:

- waits `retry-after` (capped at 60 seconds) and sends once more on a `429`;
  a second `429` is reported. A `429` **without** `retry-after` is the monthly
  spend cap and is reported at once, since no wait lifts it;
- retries once after `retry-after`, or a jittered one to two seconds, on a
  `529 overloaded_error` or any `5xx`;
- reads `anthropic-ratelimit-requests-remaining` on every reply, and when it
  reached `0` waits until `anthropic-ratelimit-requests-reset` (capped at 60
  seconds) before the next call, so a poll that walks pages does not trip the
  limit by itself.

Nothing else is retried. Every action goes through the same client, so the
same waits, retries and error text apply to all of them.

The connector does not stream, so `createMessage` defaults `maxTokens` to
1024. A long generation or a large job belongs in a message batch.

## Triggers

Both poll with `limit=100` and walk `after_id` pages, at most ten per poll,
and deliver oldest first.

### `batchEnded` — a message batch finished

Polls `GET messages/batches`, newest first, and fires once for each batch
whose `processing_status` is `ended`. Processing ends when every request has
succeeded, errored, been canceled or expired. The list is ordered by creation,
and a batch created before the last poll can end after it, so the poll walks
back until it meets a batch created more than 24 hours before the cursor:
batches expire 24 hours after creation, so anything older ended before the
previous poll. The first poll looks 24 hours back. Each item carries the
batch as `data`, `ended_at` as its time, and a title such as
`Batch msgbatch_… ended: 50 succeeded, 30 errored`. The docs give no console
URL for a batch, so there is no `url`. Read the results with
`getBatchResults`.

### `newModel` — a model became available

Polls `GET models`, newest first, and fires once for each model whose
`created_at` is at or after the cursor. The first poll looks 30 days back so
an old catalog does not fire wholesale. A model whose release date is unknown
carries an epoch `created_at` and never fires. Each item carries the model as
`data`, its `display_name` as the title and the models overview page as `url`.

## Actions

Inputs typed JSON are checked before any call is made. `model` defaults to
`claude-sonnet-5`; `messages` is either prompt text, sent as one user turn, or
a JSON array of `{ "role", "content" }` turns passed through as is.

| Action | Idempotent | What it does |
| --- | --- | --- |
| `createMessage` | no | `POST messages` with `model`, `messages`, optional `system`, `maxTokens` (default 1024), `temperature`, `tools` and `stopSequences`. Returns `id`, `model`, `text` (the first text block, empty on a tool call alone), `stopReason`, `usage`, `raw`. Every call bills a generation. |
| `countTokens` | yes | `POST messages/count_tokens` with `model`, `messages`, optional `system`. Returns `inputTokens`. |
| `listModels` | yes | `GET models`, every page. Returns `models`, `count`. |
| `getModel` | yes | `GET models/{modelId}`; resolves an alias to its id. Returns `id`, `displayName`, `createdAt`, `maxInputTokens`, `maxTokens`, `capabilities`, `raw`. |
| `createMessageBatch` | no | `POST messages/batches` with `requests`, an array of `{ "custom_id", "params" }` where `params` is a full message body; a single object is a batch of one. Returns `id`, `processingStatus`, `requestCounts`, `createdAt`, `endedAt`, `expiresAt`, `cancelInitiatedAt`, `resultsUrl`, `raw`. |
| `getMessageBatch` | yes | `GET messages/batches/{batchId}`; poll it until `processingStatus` is `ended`. Same outputs. |
| `getBatchResults` | yes | `GET messages/batches/{batchId}/results`, the JSONL parsed into `results` (`{ custom_id, result }`, matched by `custom_id`, not by order) and `count`. Before processing ends the API's own error is reported. |
| `cancelMessageBatch` | no | `POST messages/batches/{batchId}/cancel`. Same outputs, with `cancelInitiatedAt` set. Requests already running may still finish. |

Models released after Claude Opus 4.6, the default included, accept only a
`temperature` of 1.0 and reject other values with a `400`. `stopSequences`
takes a JSON array of strings, or one string as a single sequence; `tools`
takes an array of `{ name, description, input_schema }`, and a tool call comes
back as a `tool_use` block in `raw.content` with `stopReason` `tool_use`.

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/anthropic/dist/index.js --mock --receipt packages/anthropic/verified.json
```

`packages/anthropic/scripts/check.sh` runs exactly this. Tests make no network
calls: the client takes an injected `fetch`, clock and sleep.

`packages/anthropic/scripts/check-live.sh` exits 0 with a note when
`ANTHROPIC_API_KEY` is unset. With a key it lists models, reads
`claude-sonnet-5`, counts the tokens of `hello`, lists five batches, then the
batch named by `ANTHROPIC_BATCH_ID` and its results when that is set, and
finally runs `vorn-connector check --live` against the built package. The
same variable fills the live samples of `getMessageBatch` and
`getBatchResults`. Nothing is generated, queued or canceled.

## Built from

The API reference was the only source. Every `docs.anthropic.com/en/api/…`
page now redirects to the same path under `platform.claude.com/docs/en/api/`.

- API overview: https://platform.claude.com/docs/en/api/overview
- Get started (headers, `ANTHROPIC_API_KEY`): https://platform.claude.com/docs/en/get-started
- Versions: https://platform.claude.com/docs/en/api/versioning
- Create a message: https://platform.claude.com/docs/en/api/messages
- Count tokens: https://platform.claude.com/docs/en/api/messages-count-tokens
- List models: https://platform.claude.com/docs/en/api/models-list
- Get a model: https://platform.claude.com/docs/en/api/models
- Create a message batch: https://platform.claude.com/docs/en/api/creating-message-batches
- List message batches: https://platform.claude.com/docs/en/api/listing-message-batches
- Retrieve a message batch: https://platform.claude.com/docs/en/api/retrieving-message-batches
- Retrieve batch results: https://platform.claude.com/docs/en/api/retrieving-message-batch-results
- Cancel a message batch: https://platform.claude.com/docs/en/api/canceling-message-batches
- Errors: https://platform.claude.com/docs/en/api/errors
- Rate limits: https://platform.claude.com/docs/en/api/rate-limits
- Create an API key: https://console.anthropic.com/settings/keys
