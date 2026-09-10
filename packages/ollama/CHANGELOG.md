# Changelog

All notable changes to `@vornrun/connector-ollama`.

## 0.1.0

First release.

Trigger a workflow when a model on a local Ollama server is added, updated or
loaded into memory, and let a workflow step chat, generate a completion,
embed text, and list, show, pull, copy or delete models.

- **Triggers:** `modelChanged`, `modelLoaded`.
- **Actions:** `chat`, `generate`, `embed`, `listModels`, `showModel`,
  `listRunningModels`, `version`, `pullModel`, `deleteModel`, `copyModel`.
- **Signing in:** none. The one setting is the server URL from
  `OLLAMA_HOST`, `http://localhost:11434` by default, with a trailing `/api`
  stripped and a bare `host:port` given `http://`. A hosted or proxied server
  takes its key from `OLLAMA_API_KEY` in the environment, sent as
  `Authorization: Bearer` only when set; the SDK refuses a secret config
  field on a connector with no sign-in, so a host that does not pass its
  environment through cannot supply the key.

Every action and both polls go through one small client rather than declared
SDK requests, because a declared request cannot express what the API needs:
a 10 minute timeout on chat, generate and pull against 30 seconds elsewhere,
`stream: false` on every generation, a Bearer header read from the
environment, one retry after two seconds on a connection refused with the
note that the server may be starting, and the 404 `model '<name>' not found`
reported as `Model '<name>' is not present on the server; pull it first`
without ever pulling on the caller's behalf. Every other failure is reported
as the server's `error` message with the HTTP status, and every generation
returns the reply as `raw` beside the text, `doneReason` and the nanosecond
timings.

Both triggers poll on the SDK's timestamp dedupe strategy. Models are keyed
`<name>@<digest>` and stamped with `modified_at`, so a pull that changes a
digest fires again and the first poll delivers every model present. Loaded
models are keyed `<name>@<expires_at>` and stamped with `expires_at`, so a
model fires each time it appears with an expiry not yet seen. Both times are
reduced to UTC milliseconds for the cursor; the raw values stay on the item.

Ships as a pack with a conformance receipt covering the dedupe replay of both
triggers and the mock run of every action. No runtime dependencies: `fetch`,
`AbortController` and `JSON` cover the client.
