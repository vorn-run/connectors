# @vornrun/connector-ado

Trigger Vorn workflows from the work items an Azure DevOps WIQL query returns
or from newly opened pull requests, and from a workflow step create, update and
comment on work items, or review, vote on and complete pull requests.

## Signing in

There is no token to paste. This connector uses whatever Azure identity you
already have — if `az login` works in your terminal, this works:

```sh
brew install azure-cli   # or see https://learn.microsoft.com/cli/azure
az login
```

The credential is resolved on demand through `@azure/identity`, so it lives
wherever the Azure CLI keeps it and renews on its own. Nothing long-lived is
stored in the connection.

## Settings

| Field | Required | What it does |
| --- | --- | --- |
| `organization` | yes | Name or URL, e.g. `contoso` or `https://dev.azure.com/contoso` |
| `project` | yes | Project name |
| `query` | for the work item trigger | The WIQL query to poll |
| `repository` | no | Narrows the pull request trigger to one repository; where `createPullRequest` opens one |
| `top` | no | Upper bound on work items or pull requests read in one poll |

## Triggers

**Work item matches the query.** Each work item the query newly returns starts
one workflow run, once. For example:

```sql
SELECT [System.Id] FROM WorkItems
WHERE [System.State] = 'New' AND [System.AssignedTo] = @Me
ORDER BY [System.ChangedDate] DESC
```

A workflow step can then read `{{trigger.item.title}}`, `.status`, `.url` and
the rest.

The query is not given a time window. Azure DevOps returns whatever the WIQL
asks for, and the connector's `timestamp` dedupe decides what is new from each
item's changed date — including the items sharing the newest instant, which a
plain `>` comparison would drop forever.

**A pull request is opened.** Each active pull request opened since the last
poll starts one workflow run, once — the start of an automated review. The
item's `externalId` is the pull request number, which every pull request action
takes as `pullRequestId`; `.data` carries the repository, both branches, the
author and whether it is a draft.

## Actions

### Work items

| Action | Idempotent | What it does |
| --- | --- | --- |
| `createWorkItem` | no | Add a work item to the board; returns its id and url |
| `updateWorkItem` | yes | Change title, state, description or assignee |
| `getWorkItem` | yes | Every field of one work item |
| `commentOnWorkItem` | no | Add to its discussion (plain text or HTML) |

### Pull requests

Each takes the pull request number alone; the repository is read off the pull
request.

| Action | Idempotent | What it does |
| --- | --- | --- |
| `getPullRequest` | yes | Title, description, branches, commits, merge status, every reviewer's vote |
| `listPullRequestChanges` | yes | Changed paths as of the latest push, and the two commits to `git diff` between |
| `listPullRequestComments` | yes | Comment threads with status, file and line; system notices left out |
| `commentOnPullRequest` | no | New thread on the overview or a line of a file, or a reply in a thread (`threadId`) |
| `resolvePullRequestThread` | yes | Mark a thread fixed, won't fix, closed, by design — or active again |
| `votePullRequest` | yes | Approve, approve with suggestions, wait for author, reject, or reset — as the signed-in identity |
| `completePullRequest` | no | Merge now, or set auto-complete to merge once approvals and policies pass |
| `createPullRequest` | no | Open one from a pushed branch, optionally linking work items |

A review workflow is typically: `pullRequestOpened` → `getPullRequest` and
`listPullRequestChanges` → an agent reads the diff → `commentOnPullRequest` per
finding → `votePullRequest`.

**Completing.** Merging now pins the merge to the commit that was read, so
Azure DevOps refuses it if anything was pushed since — nothing lands unreviewed.
Where branch policies require approvals, prefer `autoComplete: true`: the pull
request merges itself, as you, the moment the last policy passes. A policy that
blocks an immediate completion comes back in Azure DevOps's own words. The
merge type defaults to squash and the source branch is deleted unless
`keepSourceBranch` is set.

## Built from

Azure DevOps REST API, via the maintained
[`azure-devops-node-api`](https://github.com/microsoft/azure-devops-node-api)
client:

- [Work Item Tracking](https://learn.microsoft.com/rest/api/azure/devops/wit/)
- [Work item comments](https://learn.microsoft.com/rest/api/azure/devops/wit/comments)
- [Git pull requests](https://learn.microsoft.com/rest/api/azure/devops/git/pull-requests),
  [threads](https://learn.microsoft.com/rest/api/azure/devops/git/pull-request-threads),
  [reviewers](https://learn.microsoft.com/rest/api/azure/devops/git/pull-request-reviewers)
  and [iteration changes](https://learn.microsoft.com/rest/api/azure/devops/git/pull-request-iteration-changes)
- [WIQL](https://learn.microsoft.com/azure/devops/boards/queries/wiql-syntax)
