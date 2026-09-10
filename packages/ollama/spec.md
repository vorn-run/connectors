id: ollama

# Ollama connector

Ollama is the local model server. "After installation, Ollama's API is
served by default at: `http://localhost:11434/api`", and "For running cloud
models on ollama.com, the same API is available with the following base URL:
`https://ollama.com/api`". "Ollama's API isn't strictly versioned, but the
API is expected to be stable and backwards compatible." Every request is JSON
and every answer is JSON. "Certain endpoints stream responses as JSON
objects. Streaming can be disabled by providing `{"stream": false}` for these
endpoints"; the connector always sends `stream: false` on generate, chat and
pull, so an answer is one JSON object and never a stream of lines.
"All durations are returned in nanoseconds." Model names "follow a
`model:tag` format … The tag is optional and, if not provided, will default
to `latest`".

Errors: the body is `{ "error": "<message>" }` with a non-2xx status. The
connector throws `<message> (HTTP <status>)`. A model that is not present
answers `404` with `model '<name>' not found` (observed on 0.33.3 for
`/api/show`, `/api/chat` and `/api/delete`; the copy and delete pages say
"404 Not Found if the source model doesn't exist" and "404 Not Found if the
model to be deleted doesn't exist"). The connector reports it as
`Model '<name>' is not present on the server; pull it first (HTTP 404)` and
never pulls on the caller's behalf. The FAQ says "If too many requests are
sent to the server, it will respond with a 503 error indicating the server is
overloaded"; a 503 is thrown as is. A body that is not JSON is thrown as its
text with the status.

Package: `@vornrun/connector-ollama` in `packages/ollama`, shaped like the
existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category `AI` as
the openai and anthropic packages use, `packs: true`.

## Auth

Rung: **`none`**. The API takes no credentials: every endpoint in the
reference declares `security: []`, and the server "binds 127.0.0.1 port
11434 by default". There is an `ollama` CLI (`ollama signin`, `ollama.com/settings/keys`)
but it holds an ed25519 key pair for pushing and pulling models, not a token
the HTTP API expects, so there is no `cli` rung to borrow from.

| Config field | Env name | Secret | Default | What it is |
| --- | --- | --- | --- | --- |
| `baseUrl` | `OLLAMA_HOST` | no | `http://localhost:11434` | The server origin. A trailing `/` or `/api` is stripped, so `http://localhost:11434/api` and `http://localhost:11434/` both work. The FAQ's `OLLAMA_HOST` values are `host:port` without a scheme (`0.0.0.0:11434`), so a value with no scheme gets `http://` prefixed. |

Optional API key: the cloud page says "For direct access to ollama.com's
API, first create an API key. Then, set the `OLLAMA_API_KEY` environment
variable" and its examples send `Authorization: Bearer <key>`. The brief asks
for a secret `apiKey` config field, but `@vornrun/connector-sdk`
0.7.0-beta.14 throws "claims it needs no sign-in but declares secret field"
for rung `none` with any secret field, and a non-secret field named `apiKey`
trips its `secret-not-marked` warning and spoils the receipt. So the
connector declares only `baseUrl`, reads `OLLAMA_API_KEY` from the process
environment, and sends `Authorization: Bearer <key>` only when it is set.
README and CHANGELOG say so, and say a host that does not pass its
environment through cannot supply the key. Declare `auth: { rung: 'none' }`.

## Timeouts, retries and rate limits

No rate limits exist; the server queues requests ("`OLLAMA_MAX_QUEUE` - The
maximum number of requests Ollama will queue when busy before rejecting
additional requests. The default is 512"). Chat and generate "can take
minutes on a laptop": their request timeout is 10 minutes; every other call
gets 30 seconds. Pull also downloads for minutes, so it takes the 10 minute
timeout too. A connection refused (`ECONNREFUSED`, or `fetch failed` whose
cause is one) is retried once after 2 seconds, and the error thrown after the
second failure says `Ollama did not answer at <baseUrl>; the server may be
starting or not running`. Nothing else is retried. Every duration in a reply
is nanoseconds and is passed through untouched.

## Triggers

Both poll, both `dedupe: 'timestamp'`, no config beyond the connection.
Neither endpoint pages: `/api/tags` and `/api/ps` return the whole list.

### `modelChanged` — a model was added or updated

- **Poll:** `GET /api/tags`, "Fetch a list of models and their details".
  Each model is `{ name, model, modified_at, size, digest, details:
  { parent_model, format, family, families, parameter_size,
  quantization_level }, remote_model?, remote_host? }`; `modified_at` is
  "Last modified timestamp in ISO 8601 format", `digest` the "SHA256 digest
  of the model". A pull that updates a tag changes `digest` and
  `modified_at`; a copy creates a new `name` with the same `digest`.
- **Dedupe key:** `<name>@<digest>` as `externalId`, with `updatedAt =
  modified_at`, so a model fires again when its digest changes and never
  fires twice for the same build.
- **Cursor:** the newest `modified_at` seen. With no cursor the first poll
  emits every model present, which is the documented "model was added" set
  for a fresh connection; the list is short (local disk).
- **Sample item:**

```json
{
  "externalId": "qwen2.5-coder:7b@dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364",
  "title": "qwen2.5-coder:7b (qwen2, 7.6B)",
  "url": "https://ollama.com/library/qwen2.5-coder",
  "updatedAt": "2026-08-02T16:07:41.209152383-06:00",
  "data": {
    "name": "qwen2.5-coder:7b",
    "digest": "dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364",
    "size": 4683087561,
    "modified_at": "2026-08-02T16:07:41.209152383-06:00",
    "family": "qwen2",
    "parameter_size": "7.6B",
    "details": { "parent_model": "", "format": "gguf", "family": "qwen2", "families": ["qwen2"], "parameter_size": "7.6B", "quantization_level": "Q4_K_M" }
  }
}
```

The `url` is `https://ollama.com/library/<name without tag>` only when the
name has no namespace (`user/model` names are not in the library) and the
model carries no `remote_host`; otherwise the item has no `url`.

### `modelLoaded` — a model was loaded into memory

- **Poll:** `GET /api/ps`, "Retrieve a list of models that are currently
  running". Each entry is `{ name, model, size, digest, details, expires_at,
  size_vram, context_length }`; `expires_at` is "Time when the model will be
  unloaded" and moves forward on every request the model serves, so the same
  load looks new after each use.
- **Dedupe key:** `<name>@<expires_at>` as `externalId`, with `updatedAt =
  expires_at`, as the brief asks: an item fires when a model appears with an
  expiry not yet seen. Each request that extends the expiry is a new item;
  the README says so and suggests a slower poll interval.
- **Cursor:** the newest `expires_at` seen. No cursor means every running
  model is emitted on the first poll.
- **Sample item:**

```json
{
  "externalId": "qwen2.5-coder:7b@2026-09-10T07:31:16.885215-06:00",
  "title": "qwen2.5-coder:7b loaded (4.7 GB in VRAM, context 4096)",
  "updatedAt": "2026-09-10T07:31:16.885215-06:00",
  "data": {
    "name": "qwen2.5-coder:7b",
    "digest": "dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364",
    "size": 4740716952,
    "size_vram": 4740716952,
    "expires_at": "2026-09-10T07:31:16.885215-06:00",
    "context_length": 4096,
    "details": { "parent_model": "", "format": "gguf", "family": "qwen2", "families": ["qwen2"], "parameter_size": "7.6B", "quantization_level": "Q4_K_M" }
  }
}
```

## Actions

Every action posts JSON with `Content-Type: application/json`, adds the
Bearer header when `OLLAMA_API_KEY` is set, and throws on a non-2xx answer as
described under Errors. Inputs typed `json` are validated by the harness
before `run()`; every input carries a `builderHint`. In the mock run every
action must survive a `{}` reply and placeholder args (`check` for strings,
`{}` for json), so every output is read with `??` and a `messages` value that
is neither a string nor an array is sent as an empty array.

The shared `model` input, on every action that names one:

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | The model name in `model:tag` form; the tag defaults to `latest`. `listModels` returns what is present. |

The shared `options` input is the `ModelOptions` object: "Runtime options
that control text generation", with `temperature` ("Controls randomness in
generation (higher = more random)"), `num_predict` ("Maximum number of
tokens to generate"), `seed`, `top_k`, `top_p`, `min_p`, `stop`, `num_ctx`,
and `additionalProperties: true`. It is passed through as is. The shared
`format` input is "Format to return a response in. Can be `json` or a JSON
schema"; the connector takes a string `json` or a JSON object and sends it
untouched. The structured-outputs page: "Provide a JSON schema to the
`format` field" and "It is ideal to also pass the JSON schema as a string in
the prompt to ground the model's response". `keep_alive` is "Model
keep-alive duration (for example `5m` or `0` to unload immediately)", a
string or a number of seconds; a negative number keeps the model loaded.

### `chat` — generate a chat message

`POST /api/chat`: "Generate the next chat message in a conversation between
a user and an assistant." **Not idempotent**: every call runs a generation.
10 minute timeout.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | As above |
| `messages` | string or json | yes | A single user text, sent as `[{ "role": "user", "content": <text> }]`, or a JSON array of `{ role, content }` where role is `system`, `user`, `assistant` or `tool`; `images` and `tool_calls` on a message pass through |
| `system` | string | no | A system prompt, prepended as a `{ "role": "system" }` message when the array does not already start with one |
| `format` | string or json | no | `json`, or a JSON schema object |
| `options` | json | no | `ModelOptions` such as `{ "temperature": 0.2, "num_predict": 256 }` |
| `keepAlive` | string | no | Sent as `keep_alive`; a duration string such as `10m`, or `0` to unload after the reply |

Sent body: `{ model, messages, system?, format?, options?, keep_alive?,
stream: false }`. Outputs: `content` (`message.content`, "Assistant message
text"), `thinking` (`message.thinking` when present), `toolCalls`
(`message.tool_calls` when present), `doneReason`, `evalCount` ("Number of
tokens generated in the response"), `promptEvalCount`, `totalDuration`
("Total time spent generating in nanoseconds"), `loadDuration`,
`evalDuration`, `model`, and `raw` (the whole response). Sample response:

```json
{
  "model": "gemma4",
  "created_at": "2025-10-17T23:14:07.414671Z",
  "message": { "role": "assistant", "content": "Hello! How can I help you today?" },
  "done": true,
  "done_reason": "stop",
  "total_duration": 174560334,
  "load_duration": 101397084,
  "prompt_eval_count": 11,
  "prompt_eval_duration": 13074791,
  "eval_count": 18,
  "eval_duration": 52479709
}
```

### `generate` — generate a completion

`POST /api/generate`: "Generate a response for a given prompt with a
provided model." **Not idempotent**. 10 minute timeout.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | As above |
| `prompt` | string | yes | "Text for the model to generate a response from" |
| `system` | string | no | "System prompt for the model to generate a response from" |
| `format` | string or json | no | As above |
| `options` | json | no | As above |
| `keepAlive` | string | no | As above |

Sent body: `{ model, prompt, system?, format?, options?, keep_alive?,
stream: false }`. Outputs: `response` ("The model's generated text
response"), `thinking` when present, `doneReason`, `evalCount`,
`promptEvalCount`, `totalDuration`, `loadDuration`, `promptEvalDuration`,
`evalDuration`, `model`, `raw`. The deprecated `context` array in the reply
stays inside `raw` only. Sample response:

```json
{
  "model": "gemma4",
  "created_at": "2025-10-17T23:14:07.414671Z",
  "response": "Hello! How can I help you today?",
  "done": true,
  "done_reason": "stop",
  "total_duration": 174560334,
  "load_duration": 101397084,
  "prompt_eval_count": 11,
  "prompt_eval_duration": 13074791,
  "eval_count": 18,
  "eval_duration": 52479709
}
```

### `embed` — generate embeddings

`POST /api/embed`: "Generate embeddings from a model". Idempotent: the same
input and model give the same vectors. 30 second timeout.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | As above |
| `input` | string or json | yes | "Text or array of texts to generate embeddings for"; a string is sent as is, a JSON array of strings as is |
| `truncate` | boolean | no | "If true, truncate inputs that exceed the context window. If false, returns an error." Default `true`; sent only when set |

Outputs: `embeddings` ("Array of vector embeddings", one array per input),
`count` (its length), `model`, `promptEvalCount` ("Number of input tokens
processed to generate embeddings"), `totalDuration`, `loadDuration`, `raw`.
Sample response:

```json
{
  "model": "all-minilm",
  "embeddings": [[0.010071029, -0.0017594862, 0.05007221, 0.04692972]],
  "total_duration": 14143917,
  "load_duration": 1019500,
  "prompt_eval_count": 8
}
```

Live sample: `{ "model": "qwen2.5-coder:7b", "input": "hello" }`. On this
machine (Ollama 0.33.3) that call answers `501 This server does not support
embeddings. Start it with --embeddings`, whether the model is loaded or not:
the runner this build starts for qwen2.5-coder:7b does not serve embeddings.
The live script reports that reply as a note and goes on, and takes
`OLLAMA_EMBED_MODEL` for a model that does serve them. The connector treats
the 501 as an ordinary error with the server's message.

### `listModels` — list local models

`GET /api/tags`. Idempotent, no inputs. Outputs: `models` (the array of
`{ name, model, modified_at, size, digest, details }`), `count`, `raw`.

Live sample: `{}`.

### `showModel` — show model details

`POST /api/show`: "Show information about a model including details,
modelfile, template, parameters, license, system prompt." Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | As above |
| `verbose` | boolean | no | "If true, includes large verbose fields in the response." Sent only when true |

Outputs: `details`, `capabilities` ("List of supported features", such as
`completion`, `tools`, `vision`, `embedding`), `modifiedAt`, `parameters`
("Model parameter settings serialized as text"), `template`, `license`,
`modelInfo` ("Additional model metadata"), `raw`. The reply has no `name`,
so the action echoes the requested `model`.

Live sample: `{ "model": "qwen2.5-coder:7b" }`.

### `listRunningModels` — list models loaded in memory

`GET /api/ps`: "List models that are currently loaded into memory."
Idempotent, no inputs. Outputs: `models` (the array of `{ name, model, size,
digest, details, expires_at, size_vram, context_length }`), `count`, `raw`.

Live sample: `{}`.

### `version` — get the server version

`GET /api/version`: "Retrieve the Ollama version". Idempotent, no inputs.
Outputs: `version` (`"0.33.3"` on this machine). Reply `{ "version":
"0.12.6" }`. This is the live check's probe.

Live sample: `{}`.

### `pullModel` — pull a model

`POST /api/pull`: "Download a model from the ollama library. Cancelled pulls
are resumed from where they left off, and multiple calls will share the same
download progress." **Not idempotent for a live check**: it downloads.
10 minute timeout.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | "Name of the model to download" |
| `insecure` | boolean | no | "Allow downloading over insecure connections"; sent only when true |

Sent body: `{ model, insecure?, stream: false }`. With `stream: false` the
reply is the final `StatusResponse` `{ "status": "success" }`. Outputs:
`status`, `raw`. A pull that fails answers with `{ "error": … }` and is
thrown.

### `deleteModel` — delete a model

`DELETE /api/delete` with body `{ model }`: "Delete a model and its data."
"Returns a 200 OK if successful, 404 Not Found if the model to be deleted
doesn't exist." **Not idempotent**: the second call answers 404. The reply
body is empty; outputs: `deleted` (`true`), `model`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | "Model name to delete" |

### `copyModel` — copy a model

`POST /api/copy` with `{ source, destination }`: "Returns a 200 OK if
successful, or a 404 Not Found if the source model doesn't exist."
**Not idempotent**: it creates a new tag. Empty reply body; outputs:
`copied` (`true`), `source`, `destination`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | string | yes | "Existing model name to copy from" |
| `destination` | string | yes | "New model name to create" |

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check ./packages/ollama/dist/index.js --mock --receipt packages/ollama/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard, and with a
`./` entry path because a bare `packages/…` path fails to resolve. Tests make
no network calls: the client takes an injected `fetch`, the retry test
injects a clock, and the API key test injects `env`.

## Live checks

`scripts/check-live.sh` first calls `GET /api/version` on `OLLAMA_HOST`
(default `http://localhost:11434`, a trailing `/api` stripped) and exits 0
with a note when the server does not answer. With a server it calls
`GET /api/tags`, `POST /api/show` for `OLLAMA_MODEL`
(default `qwen2.5-coder:7b`), `GET /api/ps`, `POST /api/embed` with `hello`
(reported as a note when the server answers that it does not support
embeddings), then `vorn-connector check --live` when the package is built.
Nothing is generated, pulled, deleted or copied.

| Env | Required | Used by |
| --- | --- | --- |
| `OLLAMA_HOST` | no | every call; default `http://localhost:11434` |
| `OLLAMA_API_KEY` | no | sent as `Authorization: Bearer` when set |
| `OLLAMA_MODEL` | no | `showModel` and `embed` samples; default `qwen2.5-coder:7b` |
| `OLLAMA_EMBED_MODEL` | no | `embed` sample when set, for a model whose runner serves embeddings |

## Dependencies

None at runtime. `fetch` with an `AbortSignal.timeout` covers the client,
there is no paging, and the only parsing is `JSON.parse`. The official
`ollama` npm package wraps the same endpoints with streaming and is not
inlined.

## Icon

Ollama's mark is a friendly llama head seen from the front, drawn in
outline: a rounded, slightly squarish head with two tall upright ears that
taper to rounded tips, two round dot eyes set wide apart, and a small
rounded muzzle bump at the bottom centre. A single-colour SVG carries it in
a 24-unit viewBox as filled shapes: the head as a rounded rectangle from
(4, 8) to (20, 22) with radius 5; two ears as rounded rectangles 3 wide and
7 tall at x 6 and x 15 from y 2 to y 10, their tops rounded with radius
1.5, overlapping the head so the union reads as one silhouette; the eyes as
two circles of radius 1.2 at (9.5, 14) and (14.5, 14) cut out with
`fill-rule: evenodd`; and the muzzle as a cut-out rounded rectangle from
(10, 17.5) to (14, 20) with radius 1.25. Fill only, no strokes.

## Docs

The only source. Two brief links now answer "Page Not Found" and point at a
moved page, listed beside them.

- API introduction (base URLs, versioning): https://docs.ollama.com/api
- Generate a completion: https://docs.ollama.com/api/generate
- Generate a chat message: https://docs.ollama.com/api/chat
- Generate embeddings: https://docs.ollama.com/api/embed
- List models: https://docs.ollama.com/api/tags
- Show model details: https://docs.ollama.com/api/show (moved to https://docs.ollama.com/api-reference/show-model-details)
- List running models: https://docs.ollama.com/api/ps
- Pull a model: https://docs.ollama.com/api/pull
- Delete a model: https://docs.ollama.com/api/delete
- Copy a model: https://docs.ollama.com/api/copy
- Get version: https://docs.ollama.com/api/version (moved to https://docs.ollama.com/api-reference/get-version)
- Structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- Markdown source of the reference (conventions, 404s, keep_alive, unload): https://github.com/ollama/ollama/blob/main/docs/api.md
- FAQ (`OLLAMA_HOST`, `keep_alive`, queueing, 503): https://docs.ollama.com/faq
- Cloud (`OLLAMA_API_KEY`, `Authorization: Bearer`): https://docs.ollama.com/cloud
