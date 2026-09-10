# @vornrun/connector-ollama

Trigger Vorn workflows when a model on a local Ollama server is added,
updated or loaded into memory, and chat, generate a completion, embed text,
and list, show, pull, copy or delete models from a workflow step. Talks to
the Ollama REST API at `http://localhost:11434/api` by default.

## Signing in

Nothing to sign in with: Ollama binds `127.0.0.1:11434` and its API takes no
credentials, so the connector declares `auth: { rung: 'none' }`. The only
setting is the server URL.

| Setting | Environment | Required | What it does |
| --- | --- | --- | --- |
| Server URL | `OLLAMA_HOST` | no | The server origin, `http://localhost:11434` by default. A trailing `/` or `/api` is stripped, and a bare `host:port` such as `0.0.0.0:11434` gets `http://` in front, so the same value the `ollama` CLI reads works here. |

A hosted or reverse-proxied server that wants a key takes it from the
`OLLAMA_API_KEY` environment variable, sent as `Authorization: Bearer <key>`
only when it is set. There is no config field for it: the connector SDK
refuses a secret field on a connector that declares it needs no sign-in, so
the key rides on the environment. A host that does not pass its environment
through to the connector cannot supply it.

## Errors, timeouts and retries

Every request is JSON and every reply is one JSON object: the connector sends
`stream: false` on chat, generate and pull, so an answer is never a stream of
lines. A failed call carries `{ "error": "<message>" }` and is reported as
`<message> (HTTP <status>)`. A model that is not on the server answers 404
`model '<name>' not found`, reported as `Model '<name>' is not present on the
server; pull it first (HTTP 404)`; the connector never pulls on the caller's
behalf. A `503` means the server is overloaded and is reported as is.

Chat, generate and pull can take minutes on a laptop and get a 10 minute
timeout; every other call gets 30 seconds. A connection refused is retried
once after two seconds, and a second refusal is reported as `Ollama did not
answer at <url>; the server may be starting or not running`. Nothing else is
retried; there are no rate limits, the server queues requests. Every
duration in a reply is nanoseconds and is passed through untouched.

## Triggers

Both poll the whole list, since neither endpoint pages, and both dedupe on
the SDK's timestamp strategy with the time reduced to UTC milliseconds.

### `modelChanged` — a model was added or updated

Polls `GET /api/tags` and fires once per model build: the item id is
`<name>@<digest>` stamped with `modified_at`, so a pull that updates a tag
fires again and the same build never fires twice. The first poll delivers
every model present. Each item carries `name`, `digest`, `size`,
`modified_at`, `family` and `parameter_size` beside the full `details`, a
title such as `qwen2.5-coder:7b (qwen2, 7.6B)`, and the library page as
`url` when the name has no namespace and no remote host.

### `modelLoaded` — a model was loaded into memory

Polls `GET /api/ps` and fires when a model appears with an `expires_at` not
yet seen: the item id is `<name>@<expires_at>` stamped with `expires_at`.
Every request the model serves moves the expiry forward, so a busy model
fires again on each poll; the default workflow polls every five minutes, and
a slower interval reports fewer repeats. Each item carries `name`, `digest`,
`size`, `size_vram`, `expires_at`, `context_length` and `details`.

## Actions

`model` is the `model:tag` name; the tag defaults to `latest`. `format` is
the word `json` or a JSON schema object, sent untouched; `options` is the
runtime options object such as `{ "temperature": 0.2, "num_predict": 256 }`;
`keepAlive` is sent as `keep_alive`, a duration such as `10m` or `0` to
unload at once.

| Action | Idempotent | What it does |
| --- | --- | --- |
| `chat` | no | `POST /api/chat` with `model`, `messages` (a single user text or a JSON array of `{ role, content }`), optional `system` (prepended as a system turn), `format`, `options`, `keepAlive`. Returns `content`, `thinking`, `toolCalls`, `doneReason`, `evalCount`, `promptEvalCount`, `totalDuration`, `loadDuration`, `promptEvalDuration`, `evalDuration`, `model`, `raw`. |
| `generate` | no | `POST /api/generate` with `model`, `prompt`, optional `system`, `format`, `options`, `keepAlive`. Returns `response`, `thinking` and the same timings and `raw`. |
| `embed` | yes | `POST /api/embed` with `model`, `input` (text or a JSON array of texts), optional `truncate`. Returns `embeddings`, `count`, `model`, `promptEvalCount`, `totalDuration`, `loadDuration`, `raw`. |
| `listModels` | yes | `GET /api/tags`. Returns `models`, `count`, `raw`. |
| `showModel` | yes | `POST /api/show` with `model`, optional `verbose`. Returns `model`, `details`, `capabilities`, `modifiedAt`, `parameters`, `template`, `license`, `modelInfo`, `raw`. |
| `listRunningModels` | yes | `GET /api/ps`. Returns `models`, `count`, `raw`. |
| `version` | yes | `GET /api/version`. Returns `version`. The live check probes this. |
| `pullModel` | no | `POST /api/pull` with `model`, optional `insecure`, `stream: false`. Returns the final `status` and `raw`. Downloads, so it is slow. |
| `deleteModel` | no | `DELETE /api/delete` with `model`. Returns `deleted`, `model`. A second call answers 404. |
| `copyModel` | no | `POST /api/copy` with `source`, `destination`. Returns `copied`, `source`, `destination`. |

A runner that does not serve embeddings answers `501 This server does not
support embeddings`; `showModel` lists `embedding` under `capabilities` for a
model that does.

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check ./packages/ollama/dist/index.js --mock --receipt packages/ollama/verified.json
```

`packages/ollama/scripts/check.sh` runs exactly this. Tests make no network
calls: the client takes an injected `fetch` and sleep, and the API key test
injects the environment.

`packages/ollama/scripts/check-live.sh` calls `GET /api/version` on
`OLLAMA_HOST` (default `http://localhost:11434`) and exits 0 with a note when
no server answers. With a server it lists models, shows `OLLAMA_MODEL`
(default `qwen2.5-coder:7b`), lists running models, embeds `hello` with
`OLLAMA_EMBED_MODEL` or the same model (a runner that does not serve
embeddings is reported as a note), then runs `vorn-connector check --live`
against the built package. Nothing is generated, pulled, deleted or copied.

## Built from

The API reference was the only source.

- API introduction: https://docs.ollama.com/api
- Generate a completion: https://docs.ollama.com/api/generate
- Generate a chat message: https://docs.ollama.com/api/chat
- Generate embeddings: https://docs.ollama.com/api/embed
- List models: https://docs.ollama.com/api/tags
- Show a model: https://docs.ollama.com/api/show
- List running models: https://docs.ollama.com/api/ps
- Pull a model: https://docs.ollama.com/api/pull
- Delete a model: https://docs.ollama.com/api/delete
- Copy a model: https://docs.ollama.com/api/copy
- Version: https://docs.ollama.com/api/version
- Structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- Markdown source of the reference: https://github.com/ollama/ollama/blob/main/docs/api.md
- FAQ, `OLLAMA_HOST` and the API key: https://docs.ollama.com/faq
