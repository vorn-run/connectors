id: openai

# OpenAI connector

OpenAI's REST API at `https://api.openai.com/v1`. Every request is JSON both
ways (`Content-Type: application/json`); reads are `GET` with a query string,
writes are `POST` with a JSON body. A list is
`{ object: "list", data: [...], first_id, last_id, has_more }` and every
object carries integer Unix-second timestamps (`created`, `created_at`,
`completed_at`). An error is
`{ error: { message, type, code, param } }`: `message` is prose, `type` a
broad category (`invalid_request_error`, `rate_limit_error`), `code` the
specific identifier (`invalid_api_key`, `credit_balance_exhausted`), `param`
the offending parameter or null. The connector throws
`<http status> <code>: <message>` on a non-2xx answer, with `type` in place
of `code` when the body has no code.

Package: `@vornrun/connector-openai` in `packages/openai`, shaped exactly like
the existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category
`AI` (a new category; none of the existing eleven fit), `packs: true`.

## Auth

Rung: **key**. There is no CLI developers already sign in to for this API;
the connection takes an API key.

| Config field | Env name | Secret | Where it comes from |
| --- | --- | --- | --- |
| `apiKey` | `OPENAI_API_KEY` | yes | https://platform.openai.com/api-keys (the reference links it as https://platform.openai.com/settings/organization/api-keys): **Create new secret key**, copied once |
| `organization` | `OPENAI_ORGANIZATION` | no | Organization id (`org-…`), from **Settings → Organization → General** |
| `project` | `OPENAI_PROJECT` | no | Project id (`proj_…`), from **Settings → Project → General** |

Headers, exactly as the reference shows them:

- `Authorization: Bearer <key>` on every request.
- `OpenAI-Organization: <organization>` and `OpenAI-Project: <project>`,
  each only when the field is set. The docs: they are needed when you
  "belong to more than one organization or access projects through a legacy
  user API key". A project key (`sk-proj-…`) is already scoped to one
  project, so both stay empty in the common case.

What the docs say, and what follows from it:

- Standard API keys serve the application endpoints; an Admin key
  (`settings/organization/admin-keys`) serves only the Administration API
  and is not this connection. There are no scopes on a standard key: a key's
  permissions are set per key at creation (all, restricted per endpoint, or
  read-only), and a key that lacks an endpoint answers 401
  `insufficient permissions` prose under `invalid_authentication`. The
  connector surfaces the message verbatim.
- 401 `invalid_api_key`: "typo, extra space, deleted key". The connector
  trims the pasted value; "revocations of an API key take effect within a
  few seconds".
- 403 is geography ("unsupported country, region, or territory"), not
  credentials; the connector reports it as-is and never retries.
- "Don't share it with others or expose it in any client-side code"; the
  connector reads it from config or `OPENAI_API_KEY` only.

Preflight is `GET /models`, the cheapest authenticated read: it costs no
tokens, honours the organization and project headers, and a wrong key fails
it with the 401 above.

## Rate limits and retries

Limits are per organization and project, per model, in requests per minute
and tokens per minute. Every response carries:

| Header | Meaning (quoted) |
| --- | --- |
| `x-ratelimit-limit-requests` | "The maximum number of requests that are permitted before exhausting the rate limit." |
| `x-ratelimit-remaining-requests` | "The remaining number of requests that are permitted before exhausting the rate limit." |
| `x-ratelimit-reset-requests` | "The time until the rate limit (based on requests) resets to its initial state." (a duration such as `1s` or `6m0s`) |
| `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens` | the same for tokens |
| `Retry-After` | "The minimum number of seconds to wait before retrying a temporary rate-limit error, when present." |

The guide: "Wait at least that long and add a small random delay so multiple
clients don't retry at the same time"; "unsuccessful requests contribute to
your per-minute limit, so continuously resending a request won't work"; and
"don't retry quota, billing, or other errors that require you to take
action."

The connector's policy, per the connector spec:

- On `429` with `code` `rate_limit_error`, `slow_down`, or no code: wait
  `Retry-After` seconds when present, else parse
  `x-ratelimit-reset-requests`, else 2 seconds, plus up to 500 ms of jitter,
  and retry **once**.
- On `429` with `credit_balance_exhausted`,
  `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` or
  `organization_usage_limit_exceeded`: throw immediately with the message;
  these need a person.
- On `500`, `502`, `503`, `504` (503 carries `server_is_overloaded`): wait
  `Retry-After` or 1 second plus jitter and retry **once**.
- When `x-ratelimit-remaining-requests` is `0` on a successful answer, the
  client records `x-ratelimit-reset-requests` and sleeps that long (capped
  at 10 s) before its next call in the same process, so a poll that pages
  does not walk into the 429 it can see coming.
- Every thrown error carries `error.message` and `error.code`, plus the
  `x-request-id` response header for support.

## Pagination

`GET /batches`, `GET /files` and `GET /fine_tuning/jobs` take `after`
(the id of the last object on the previous page) and `limit`, and answer
`has_more`. Batches: `limit` 1 to 100, default 20. Fine-tuning jobs: `limit`
default 20. Files: `limit` 1 to 10,000, default 10,000, plus `order`
(`asc` or `desc` on `created_at`, default `desc`) and `purpose`. Batches and
fine-tuning jobs have no `order` and come newest first. Every poll walks at
most 5 pages with `after = last_id` while `has_more` and the page still
holds an item newer than the cursor, then reverses so the workflow sees the
oldest first.

## Triggers

All poll. Items carry Unix seconds converted to ISO strings in `updatedAt`
and the raw object in `data`. Dashboard URLs are the platform's pages:
`https://platform.openai.com/batches/<id>`,
`https://platform.openai.com/storage/files/<id>`,
`https://platform.openai.com/finetune/<id>`.

### `batchFinished` — a batch reached a terminal status

- **Poll:** `GET /batches?limit=100`, then keep
  `status ∈ {completed, failed, expired, cancelled}`. Status values from
  the object: `validating`, `failed`, `in_progress`, `finalizing`,
  `completed`, `expired`, `cancelling`, `cancelled`. The list has no status
  filter, so the filter is client-side.
- **Cursor:** the largest `created_at` seen across all batches on the page,
  minus `lookbackHours` (config, default 48) as the lower bound: a batch
  finishes up to 24 hours (`completion_window`) after creation and expires
  later still, so the poll keeps reading batches created inside the window
  and stops paging once a page ends below it. With no cursor yet the first
  poll starts 7 days back. The terminal timestamp for `updatedAt` is
  `completed_at ?? failed_at ?? expired_at ?? cancelled_at ?? created_at`.
- **Dedupe key:** `${id}:${status}`, per the connector spec, so a batch fires
  exactly once when it lands in one terminal state.
- **Config:** `lookbackHours` (number, optional, default 48), `endpoint`
  (string, optional; keep only batches whose `endpoint` matches, such as
  `/v1/chat/completions`).
- **Sample item** (`data` is the batch object as returned):

```json
{
  "externalId": "batch_abc123:completed",
  "title": "Batch batch_abc123 completed: 95 of 100 requests, 5 failed",
  "url": "https://platform.openai.com/batches/batch_abc123",
  "status": "completed",
  "updatedAt": "2024-03-26T23:26:03.000Z",
  "data": {
    "id": "batch_abc123",
    "object": "batch",
    "endpoint": "/v1/chat/completions",
    "errors": null,
    "input_file_id": "file-abc123",
    "completion_window": "24h",
    "status": "completed",
    "output_file_id": "file-cvaTdG",
    "error_file_id": "file-HOWS94",
    "created_at": 1711471533,
    "in_progress_at": 1711471538,
    "expires_at": 1711557933,
    "finalizing_at": 1711493133,
    "completed_at": 1711493163,
    "failed_at": null,
    "expired_at": null,
    "cancelling_at": null,
    "cancelled_at": null,
    "request_counts": { "total": 100, "completed": 95, "failed": 5 },
    "metadata": { "customer_id": "user_123456789", "batch_description": "Nightly job" }
  }
}
```

### `fileUploaded` — a file was uploaded

- **Poll:** `GET /files?order=desc&limit=100[&purpose=<purpose>]`, newest
  first by `created_at`.
- **Cursor:** the largest `created_at` seen, compared with `>=` because the
  resolution is one second; dedupe absorbs the repeat. With no cursor the
  first poll starts one hour back. Paging stops at the first file older
  than the cursor.
- **Dedupe key:** `id` (`file-…`).
- **Config:** `purpose` (string, optional; one of `assistants`,
  `assistants_output`, `batch`, `batch_output`, `fine-tune`,
  `fine-tune-results`, `vision`, `user_data`, passed through as the
  `purpose` filter). `status` on the object is deprecated and ignored.
- **Sample item:**

```json
{
  "externalId": "file-abc123",
  "title": "salesOverview.pdf (assistants, 175 bytes)",
  "url": "https://platform.openai.com/storage/files/file-abc123",
  "updatedAt": "2021-02-18T20:23:05.000Z",
  "data": {
    "id": "file-abc123",
    "object": "file",
    "bytes": 175,
    "created_at": 1613677385,
    "expires_at": 1677614202,
    "filename": "salesOverview.pdf",
    "purpose": "assistants"
  }
}
```

### `fineTuningJobFinished` — a fine-tuning job reached a terminal status

- **Poll:** `GET /fine_tuning/jobs?limit=100`, then keep
  `status ∈ {succeeded, failed, cancelled}`. Status values:
  `validating_files`, `queued`, `running`, `succeeded`, `failed`,
  `cancelled`. No status filter on the list, so client-side.
- **Cursor:** the largest `finished_at` seen among terminal jobs. Jobs are
  created long before they finish, so the lower bound on `created_at` for
  paging is the cursor minus `lookbackHours` (config, default 168, a week),
  and a job is emitted only when `finished_at >= cursor`. `updatedAt` is
  `finished_at`, falling back to `created_at` when the API leaves it null on
  a cancelled job.
- **Dedupe key:** `${id}:${status}`, per the connector spec.
- **Config:** `lookbackHours` (number, optional, default 168).
- **Sample item** (the list example shows a queued job; the fields below are
  the same object once succeeded):

```json
{
  "externalId": "ftjob-abc123:succeeded",
  "title": "Fine-tuning job ftjob-abc123 succeeded: ft:gpt-4o-mini-2024-07-18:org::abc123",
  "url": "https://platform.openai.com/finetune/ftjob-abc123",
  "status": "succeeded",
  "updatedAt": "2024-07-24T20:00:00.000Z",
  "data": {
    "object": "fine_tuning.job",
    "id": "ftjob-abc123",
    "model": "gpt-4o-mini-2024-07-18",
    "created_at": 1721764800,
    "finished_at": 1721851200,
    "fine_tuned_model": "ft:gpt-4o-mini-2024-07-18:org::abc123",
    "organization_id": "org-123",
    "result_files": ["file-results123"],
    "status": "succeeded",
    "validation_file": null,
    "training_file": "file-abc123",
    "trained_tokens": 5768,
    "error": null,
    "metadata": { "key": "value" }
  }
}
```

A failed job carries `error: { code, message, param }`; the title then reads
`… failed: <error.message>`.

## Actions

Every action sends the auth headers above, throws on a non-2xx answer as
described, and retries as described. Inputs that the host passes as strings
but the API wants as JSON (`input`, `messages`, `schema`, `response_format`,
`metadata`) are parsed by the action; a value that is not valid JSON and not
meant to be plain text is refused before any call.

### `createResponse` — create a model response

`POST /responses`. Not idempotent: every call spends tokens and, with
`store` defaulting to true ("Defaults to true when omitted ... stored for at
least 30 days"), creates a stored response. The connector sends
`store: false` unless `store` is set, so a workflow step leaves nothing
behind by default.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | Model id such as `gpt-4o-mini` |
| `input` | string | yes | Plain text, or a JSON array of message items `{ role, content }` with `role` one of `user`, `assistant`, `system`, `developer`; a value that parses as a JSON array is sent as the array, anything else as text |
| `instructions` | string | no | "System (or developer) message inserted into the model's context" |
| `temperature` | number | no | 0 to 2; "we generally recommend altering this or top_p but not both" |
| `maxOutputTokens` | number | no | `max_output_tokens`, "an upper bound for the number of tokens that can be generated for a response, including visible output tokens and reasoning tokens", minimum 16 |
| `schema` | string | no | A JSON Schema object; sent as `text.format = { type: "json_schema", name, schema, strict: true }` for Structured Outputs |
| `schemaName` | string | no | The format `name`, "a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64", default `output` |
| `store` | boolean | no | Store the response for retrieval; default false here |

Outputs: `id`, `status` (`completed`, `incomplete`, `failed`, `in_progress`),
`text` (the `text` of every `output_text` content part in every `message`
output item, joined; the SDK-only `output_text` field is not in the HTTP
body, so the connector aggregates it), `json` (the parsed text when
`schema` was given), `model`, `usage` (`input_tokens`, `output_tokens`,
`total_tokens`, `reasoning_tokens` from `output_tokens_details`),
`incompleteReason` (`incomplete_details.reason`: `max_output_tokens`,
`content_filter`, …), `response` (the raw object).

### `createChatCompletion` — create a chat completion

`POST /chat/completions`. Not idempotent (spends tokens).

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | Model id |
| `messages` | string | yes | JSON array of `{ role, content }`; `role` one of `system`, `developer`, `user`, `assistant`, `tool` |
| `temperature` | number | no | 0 to 2 |
| `maxTokens` | number | no | Sent as `max_completion_tokens`, "an upper bound for the number of tokens that can be generated for a completion, including visible output tokens and reasoning tokens"; `max_tokens` "is now deprecated in favor of max_completion_tokens, and is not compatible with o-series models" |
| `responseFormat` | string | no | JSON: `{ "type": "text" }` (default), `{ "type": "json_object" }`, or `{ "type": "json_schema", "json_schema": { name, schema, strict } }` |

Outputs: `id`, `text` (`choices[0].message.content`), `finishReason`
(`stop`, `length`, `tool_calls`, `content_filter`, `function_call`),
`refusal` (`choices[0].message.refusal`), `model`, `usage` (`prompt_tokens`,
`completion_tokens`, `total_tokens`), `completion` (the raw object).

### `createEmbeddings` — create embeddings

`POST /embeddings`. Idempotent for a live check: the same input yields the
same vector, and nothing is stored.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | `text-embedding-3-small`, `text-embedding-3-large` or `text-embedding-ada-002` |
| `input` | string | yes | Plain text or a JSON array of strings; "must not exceed the max input tokens for the model (8192 tokens for all embedding models)" and "any array must be 2048 dimensions or less" |
| `dimensions` | number | no | "The number of dimensions the resulting output embeddings should have. Only supported in text-embedding-3 and later models." |

Outputs: `embeddings` (array of number arrays, in `index` order),
`dimensions` (length of the first), `model`, `usage` (`prompt_tokens`,
`total_tokens`). `encoding_format` stays at its `float` default.

Live sample: `{ "model": "text-embedding-3-small", "input": "hello" }`.

### `moderateText` — classify text against OpenAI's usage policies

`POST /moderations`. Idempotent, free of charge, nothing stored.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | string | yes | Plain text or a JSON array of strings |
| `model` | string | no | `omni-moderation-latest` (the default), `omni-moderation-2024-09-26`, `text-moderation-latest`, `text-moderation-stable` |

Outputs: `flagged` (true when any result is flagged), `results` (array of
`{ flagged, categories, category_scores, category_applied_input_types }` as
returned), `model`, `id`.

Live sample: `{ "input": "hello" }`.

### `listModels` — list models

`GET /models`. Idempotent, no inputs. "Lists the currently available models,
and provides basic information about each one such as the owner and
availability."

Outputs: `models` (array of `{ id, created (ISO), ownedBy, shutdownDate }`),
`count`.

Live sample: `{}`.

### `getModel` — retrieve a model

`GET /models/{model}`. Idempotent. An unknown id answers 404
`model_not_found`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | Model id such as `gpt-4o-mini` |

Outputs: `id`, `created` (ISO), `ownedBy`, `shutdownDate` (or null).

Live sample: `{ "model": "gpt-4o-mini" }`.

### `listFiles` — list files

`GET /files`. Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `purpose` | string | no | Filter on purpose |
| `limit` | number | no | 1 to 10,000, sent as `limit`; the connector defaults to 100 |
| `order` | string | no | `asc` or `desc` on `created_at`, default `desc` |
| `after` | string | no | A file id from an earlier page |

Outputs: `files` (array of `{ id, filename, bytes, purpose, createdAt,
expiresAt }`), `hasMore`, `lastId`.

Live sample: `{ "limit": 5 }`.

### `getBatch` — retrieve a batch

`GET /batches/{batch_id}`. Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `batch` | string | yes | Batch id such as `batch_abc123` |

Outputs: `id`, `status`, `endpoint`, `inputFileId`, `outputFileId`,
`errorFileId`, `requestCounts` (`{ total, completed, failed }`),
`createdAt`, `completedAt`, `failedAt`, `expiredAt`, `cancelledAt` (ISO or
null), `errors`, `metadata`, `batch` (raw).

Live sample: `{ "batch": "$OPENAI_BATCH_ID" }`, a placeholder the live check
fills from the environment and skips when unset.

### `createBatch` — create a batch

`POST /batches`. Not idempotent: each call queues a new batch that runs and
bills.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `inputFileId` | string | yes | `input_file_id`, "the ID of an uploaded file that contains requests for the new batch", uploaded with purpose `batch` |
| `endpoint` | string | yes | One of `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/completions`, `/v1/moderations`, `/v1/images/generations`, `/v1/images/edits`, `/v1/videos` |
| `completionWindow` | string | no | `completion_window`; "currently only 24h is supported", default `24h` |
| `metadata` | string | no | JSON object, "up to 16 key-value pairs", keys at most 64 characters, values at most 512 |

Outputs: as `getBatch`.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/openai/dist/index.js --mock --receipt packages/openai/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls: the client takes an injected `fetch`, and the retry tests use
fake timers.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `OPENAI_API_KEY` is unset.
With a key it calls `GET /models`, `GET /models/gpt-4o-mini`,
`GET /files?limit=5`, `POST /moderations` with `hello`, `POST /embeddings`
with `text-embedding-3-small` and `hello`, `GET /batches/$OPENAI_BATCH_ID`
when that is set, then `vorn-connector check --live`.

| Env | Required | Used by |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | every call |
| `OPENAI_ORGANIZATION` | no | `OpenAI-Organization` header when set |
| `OPENAI_PROJECT` | no | `OpenAI-Project` header when set |
| `OPENAI_BATCH_ID` | no | `getBatch`; skipped when unset |

No response, chat completion or batch is created: the live check touches
only idempotent endpoints, and the two paid ones (embeddings) cost a few
tokens of `text-embedding-3-small`. No key exists on this machine.

## Dependencies

None at runtime. `fetch`, `URL`, `URLSearchParams` and `setTimeout` cover
the client, pagination and the retry waits. The official `openai` npm package
is a full SDK of every resource with streaming and file upload machinery and
is not inlined.

## Icon

OpenAI's mark is a hexagonal knot: six identical elongated loops, each a
rounded rectangle outline, rotated 60 degrees apart around the centre and
interlaced so their ends overlap the neighbours' sides, leaving a small
hexagonal counter in the middle. It is drawn in one colour (black or white)
with no background. A single-colour SVG carries it in a 24-unit viewBox as
one filled path with even-odd holes: each loop is a stadium about 12 units
long and 4.5 units wide with a stroke about 1.6 units thick, its inner end
at radius 2 from the centre and its outer end at radius 12, pointing at 30,
90, 150, 210, 270 and 330 degrees, so the outer contour touches the box on
all sides and the central hexagon spans roughly 4 units. Fill only,
`fill-rule: evenodd`, one path.

## Docs

The only source. The `platform.openai.com/docs` links in the brief now
answer 403 to non-browser clients or redirect; each row gives the address
that serves the same page.

- Introduction: https://platform.openai.com/docs/api-reference/introduction → https://developers.openai.com/api/reference/overview
- Authentication: https://platform.openai.com/docs/api-reference/authentication → https://developers.openai.com/api/reference/overview
- API keys: https://platform.openai.com/api-keys (https://platform.openai.com/settings/organization/api-keys)
- Responses: https://platform.openai.com/docs/api-reference/responses → https://developers.openai.com/api/reference/resources/responses (create: https://developers.openai.com/api/reference/resources/responses/methods/create)
- Chat: https://platform.openai.com/docs/api-reference/chat → https://developers.openai.com/api/reference/resources/chat
- Embeddings: https://platform.openai.com/docs/api-reference/embeddings → https://developers.openai.com/api/reference/resources/embeddings
- Moderations: https://platform.openai.com/docs/api-reference/moderations → https://developers.openai.com/api/reference/resources/moderations
- Models: https://platform.openai.com/docs/api-reference/models → https://developers.openai.com/api/reference/resources/models
- Files: https://platform.openai.com/docs/api-reference/files → https://developers.openai.com/api/reference/resources/files
- Batch: https://platform.openai.com/docs/api-reference/batch → https://developers.openai.com/api/reference/resources/batches
- Fine-tuning: https://platform.openai.com/docs/api-reference/fine-tuning → https://developers.openai.com/api/reference/resources/fine_tuning (jobs list: https://developers.openai.com/api/reference/resources/fine_tuning/subresources/jobs/methods/list)
- Rate limits: https://platform.openai.com/docs/guides/rate-limits → https://developers.openai.com/api/docs/guides/rate-limits
- Error codes: https://platform.openai.com/docs/guides/error-codes → https://developers.openai.com/api/docs/guides/error-codes
