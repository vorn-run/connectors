id: gitlab

# GitLab connector

Trigger Vorn workflows from GitLab issues, merge requests and pipeline results,
and create or comment on issues and merge requests from a workflow step. Works
against gitlab.com and self-managed instances: the config takes a base URL that
defaults to `https://gitlab.com`, and every request goes to `<baseUrl>/api/v4/...`
(the docs: "the root endpoint path must begin with `/api/v4`").

Package: `@vornrun/connector-gitlab` in `packages/gitlab`, shaped exactly like
the five existing packages: scoped name, `tsup src/index.ts --format esm
--target node22 --clean`, `vitest.config.ts` re-exporting `vitest.shared.ts`
(90% per-file coverage), `CHANGELOG.md`, `README.md` with the docs links from
the Sources section below, `verified.json` written by `vorn-connector check
--mock`, and a `"vorn"` block in `package.json` with category `Development`,
keywords, and one sentence on how it signs in.

## Auth

**Rung: `cli`.** Most developers already sign in with the `glab` CLI
(`brew install glab`, then `glab auth login`). The connector borrows that
login and stores nothing in the connection.

| Role | Value |
| --- | --- |
| Probe (reports the session) | `glab auth status` |
| Prints a token | `glab config get token --host <host>` |
| Env variable the API client reads | `GITLAB_TOKEN` |
| Header sent to the API | `Authorization: Bearer <token>` (see below) |

What the docs and the CLI source say:

- `glab auth status` "verifies and displays information about your
  authentication state" for the host in the current context (git remote,
  `GITLAB_HOST`, or config); `--hostname <host>` checks one instance, `--all`
  every configured one. It prints `Logged in to <host> as <user> (<source>)`
  on success and exits with an error when no instance is authenticated ("no
  GitLab instances have been authenticated with glab; run `glab auth login`"),
  when the named host is unknown, or when the API call with the stored token
  fails. Exit 0 means signed in.
- **`glab auth token` does not exist.** The `glab auth` command tree in the
  CLI repository is `login`, `logout`, `status`, `configure-docker`,
  `docker-helper`, `dpop-gen` (plus `generate` and `credentialhelper`
  internally). The documented, machine-readable way to read the stored token
  is `glab config get token --host <host>`: `config get` "prints the value of
  a given configuration key" and "if the key is not set, nothing is printed".
  Its lookup (`internal/config/config.go`, `GetWithSource`) is environment
  variables first, then the host entry, reading the OS keyring when
  `use_keyring` is on, then a keyring fallback for older installs, so it
  returns the token `glab auth login` put in the macOS Keychain, Windows
  Credential Manager or Linux Secret Service. `glab auth status --show-token`
  also reveals the token, but inside a human-readable line on stderr, so it is
  not the borrow command.
- `glab` itself honours `GITLAB_TOKEN`, then `GITLAB_ACCESS_TOKEN`, then
  `OAUTH_TOKEN`, ahead of stored credentials, and `GITLAB_HOST` (or
  `GITLAB_URI`, default `https://gitlab.com`) for the instance.
- The token `glab` stores is either a personal access token (`glab auth login
  --token` / `--stdin`) or an OAuth access token from the `--web` / `--device`
  flow. Per the REST authentication page a personal access token is accepted
  in the `PRIVATE-TOKEN: <token>` header (the documented recommendation) or as
  `Authorization: Bearer <token>`; an OAuth token is accepted only as
  `Authorization: Bearer` or the `access_token` parameter. Send **Bearer**,
  which covers both. "All OAuth access tokens are valid for two hours after
  they are created", so a 401 means re-read the token from `glab` once and
  retry, the same shape as the GitHub connector's token source.
- Scopes: `api` ("Grants complete read and write access to the API for the
  token's scope"). `read_api` ("Grants read access to the API for the token's
  scope") is enough for the three triggers and the three idempotent actions;
  `createIssue`, `commentOnIssue` and `commentOnMergeRequest` need `api`.
  `glab auth login` with a personal access token asks for at least `api` and
  `write_repository`, so a `glab` login already carries what is needed.

**Personal access token field (borrow only when empty):** a `token` config
field (env `GITLAB_TOKEN`, `secret: true`, not required, label "Personal
access token"). When it is filled it is used as-is and `glab` is never run;
only when it is empty does the connector borrow from `glab`. A person creates
one at avatar → **Edit profile** → **Access** → **Personal access tokens** →
**Generate token**, scope `api` (or `read_api` for read-only use). Tokens
default to a 365-day expiry and are prefixed `glpat-`.

Manifest declaration:

```ts
auth: {
  rung: 'cli',
  probe: { command: 'glab', args: ['auth', 'status'] },
  borrow: { env: ['GITLAB_TOKEN'], tokenArgs: ['glab', 'config', 'get', 'token'], tokenEnv: 'GITLAB_TOKEN' }
}
```

`borrow.env` names `GITLAB_TOKEN`, which is why it must also be the `token`
config field's env: the host refuses to borrow a name the connector does not
openly read. The connector's own token source appends `--host <hostname of
baseUrl>` at runtime so the borrowed token matches the API it is sent to;
`tokenArgs` as declared is the gitlab.com default. `probe.command` is the bare
executable name the SDK check requires.

## Config

| Key | Env | Required | Description |
| --- | --- | --- | --- |
| `baseUrl` | `GITLAB_BASE_URL` | no | Instance URL, default `https://gitlab.com`. The client appends `/api/v4`. |
| `project` | `GITLAB_PROJECT` | yes | Project path (`group/project`) or numeric id, used by the triggers. Paths are sent URL-encoded (`group%2Fproject`), as the docs require for namespaced requests. |
| `token` | `GITLAB_TOKEN` | no | Personal access token, secret. Leave empty to borrow `glab`'s login. |

Actions take `project` as an input so one connection can act on several
projects; the triggers poll the connection's `project`.

## Triggers

All three poll `GET /projects/:id/<resource>` with `sort=asc`, `per_page=100`
(the documented maximum; default 20) and an inclusive ISO 8601 time lower
bound, and page with `page=N` following the `x-next-page` response header
(empty when there is no next page). Offset pagination is used for all three:
keyset pagination (`pagination=keyset`) is documented for project issues
(`order_by` `created_at` / `updated_at`, GitLab 18.3 onward) but not for merge
requests or pipelines, and a self-managed instance may be older than 18.3.

Time filters ("created on or after the given time") are inclusive at second
precision while timestamps carry milliseconds, so the item whose timestamp
equals the cursor comes back on the next poll. Dedupe on the id absorbs that;
do not add a second to the cursor, which would skip items created in the same
second. Lists over 10,000 records omit `x-total` and `x-total-pages`, so
never rely on them.

Hand-written `poll()` rather than declarative `fetch()`, as in the GitHub
package, because the cursor is `{since, page}` across a multi-page window.
Each trigger also declares `sample` items (the payloads below, mapped) so
`vorn-connector check --mock` can replay the dedupe pipeline.

### `issueCreated` — an issue is created

- Endpoint: `GET /projects/:id/issues?state=all&order_by=created_at&sort=asc&created_after=<cursor>&per_page=100&page=N`
- Cursor: `created_after` = the largest `created_at` seen; initial value is
  the poll start minus one minute. (`updated_after` with
  `order_by=updated_at` is the same shape if a "created or updated" variant is
  wanted later; both parameters are documented.)
- Dedupe key: `iid`, the project-scoped number shown in the UI (`#627684`).
  `id` is the global id and is kept in `data`.
- Item mapping: `externalId = String(iid)`, `title`, `url = web_url`,
  `description`, `status = state` (`opened` / `closed`), `labels`,
  `assignee = assignees[0]?.username`, `updatedAt = updated_at`, `data = { id,
  iid, projectId: project_id, author: author.username, assignees:
  assignees[].username, createdAt: created_at, closedAt: closed_at,
  issueType: issue_type, confidential }`.
- Status suggestions: `opened → todo`, `closed → done`.
- Sample item, returned by gitlab.com for `gitlab-org/gitlab` on 2026-09-04
  (fields trimmed; note `web_url` now points at `/-/work_items/`):

```json
{
  "id": 201377309,
  "iid": 627684,
  "project_id": 278964,
  "title": "Restructure Package Metadata Database documentation and split the offline quick start guide",
  "description": "This issue tracks a documentation follow-up agreed during review of https://gitlab.com/gitlab-org/gitlab/-/merge_requests/...",
  "state": "opened",
  "created_at": "2026-09-04T02:23:26.054Z",
  "updated_at": "2026-09-04T03:10:09.633Z",
  "closed_at": null,
  "labels": ["automation:quick-win-judged", "documentation", "group::composition analysis", "type::maintenance"],
  "author": { "id": 32685309, "username": "azaydan", "name": "Ahmad Zaydan" },
  "assignees": [],
  "web_url": "https://gitlab.com/gitlab-org/gitlab/-/work_items/627684",
  "issue_type": "issue",
  "confidential": false
}
```

### `mergeRequestOpened` — a merge request is opened

- Endpoint: `GET /projects/:id/merge_requests?state=all&order_by=created_at&sort=asc&created_after=<cursor>&per_page=100&page=N`
  (`state` accepts `opened`, `closed`, `merged`, `all`; default `all`).
- Cursor: `created_after`, as for issues.
- Dedupe key: MR `iid`.
- Item mapping: `externalId = String(iid)`, `title`, `url = web_url`,
  `description`, `status = state` (`opened` / `closed` / `merged`), `labels`,
  `assignee = assignees[0]?.username`, `updatedAt = updated_at`, `data = { id,
  iid, projectId, sourceBranch: source_branch, targetBranch: target_branch,
  draft, sha, author: author.username, createdAt, mergedAt: merged_at,
  closedAt: closed_at, hasConflicts: has_conflicts, detailedMergeStatus:
  detailed_merge_status }`.
- Status suggestions: `opened → in_progress`, `merged → done`, `closed → done`.
- Sample item (gitlab.com, 2026-09-04, trimmed):

```json
{
  "id": 527853893,
  "iid": 253583,
  "project_id": 278964,
  "title": "Add scope, engine and level properties to perform_search",
  "description": "Nothing in GitLab measured whether a search returned any results, so the zero-result rate could not be computed. This adds...",
  "state": "opened",
  "draft": false,
  "created_at": "2026-09-04T03:07:05.722Z",
  "updated_at": "2026-09-04T03:12:24.611Z",
  "merged_at": null,
  "closed_at": null,
  "source_branch": "wt/telemetry-zero-result",
  "target_branch": "master",
  "sha": "ae17207bc7b8ea3696979d9888fd25e0629c8bde",
  "author": { "id": 9717668, "username": "johnmason", "name": "John Mason" },
  "labels": ["analytics instrumentation", "backend", "feature::addition", "type::feature"],
  "web_url": "https://gitlab.com/gitlab-org/gitlab/-/merge_requests/253583",
  "has_conflicts": false,
  "detailed_merge_status": "not_approved"
}
```

### `pipelineFinished` — a pipeline reaches a result

- Endpoint: `GET /projects/:id/pipelines?order_by=updated_at&sort=asc&updated_after=<cursor>&per_page=100&page=N`,
  optionally `&ref=<branch>` from a connection setting. `updated_after` is
  documented on **List project pipelines** (the instance-wide `GET /pipelines`
  has only `created_after`), and `updated_at` moves as a pipeline runs, which
  is what makes a finished pipeline reappear after the poll that first saw it
  running.
- Cursor: `updated_after` = the largest `updated_at` seen.
- Dedupe key: pipeline `id`, with `status` carried on the item. Only terminal
  statuses are delivered, filtered client-side from the documented enum:
  terminal `success`, `failed`, `canceled`, `skipped`; non-terminal `created`,
  `waiting_for_resource`, `preparing`, `waiting_for_callback`, `pending`,
  `running`, `canceling`, `manual`, `scheduled`. A pipeline seen while running
  is not delivered and not deduped, so it fires once it finishes. A retried
  pipeline keeps its id and finishes again; dedupe on `id` means that second
  result is not redelivered, which is the trade-off of the id key the spec
  asks for (a composite `id:status` key would be the alternative).
- Item mapping: `externalId = String(id)`, `title = `${name ?? ref}: ${status}``,
  `url = web_url`, `status`, `updatedAt = updated_at`, `data = { id, iid,
  projectId: project_id, ref, sha, source, name, status, createdAt }`. The
  list payload has no `duration` / `finished_at`; those need
  `GET /projects/:id/pipelines/:pipeline_id` and are out of scope for the poll.
- Status suggestions: `success → done`, `failed → blocked`.
- Sample item (gitlab.com, 2026-09-04, exactly as returned by the list
  endpoint; a delivered item would have a terminal status):

```json
{
  "id": 2818962738,
  "iid": 6291260,
  "project_id": 278964,
  "sha": "631b08ab8c69929b88af7f06d64500c3e5f400ae",
  "ref": "master",
  "status": "running",
  "source": "push",
  "created_at": "2026-09-04T03:12:16.050Z",
  "updated_at": "2026-09-04T03:12:20.492Z",
  "web_url": "https://gitlab.com/gitlab-org/gitlab/-/pipelines/2818962738",
  "name": "Ruby 3.3.12 master branch"
}
```

## Actions

`project` inputs accept a path (`group/project`) or numeric id and are
URL-encoded before use. `iid` inputs arrive as text from templates and are
validated as positive integers before the request is sent, as the GitHub
connector does for issue numbers, so an unresolved `{{...}}` names itself
rather than producing a 404.

| Action | Method and path | Idempotent | Scope |
| --- | --- | --- | --- |
| `createIssue` | `POST /projects/:id/issues` | no | `api` |
| `commentOnIssue` | `POST /projects/:id/issues/:issue_iid/notes` | no | `api` |
| `commentOnMergeRequest` | `POST /projects/:id/merge_requests/:merge_request_iid/notes` | no | `api` |
| `getProject` | `GET /projects/:id` | yes | `read_api` |
| `listOpenMergeRequests` | `GET /projects/:id/merge_requests?state=opened` | yes | `read_api` |
| `getIssue` | `GET /projects/:id/issues/:issue_iid` | yes | `read_api` |

### `createIssue`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | yes | Project path or id |
| `title` | string | yes | Issue title (`title`, the only required body field) |
| `description` | string | no | Markdown body, "limited to 1,048,576 characters" (`description`) |
| `labels` | string | no | Comma-separated label names (`labels`) |

Outputs: `id` (number), `iid` (number), `url` (string, `web_url`), `title`,
`state`, `createdAt`. Not idempotent: two identical calls make two issues and
GitLab offers no idempotency key on this endpoint.

### `commentOnIssue`

Inputs: `project` (string, required), `iid` (number, required, the issue
`iid`), `body` (string, required, "limited to 1,000,000 characters"),
`internal` (boolean, optional, default false; the documented replacement for
the deprecated `confidential`). Outputs: `id` (note id), `body`, `author`
(`author.username`), `createdAt`, `noteableIid` (`noteable_iid`),
`noteableType` (`noteable_type`, `Issue`). A note has no `web_url` in the
documented response. Not idempotent.

### `commentOnMergeRequest`

Inputs: `project` (string, required), `iid` (number, required, the MR `iid`),
`body` (string, required), `internal` (boolean, optional). Outputs as for
`commentOnIssue` with `noteableType` = `MergeRequest`. Not idempotent.

Documented note response, for the mock:

```json
{
  "id": 301, "body": "Comment text",
  "author": { "id": 1, "username": "pipin" },
  "created_at": "2013-10-02T08:57:14Z", "updated_at": "2013-10-02T08:57:14Z",
  "system": false, "noteable_id": 2, "noteable_type": "MergeRequest",
  "noteable_iid": 2, "internal": false, "resolvable": false
}
```

### `getProject` (idempotent)

Inputs: `project` (string, required; "The ID or URL-encoded path of the
project"). Outputs: `id`, `name`, `path`, `pathWithNamespace`
(`path_with_namespace`), `description`, `defaultBranch` (`default_branch`),
`visibility`, `url` (`web_url`), `httpUrlToRepo`, `sshUrlToRepo`,
`createdAt`, `lastActivityAt`, `archived`, `namespace`
(`namespace.full_path`), `starCount`, `forksCount`, `topics`. "This endpoint
can be accessed without authentication if the project is publicly
accessible", so the live check works on a public project with `read_api`.

Sample arguments for the live check: `{ "project": "gitlab-org/gitlab" }`.
Response from gitlab.com on 2026-09-04, trimmed:

```json
{
  "id": 278964,
  "name": "GitLab",
  "path": "gitlab",
  "path_with_namespace": "gitlab-org/gitlab",
  "name_with_namespace": "GitLab.org / GitLab",
  "default_branch": "master",
  "visibility": "public",
  "web_url": "https://gitlab.com/gitlab-org/gitlab",
  "http_url_to_repo": "https://gitlab.com/gitlab-org/gitlab.git",
  "ssh_url_to_repo": "git@gitlab.com:gitlab-org/gitlab.git",
  "created_at": "2015-05-20T10:47:11.949Z",
  "last_activity_at": "2026-09-04T02:39:11.259Z",
  "namespace": { "id": 9970, "name": "GitLab.org", "path": "gitlab-org", "kind": "group", "full_path": "gitlab-org" },
  "star_count": 6130,
  "forks_count": 12375,
  "topics": ["hacktoberfest", "javascript", "ruby", "vue.js"]
}
```

### `listOpenMergeRequests` (idempotent)

Inputs: `project` (string, required), `limit` (number, optional, default 20,
max 100, sent as `per_page`), `targetBranch` (string, optional, sent as
`target_branch`). Request:
`GET /projects/:id/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=<limit>`.
Outputs: `count` (number), `items` (json: the MR mapping the trigger uses, one
per MR). Sample arguments: `{ "project": "gitlab-org/gitlab" }`.

### `getIssue` (idempotent)

Inputs: `project` (string, required), `iid` (number, required). Request:
`GET /projects/:id/issues/:issue_iid`. Outputs: the issue mapping the trigger
uses (`id`, `iid`, `title`, `description`, `state`, `url`, `labels`, `author`,
`assignees`, `createdAt`, `updatedAt`, `closedAt`). Sample arguments:
`{ "project": "gitlab-org/gitlab", "iid": 1 }`.

## Errors, limits and retries

- `401 Unauthorized`: token missing or invalid. Re-read it from `glab` once,
  then report `Not signed in to GitLab. Run glab auth login.`. `403` is a
  permission or scope problem (an OAuth token lacking scope answers
  `insufficient_scope`) and is reported with GitLab's own message.
- Every response carries `RateLimit-Limit`, `RateLimit-Observed`,
  `RateLimit-Remaining`, `RateLimit-Reset` (Unix time) and `RateLimit-Name`.
  A throttled request returns `429` with `Retry-After` (seconds) and
  `RateLimit-ResetTime`. gitlab.com allows 2,000 authenticated requests per
  minute per user, 500 unauthenticated per IP, and 400 per minute on
  `GET /projects/:id`. Honour `Retry-After` with bounded retries.
- Page with `x-next-page` or the `Link` `rel="next"` URL, never `x-total`.

## Checks

```sh
yarn typecheck && yarn test && yarn build
yarn workspace @vornrun/connector-gitlab exec vorn-connector check ./dist/index.js --mock --receipt verified.json
node scripts/check-packages.mjs && node scripts/check-conformance.mjs && node scripts/build-catalog.mjs --check
```

`scripts/check.sh` runs exactly this for `packages/gitlab`. Tests make no
network calls: the HTTP client is exercised with an injected `fetch`, and the
`glab` token source with an injected runner, as the GitHub package injects
`runGh`. If `yarn install` fails because the registry is unreachable, link the
repository root's `node_modules` into the worktree and carry on; CI resolves
the lockfile.

## Live checks

`scripts/check-live.sh` builds the package and runs `vorn-connector check
./dist/index.js --live`, which polls each trigger for real and calls the
idempotent actions with the sample arguments above. It exits 0 with a note
when `GITLAB_TOKEN` is not set, because no sandbox credentials exist yet.

| Variable | Required | Meaning |
| --- | --- | --- |
| `GITLAB_TOKEN` | yes | Personal access token with `read_api` (`api` to also exercise the write actions) |
| `GITLAB_PROJECT` | no | Project to poll; defaults to `gitlab-org/gitlab` |
| `GITLAB_BASE_URL` | no | Instance URL; defaults to `https://gitlab.com` |

## Sources

Only the service's own published documentation was used:

- [REST API overview: base path, URL encoding, pagination](https://docs.gitlab.com/api/rest/)
- [REST API authentication: PRIVATE-TOKEN, Bearer, OAuth, 401/403](https://docs.gitlab.com/api/rest/authentication/)
- [Issues API](https://docs.gitlab.com/api/issues/)
- [Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- [Pipelines API](https://docs.gitlab.com/api/pipelines/)
- [Notes API (issue and merge request comments)](https://docs.gitlab.com/api/notes/)
- [Projects API](https://docs.gitlab.com/api/projects/)
- [Personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)
- [Access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)
- [Rate limit response headers](https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/)
- [GitLab.com rate limits](https://docs.gitlab.com/user/gitlab_com/)
- [glab CLI repository](https://gitlab.com/gitlab-org/cli):
  [README and environment variables](https://gitlab.com/gitlab-org/cli/-/blob/main/README.md),
  [authentication](https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/authentication.md),
  [`glab auth login`](https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/auth/login.md),
  [`glab auth status`](https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/auth/status.md),
  [`glab config get`](https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/config/get.md),
  [`internal/config/config.go`](https://gitlab.com/gitlab-org/cli/-/blob/main/internal/config/config.go) for the token lookup order
