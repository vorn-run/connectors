# @vornrun/connector-openai

Trigger Vorn workflows when an OpenAI batch or fine-tuning job finishes or a
file is uploaded, and create responses, chat completions, embeddings,
moderations and batches, or read models, files and batches, from a workflow
step. Talks to the REST API at `https://api.openai.com/v1`.

## Signing in

There is no OpenAI CLI to borrow a login from: the connection takes an API key.

1. Open https://platform.openai.com/api-keys (the reference links it as
   https://platform.openai.com/settings/organization/api-keys).
2. Press **Create new secret key** and copy the key it shows once. A project
   key (`sk-proj-…`) is already scoped to one project; a key's permissions are
   set when it is created (all, restricted per endpoint, or read-only).
3. Paste it into the **API key** field (`OPENAI_API_KEY`). Whitespace is
   trimmed; the connector sends it as `Authorization: Bearer <key>`.

An Admin key serves only the Administration API and is not this connection. A
wrong, revoked or mistyped key answers `401 invalid_api_key`; a key that lacks
an endpoint answers `401` with `insufficient permissions` in the message, which
the connector surfaces verbatim. A `403` is geography, not credentials, and is
never retried.

The **Organization** and **Project** fields are for a legacy user key that
belongs to more than one organization or should bill one project; they are
sent as `OpenAI-Organization` and `OpenAI-Project` only when set.

## Settings

| Field | Env | Required | What it does |
| --- | --- | --- | --- |
| `apiKey` | `OPENAI_API_KEY` | yes | The key, sent as a Bearer token. |
| `organization` | `OPENAI_ORGANIZATION` | no | `org-…`, sent as `OpenAI-Organization`. |
| `project` | `OPENAI_PROJECT` | no | `proj_…`, sent as `OpenAI-Project`. |
| `batchEndpoint` | `OPENAI_BATCH_ENDPOINT` | no | Only batches for this endpoint, such as `/v1/chat/completions`. |
| `batchLookbackHours` | `OPENAI_BATCH_LOOKBACK_HOURS` | no | How far before the watermark the batch poll reads. Default 48. |
| `filePurpose` | `OPENAI_FILE_PURPOSE` | no | Only files with this `purpose`, passed to the API. |
| `fineTuningLookbackHours` | `OPENAI_FINE_TUNING_LOOKBACK_HOURS` | no | How far before the watermark the fine-tuning poll reads. Default 168. |

Preflight is `GET /models`, the cheapest authenticated read: it costs no
tokens and a wrong key fails it.

## Triggers

All three poll. Each walks `after` up to five pages of 100 per poll, newest
first as the API returns them, and delivers oldest first. Every item's `data`
is the object exactly as returned, with Unix seconds; `updatedAt` is the same
instant as ISO 8601.

**A batch finishes** (`batchFinished`) reads `GET /batches` and keeps the ones
whose `status` is `completed`, `failed`, `expired` or `cancelled`; the list has
no status filter, so the filter is client-side. Items are keyed
`<id>:<status>` and stamped with `completed_at`, `failed_at`, `expired_at` or
`cancelled_at`, so a batch fires exactly once when it lands in one terminal
state. A batch finishes up to 24 hours after creation and expires later still,
so paging reads batches created up to `batchLookbackHours` before the
watermark and stops once a page ends below that. The first poll looks a week
back. `batchEndpoint` keeps only batches for one endpoint. The title reads
`Batch <id> completed: 95 of 100 requests, 5 failed`; the URL is the platform's
batch page.

**A file is uploaded** (`fileUploaded`) reads
`GET /files?order=desc&limit=100`, plus `purpose` when `filePurpose` is set,
and watermarks on `created_at`. The comparison is `>=` because the resolution
is one second; the SDK recognises the file on the boundary by id. The first
poll looks an hour back. The title is `<filename> (<purpose>, <bytes> bytes)`.

**A fine-tuning job finishes** (`fineTuningJobFinished`) reads
`GET /fine_tuning/jobs` and keeps `succeeded`, `failed` and `cancelled`
jobs. Items are keyed `<id>:<status>` and stamped with `finished_at`, falling
back to `created_at` when the API leaves it null on a cancelled job. A job is
created long before it finishes, so paging on `created_at` reaches
`fineTuningLookbackHours` further back than the watermark, and a job is
delivered when `finished_at` is at or after it. The first poll looks the same
week back. A failed job's title carries `error.message`.

Status suggestions: `completed` and `succeeded` → done; `failed` → todo;
`expired` and `cancelled` → cancelled.

## Actions

| Action | Idempotent | Notes |
| --- | --- | --- |
| Create a response | no | `POST /responses`. `model`, `input` (text or a JSON array of `{ role, content }`), optional `instructions`, `temperature`, `maxOutputTokens`, a JSON `schema` for Structured Outputs with `schemaName`, and `store`. Sends `store: false` unless asked. Returns `id`, `status`, `text`, `json`, `model`, `usage`, `incompleteReason`, `response`. |
| Create a chat completion | no | `POST /chat/completions`. `model`, `messages` (JSON), optional `temperature`, `maxTokens` (sent as `max_completion_tokens`), `responseFormat` (JSON). Returns `id`, `text`, `finishReason`, `refusal`, `model`, `usage`, `completion`. |
| Create embeddings | yes | `POST /embeddings`. `model`, `input` (text or a JSON array of strings), optional `dimensions`. Returns `embeddings` in input order, `dimensions`, `model`, `usage`. Live sample: `text-embedding-3-small`, `hello`. |
| Moderate text | yes | `POST /moderations`. `input`, optional `model`. Returns `flagged`, `results`, `model`, `id`. Free. Live sample: `hello`. |
| List models | yes | `GET /models`. Returns `models` as `{ id, created, ownedBy, shutdownDate }` and `count`. |
| Get a model | yes | `GET /models/{model}`. An unknown id answers `404 model_not_found`. Live sample: `gpt-4o-mini`. |
| List files | yes | `GET /files`. Optional `purpose`, `limit` (default 100), `order`, `after`. Returns `files`, `hasMore`, `lastId`. Live sample: `limit` 5. |
| Get a batch | yes | `GET /batches/{id}`. Returns the batch flattened with ISO times plus the raw `batch`. Live sample: `$OPENAI_BATCH_ID`, read from the environment and refused as missing when unset. |
| Create a batch | no | `POST /batches`. `inputFileId`, `endpoint`, optional `completionWindow` (only `24h`) and `metadata` (JSON). Returns as Get a batch. |

Inputs the host passes as strings but the API wants as JSON are parsed:
`messages`, `schema`, `responseFormat` and `metadata` must be JSON, and
`input` is sent as an array when it parses as one and as text otherwise. A
response's `text` is every `output_text` part of every message item joined,
because the HTTP body has no `output_text` field. Every output converts the
API's Unix seconds to ISO 8601.

Every action is hand-written against one client rather than declared as an SDK
request, because the retry policy, the error shape and the JSON-or-text inputs
below cannot be said in a header template or a `postReceive`.

## Rate limits and errors

Limits are per organization and project, per model, in requests and tokens
per minute. The client reads `x-ratelimit-remaining-requests`,
`x-ratelimit-reset-requests` and `Retry-After` from every answer:

- A `429` whose code is `rate_limit_exceeded`, `slow_down`, missing or
  otherwise a plain rate limit is retried **once** after `Retry-After` seconds
  when present, else the `x-ratelimit-reset-requests` duration, else two
  seconds, plus up to 500 ms of jitter.
- A `429` naming `insufficient_quota`, `credit_balance_exhausted`,
  `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` or any
  other code is thrown at once: those need a person.
- `500`, `502`, `503` and `504` are retried **once** after `Retry-After` or
  one second plus jitter.
- When a successful answer says no requests remain, the next call in the same
  process sleeps out `x-ratelimit-reset-requests` first, capped at ten
  seconds, so a poll that pages does not walk into the `429` it can see
  coming.

The SDK's own fetch sits beneath the client and adds its retries for reads.
A failure is thrown as `<status> <code>: <message>`, with the error `type` in
place of `code` when the body names none, and the `x-request-id` appended for
support; the thrown error also carries `status`, `code`, `type`, `param` and
`requestId`.

## What this connector cannot do

- **No webhooks.** It polls. The default seeded workflows run every 5 minutes
  (15 for fine-tuning jobs).
- **No uploads.** `createBatch` takes the id of a file already uploaded with
  purpose `batch`.
- **No streaming, tools or images.** `createResponse` and
  `createChatCompletion` send one request and return the text.
- **A backlog over 500 objects in one poll** is cut at five pages, newest
  first, and the rest is not asked for again.

## Checks

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/openai/dist/index.js --mock --receipt packages/openai/verified.json
```

`scripts/check.sh` in this package runs exactly this from the repository root.
`scripts/check-live.sh` calls `GET /models`, `GET /models/gpt-4o-mini`,
`GET /files?limit=5`, `POST /moderations` and `POST /embeddings` with `hello`,
`GET /batches/$OPENAI_BATCH_ID` when that is set, then
`vorn-connector check --live`, and exits 0 with a note when `OPENAI_API_KEY`
is unset. Nothing is created by either; the embeddings call costs a few tokens
of `text-embedding-3-small`. Tests make no network calls.

## Built from

- [API reference](https://platform.openai.com/docs/api-reference/introduction)
- [Authentication](https://platform.openai.com/docs/api-reference/authentication)
- [API keys](https://platform.openai.com/api-keys)
- [Responses](https://platform.openai.com/docs/api-reference/responses)
- [Chat](https://platform.openai.com/docs/api-reference/chat)
- [Embeddings](https://platform.openai.com/docs/api-reference/embeddings)
- [Moderations](https://platform.openai.com/docs/api-reference/moderations)
- [Models](https://platform.openai.com/docs/api-reference/models)
- [Files](https://platform.openai.com/docs/api-reference/files)
- [Batch](https://platform.openai.com/docs/api-reference/batch)
- [Fine-tuning](https://platform.openai.com/docs/api-reference/fine-tuning)
- [Rate limits](https://platform.openai.com/docs/guides/rate-limits)
- [Error codes](https://platform.openai.com/docs/guides/error-codes)
