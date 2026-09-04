# @vornrun/connector-gitlab

Trigger Vorn workflows from GitLab issues, merge requests and pipeline results,
and create or comment on issues and merge requests from a workflow step. Works
against gitlab.com and self-managed instances.

## Signing in

There is no token to paste. This connector borrows the GitLab CLI's login:

```sh
brew install glab      # or see https://gitlab.com/gitlab-org/cli
glab auth login
```

`glab config get token --host <host>` supplies the credential on demand, so it
lives wherever `glab` keeps it — the OS keychain, usually — and nothing is
stored in the connection. (`glab auth token` does not exist; `config get` is the
documented way to read what `glab auth login` stored.)

If you would rather not depend on `glab`, paste a
[personal access token](https://docs.gitlab.com/user/profile/personal_access_tokens/)
into the **Personal access token** field. It is used as-is and `glab` is never
run. Scope `api` covers everything here; `read_api` is enough for the triggers
and the read-only actions.

The token is sent as `Authorization: Bearer`, which GitLab accepts for both
personal access tokens and the OAuth tokens `glab auth login --web` stores. A
borrowed OAuth token lives two hours, so the triggers and the merge request
list re-read it from `glab` once on a `401` before reporting that you are
signed out. The other actions are declared requests and send the token the host
borrowed when it started the connector, which it does afresh on every start.

## Settings

| Field | Required | What it does |
| --- | --- | --- |
| `baseUrl` | no | Instance URL, default `https://gitlab.com`. Without a trailing slash; `/api/v4` is appended. |
| `project` | yes | Path such as `gitlab-org/gitlab`, or the numeric id. The triggers poll this project. |
| `token` | no | Personal access token. Leave empty to borrow `glab`'s login. |
| `ref` | no | Branch or tag whose pipelines to watch. Blank for every ref. |

Actions take their own `project` input, so one connection can act on several
projects while its triggers watch one.

## Triggers

**An issue is created**, **A merge request is opened** and **A pipeline
finishes**. Each polls the project's list endpoint, oldest first, for
everything at or after the last watermark, and follows `x-next-page` up to ten
pages of 100 per poll.

Things worth knowing if you are reading `src/connector.ts`:

- The watermark is the field the request filters on. The issue and merge
  request triggers ask for `created_after`, so their items carry `created_at`
  as `updatedAt`; the real `updated_at` rides along as `changedAt`. A poll cut
  short by a limit could otherwise move the watermark past an item created
  earlier but touched later, and never ask for it again.
- The very first poll, before any watermark exists, asks for the minute
  before it rather than the project's whole history.
- GitLab's time filters are inclusive at second precision while timestamps
  carry milliseconds, so the item sitting on the watermark comes back on the
  next poll. The SDK recognises it by its `iid`; adding a second to the cursor
  would skip whatever else was created in that second.
- Pipelines are polled with `updated_after`, because `updated_at` moves as a
  pipeline runs. Only `success`, `failed`, `canceled` and `skipped` are
  delivered. A running pipeline is neither delivered nor remembered, so it
  fires once it finishes. A retried pipeline keeps its id and is not delivered
  again — the cost of keying on the id.
- Lists over 10,000 records omit `x-total`, so the connector never reads it.

Status suggestions: issues `opened → todo`, `closed → done`; merge requests
`opened → in_progress`, `merged`/`closed → done`; pipelines `success → done`,
`failed → todo`, `canceled`/`skipped → cancelled`.

## Actions

| Action | Idempotent | Notes |
| --- | --- | --- |
| Create an issue | no | Two identical calls make two issues; GitLab offers no idempotency key |
| Comment on an issue | no | Posts a note; `internal` hides it from non-members |
| Comment on a merge request | no | As above, on a merge request |
| Get a project | yes | `namespace` comes back as `{id, name, path, fullPath, kind}` |
| List open merge requests | yes | Newest-updated first; `limit` up to 100, optional `targetBranch`. Returns `count` and `items` in the shape the merge request trigger delivers |
| Get an issue | yes | `author` and `assignees` come back as `{id, username, name}` |

Every action but the merge request list is a declared request: the SDK fills
in the arguments, URL-encodes the project path (`gitlab-org%2Fgitlab`), sends
the call and keeps the fields named above under camelCase names. The merge
request list is hand-written, because a declared request cannot count what it
returns. Issue and merge request numbers are their
project-scoped `iid`, the number shown in the UI, and are checked to be numbers
before anything is sent, so a `{{...}}` that resolved to nothing names itself
rather than returning a 404.

## What this connector cannot do

- **No webhooks.** It polls. The default seeded workflows run every 5 minutes.
- **One project per connection** for the triggers.
- **No pipeline duration.** The list endpoint carries no `duration` or
  `finished_at`; those need a per-pipeline call this connector does not make.
- **Nothing beyond the token's scope.** A `403` is reported with GitLab's own
  message; an OAuth token lacking scope answers `insufficient_scope`.

Rate limits are honoured by the SDK: a `429` waits out `Retry-After` a bounded
number of times before the poll gives up and the next scheduled one tries again.

## Checks

```sh
yarn typecheck && yarn test && yarn build
yarn workspace @vornrun/connector-gitlab exec vorn-connector check ./dist/index.js --mock --receipt verified.json
```

`scripts/check.sh` at the repository root runs exactly this for this package.
`scripts/check-live.sh` runs `vorn-connector check --live` against a real
instance when `GITLAB_TOKEN` is set, and exits 0 with a note when it is not.

## Built from

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
  [`glab config get`](https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/config/get.md)
