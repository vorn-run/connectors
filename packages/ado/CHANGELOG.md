# Changelog

All notable changes to `@vornrun/connector-ado`.

## 0.4.0

`listPullRequestComments` is usable on a pull request with real history.

- **`status`**: keep only threads in these states, comma-separated — `active` for triage.
- **`top`**: keep only the most recently active threads — 50 unless told otherwise. `total` says how many matched before the cut.
- Threads come back most recently active first, each with `updatedAt`.
- A thread on the overview has `filePath: null` and `line: null`, and one on a whole file has `line: null`, instead of `''` and `0` — which read as line 0 of a file.

## 0.3.1

Starts as a pack again. `azure-devops-node-api` reads `__dirname` when a connection is made, which the bundled pack did not define, so every step that reached Azure DevOps failed with `__dirname is not defined in ES module scope`. Built with `@vornrun/connector-sdk` 0.7.2, whose packer gives a bundled dependency `__dirname` and `__filename`.

## 0.3.0

Code review on Azure Repos, and more to do with work items.

- **Trigger added:** `pullRequestOpened` fires once for each new active pull request, across the project or in the repository `ADO_REPOSITORY` names.
- **Pull request actions:** `getPullRequest`, `listPullRequestChanges`, `listPullRequestComments`, `commentOnPullRequest` (overview, a line of a file, or a reply), `resolvePullRequestThread`, `votePullRequest` (approve, approve with suggestions, wait for author, reject, reset), `completePullRequest` (merge now — pinned to the reviewed commit when given one — or set auto-complete) and `createPullRequest`. Each names the pull request by number alone.
- **Work item actions:** `getWorkItem`, `commentOnWorkItem`.
- `ADO_QUERY` is no longer required on the form: only the work item trigger reads it, and it still says so when it is missing.

## 0.2.4

Speaks Vorn's own connector protocol instead of MCP, so it needs Vorn 0.7.1-beta.3 or later. Action arguments arrive as typed values.

## 0.2.3

Start as a pack: the bundle now carries the require its CommonJS dependencies were built against.

## 0.2.2

Read the version from the bundle instead of a package.json the packed connector does not carry.

## 0.2.1

Declares how it signs in: it borrows the Azure CLI's login, so the app can say
so before anyone installs it. Ships a conformance receipt.

## 0.2.0

Azure DevOps can now write, not just watch.

- **Actions added:** `createWorkItem`, `updateWorkItem`.
- The connector wears its own mark in the catalog rather than borrowing a
  generic one.

## 0.1.0

First release.

Trigger a workflow from the work items a WIQL query returns.

- **Trigger:** `workItem`. Each work item the query returns starts one run, once.
- **Signing in:** uses your Azure identity. If `az login` works in your
  terminal, this works — there is no token to create or paste.
