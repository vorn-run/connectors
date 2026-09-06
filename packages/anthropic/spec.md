id: anthropic

# Anthropic connector

Anthropic's Claude API, "a RESTful API at `https://api.anthropic.com`", used
here through the `/v1` routes for messages, token counting, models and
message batches. Every request is HTTPS with a JSON body and a JSON answer,
except batch results, which stream as `.jsonl`. Ids carry a prefix: messages
`msg_…`, batches `msgbatch_…`, requests `req_…`; model ids are plain slugs
such as `claude-sonnet-5`. Every response carries a `request-id` header,
"a globally unique identifier for the request", which the connector quotes
in every thrown error.

Errors: "The API always returns errors as JSON, with a top-level `error`
object that always includes a `type` and `message` value. The response also
includes a `request_id` field":

```json
{
  "type": "error",
  "error": {
    "type": "not_found_error",
    "message": "The requested resource could not be found."
  },
  "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
}
```

The connector throws `<error.type>: <error.message>` with the HTTP status
and the request id. Statuses from the errors page: `400 invalid_request_error`
("also used for other 4XX status codes not listed"), `401 authentication_error`
("malformed, revoked, or expired" key), `402 billing_error`,
`403 permission_error`, `404 not_found_error`, `409 conflict_error`,
`413 request_too_large` (32 MB for Messages and Token Counting, 256 MB for
batches), `429 rate_limit_error`, `500 api_error`, `504 timeout_error`,
`529 overloaded_error`.

Package: `@vornrun/connector-anthropic` in `packages/anthropic`, shaped like
the existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category `AI`,
`packs: true`.

## Auth

Rung: **`key`**. The `ant` CLI exists (`ant auth login`, `ant auth status`),
but it is new and its OAuth token is not what the Messages API documents for
`x-api-key`; the getting-started page's own path is "Export your API key as
an environment variable", so the connector takes a pasted key, as the notion
and airtable connectors do.

| Config field | Env name | Where it comes from |
| --- | --- | --- |
| `apiKey` (secret, required) | `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys (the console now lives at https://platform.claude.com/settings/keys; both open the same page) |

Sent on every request as:

```
x-api-key: <key>
anthropic-version: 2023-06-01
content-type: application/json
```

The overview lists `Authorization: Bearer <token>` as the primary header and
`x-api-key` as "Your API key from Console. Legacy fallback for
`Authorization`, still supported"; every curl example on the endpoint pages
still sends `X-Api-Key`, and that is what this connector sends.
`anthropic-version` is required: "When making API requests, you must send an
`anthropic-version` request header. For example, `anthropic-version:
2023-06-01`", and `2023-06-01` is the newest listed version. Declare
`auth: { rung: 'key', keys: ['apiKey'] }`. Keys have no scopes; a key
"choose[s] each key's type … and its expiration when you create it", and a
key that lacks access to a resource answers `403 permission_error`.
`anthropic-workspace-id` is "Required with a multi-workspace API key" and is
not sent; the README says to use a single-workspace key.

## Rate limits and retries

Limits are per organization and per model, "measured in requests per minute
(RPM), input tokens per minute (ITPM), and output tokens per minute (OTPM)",
enforced with "the token bucket algorithm", and "If you exceed any of the rate
limits you will get a 429 error describing which rate limit was exceeded,
along with a `retry-after` header indicating how long to wait." Batches have
their own RPM "shared across all models".

Headers the connector reads on every response:

| Header | Doc text |
| --- | --- |
| `retry-after` | "The number of seconds to wait until you can retry the request. Earlier retries will fail. Not sent with the spend-cap 429" |
| `anthropic-ratelimit-requests-remaining` | "The number of requests remaining before being rate limited." |
| `anthropic-ratelimit-requests-reset` | "The time when the request rate limit will be fully replenished, provided in RFC 3339 format." |

Behaviour:

- **429:** wait `retry-after` seconds (capped at 60) and retry once; a second
  429 is thrown. A 429 with no `retry-after` is the monthly spend cap ("The
  error type is `rate_limit_error`, the same as for a rate limit, but the
  response has no `retry-after` header. Retrying … fails until access
  resumes"; `error.details.error_code` is `enforced_spend_limit_reached`), so
  it is thrown at once without a retry.
- **529 and 5xx:** "529 errors can occur when the API experiences high traffic
  across all users"; 500 says "Retry the request with exponential backoff".
  The connector retries once after `retry-after` when present, else a short
  jittered wait (1 to 2 seconds), then throws.
- **Requests-remaining:** when the last response said
  `anthropic-ratelimit-requests-remaining: 0`, the next call waits until
  `anthropic-ratelimit-requests-reset` (capped at 60 seconds) before it is
  sent, so a poll that walks pages does not trip the limit by itself.
- Nothing else is retried; 4xx other than 429 are thrown with the body's
  `error.type` and `error.message`.

Long generations: "Avoid setting a large `max_tokens` value without using the
streaming Messages API or Message Batches API"; the connector does not stream,
so `createMessage` defaults `max_tokens` to 1024 and the README points large
jobs at batches.

## Pagination

Batches and models "take `after_id` and `before_id` query parameters instead
of `page`. Their responses return `has_more`, `first_id`, and `last_id`":
`last_id` "Can be used as the `after_id` for the next page", `limit` "Defaults
to `20`. Ranges from `1` to `1000`." Both lists are newest first: "Most
recently created batches are returned first" and "More recently released
models are listed first". The connector pages with `limit=100` and
`after_id=<last_id>` while `has_more` is true, at most 10 pages per call.

## Triggers

Both poll, both `dedupe: 'timestamp'`, no config beyond the connection.

### `batchEnded` — a message batch finished processing

- **Poll:** `GET /v1/messages/batches?limit=100`, then `after_id` pages.
  `processing_status` is `"in_progress" or "canceling" or "ended"`, and
  `ended_at` is "Specified only once processing ends. Processing ends when
  every request in a Message Batch has either succeeded, errored, canceled,
  or expired." A batch is emitted when `processing_status` is `ended`.
- **Walk bound:** the list is by creation, not by ending, and a batch created
  before the cursor can end after it. `expires_at` is "24 hours after
  creation", so the poll walks newest-first pages until it meets a batch
  whose `created_at` is older than the cursor minus 24 hours; everything
  older than that ended before the previous poll saw it. With no cursor the
  first poll looks 24 hours back.
- **Cursor:** the newest `created_at` seen.
- **Dedupe key:** the batch `id`, with `updatedAt = ended_at`, which never
  changes once set, so a batch fires once even though the walk revisits it.
- **Sample item:**

```json
{
  "externalId": "msgbatch_013Zva2CMHLNnXjNJJKqJ2EF",
  "title": "Batch msgbatch_013Zva2CMHLNnXjNJJKqJ2EF ended: 50 succeeded, 30 errored",
  "updatedAt": "2024-08-20T18:37:24.100435Z",
  "data": {
    "id": "msgbatch_013Zva2CMHLNnXjNJJKqJ2EF",
    "type": "message_batch",
    "processing_status": "ended",
    "request_counts": { "processing": 0, "succeeded": 50, "errored": 30, "canceled": 10, "expired": 10 },
    "created_at": "2024-08-20T18:37:24.100435Z",
    "ended_at": "2024-08-20T18:37:24.100435Z",
    "expires_at": "2024-08-21T18:37:24.100435Z",
    "archived_at": null,
    "cancel_initiated_at": null,
    "results_url": "https://api.anthropic.com/v1/messages/batches/msgbatch_013Zva2CMHLNnXjNJJKqJ2EF/results"
  }
}
```

The docs give no console URL for a batch, so the item carries no `url`.

### `newModel` — a model became available

- **Poll:** `GET /v1/models?limit=100`, then `after_id` pages. Each model is
  `{ id, type: "model", display_name, created_at, max_input_tokens,
  max_tokens, capabilities }`; `created_at` is an "RFC 3339 datetime string
  representing the time at which the model was released. May be set to an
  epoch value if the release date is unknown."
- **Cursor:** the newest `created_at` seen. Models with `created_at` at or
  after the cursor are emitted; with no cursor the first poll looks 30 days
  back, so an old catalog does not fire wholesale. An epoch `created_at`
  never passes the cursor and never fires.
- **Dedupe key:** the model `id`, with `updatedAt = created_at`.
- **Sample item:**

```json
{
  "externalId": "claude-opus-5",
  "title": "Claude Opus 5",
  "url": "https://platform.claude.com/docs/en/about-claude/models/overview",
  "updatedAt": "2026-07-24T00:00:00Z",
  "data": {
    "id": "claude-opus-5",
    "type": "model",
    "display_name": "Claude Opus 5",
    "created_at": "2026-07-24T00:00:00Z",
    "max_input_tokens": 1000000,
    "max_tokens": 128000,
    "capabilities": { "batch": { "supported": true }, "thinking": { "supported": true, "types": { "adaptive": { "supported": true }, "enabled": { "supported": true } } } }
  }
}
```

## Actions

Every action sends the three headers above and throws on a non-2xx answer as
described under Errors. Inputs typed `json` are validated by the harness
before `run()`; every input carries a `builderHint`. The shared `model` input:

| Input | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | string | no | `claude-sonnet-5` | "The model that will complete your prompt." |

Its `builderHint` lists the ids the Messages reference enumerates today, so a
builder can pick without a lookup: `claude-fable-5-1`, `claude-sonnet-5`,
`claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`,
`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`,
`claude-opus-4-5`, `claude-sonnet-4-5`; `listModels` returns the live set.

The shared `messages` input takes either a string, sent as one
`{ "role": "user", "content": <string> }` turn ("Using a `string` for
`content` is shorthand for an array of one content block of type `"text"`"),
or a JSON array of `{ role, content }` turns passed through as is. "Consecutive
`user` or `assistant` turns in your request will be combined into a single
turn." `system` is "a way of providing context and instructions to Claude"
and is sent as a string when set.

### `createMessage` — create a message

`POST /v1/messages`. **Not idempotent**: every call bills a generation.

| Input | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | string | no | `claude-sonnet-5` | As above |
| `messages` | string or json | yes | | Prompt text, or a JSON array of `{ "role", "content" }` turns |
| `system` | string | no | | System prompt |
| `maxTokens` | number | no | 1024 | "The maximum number of tokens to generate before stopping. Note that our models may stop before reaching this maximum." Sent as `max_tokens` |
| `temperature` | number | no | | "Ranges from `0.0` to `1.0`"; sent only when set. "Models released after Claude Opus 4.6 do not support setting temperature. A value of 1.0 … will be accepted for backwards compatibility, all other values will be rejected with a 400 error", which the hint says outright because the default model is one of them |
| `tools` | json | no | | An array of tool definitions, each `{ name, description, input_schema }` where `input_schema` is a JSON schema "for the tool `input` shape that the model will produce in `tool_use` output content blocks" |
| `stopSequences` | json | no | | An array of strings; "If the model encounters one of the custom sequences, the response `stop_reason` value will be `"stop_sequence"`". Sent as `stop_sequences` |

Outputs: `text` (the `text` of the first `text` block in `content`, empty
when there is none, as when the model answered with a `tool_use` block),
`stopReason` (one of `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`,
`pause_turn`, `refusal`, `model_context_window_exceeded`), `usage`
(`{ input_tokens, output_tokens, cache_creation_input_tokens,
cache_read_input_tokens }`), `id`, `model`, and `raw` (the whole response,
so tool calls and `stop_details` stay reachable). Sample response from the
getting-started page:

```json
{
  "model": "claude-opus-5",
  "id": "msg_013mHbppMPd2PrVJzGMZPt2D",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "Here are some effective search strategies…" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "stop_details": null,
  "usage": { "input_tokens": 21, "output_tokens": 305 }
}
```

### `countTokens` — count the tokens of a prompt

`POST /v1/messages/count_tokens`: "Count the number of tokens in a Message,
including tools, images, and documents, without creating it." Idempotent.

| Input | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | string | no | `claude-sonnet-5` | As above |
| `messages` | string or json | yes | | As above |
| `system` | string | no | | As above |

Outputs: `inputTokens`, "The total number of tokens across the provided list
of messages, system prompt, and tools." Response `{ "input_tokens": 2095 }`.

Live sample: `{ "model": "claude-sonnet-5", "messages": "hello" }`.

### `listModels` — list the models the key can use

`GET /v1/models`, paged on `after_id`. Idempotent, no inputs.

Outputs: `models` (array of `{ id, display_name, created_at,
max_input_tokens, max_tokens, capabilities }`), `count`.

Live sample: `{}`.

### `getModel` — get a model

`GET /v1/models/{model_id}`: "determine information about a specific model
or resolve a model alias to a model ID". `model_id` is "Model identifier or
alias". Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `modelId` | string | yes | The model id or alias, URL-encoded into the path |

Outputs: `id`, `displayName`, `createdAt`, `maxInputTokens`, `maxTokens`,
`capabilities`, `raw`.

Live sample: `{ "modelId": "claude-sonnet-5" }`.

### `createMessageBatch` — create a message batch

`POST /v1/messages/batches` with `{ requests }`. **Not idempotent**: two
calls queue two batches.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `requests` | json | yes | An array of `{ "custom_id", "params" }`; `custom_id` matches `^[a-zA-Z0-9_-]{1,64}$` and "Must be unique within the batch", `params` is a full Messages request (`model`, `max_tokens`, `messages`, …). 1 to 100,000 per batch |

Outputs: `id`, `processingStatus`, `requestCounts`, `createdAt`,
`expiresAt`, `raw`. Sample response:

```json
{
  "id": "msgbatch_019z91jjjkactqvnbb1z9jk56a",
  "type": "message_batch",
  "processing_status": "in_progress",
  "request_counts": { "processing": 2, "succeeded": 0, "errored": 0, "canceled": 0, "expired": 0 },
  "created_at": "2024-01-15T12:00:00Z",
  "ended_at": null,
  "expires_at": "2024-01-16T12:00:00Z",
  "archived_at": null,
  "cancel_initiated_at": null,
  "results_url": null
}
```

### `getMessageBatch` — get a message batch

`GET /v1/messages/batches/{message_batch_id}`: "This endpoint is idempotent
and can be used to poll for Message Batch completion." Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `batchId` | string | yes | The batch id, `msgbatch_…` |

Outputs: `id`, `processingStatus`, `requestCounts`, `createdAt`, `endedAt`,
`expiresAt`, `resultsUrl`, `raw`.

Live sample: `{ "batchId": "$ANTHROPIC_BATCH_ID" }`, skipped when unset; mock
sample `{ "batchId": "msgbatch_placeholder" }`.

### `getBatchResults` — get the results of a message batch

`GET /v1/messages/batches/{message_batch_id}/results`: "Streams the results
of a Message Batch as a `.jsonl` file. Each line in the file is a JSON object
containing the result of a single request in the Message Batch. Results are
not guaranteed to be in the same order as requests. Use the `custom_id`
field to match results to requests." Idempotent. `results_url` is "Specified
only once processing ends", so before then the API's own error is thrown.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `batchId` | string | yes | The batch id |

Outputs: `results` (the lines parsed into an array of `{ custom_id, result }`
where `result.type` is `succeeded` with `result.message`, `errored` with
`result.error`, `canceled` or `expired`), `count`. An empty body parses to an
empty array.

Live sample: `{ "batchId": "$ANTHROPIC_BATCH_ID" }`, skipped when unset; mock
sample `{ "batchId": "msgbatch_placeholder" }`.

### `cancelMessageBatch` — cancel a message batch

`POST /v1/messages/batches/{message_batch_id}/cancel`: "Batches may be
canceled any time before processing ends. Once cancellation is initiated, the
batch enters a `canceling` state … Note that cancellation may not result in
any canceled requests if they were non-interruptible." **Not idempotent**:
it changes state, and a batch that has ended cannot be canceled.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `batchId` | string | yes | The batch id |

Outputs: `id`, `processingStatus`, `cancelInitiatedAt`, `requestCounts`,
`raw`.

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/anthropic/dist/index.js --mock --receipt packages/anthropic/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls: the client takes an injected `fetch`, and the retry tests
inject a clock.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `ANTHROPIC_API_KEY` is
unset; no key exists on this machine. With a key it calls `GET /v1/models`,
`GET /v1/models/claude-sonnet-5`, `POST /v1/messages/count_tokens` with
`"hello"`, `GET /v1/messages/batches?limit=5`, then, when
`ANTHROPIC_BATCH_ID` is set, the batch and its results, then
`vorn-connector check --live` when the package is built.

| Env | Required | Used by |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | every call |
| `ANTHROPIC_BATCH_ID` | no | `getMessageBatch`, `getBatchResults` |

Nothing is generated, queued or canceled: the live check touches only reads
and token counting, which bills nothing.

## Dependencies

None at runtime. `fetch` and `JSON` cover the client, the pager is a loop on
`after_id`, and JSONL is `split('\n')`. The official `@anthropic-ai/sdk`
wraps the same endpoints with its own retries and is not inlined.

## Icon

Anthropic's mark is a bare capital "A" with no crossbar, drawn as two heavy
slanted strokes of equal weight: the right leg is a full-height stroke
leaning left from apex to baseline, the left leg is a shorter stroke leaning
right that meets the right leg below the apex, leaving a small notch at the
top. A single-colour SVG carries it as two filled polygons in a 24-unit
viewBox: the right leg from (9, 3) to (15, 3) down to (22.5, 21) and back to
(16.5, 21); the left leg from (1.5, 21) to (7.5, 21) up to (12.5, 8.5) and
back to (9.5, 3.8), so its top edge sits under the right leg's apex. Fill
only, no strokes, `fill-rule: nonzero`.

## Docs

The only source. Every `docs.anthropic.com/en/api/…` link in the brief now
answers 301 to the same path under `platform.claude.com/docs/en/api/`.

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
