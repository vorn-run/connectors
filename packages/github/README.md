# @vornrun/connector-github

Trigger Vorn workflows from GitHub issues and pull requests, and open, close or
comment on them from a workflow step.

## Signing in

There is no token to paste. This connector borrows the GitHub CLI's login:

```sh
brew install gh      # or see https://cli.github.com
gh auth login
```

`gh auth token` supplies the credential on demand, so it lives wherever `gh`
keeps it and rotates on its own. Nothing is stored in the connection.

If `gh` is missing or signed out, the connector says which and what to run.

## Settings

| Field | Required | What it does |
| --- | --- | --- |
| `owner` | yes | User or organisation, e.g. `vorn-run` |
| `repo` | yes | Repository name on its own, without the owner |
| `labels` | no | Comma-separated. Narrows the **issue** trigger only. |

## Triggers

**An issue is created** and **A pull request is opened**. Both poll
[search](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests)
for items created since the last run, and suggest `open → todo`,
`closed → done` when items become tasks.

Three properties of that API shape the polling, and each is worth knowing if
you are reading `src/search.ts`:

- `created:>X` is a **strict** bound compared at second precision, so the
  cursor is rewound a second before it is used. Without that, everything
  created in the cursor's own second is skipped.
- The search index **lags writes**. An item created before a poll ran can be
  indexed after it, so the watermark is left five minutes behind the poll's
  start and those items are re-read rather than missed.
- Search returns at most **1,000 results** whatever `total_count` says. On
  hitting that, the poll moves its time window to just before the last item it
  saw rather than asking for a page the API will not serve.

Where the API admits a page was partial (`incomplete_results`), the poll fails
instead of advancing — the response gives no indication of what is missing, and
advancing past it would lose those items for good.

## Actions

| Action | Idempotent | Notes |
| --- | --- | --- |
| Create an issue | no | Two identical calls make two issues; GitHub offers no idempotency key |
| Close an issue | yes | Closing a closed issue leaves it closed |
| Comment on an issue | no | Two identical calls make two comments |

Issue numbers arrive as text from workflow templates and are validated before
being sent, so a `{{...}}` that resolved to nothing names itself rather than
returning a confusing 404 about the repository.

## What this connector cannot do

- **No webhooks.** It polls. The default seeded workflows run every 5 minutes.
- **No repository-wide search.** One connection watches one repository.
- **Pull requests ignore the label filter**, which is described as an issue
  filter. Narrowing them silently would be a surprise nothing on the form
  explains.
- **Nothing that needs more than `gh`'s scopes.** If `gh auth login` was run
  without the scopes an action needs, that action fails with GitHub's own
  message; re-run `gh auth refresh -s <scope>`.

## Built from

- [REST: issues](https://docs.github.com/en/rest/issues/issues)
- [REST: issue comments](https://docs.github.com/en/rest/issues/comments)
- [Search: issues and pull requests](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests)
- [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [`@octokit/rest`](https://github.com/octokit/rest.js)
- [GitHub CLI manual: `gh auth`](https://cli.github.com/manual/gh_auth)
